// cadence.test.js — when a recurring chore is due, and whose day it is.
//
// Three of Ryan's requests land here:
//
//   "add a 'weekly' option and be able to select the day"
//   "an option to reset a start date ... I take the trash out today, but it says
//    it doesn't need to be done until tomorrow (every 2 days)"
//   "if it's a rotating one, each person can choose a day or cadence"
//
// The first already worked and was reported missing because the button said
// "Certain days"; the tests are here anyway so the behaviour is pinned now that
// it has a name people will look for.
//
// Dates used throughout: 2026-08-17 is a Monday, 2026-08-20 a Thursday.

import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/lib/cadence.js";
import { assigneeFor } from "../src/lib/rotation.js";

const MON = "2026-08-17", TUE = "2026-08-18", THU = "2026-08-20", FRI = "2026-08-21";

/* ------------------------------------------------------------- weekly --- */

test("a weekly chore is due only on its chosen days", () => {
  const c = { cadence: { type: "weekly", days: [1, 4] } };
  assert.equal(C.dueOn(c, MON), true);
  assert.equal(C.dueOn(c, THU), true);
  assert.equal(C.dueOn(c, TUE), false);
  assert.equal(C.dueOn(c, FRI), false);
});

test("a weekly chore with no days chosen is due on none of them", () => {
  // Rather than falling through to "every day", which would be a surprising
  // amount of chore to appear from an empty selection.
  assert.equal(C.dueOn({ cadence: { type: "weekly", days: [] } }, MON), false);
});

test("weekly reads back in words", () => {
  assert.equal(C.describeCadence({ cadence: { type: "weekly", days: [1, 4] } }), "Every Mon, Thu");
  assert.equal(C.describeCadence({ cadence: { type: "weekly", days: [0,1,2,3,4,5,6] } }), "Every day");
  assert.equal(C.describeCadence({ cadence: { type: "daily" } }), "Every day");
  assert.equal(C.describeCadence({ cadence: { type: "interval", everyN: 2 } }), "Every 2 days");
  assert.equal(C.describeCadence({ cadence: { type: "monthly", dayOfMonth: 3 } }), "Monthly, on the 3rd");
});

test("toggling a day keeps the list sorted and reversible", () => {
  let days = [];
  days = C.toggleDay(days, 4);
  days = C.toggleDay(days, 1);
  assert.deepEqual(days, [1, 4]);
  assert.deepEqual(C.toggleDay(days, 1), [4]);
});

/* --------------------------------------------------- resetting the clock --- */

test("REGRESSION: doing it early re-anchors the schedule", () => {
  /* Ryan's exact example. Bins are every two days from the 17th, so the 20th is
     an off day — but he took them out anyway, and the app should stop insisting
     on the 21st. */
  const bins = { id: "c1", cadence: { type: "interval", everyN: 2, start: MON } };
  assert.equal(C.dueOn(bins, THU), false, "the 20th is an off day to begin with");

  const reset = C.resetAnchor(bins, THU);
  assert.equal(reset.cadence.start, THU);
  assert.equal(C.dueOn(reset, THU), true, "the day it was done is now on-schedule");
  assert.equal(C.dueOn(reset, FRI), false, "and tomorrow is not");
  assert.equal(C.dueOn(reset, "2026-08-22"), true, "two days later, it comes round again");
});

test("the reset says when it will next come round", () => {
  const bins = { cadence: { type: "interval", everyN: 3, start: MON } };
  assert.equal(C.nextAfterReset(bins, THU), "2026-08-23");
});

test("only an interval chore has an anchor to move", () => {
  /* Doing the bins on a Wednesday does not make bin day Wednesday. Offering the
     control anyway would be a button that silently does nothing. */
  assert.equal(C.canResetAnchor({ cadence: { type: "interval", everyN: 2 } }), true);
  for (const type of ["daily", "weekly", "monthly", "perPerson"]) {
    assert.equal(C.canResetAnchor({ cadence: { type } }), false, `${type} has no anchor`);
    const c = { cadence: { type, days: [1] } };
    assert.deepEqual(C.resetAnchor(c, THU), c, `${type} is returned untouched`);
  }
  assert.equal(C.nextAfterReset({ cadence: { type: "weekly", days: [1] } }, THU), null);
});

test("re-anchoring does not disturb anything else about the chore", () => {
  const bins = { id: "c1", title: "Bins", rotation: ["p1", "p2"], done: { [MON]: { by: "p1" } },
                 cadence: { type: "interval", everyN: 2, start: MON } };
  const reset = C.resetAnchor(bins, THU);
  assert.equal(reset.title, "Bins");
  assert.deepEqual(reset.rotation, ["p1", "p2"]);
  assert.deepEqual(reset.done, bins.done, "the record of what was done is untouched");
  assert.equal(reset.cadence.everyN, 2);
});

/* ----------------------------------------------------- each their own day --- */

const shared = {
  id: "c2", title: "Bins", rotation: ["p1", "p2"],
  cadence: { type: "perPerson", people: { p1: { days: [1] }, p2: { days: [4] } } },
  done: {},
};

test("a per-person chore is due on any day somebody claimed", () => {
  assert.equal(C.dueOn(shared, MON), true);
  assert.equal(C.dueOn(shared, THU), true);
  assert.equal(C.dueOn(shared, TUE), false, "nobody claimed Tuesday");
});

test("the day decides the person, not the turn order", () => {
  assert.equal(C.scheduledPerson(shared, MON), "p1");
  assert.equal(C.scheduledPerson(shared, THU), "p2");
  assert.equal(C.scheduledPerson(shared, TUE), null);
});

test("REGRESSION: a missed week does not become the other person's problem", () => {
  /* The whole reason this is not a rotation. With a rotation, p1 skipping
     Monday would leave p1 up on Thursday as well — here Thursday is simply
     p2's, whatever happened on Monday. */
  assert.equal(assigneeFor(shared, MON), "p1");
  assert.equal(assigneeFor(shared, THU), "p2");

  const missed = { ...shared, done: {} };
  assert.equal(assigneeFor(missed, "2026-08-24"), "p1", "the next Monday is p1's again");
  assert.equal(assigneeFor(missed, "2026-08-27"), "p2", "and the next Thursday is p2's");
});

test("a completion does not shift a per-person schedule", () => {
  const after = { ...shared, done: { [MON]: { by: "p1", byType: "user" } } };
  assert.equal(assigneeFor(after, THU), "p2", "still p2's Thursday");
  assert.equal(assigneeFor(after, "2026-08-24"), "p1", "still p1's Monday");
});

test("two people can share a day, and the answer is stable", () => {
  // A chore two people do together is real. The rotation order breaks the tie
  // so the answer does not depend on object key order.
  const both = { rotation: ["p2", "p1"],
    cadence: { type: "perPerson", people: { p1: { days: [1] }, p2: { days: [1] } } } };
  assert.equal(C.scheduledPerson(both, MON), "p2", "rotation order decides");
  assert.equal(C.scheduledPerson(both, MON), C.scheduledPerson(both, MON), "and is stable");
});

test("setting somebody's days builds the cadence, and clearing them removes it", () => {
  let c = C.setPersonDays({ id: "c3" }, "p1", [1, 4]);
  assert.equal(c.cadence.type, "perPerson");
  assert.deepEqual(c.cadence.people.p1.days, [1, 4]);

  c = C.setPersonDays(c, "p2", [2]);
  assert.deepEqual(Object.keys(c.cadence.people).sort(), ["p1", "p2"]);

  c = C.setPersonDays(c, "p1", []);
  assert.equal(c.cadence.people.p1, undefined, "no days means not on the schedule at all");
  assert.deepEqual(Object.keys(c.cadence.people), ["p2"]);
});

test("nonsense weekdays are dropped rather than stored", () => {
  const c = C.setPersonDays({}, "p1", [1, 9, -2, 4]);
  assert.deepEqual(c.cadence.people.p1.days, [1, 4]);
});

test("a per-person chore with nobody scheduled is never due", () => {
  const empty = { cadence: { type: "perPerson", people: {} } };
  assert.equal(C.dueOn(empty, MON), false);
  assert.equal(C.scheduledPerson(empty, MON), null);
  assert.equal(C.describeCadence(empty), "Nobody has a day yet");
});

/* ------------------------------------------------- nothing else regressed --- */

test("the older cadence types behave exactly as before", () => {
  assert.equal(C.dueOn({}, MON), true, "no cadence at all means every day");
  assert.equal(C.dueOn({ cadence: { type: "daily" } }, MON), true);

  const monthly = { cadence: { type: "monthly", dayOfMonth: 31 } };
  assert.equal(C.dueOn(monthly, "2026-08-31"), true);
  assert.equal(C.dueOn(monthly, "2026-09-30"), true, "a short month uses its last day");
  assert.equal(C.dueOn(monthly, "2026-09-29"), false);

  const iv = { cadence: { type: "interval", everyN: 2, start: MON } };
  assert.equal(C.dueOn(iv, "2026-08-15"), false, "before the start it is not due");
});
