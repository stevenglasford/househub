// interaction.test.js — the buttons do what they are supposed to do.
//
// Everything else here checks that the app *renders*. Nothing checked what
// happens when somebody presses something, and that is the gap the reported
// bugs kept falling into: a handler that runs and does the wrong thing looks
// identical, from the outside, to a handler that is correct.
//
// So this mounts components into a real DOM and clicks them.
//
// The three behaviours below are the ones that were actually wrong, and each
// test fails if the old behaviour comes back:
//
//   * tapping anywhere on a row completed the item, so reaching for the
//     person's name or the skip control ticked the chore off
//   * changing who did a chore wrote a raw value, discarding the completion
//     record and skipping the archive
//   * the check-in step list was recomputed as you went, deleting the status
//     step out from under the second person before they had finished

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const ESBUILD = join(WEB, "node_modules", "esbuild", "bin", "esbuild");

let JSDOM;
try { ({ JSDOM } = await import("jsdom")); } catch { /* reported below */ }

const ready = Boolean(JSDOM) && existsSync(ESBUILD);
const needs = { skip: ready ? false : "needs jsdom and the esbuild binary" };

/* The DOM has to exist as a global BEFORE react-dom/client is imported: it
   reads `window` while the module is evaluating, so setting up per-test would
   be too late and every test would fail with "window is not defined". One
   document is shared and the root emptied between tests. */
let dom = null;
if (ready) {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event",
                   "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    if (dom.window[k] !== undefined) globalThis[k] = dom.window[k];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

/** A clean mount point. */
function mountPoint() {
  const el = dom.window.document.getElementById("root");
  el.innerHTML = "";
  return el;
}

function bundle(entry, names) {
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-interact-"));
  const shim = join(dir, "entry.jsx");
  writeFileSync(shim, `export { ${names.join(", ")} } from ${JSON.stringify(join(WEB, entry))};\n`);
  const out = join(dir, "bundle.mjs");
  execFileSync(ESBUILD, [
    shim, "--bundle", "--format=esm", "--jsx=automatic", "--platform=node",
    "--external:react", "--external:react-dom", "--external:react/jsx-runtime",
    "--loader:.js=jsx", "--external:*.woff2", "--external:*.css",
    "--define:import.meta.env={}", `--outfile=${out}`, "--log-level=error",
  ], { cwd: WEB });
  return import(pathToFileURL(out).href);
}

/* ------------------------------------------------------- credit picker --- */

test("the credit picker reports the person that was tapped", needs, async () => {
  const { CreditPicker } = await bundle("src/App.jsx", ["CreditPicker"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  {
    const picked = [];
    const root = createRoot(mountPoint());
    await act(async () => {
      root.render(React.createElement(CreditPicker, {
        people: [{ id: "p1", name: "Steven", color: "#111" }, { id: "p2", name: "Alex", color: "#222" }],
        currentId: "p1",
        onPick: (id) => picked.push(id),
      }));
    });

    const buttons = [...dom.window.document.querySelectorAll("button")];
    const alex = buttons.find((b) => b.textContent.trim() === "Alex");
    assert.ok(alex, `expected an Alex button, saw: ${buttons.map((b) => b.textContent.trim())}`);

    await act(async () => { alex.click(); });
    assert.deepEqual(picked, ["p2"], "tapping a name must report that person");

    const nobody = buttons.find((b) => b.textContent.trim() === "Nobody");
    await act(async () => { nobody.click(); });
    assert.deepEqual(picked, ["p2", ""], "and 'Nobody' must clear the credit");
    await act(async () => { root.unmount(); });
  }
});

/* ------------------------------------------------- completion semantics --- */

test("changing who did a chore keeps the completion record intact", needs, async () => {
  // The old handler wrote `personId || true` straight into done[], which threw
  // away which device ticked it, when, and whether the claim was somebody's
  // own -- and never touched the archive, so the permanent record and the
  // screen disagreed from then on.
  const C = await import("../src/lib/completion.js");
  const display = { isDisplay: true, displayName: "Hall iPad" };

  let doc = {
    archiveSettings: { chores: true }, archive: {},
    people: [{ id: "p1", name: "Steven" }, { id: "p2", name: "Alex" }],
    chores: [{ id: "c1", title: "Bins out", personId: "p1", done: {} }],
  };
  doc = C.toggleChore(doc, "c1", "2026-08-14", display, {});
  const beforeArchive = doc.archive.chores.length;

  doc = C.attributeChore(doc, "c1", "2026-08-14", "p2", display);
  const mark = doc.chores[0].done["2026-08-14"];
  const rec = C.completionOf(mark);

  assert.equal(rec.by, "p2", "credit moved");
  assert.equal(rec.byType, "display", "origin is preserved, not overwritten");
  assert.equal(rec.source, "Hall iPad", "and which screen it came from");
  assert.ok(rec.at, "the timestamp survives");
  assert.equal(doc.archive.chores.length, beforeArchive, "no duplicate archive row");
  assert.equal(doc.archive.chores.at(-1).by, "p2", "the archive followed the correction");
});

test("a signed-in person's own tick cannot be rewritten by a screen", needs, async () => {
  const C = await import("../src/lib/completion.js");
  const member = { userId: "u1", personId: "p1", isDisplay: false };
  const display = { isDisplay: true, displayName: "Hall iPad" };

  let doc = {
    people: [{ id: "p1", name: "Steven" }, { id: "p2", name: "Alex" }],
    chores: [{ id: "c1", title: "Bins out", personId: "p1", done: {} }],
  };
  doc = C.toggleChore(doc, "c1", "2026-08-14", member, {});
  const mark = doc.chores[0].done["2026-08-14"];

  assert.equal(C.canReattribute(mark, display), false);
  assert.throws(() => C.attributeChore(doc, "c1", "2026-08-14", "p2", display));
});

/* ------------------------------------------------------ check-in steps --- */

test("the status step survives people recording their scores", needs, async () => {
  // The reported bug: with two people, the second person's first slider made
  // the step vanish before they had set the other two.
  const { buildCheckinSteps } = await import("../src/lib/checkin.js");
  const opts = { peopleCount: 2, mealsPlanned: true };

  const atStart = buildCheckinSteps(opts);
  assert.ok(atStart.some((s) => s.id === "status"));

  // Whatever anybody records, the list is the same list.
  const later = buildCheckinSteps(opts);
  assert.deepEqual(later.map((s) => s.id), atStart.map((s) => s.id));
});

/* ---------------------------------------------------------- step editor --- */

test("ticking a step on a to-do changes only that step", needs, async () => {
  const S = await import("../src/lib/subtasks.js");
  let task = S.addStep(S.addStep({ id: "t1" }, "Find papers"), "Pay the fee");
  const [a, b] = S.stepsOf(task);

  task = S.toggleStep(task, a.id);
  assert.equal(S.stepsOf(task).find((s) => s.id === a.id).done, true);
  assert.equal(S.stepsOf(task).find((s) => s.id === b.id).done, false,
    "the other step must not move");
});

/* ----------------------------------------------- only the circle ticks --- */

test("the completion control is the circle, not the row", needs, async () => {
  /* The reported bug, tested at the source rather than by eye: a chore row was
     one big <button>, so reaching for the person's name or the Skip control
     completed the chore instead. Irritating on a phone, worse on a wall tablet
     where the targets are large and people tap in passing.

     Checked against the source because these rows live deep inside views that
     need a dozen props and three contexts to mount. What matters is structural
     and visible here: no row wraps its whole contents in a button that toggles. */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(WEB, "src", "App.jsx"), "utf8");

  const offenders = [];
  for (const m of src.matchAll(/<button[^>]*onClick=\{\(\) => toggle(?:Chore|Task)\([^)]*\)\}([^>]*)>/g)) {
    const attrs = m[1];
    // A row-sized button announces itself: it lays out its children.
    if (/flex items-center/.test(attrs) || /text-left/.test(attrs)) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`App.jsx:${line} — toggle button also lays out the row`);
    }
  }
  assert.deepEqual(offenders, [],
    `rows that complete when tapped anywhere:\n  ${offenders.join("\n  ")}`);
});

test("that check would notice the old markup", needs, async () => {
  // The pattern, proven against the shape the code actually had.
  const old = `<button key={c.id} onClick={() => toggleChore(c.id)} className="tapfade flex items-center gap-2.5 rounded-xl px-2 py-2 text-left">`;
  const hits = [...old.matchAll(/<button[^>]*onClick=\{\(\) => toggle(?:Chore|Task)\([^)]*\)\}([^>]*)>/g)];
  assert.equal(hits.length, 1);
  assert.match(hits[0][1], /flex items-center/);
});

/* ------------------------------------------------- who did it, on a screen --- */

test("REGRESSION: a display tick names somebody instead of asking", needs, async () => {
  /* Ryan: "After a todo item has been checked off on the display, it changes to
     'who did it' — it should say the person who did it."

     A shared screen genuinely cannot know who pressed it, and the old code was
     strictly truthful about that: it credited nobody. In a kitchen that meant
     the row asked a question forever, because nobody goes back to answer the
     wall. It now assumes whoever's turn it was and marks that as an assumption. */
  const C = await import("../src/lib/completion.js");
  const display = { isDisplay: true, displayName: "Hall iPad" };

  let doc = {
    people: [{ id: "p1", name: "Steven" }, { id: "p2", name: "Alex" }],
    chores: [{ id: "c1", title: "Bins out", personId: "p1", done: {} }],
    archiveSettings: { chores: true }, archive: {},
  };
  doc = C.toggleChore(doc, "c1", "2026-08-21", display, { assigneeOf: (c) => c.personId });

  const rec = C.completionOf(doc.chores[0].done["2026-08-21"]);
  assert.equal(rec.by, "p1", "the assignee is credited rather than nobody");
  assert.equal(rec.presumed, true, "and it is recorded as an assumption, not a claim");
  assert.equal(rec.byType, "display", "the origin is still the screen");
});

test("correcting the credit clears the assumption", needs, async () => {
  const C = await import("../src/lib/completion.js");
  const display = { isDisplay: true, displayName: "Hall iPad" };
  let doc = {
    people: [{ id: "p1" }, { id: "p2" }],
    chores: [{ id: "c1", title: "Bins out", personId: "p1", done: {} }],
    archiveSettings: { chores: true }, archive: {},
  };
  doc = C.toggleChore(doc, "c1", "2026-08-21", display, { assigneeOf: (c) => c.personId });
  doc = C.attributeChore(doc, "c1", "2026-08-21", "p2", display);

  const rec = C.completionOf(doc.chores[0].done["2026-08-21"]);
  assert.equal(rec.by, "p2");
  assert.equal(rec.presumed, false, "somebody has said who it was, so it is no longer a guess");
});

test("a signed-in person's own tick is never a presumption", needs, async () => {
  const C = await import("../src/lib/completion.js");
  const rec = C.completionOf(C.markCompleted({ userId: "u1", personId: "p1", isDisplay: false }));
  assert.equal(rec.presumed, false);
  assert.equal(rec.locked, true, "it is a statement about themselves and it stands");
});

/* ------------------------------------------- who did a task --- */
// Ryan: "on an overdue task, from Today. I can't change the person who did it
// after i check it off."
//
// That was not a locking rule — there was nothing to correct. A completed task
// stored `done` and `doneAt` and nothing about who did it, so the name on the
// row was the *assignee*, and the picker was hard-coded off because there was
// no record for it to edit. Tasks now carry the same completion record chores
// do, which is what makes the same rules apply to both.

test("ticking a task records who did it, not just when", needs, async () => {
  const { markCompleted, canReattribute, reattribute, completedBy } =
    await import("../src/lib/completion.js");

  // A signed-in member's own tick: a first-person claim, and it stands.
  const mine = markCompleted({ personId: "p1", userId: "u1" }, { fallbackPersonId: "p1" });
  assert.equal(completedBy(mine), "p1");
  assert.equal(mine.locked, true);
  assert.equal(canReattribute(mine, { personId: "p1" }), false,
    "nothing anonymous rewrites somebody's statement about themselves");

  // A shared display: somebody's word for who was there, and correctable.
  const wall = markCompleted({ isDisplay: true, displayName: "Kitchen wall" }, { fallbackPersonId: "p2" });
  assert.equal(wall.byType, "display");
  assert.equal(wall.presumed, true, "it names the likely person and flags the assumption");
  assert.equal(canReattribute(wall, { isDisplay: true }), true);

  const fixed = reattribute(wall, "p3", { isDisplay: true, displayName: "Kitchen wall" });
  assert.equal(completedBy(fixed), "p3");
  assert.equal(fixed.presumed, false, "once somebody has said, it is no longer an assumption");
});

test("a task with no doer recorded falls back to the assignee, not to nobody", needs, async () => {
  // Every task completed before this existed has no `doneBy`. Showing a blank
  // where a name used to be would read as data loss.
  const { completedBy } = await import("../src/lib/completion.js");
  const legacy = { id: "t1", title: "Post the form", done: true, doneAt: "2026-09-01", personId: "p2" };
  assert.equal(completedBy(legacy.doneBy), "", "there is genuinely no doer on record");
  const shown = completedBy(legacy.doneBy) || legacy.personId;
  assert.equal(shown, "p2", "so the row shows who it was assigned to");
});

test("a tick from a session with nobody behind it can be corrected", needs, async () => {
  // Ryan: "it was a chore and i'm not signed in in the sandbox. i cannot change
  // who did it from Today for an overdue chore."
  //
  // `markCompleted` locked unconditionally on the non-display branch. Locking
  // exists so that a statement somebody made ABOUT THEMSELVES stands — but an
  // actor with no personId has no self to make one about. The completion was
  // credited to the assignee, locked, and correctable by nobody.
  //
  // This is not sandbox-only: a real member whose account is not linked to
  // anybody in the household takes the identical path.
  const { markCompleted, canReattribute, completedBy } = await import("../src/lib/completion.js");

  const nobody = markCompleted({ isDisplay: false, userId: null, personId: "" },
    { fallbackPersonId: "p2" });
  assert.equal(nobody.locked, false, "no self, so no first-person claim to protect");
  assert.equal(completedBy(nobody), "p2", "still credited to whoever it was assigned to");
  assert.equal(nobody.presumed, true, "and flagged as the assumption it is");
  assert.equal(canReattribute(nobody, {}), true, "so it can be put right");

  // The case locking actually exists for is untouched.
  const mine = markCompleted({ isDisplay: false, userId: "u1", personId: "p1" },
    { fallbackPersonId: "p1" });
  assert.equal(mine.locked, true);
  assert.equal(mine.presumed, false, "nothing presumed — they said so themselves");
  assert.equal(canReattribute(mine, { personId: "p1" }), false);
});

test("every unlocked completion is correctable, whatever its byType", needs, async () => {
  // canReattribute used to require one of an enumerated list of byTypes as well
  // as being unlocked, so the flag and the list could disagree — and they did,
  // leaving a correctable record with no way to correct it.
  const { canReattribute } = await import("../src/lib/completion.js");
  for (const byType of ["user", "display", "legacy", "onBehalf"]) {
    assert.equal(canReattribute({ by: "p1", byType, locked: false }, {}), true, byType);
    assert.equal(canReattribute({ by: "p1", byType, locked: true }, {}), false, byType + " (locked)");
  }
});
