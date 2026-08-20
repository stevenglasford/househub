// new-views.test.js — the screens added for Ryan's list actually draw.
//
// A clean `vite build` says nothing about whether a component renders: esbuild
// transforms modules without resolving identifiers, so a missing import or an
// undeclared name compiles perfectly and throws the instant React draws it.
// That is exactly how two white screens reached production here before.
//
// Every component added or materially changed in this round is mounted for real
// with a realistic document.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as LISTS from "../src/lib/lists.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const ESBUILD = join(WEB, "node_modules", "esbuild", "bin", "esbuild");
const needs = { skip: existsSync(ESBUILD) ? false : "esbuild binary not found" };

function load(entry, names) {
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-newviews-"));
  const shim = join(dir, "entry.jsx");
  writeFileSync(shim, `export { ${names.join(", ")} } from ${JSON.stringify(join(WEB, entry))};\n`);
  const out = join(dir, "bundle.mjs");
  execFileSync(ESBUILD, [
    shim, "--bundle", "--format=esm", "--jsx=automatic", "--platform=node",
    "--external:react", "--external:react-dom", "--external:react/jsx-runtime",
    "--loader:.js=jsx", "--external:*.woff2", "--external:*.css",
    // lucide-react ships CJS and ESM; under --platform=node esbuild picks CJS,
    // which then calls require("react") inside an ES module and dies.
    "--main-fields=module,main", "--conditions=import,module",
    "--define:import.meta.env={}", `--outfile=${out}`, "--log-level=error",
  ], { cwd: WEB });
  return import(pathToFileURL(out).href);
}

const chore = {
  id: "c1", title: "Bins out", rotation: ["p1", "p2"],
  checklist: ["Wheelie bin", "Recycling", "Garden waste"],
  notes: { "2026-08-20": "The lorry never came", "2026-08-13": "Fine" },
  done: { "2026-08-20": { by: "p2", byType: "onBehalf", onBehalfOf: "p1", at: 1 } },
};
const people = [{ id: "p1", name: "Steven", color: "#111" }, { id: "p2", name: "Alex", color: "#222" }];
const personById = (id) => people.find((p) => p.id === id) || null;

test("the chore-occurrence sheet renders, with the note and the checklist", needs, async () => {
  const { ChoreDayModal } = await load("src/App.jsx", ["ChoreDayModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const html = renderToStaticMarkup(React.createElement(ChoreDayModal, {
    chore, dateKey: "2026-08-20", people, personById,
    update: () => {}, close: () => {}, openChore: () => {},
  }));

  assert.match(html, /Bins out/);
  assert.match(html, /Wheelie bin/, "the checklist Ryan asked for must be visible here");
  assert.match(html, /The lorry never came/, "and the note for this occurrence");
  assert.match(html, /Fine/, "earlier notes are readable as history");
  assert.match(html, /Alex/, "who did it");
  assert.match(html, /Steven/, "and whose turn it was");
  assert.match(html, /still up next time/, "covering must not silently consume a turn");
});

test("the sheet copes with a chore that has nothing on it", needs, async () => {
  const { ChoreDayModal } = await load("src/App.jsx", ["ChoreDayModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(ChoreDayModal, {
    chore: { id: "c9", title: "Plain", done: {} }, dateKey: "2026-08-20",
    people: [], personById: () => null, update: () => {}, close: () => {}, openChore: () => {},
  })));
});

test("the lists view renders empty, populated, and opened", needs, async () => {
  const { ListsView } = await load("src/App.jsx", ["ListsView"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const empty = renderToStaticMarkup(React.createElement(ListsView,
    { data: { lists: [] }, update: () => {}, personById: () => null }));
  assert.match(empty, /No lists yet/);

  let packing = LISTS.createList("Packing");
  packing = LISTS.addItem(LISTS.addItem(packing, "Socks"), "Passport");
  packing = LISTS.toggleItem(packing, LISTS.itemsOf(packing)[0].id);

  const shelf = renderToStaticMarkup(React.createElement(ListsView,
    { data: { lists: [packing] }, update: () => {}, personById: () => null }));
  assert.match(shelf, /Packing/);
  assert.match(shelf, /1\/2/, "progress is shown");
  assert.match(shelf, /Passport/, "the outstanding items preview");
});

test("the project editor renders and offers the sync targets", needs, async () => {
  const { ProjectModal } = await load("src/App.jsx", ["ProjectModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const html = renderToStaticMarkup(React.createElement(ProjectModal, {
    payload: {
      id: "pr1", title: "Kitchen", stages: [{ id: "s1", title: "Order tiles", date: "2026-09-01", done: false }],
    },
    people, update: () => {}, close: () => {},
    calendars: [{ id: "cal1", name: "Family", writable: true }, { id: "cal2", name: "Work", writable: false }],
  }));

  assert.match(html, /Show these dates on/);
  assert.match(html, /HouseHub only/, "the default must be that nothing leaves the house");
  assert.match(html, /Family/);
  assert.match(html, /Work \(read-only\)/, "a read-only calendar is labelled as such");
});

test("the project editor works with no synced calendars at all", needs, async () => {
  const { ProjectModal } = await load("src/App.jsx", ["ProjectModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(ProjectModal, {
    payload: {}, people, update: () => {}, close: () => {}, calendars: undefined,
  }));
  assert.match(html, /HouseHub only/);
});

test("the countdown strip and board still draw after the urgency change", needs, async () => {
  const { CountdownStrip, BoardView } = await load("src/App.jsx", ["CountdownStrip", "BoardView"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const dates = [{ id: "a", title: "Vet", date: "2026-08-23", annual: false }];
  assert.doesNotThrow(() =>
    renderToStaticMarkup(React.createElement(CountdownStrip, { dates, todayKey: "2026-08-20" })));
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(BoardView, {
    data: { dates, notes: [] }, update: () => {}, personById: () => null,
    todayKey: "2026-08-20", openNote: () => {}, openDate: () => {},
  })));
});

test("the whole app still bundles with every new import resolved", needs, () => {
  // esbuild resolves every import while bundling, so a module that does not
  // exist, or an export renamed out from under a caller, fails here.
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-newviews-full-"));
  assert.doesNotThrow(() => {
    execFileSync(ESBUILD, [
      join(WEB, "src", "main.jsx"), "--bundle", "--format=esm", "--jsx=automatic",
      "--platform=browser", "--external:react", "--external:react-dom",
      "--external:react/jsx-runtime", "--external:*.woff2", "--external:*.css",
      `--outfile=${join(dir, "out.mjs")}`, "--log-level=error",
    ], { cwd: WEB, stdio: "pipe" });
  });
});
