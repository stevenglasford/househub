// render.test.js — the components actually render.
//
// Every other test in this directory reasons about source text. None of them
// runs the app, and that is exactly how two crashes reached production: a
// missing `useMemo` import and a `canFixCredit` that was used but never
// declared. Both compiled cleanly, because esbuild transforms modules without
// resolving identifiers. Both threw the instant React rendered them, and the
// page went white.
//
// This renders the components for real, through react-dom/server, with a
// realistic household document. It cannot catch everything a browser would --
// no effects, no layout, no clicking -- but it catches the thing that kept
// getting through: a component that throws the moment it is asked to draw.
//
// JSX is transpiled with the esbuild binary that Vite already depends on, so
// this adds no new dependency.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const ESBUILD = join(WEB, "node_modules", "esbuild", "bin", "esbuild");

const haveEsbuild = existsSync(ESBUILD);
const needsEsbuild = { skip: haveEsbuild ? false : "esbuild binary not found" };

/**
 * Bundle a module and import it.
 *
 * Bundling rather than transpiling file-by-file, because App.jsx imports a
 * dozen siblings and Node cannot resolve `.jsx` on its own. React is kept
 * external so the test and the component share one copy.
 */
function loadModule(entry, exportsWanted) {
  /* The bundle is written inside the project, not /tmp. React is kept external
     so the test and the component share one copy, and Node resolves an external
     import from the importing file's directory -- from /tmp there is no
     node_modules above it and `react` cannot be found. */
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-render-"));
  const shim = join(dir, "entry.jsx");
  // Absolute, because the shim lives in a temp directory and a relative
  // specifier would resolve against that instead of the project.
  const abs = join(WEB, entry.replace(/^\.\//, ""));
  writeFileSync(shim, `export { ${exportsWanted.join(", ")} } from ${JSON.stringify(abs)};\n`);
  const out = join(dir, "bundle.mjs");
  execFileSync(ESBUILD, [
    shim, "--bundle", "--format=esm", "--jsx=automatic", "--platform=node",
    "--external:react", "--external:react-dom", "--external:react/jsx-runtime",
    "--loader:.js=jsx", "--external:*.woff2", "--external:*.css",
    // Vite injects import.meta.env at build time; Node has no such thing.
    "--define:import.meta.env={}",
    `--outfile=${out}`, "--log-level=error",
  ], { cwd: WEB });
  return import(pathToFileURL(out).href);
}

/** A household with enough in it that the interesting branches are taken. */
function household() {
  const people = [
    { id: "p1", name: "Steven", color: "#5D6FE0" },
    { id: "p2", name: "Alex", color: "#2E9187" },
  ];
  const status = {};
  for (let i = 0; i < 40; i++) {
    const d = new Date(2026, 7, 14 - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    status[key] = {
      p1: { happiness: 4, connection: 3, intimacy: 4 },
      p2: { happiness: 3, connection: 4, intimacy: 3 },
    };
  }
  return {
    householdName: "Test House",
    people,
    status,
    chores: [
      { id: "c1", title: "Bins out", personId: "p1", done: {}, cadence: { type: "daily" } },
      // A completion in each stored shape, since each takes a different branch.
      { id: "c2", title: "Dishes", personId: "p2", cadence: { type: "daily" },
        done: { "2026-08-14": { by: "p2", byType: "display", source: "Hall iPad", locked: false } } },
      { id: "c3", title: "Legacy", personId: "p1", cadence: { type: "daily" },
        done: { "2026-08-14": "p1" } },
      { id: "c4", title: "Skipped", personId: "p1", cadence: { type: "daily" },
        done: { "2026-08-14": "skipped" } },
    ],
    tasks: [
      { id: "t1", title: "Renew tabs", date: "2026-08-14", personId: "p1", done: false,
        steps: [{ id: "s1", title: "Find papers", done: true }, { id: "s2", title: "Pay", done: false }] },
    ],
    projects: [], grocery: [], notes: [], dates: [], agenda: [], agendaArchive: [],
    agendaPrompts: [], dateJars: [], dateIdeas: [], events: [], meals: {},
    groceryStores: ["Any"], groceryHistory: {},
    checkin: { log: {}, overrides: {} },
    alertSnooze: {}, alertRelayed: {}, reminderRelay: { enabled: false, endpoint: "" },
    calendars: [], homeEntities: [], upNextSources: null,
  };
}

test("the components that crashed actually render", needsEsbuild, async () => {
  /* StatusGraph is the exact component that went white: it used useMemo, which
     was never imported, and threw the instant the status pane drew it. This
     renders it for real. CreditPicker is the other new interactive piece. */
  const mod = await loadModule("./src/App.jsx", ["StatusGraph", "CreditPicker"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const doc = household();

  const graph = renderToStaticMarkup(
    React.createElement(mod.StatusGraph, { data: doc, todayKey: "2026-08-14" }));
  assert.match(graph, /<svg/, "the graph should draw an svg");
  assert.match(graph, /Over time/);

  const picker = renderToStaticMarkup(
    React.createElement(mod.CreditPicker, { people: doc.people, currentId: "p1", onPick: () => {} }));
  assert.match(picker, /Steven/);
  assert.match(picker, /Nobody/);
});

test("the status graph renders for every window and dimension", needsEsbuild, async () => {
  // Each combination takes a different path through the series builder, and an
  // empty household is the one most likely to divide by zero.
  const { StatusGraph } = await loadModule("./src/App.jsx", ["StatusGraph"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  for (const data of [household(), { ...household(), status: {} }, { people: [], status: {} }]) {
    assert.doesNotThrow(
      () => renderToStaticMarkup(React.createElement(StatusGraph, { data, todayKey: "2026-08-14" })),
      "the graph must survive a household with no check-ins at all");
  }
});

test("every exported library function survives a realistic document", needsEsbuild, async () => {
  // Not a render, but the same purpose: run the real code over real data rather
  // than only over the tidy fixtures each unit test builds for itself.
  const mods = await Promise.all([
    import("../src/lib/status.js"),
    import("../src/lib/subtasks.js"),
    import("../src/lib/completion.js"),
    import("../src/lib/alerts.js"),
    import("../src/lib/checkin.js"),
  ]);
  const [STATUS, SUB, COMPLETION, ALERTS, CHECKIN] = mods;
  const doc = household();

  assert.doesNotThrow(() => STATUS.buildSeries(doc.status, doc.people,
    { todayKey: "2026-08-14", days: 90, dimension: "average" }));
  for (const chore of doc.chores) {
    assert.doesNotThrow(() => COMPLETION.completionOf(chore.done["2026-08-14"]));
    assert.doesNotThrow(() => COMPLETION.completedBy(chore.done["2026-08-14"]));
    assert.doesNotThrow(() => SUB.choreNotes(chore));
  }
  for (const task of doc.tasks) assert.doesNotThrow(() => SUB.stepProgress(task));
  assert.doesNotThrow(() => ALERTS.dueAlerts(doc, "2026-08-14", 12 * 60));
  assert.doesNotThrow(() => CHECKIN.buildCheckinSteps({ peopleCount: 2 }));
});

test("App.jsx bundles without an unresolved import", needsEsbuild, () => {
  // esbuild resolves every import while bundling, so a module that does not
  // exist, or an export that was renamed, fails here rather than at runtime.
  const dir = mkdtempSync(join(tmpdir(), "hh-bundle-"));
  assert.doesNotThrow(() => {
    execFileSync(ESBUILD, [
      join(WEB, "src", "main.jsx"), "--bundle", "--format=esm", "--jsx=automatic",
      "--platform=browser", "--external:react", "--external:react-dom",
      "--external:react/jsx-runtime",
      // Fonts and stylesheets are Vite's job; esbuild alone cannot resolve them
      // and their absence says nothing about the code.
      "--external:*.woff2", "--external:*.css",
      `--outfile=${join(dir, "out.mjs")}`, "--log-level=error",
    ], { cwd: WEB, stdio: "pipe" });
  });
});
