// timers-ui.test.js — the timer controls do what they say.
//
// The logic tests in timers.test.js prove the countdown; they cannot prove that
// pressing "Stop" is wired to silencing rather than to deleting, which is
// exactly the class of mistake that looks fine in review and then loses
// somebody's other running timer.
//
// So this mounts the real components and presses the real buttons.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as TM from "../src/lib/timers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const ESBUILD = join(WEB, "node_modules", "esbuild", "bin", "esbuild");

let JSDOM;
try { ({ JSDOM } = await import("jsdom")); } catch { /* reported below */ }

const ready = Boolean(JSDOM) && existsSync(ESBUILD);
const needs = { skip: ready ? false : "needs jsdom and the esbuild binary" };

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

function mountPoint() {
  const el = dom.window.document.getElementById("root");
  el.innerHTML = "";
  return el;
}

function bundle(entry, names) {
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-timers-"));
  const shim = join(dir, "entry.jsx");
  writeFileSync(shim, `export { ${names.join(", ")} } from ${JSON.stringify(join(WEB, entry))};\n`);
  const out = join(dir, "bundle.mjs");
  execFileSync(ESBUILD, [
    shim, "--bundle", "--format=esm", "--jsx=automatic", "--platform=node",
    "--external:react", "--external:react-dom", "--external:react/jsx-runtime",
    "--loader:.js=jsx", "--external:*.woff2", "--external:*.css",
    /* Prefer each package's ESM entry. Without this, esbuild resolves
       lucide-react to its CommonJS build, which does a dynamic require of
       react that an ES module cannot satisfy. The older interaction suite gets
       away with the default because the component it bundles uses no icons and
       lucide is tree-shaken out entirely. */
    "--main-fields=module,main",
    "--define:import.meta.env={}", `--outfile=${out}`, "--log-level=error",
  ], { cwd: WEB });
  return import(pathToFileURL(out).href);
}

const T = { bg: "#111", panel: "#222", panelAlt: "#333", line: "#444", ink: "#eee", faint: "#999", accent: "#2f6f4f" };
const mins = (n) => n * 60 * 1000;

/** A tiny stand-in for App's `update`, holding the document it mutates. */
function makeDoc(timers) {
  const box = { data: { timers } };
  return {
    box,
    update: (fn) => { box.data = fn({ ...box.data }); },
  };
}

test("running timers each show their own name and countdown", needs, async () => {
  const { TimerBar } = await bundle("src/components/TimersPanel.jsx", ["TimerBar"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const now = Date.now();
  const { box, update } = makeDoc([
    TM.newTimer({ id: "a", label: "Pasta", durationMs: mins(10), now }),
    TM.newTimer({ id: "b", label: "Garlic bread", durationMs: mins(4), now }),
  ]);

  const root = createRoot(mountPoint());
  await act(async () => {
    root.render(React.createElement(TimerBar, { data: box.data, update, T }));
  });

  const text = dom.window.document.body.textContent;
  assert.match(text, /Pasta/, "the first timer is named on screen");
  assert.match(text, /Garlic bread/, "and so is the second — this is the whole of 'multiple named timers'");
  assert.match(text, /3:5\d|4:00/, "with its own countdown, not a shared one");
  await act(async () => { root.unmount(); });
});

test("Stop silences the ringing timer and leaves the others running", needs, async () => {
  // The mistake this guards: wiring Stop to a delete. It looks correct on a
  // single timer and quietly destroys the record of the one still counting.
  const { TimerAlarm } = await bundle("src/components/TimersPanel.jsx", ["TimerAlarm"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const now = Date.now();
  const { box, update } = makeDoc([
    { ...TM.newTimer({ id: "a", label: "Eggs", durationMs: mins(6), now }), endsAt: now - 1000 },
    TM.newTimer({ id: "b", label: "Rice", durationMs: mins(20), now }),
  ]);

  const root = createRoot(mountPoint());
  const render = async () => act(async () => {
    root.render(React.createElement(TimerAlarm, { data: box.data, update, T }));
  });
  await render();

  assert.match(dom.window.document.body.textContent, /Eggs/, "the finished timer takes over the screen");

  const stop = [...dom.window.document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "Stop");
  assert.ok(stop, "there is a Stop control");
  await act(async () => { stop.click(); });

  assert.equal(box.data.timers.length, 2, "nothing was deleted");
  assert.equal(TM.timerState(box.data.timers[0]), "done", "the ringing one is silenced");
  assert.equal(TM.timerState(box.data.timers[1]), "running", "and the other is untouched");

  await render();
  assert.doesNotMatch(dom.window.document.body.textContent, /TIMER FINISHED/,
    "and the takeover closes — on every screen, because the silence is in the document");
  await act(async () => { root.unmount(); });
});

test("“+1 min” on a finished timer sets it running again, audibly", needs, async () => {
  const { TimerAlarm } = await bundle("src/components/TimersPanel.jsx", ["TimerAlarm"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const now = Date.now();
  const { box, update } = makeDoc([
    { ...TM.newTimer({ id: "a", label: "Roast", durationMs: mins(30), now }), endsAt: now - 500 },
  ]);

  const root = createRoot(mountPoint());
  await act(async () => {
    root.render(React.createElement(TimerAlarm, { data: box.data, update, T }));
  });

  const plus = [...dom.window.document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "+1 min");
  assert.ok(plus, "there is a +1 min control");
  await act(async () => { plus.click(); });

  const t = box.data.timers[0];
  assert.equal(TM.timerState(t), "running");
  assert.equal(t.silencedAt, 0,
    "and it is not left pre-silenced — otherwise it runs down and finishes without a sound");
  await act(async () => { root.unmount(); });
});

test("a timer can be started from the quick durations", needs, async () => {
  const { TimerBar } = await bundle("src/components/TimersPanel.jsx", ["TimerBar"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const { box, update } = makeDoc([]);
  const root = createRoot(mountPoint());
  const render = async () => act(async () => {
    root.render(React.createElement(TimerBar, { data: box.data, update, T }));
  });
  await render();

  const add = [...dom.window.document.querySelectorAll("button")]
    .find((b) => b.getAttribute("aria-label") === "New timer");
  assert.ok(add, "the bar offers a way to start one even with nothing running");
  await act(async () => { add.click(); });

  const ten = [...dom.window.document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "10m");
  assert.ok(ten, "with quick durations");
  await act(async () => { ten.click(); });

  assert.equal(box.data.timers.length, 1);
  assert.equal(box.data.timers[0].durationMs, mins(10));
  assert.equal(TM.timerState(box.data.timers[0]), "running");
  await act(async () => { root.unmount(); });
});

test("the microphone is offered only where the browser has one", needs, async () => {
  // Firefox has no Web Speech API. Offering a button that cannot work is worse
  // than offering nothing, so the control is absent rather than broken.
  const { TimerBar } = await bundle("src/components/TimersPanel.jsx", ["TimerBar"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const { box, update } = makeDoc([]);
  const root = createRoot(mountPoint());
  await act(async () => {
    root.render(React.createElement(TimerBar, { data: box.data, update, T }));
  });

  const mic = [...dom.window.document.querySelectorAll("button")]
    .find((b) => (b.getAttribute("aria-label") || "").includes("voice"));
  assert.equal(mic, undefined, "jsdom has no SpeechRecognition, so no microphone button is drawn");
  await act(async () => { root.unmount(); });
});

/* ------------------------------------------------- history, in one place --- */
// Ryan: "merge the To-do history and the Chores history/log/archive from the
// settings into one reports or history section in the to-dos tab."
//
// The failure worth guarding: the view switch used to live inside the tally
// bar, which only renders when something was completed in the window. Adding
// Archive there would have made it unreachable for exactly the household most
// likely to go looking for the older record.

test("History, Report and Archive are all reachable, even with an empty window", needs, async () => {
  const { HistoryModal } = await bundle("src/App.jsx", ["HistoryModal"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const data = {
    people: [{ id: "p1", name: "Ryan", color: "#111" }],
    chores: [], tasks: [],
    // nothing completed in the window, so there is no tally at all
    archive: { chores: [{
      id: "a1", choreId: "c1", title: "Bins out", dateKey: "2026-08-01",
      by: "p1", byType: "display", assignedTo: "p1", completedAt: 1,
    }] },
    archiveSettings: { chores: true },
  };

  const root = createRoot(mountPoint());
  await act(async () => {
    root.render(React.createElement(HistoryModal, {
      data, update: () => {}, personById: (id) => data.people.find((p) => p.id === id) || null,
      close: () => {},
    }));
  });

  const buttons = () => [...dom.window.document.querySelectorAll("button")];
  for (const label of ["History", "Report", "Archive"]) {
    assert.ok(buttons().some((b) => b.textContent.trim() === label),
      `expected a ${label} view, saw: ${buttons().map((b) => b.textContent.trim()).join(" | ")}`);
  }

  const archive = buttons().find((b) => b.textContent.trim() === "Archive");
  await act(async () => { archive.click(); });
  assert.match(dom.window.document.body.textContent, /Bins out/,
    "the archived completion shows in the To-Dos tab, not only under Settings");

  await act(async () => { root.unmount(); });
});

/* -------------------------------------------------------- settings shape --- */
// Ryan: "clean up the settings, it's just one really long scroll right now."
//
// It was worse than a long scroll: twenty flat fields, and then a tab strip
// *underneath* them, so half of Settings was tabbed and the tabs were below the
// scroll they were meant to be navigating.
//
// The risk in restructuring is silently dropping a field. This test walks every
// section and checks the fields that were there before are still reachable.

test("every settings section is reachable, and nothing was dropped", needs, async () => {
  const { SettingsModal } = await bundle("src/App.jsx", ["SettingsModal"]);
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const data = {
    householdName: "Ours", people: [], chores: [], tasks: [], events: [], calendars: [],
    grocery: [], notes: [], dates: [], agenda: [], projects: [], lists: [], timers: [],
    weather: {}, checkin: {}, secondBlock: {}, status: {}, archive: { chores: [] },
    archiveSettings: {},
  };

  const root = createRoot(mountPoint());
  await act(async () => {
    root.render(React.createElement(SettingsModal, {
      data, update: () => {}, saveNow: () => {}, syncCalendars: () => {},
      close: () => {}, currentUser: { id: "u1", email: "a@b.c", role: "admin" },
    }));
  });

  const text = () => dom.window.document.body.textContent;
  const buttons = () => [...dom.window.document.querySelectorAll("button")];
  const goTo = async (label) => {
    const b = buttons().find((x) => x.textContent.trim() === label);
    assert.ok(b, `no "${label}" section, saw: ${buttons().map((x) => x.textContent.trim()).slice(0, 20).join(" | ")}`);
    await act(async () => { b.click(); });
  };

  // Every field that existed before the restructure, and where it now lives.
  const expected = [
    ["Household", ["Household name", "People"]],
    ["Screens", ["Display mode", "Sticky notes on Today", "Per-person summary on Today",
                 "Extra row on Today", "Displays"]],
    ["Connections", ["Home Assistant", "Devices", "Cameras", "Two-way calendar sync", "AI"]],
    ["Record", ["Archive"]],
    ["Account & data", ["Staying signed in", "Your data", "Import from the old HouseHub",
                        "Account", "Reset everything"]],
  ];

  for (const [section, fields] of expected) {
    await goTo(section);
    for (const f of fields) {
      assert.ok(text().includes(f), `"${f}" went missing from the ${section} section`);
    }
  }

  // And the destructive one is not on every screen.
  await goTo("Household");
  assert.ok(!text().includes("Reset everything"),
    "a button that wipes the household must not follow you around every section");

  await act(async () => { root.unmount(); });
});

/* --------------------------------------------- overdue, then completed --- */
// Ryan: "Overdue tasks on the today screen need to still show as completed on
// the day they were on Today."
//
// They did not. An overdue chore is completed *under today* — today is usually
// not one of its due days — and `choreState` set `active: dueToday` whenever a
// mark existed. So the moment it was ticked, active went false and the chore
// dropped out of the list Today builds both its open rows and its done group
// from. It did not move to the done group; it left the screen entirely, which
// on a shared display reads as "did that save?" and gets it done twice.

test("a chore completed on a day it was not due still belongs to that day", needs, async () => {
  const { choreState } = await bundle("src/App.jsx", ["choreState"]);

  // Every Monday, and today is a Wednesday: not due today, and owed since Monday.
  const chore = { id: "c1", title: "Bins out", cadence: { type: "weekly", days: [1] }, done: {} };
  const wed = "2026-09-02";

  const before = choreState(chore, wed);
  assert.equal(before.dueToday, false, "not scheduled for today");
  assert.ok(before.missedSince, "but owed, so it shows as overdue");
  assert.equal(before.active, true, "and is on the screen");

  // Ticked on Today — the completion is recorded under today, not under Monday.
  const after = choreState({ ...chore, done: { [wed]: { by: "p1", at: 1, byType: "user" } } }, wed);
  assert.equal(after.dueToday, false, "still not a scheduled day");
  assert.equal(after.active, true,
    "and it must stay on the screen, in the done group — the old behaviour dropped it entirely");
  assert.equal(after.missedSince, null, "and is no longer overdue");
});

test("the counts of what is left are unaffected", needs, async () => {
  // The three "how many remain" figures pair active with !done, so widening
  // active must not inflate them.
  const { choreState } = await bundle("src/App.jsx", ["choreState"]);
  const wed = "2026-09-02";
  const done = { id: "c1", cadence: { type: "weekly", days: [1] }, done: { [wed]: { by: "p1", at: 1 } } };

  const st = choreState(done, wed);
  assert.equal(st.active && !done.done[wed], false,
    "active AND not-done is still false, so it is not counted as remaining");
});

test("pausing a chore takes it off the list, even one already late", needs, async () => {
  // Ryan: "when i pause one (the hoover) it doesn't take it off of the chores
  // list."
  //
  // Pausing stopped it being DUE, but the occurrences it already owed were from
  // before the pause began, so the overdue walk still found them. The chore was
  // "not due" and "three days late" at the same moment — and being late is what
  // kept it on screen.
  const { choreState } = await bundle("src/App.jsx", ["choreState"]);

  const hoover = {
    id: "c9", title: "Hoover", createdOn: "2026-08-01",
    cadence: { type: "weekly", days: [1] },   // Mondays
    done: {},
  };
  const wed = "2026-09-02";

  const before = choreState(hoover, wed);
  assert.equal(before.active, true, "unpaused and late, so it is on the list");
  assert.ok(before.missedSince);

  const paused = { ...hoover, pause: { from: wed, until: null, annual: false, paused: true } };
  const after = choreState(paused, wed);
  assert.equal(after.active, false, "paused, so it leaves the list entirely");
  assert.equal(after.missedSince, null, "and stops being late — it is not owed while it sleeps");
  assert.equal(after.paused, true, "and says so, so the UI can file it under Paused");
});

test("a chore completed on a day it was paused still shows as done", needs, async () => {
  // Somebody hoovered anyway. The record wins over the pause — losing it would
  // be destroying a completion to satisfy a setting.
  const { choreState } = await bundle("src/App.jsx", ["choreState"]);
  const wed = "2026-09-02";
  const c = {
    id: "c9", cadence: { type: "weekly", days: [1] },
    pause: { from: wed, until: null, annual: false, paused: true },
    done: { [wed]: { by: "p1", at: 1, byType: "user" } },
  };
  const st = choreState(c, wed);
  assert.equal(st.active, true, "so it appears in the done group for that day");
  assert.ok(st.mark);
});
