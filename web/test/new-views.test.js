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

/* ------------------------------------------- this round's changed screens --- */

test("the event detail sheet shows times, place, details and the calendar", needs, async () => {
  /* Ryan asked for start and end time, location, "any other details", and which
     calendar it belongs to. The last of those used to render "From undefined",
     because the server never sent a name and the document was never consulted. */
  const { ViewEventModal } = await load("src/App.jsx", ["ViewEventModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const html = renderToStaticMarkup(React.createElement(ViewEventModal, {
    ev: {
      id: "ics:a", source: "ics", title: "Dinner", date: "2026-09-04",
      time: "19:00", endTime: "21:00", location: "The Bar, Main St",
      notes: "Bring cash\nand a coat", calName: "Ryan's Calendar",
      color: "#5D6FE0", personId: "p2",
    },
    personById: (id) => (id === "p2" ? { id: "p2", name: "Alex", color: "#2E9187" } : null),
    close: () => {},
  }));

  assert.match(html, /7:00pm/, "start time");
  assert.match(html, /9:00pm/, "end time");
  assert.match(html, /The Bar, Main St/, "location");
  assert.match(html, /Bring cash/, "details");
  assert.match(html, /Ryan&#x27;s Calendar|Ryan's Calendar/, "which calendar it came from");
  assert.doesNotMatch(html, /undefined/, "and never the word undefined");
  assert.match(html, /Alex/, "the person the calendar is assigned to");
});

test("the detail sheet copes with a bare all-day event", needs, async () => {
  const { ViewEventModal } = await load("src/App.jsx", ["ViewEventModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(ViewEventModal, {
    ev: { id: "x", title: "Bins", date: "2026-09-04", allDay: true },
    personById: () => null, close: () => {},
  }));
  assert.match(html, /All day/);
  assert.match(html, /Everyone/, "an event belonging to nobody says so");
  assert.doesNotMatch(html, /undefined/);
});

test("a project-derived event offers the project, not an editor", needs, async () => {
  const { ViewEventModal } = await load("src/App.jsx", ["ViewEventModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(ViewEventModal, {
    ev: { id: "project:pr1:s1", source: "project", projectId: "pr1",
          title: "Kitchen — Order tiles", date: "2026-09-01", allDay: true },
    personById: () => null, close: () => {}, openProject: () => {},
  }));
  assert.match(html, /Open the project/);
  assert.match(html, /From a project/);
});

test("the credit chip always names somebody, and flags a stand-in", needs, async () => {
  const { CreditChip } = await load("src/App.jsx", ["CreditChip"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const people = { p1: { id: "p1", name: "Steven", color: "#111" },
                   p2: { id: "p2", name: "Alex", color: "#222" } };
  const by = (id) => people[id] || null;

  const presumed = renderToStaticMarkup(React.createElement(CreditChip, {
    mark: { by: "p1", byType: "display", presumed: true }, personById: by,
    open: false, onOpen: () => {}, assignedTo: "p1",
  }));
  assert.match(presumed, /Steven/, "a name, not a question");
  assert.doesNotMatch(presumed, /Who did it/);

  const covered = renderToStaticMarkup(React.createElement(CreditChip, {
    mark: { by: "p2", byType: "onBehalf", onBehalfOf: "p1" }, personById: by,
    open: false, onOpen: () => {}, assignedTo: "p1",
  }));
  assert.match(covered, /Alex/);
  assert.match(covered, /covering for Steven/, "the label says somebody stood in");
  assert.match(covered, /<svg/, "and it is marked visually too");
});

test("the note editor offers an end date", needs, async () => {
  const { NoteModal } = await load("src/App.jsx", ["NoteModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(NoteModal, {
    payload: {}, people: [], update: () => {}, close: () => {},
  }));
  assert.match(html, /Take it down on/);
  assert.match(html, /In 2 weeks/);
  assert.match(html, /stays on the board until somebody removes it/);
});

test("the board shows note history once notes have come down", needs, async () => {
  const { BoardView } = await load("src/App.jsx", ["BoardView"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(BoardView, {
    data: {
      notes: [
        { id: "a", text: "Still up", color: "#FBEFA6", from: "2026-08-01" },
        { id: "b", text: "Came down", color: "#D3E8C6", from: "2026-07-01", until: "2026-07-10" },
      ],
      dates: [],
    },
    update: () => {}, personById: () => null, todayKey: "2026-08-21",
    openNote: () => {}, openDate: () => {},
  }));
  assert.match(html, /Still up/);
  assert.match(html, /note history · 1/);
  assert.doesNotMatch(html, /Came down[\s\S]{0,200}Still up/,
    "an expired note must not be sitting on the board");
});

test("the chore editor offers weekly by name, and per-person days", needs, async () => {
  /* "Weekly" existed as "Certain days", which is why it was reported missing.
     
     Per-person days USED to appear only once there was a rotation to divide up.
     That gating is gone, at Ryan's request: "choosing the day of the week to do
     it should be an option for any chore, not just those that you take turns
     on." It also left a per-person chore that had no rotation renderable on
     Today and impossible to edit — its schedule simply invisible. */
  const { ChoreModal } = await load("src/App.jsx", ["ChoreModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const people = [{ id: "p1", name: "Steven", color: "#111" }, { id: "p2", name: "Alex", color: "#222" }];

  const solo = renderToStaticMarkup(React.createElement(ChoreModal, {
    payload: { id: "c1", title: "Bins", cadence: { type: "weekly", days: [1] } },
    people, update: () => {}, close: () => {},
  }));
  assert.match(solo, /Weekly/);
  assert.doesNotMatch(solo, /Certain days/);
  assert.match(solo, /Each person's own day|Each person&#x27;s own day/,
    "offered without a rotation — a household of one still gets to say Thursdays are theirs");

  const rotating = renderToStaticMarkup(React.createElement(ChoreModal, {
    payload: { id: "c2", title: "Bins", rotation: ["p1", "p2"],
               cadence: { type: "perPerson", people: { p1: { days: [1] }, p2: { days: [4] } } } },
    people, update: () => {}, close: () => {},
  }));
  assert.match(rotating, /Each person&#x27;s own day|Each person's own day/);
  assert.match(rotating, /Who does it, and when/);
  assert.match(rotating, /Steven/);
  assert.match(rotating, /Alex/);
});

test("weekly can repeat every other week, and monthly can pick a weekday", needs, async () => {
  // Ryan: "there should also be a way so that we could say to do it every other
  // week or monthly, but we get to choose the day (monday through sunday)".
  const { ChoreModal } = await load("src/App.jsx", ["ChoreModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const people = [{ id: "p1", name: "Steven", color: "#111" }];

  const weekly = renderToStaticMarkup(React.createElement(ChoreModal, {
    payload: { id: "c1", title: "Bins", cadence: { type: "weekly", days: [2], everyNWeeks: 2 } },
    people, update: () => {}, close: () => {},
  }));
  assert.match(weekly, /Every other/, "the every-other-week control is on the weekly editor");
  assert.match(weekly, /Counting from the week of/, "and says which week it counts from");

  const monthlyDay = renderToStaticMarkup(React.createElement(ChoreModal, {
    payload: { id: "c2", title: "Bins", cadence: { type: "monthlyDay", dow: 1, nth: 1 } },
    people, update: () => {}, close: () => {},
  }));
  assert.match(monthlyDay, /Which weekday of the month/);
  assert.match(monthlyDay, /Last/, "including the last one of the month");
  assert.match(monthlyDay, /Monthly, the 1st Mon/, "and it reads back in words");
});

test("a chore can be paused for a season", needs, async () => {
  const { ChoreModal } = await load("src/App.jsx", ["ChoreModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const paused = renderToStaticMarkup(React.createElement(ChoreModal, {
    payload: { id: "c3", title: "Mow the lawn", cadence: { type: "weekly", days: [6] },
               pause: { from: "2026-11-01", until: "2027-03-31", annual: true, paused: true } },
    people: [{ id: "p1", name: "Steven", color: "#111" }], update: () => {}, close: () => {},
  }));
  assert.match(paused, /Paused each year/);
  assert.match(paused, /Every year — seasonal|Every year/);
  assert.match(paused, /will not come due or go overdue/,
    "the reason it is a pause and not a standing skip");
});

test("the occurrence sheet offers a schedule reset only where it means something", needs, async () => {
  const { ChoreDayModal } = await load("src/App.jsx", ["ChoreDayModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const args = {
    dateKey: "2026-08-20", people: [], personById: () => null,
    update: () => {}, close: () => {}, openChore: () => {},
  };

  const interval = renderToStaticMarkup(React.createElement(ChoreDayModal, {
    ...args, chore: { id: "c1", title: "Bins", done: {}, cadence: { type: "interval", everyN: 2, start: "2026-08-17" } },
  }));
  assert.match(interval, /restart the schedule/);
  assert.match(interval, /Every 2 days/);

  const weekly = renderToStaticMarkup(React.createElement(ChoreDayModal, {
    ...args, chore: { id: "c2", title: "Hoover", done: {}, cadence: { type: "weekly", days: [1] } },
  }));
  assert.doesNotMatch(weekly, /restart the schedule/,
    "a weekly chore has no anchor to move, so the control would do nothing");
  assert.match(weekly, /Every Mon/);
});

test("the day sheet can move one occurrence, and says how often it really comes round", needs, async () => {
  // Ryan: "there should be a 'reschedule this occurrence' of a chore if we want
  // or need to push it to another day that week" and "we want to see the amount
  // of time between when different chores have been completed".
  const { ChoreDayModal } = await load("src/App.jsx", ["ChoreDayModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const feeder = {
    id: "cat", title: "Fill the cat feeder",
    cadence: { type: "interval", everyN: 4, start: "2026-08-01" },
    done: {
      "2026-08-01": { by: "p1", at: 1, byType: "user" },
      "2026-08-04": { by: "p1", at: 1, byType: "user" },
      "2026-08-06": { by: "p1", at: 1, byType: "user" },
      "2026-08-09": { by: "p1", at: 1, byType: "user" },
      "2026-08-11": { by: "p1", at: 1, byType: "user" },
    },
  };
  const args = {
    chore: feeder, dateKey: "2026-09-01",
    people: [{ id: "p1", name: "Steven", color: "#111" }],
    personById: (id) => (id === "p1" ? { id, name: "Steven", color: "#111" } : null),
    update: () => {}, close: () => {}, openChore: () => {},
  };

  const html = renderToStaticMarkup(React.createElement(ChoreDayModal, args));

  assert.match(html, /Move this one/, "an outstanding occurrence can be pushed");
  assert.match(html, /the schedule itself does not change/,
    "and it is clear that this is one occurrence, not the cadence");

  assert.match(html, /How often, in practice/);
  assert.match(html, /usually every 2.5 days/, "the cat feeder question, answered");
  assert.match(html, /Set to every 4 days/, "and the schedule is checked against it");
});

test("a finished occurrence cannot be moved", needs, async () => {
  // Moving something already done would be rewriting history, not planning.
  const { ChoreDayModal } = await load("src/App.jsx", ["ChoreDayModal"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const html = renderToStaticMarkup(React.createElement(ChoreDayModal, {
    chore: { id: "c1", title: "Bins", cadence: { type: "weekly", days: [2] },
             done: { "2026-09-01": { by: "p1", at: 1, byType: "user" } } },
    dateKey: "2026-09-01",
    people: [{ id: "p1", name: "Steven", color: "#111" }],
    personById: (id) => (id === "p1" ? { id, name: "Steven", color: "#111" } : null),
    update: () => {}, close: () => {}, openChore: () => {},
  }));
  assert.doesNotMatch(html, /Move this one/);
});

test("Today shows what was finished, and a display can correct who did it", needs, async () => {
  /* Ryan: "any todo or chore on the today screen, overdue or not, needs to be
     reflected on that day and also you need to be able to say who did it (if
     it's not the person who was assigned) while on display mode."
     
     Both halves in one test, because they are one screen: an overdue chore is
     completed under TODAY (not under the day it was owed), so if `choreState`
     drops it for not being due today, there is nothing for the picker to be
     attached to and the second half cannot be tested at all. */
  const { TodayView } = await load("src/App.jsx", ["TodayView"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const TODAY = "2026-09-02";                 // a Wednesday
  const people = [
    { id: "p1", name: "Ryan", color: "#2f6f4f" },
    { id: "p2", name: "Alex", color: "#8a4326" },
  ];
  const onDisplay = { by: "p1", byType: "display", source: "Kitchen wall", locked: false, presumed: true, at: 1 };

  const data = {
    people, events: [], projects: [], grocery: [], notes: [], dates: [],
    meals: {}, lists: [], timers: [], secondBlock: {}, status: {}, agenda: [],
    chores: [{
      id: "c1", title: "Take the bins out", personId: "p1", createdOn: "2026-08-01",
      cadence: { type: "weekly", days: [1] },  // Mondays — overdue, and not due today
      done: { [TODAY]: onDisplay },
    }],
    tasks: [{
      id: "t1", title: "Post the form", date: "2026-08-28", done: true, doneAt: TODAY,
      personId: "p2", doneBy: { ...onDisplay, by: "p2" },
    }],
  };

  const html = renderToStaticMarkup(React.createElement(TodayView, {
    data, allEvents: [], now: new Date(2026, 8, 2, 10, 0),
    personById: (id) => people.find((p) => p.id === id) || null,
    todayKey: TODAY, viewKey: TODAY, viewOffset: 0, setViewOffset: () => {},
    filter: "all", inFilter: () => true, colorFor: () => "#999", update: () => {},
    taskDueToday: (t) => !t.done && t.date && t.date <= TODAY,
    openMeal: () => {}, openEvent: () => {}, viewEvent: () => {}, openNote: () => {},
    gotoBoard: () => {}, openProject: () => {}, openTask: () => {},
    openChore: () => {}, openChoreDay: () => {},
  }));

  // Reflected on the day they were finished, both kinds.
  assert.match(html, /Done · 2/, "both the chore and the task are on the day they were done");
  assert.match(html, /Take the bins out/,
    "an overdue chore completed today must not vanish — it is recorded under today, not under the day it was owed");
  assert.match(html, /Post the form/);

  // And a display can say who really did it.
  assert.match(html, /Ryan/);
  assert.match(html, /Alex/);
  // The picker is a button whose label says what it does. Matching on that
  // rather than on styling, so a restyle does not fail this and a removal does.
  assert.match(html, /Change who did this/,
    "an unlocked completion offers the picker — this is the whole of 'say who did it on a display'");
  assert.equal((html.match(/Change who did this/g) || []).length, 2,
    "on both rows: the overdue chore and the overdue task");
});
