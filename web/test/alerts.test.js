// alerts.test.js — reminders fire when they should and stay quiet otherwise.
//
// Worth testing carefully rather than by eye. A reminder that fires on the
// wrong day, or keeps chiming after somebody dealt with it, teaches the
// household to ignore the sound — and then the one that actually matters gets
// ignored too. Every case below is a way that happens.

import test from "node:test";
import assert from "node:assert/strict";
import { dueAlerts, alertOverdueMins, escalationStep, minutesOf } from "../src/lib/alerts.js";

const TODAY = "2026-08-11";
const ALERT = { at: "17:00", everyMins: 10, until: "22:00", style: "banner" };

const doc = (over = {}) => ({
  people: [{ id: "p1", name: "Sam" }, { id: "p2", name: "Alex" }],
  chores: [{ id: "c1", title: "Cat medication", personId: "p1", done: {}, alert: { ...ALERT } }],
  tasks: [],
  alertSnooze: {},
  ...over,
});

// nowMs is pinned so snooze expiry is deterministic rather than clock-dependent
const at = (mins, over = {}, opts = {}) =>
  dueAlerts(doc(over), TODAY, mins, { nowMs: 1000, ...opts });

test("stays silent before the reminder time", () => {
  assert.equal(at(16 * 60 + 59).length, 0);
});

test("fires at the appointed minute", () => {
  const [a] = at(17 * 60);
  assert.equal(a.title, "Cat medication");
  assert.equal(a.overdue, 0);
  assert.equal(a.person.name, "Sam", "carries whoever owes it, for the banner");
});

test("reports how late it is", () => {
  assert.equal(at(18 * 60 + 30)[0].overdue, 90);
});

test("stops at the cutoff", () => {
  // Not a detail: a reminder that chimes all night gets the tablet muted, and
  // then none of them work.
  assert.equal(at(22 * 60).length, 1, "still sounding at the cutoff minute");
  assert.equal(at(22 * 60 + 1).length, 0, "silent one minute past it");
});

test("goes quiet once the chore is ticked off", () => {
  const done = { ...doc().chores[0], done: { [TODAY]: { by: "p1", byType: "user" } } };
  assert.equal(at(18 * 60, { chores: [done] }).length, 0);
});

test("does not fire on a day the chore is not scheduled", () => {
  // A weekly bin chore reminding on a Tuesday is the fastest way to train
  // somebody to ignore the sound entirely.
  assert.equal(at(18 * 60, {}, { dueOn: () => false }).length, 0);
});

/* ------------------------------------------------------------- snoozes --- */

test("snoozes are keyed per item and do not leak across kinds", () => {
  const both = {
    tasks: [{ id: "t9", title: "Post the parcel", done: false, date: TODAY, alert: { ...ALERT, at: "16:00" } }],
  };
  const keys = at(18 * 60, both).map((a) => a.key).sort();
  assert.deepEqual(keys, ["cc1", "tt9"]);

  const choreSnoozed = at(18 * 60, { ...both, alertSnooze: { cc1: 9e12 } });
  assert.deepEqual(choreSnoozed.map((a) => a.key), ["tt9"],
    "silencing the chore must not silence the task");
});

test("a snooze expires and the reminder comes back", () => {
  assert.equal(at(18 * 60, { alertSnooze: { cc1: 9e12 } }).length, 0);
  assert.equal(at(18 * 60, { alertSnooze: { cc1: 500 } }).length, 1);
});

/* -------------------------------------------------------------- tasks --- */

test("a task dated tomorrow stays quiet today", () => {
  const t = { id: "t1", title: "Post the parcel", done: false, date: "2026-08-12", alert: { ...ALERT } };
  assert.equal(at(18 * 60, { chores: [], tasks: [t] }).length, 0);
});

test("a completed task stays quiet", () => {
  const t = { id: "t1", title: "Post the parcel", done: true, date: TODAY, alert: { ...ALERT } };
  assert.equal(at(18 * 60, { chores: [], tasks: [t] }).length, 0);
});

/* ----------------------------------------------------------- ordering --- */

test("the latest item leads, since the banner only shows one", () => {
  const chores = [
    { id: "a", title: "early", done: {}, alert: { ...ALERT, at: "09:00" } },
    { id: "b", title: "later", done: {}, alert: { ...ALERT, at: "17:00" } },
  ];
  assert.deepEqual(at(18 * 60, { chores }).map((a) => a.title), ["early", "later"]);
});

/* -------------------------------------------------- malformed input --- */

test("nonsense times never fire rather than firing constantly", () => {
  for (const bad of ["nonsense", "25:00", "12:99", "", null, undefined, "7pm"]) {
    assert.equal(alertOverdueMins({ alert: { at: bad } }, 12 * 60, false), null, `at=${bad}`);
  }
});

test("minutesOf accepts real times and rejects the rest", () => {
  assert.equal(minutesOf("00:00"), 0);
  assert.equal(minutesOf("9:05"), 545);
  assert.equal(minutesOf("23:59"), 1439);
  assert.equal(minutesOf("24:00"), null);
});

/* ---------------------------------------------------------- escalation --- */

test("escalation steps advance once per interval", () => {
  // The chime fires on a change of step, so this is what stops a one-minute
  // render tick from becoming a one-minute alarm.
  assert.deepEqual([0, 1, 9, 10, 11, 25].map((m) => escalationStep({ everyMins: 10 }, m)),
    [0, 0, 0, 1, 1, 2]);
});

test("a missing or zero interval falls back to the default rather than chiming every minute", () => {
  // everyMins: 0 is falsy, so it takes the 10-minute default. That is the right
  // reading of a nonsense value: an interval of zero would otherwise escalate
  // once a minute, which is an alarm, not a reminder.
  assert.equal(escalationStep({}, 30), 3);
  assert.equal(escalationStep({ everyMins: 0 }, 30), 3);
  assert.equal(escalationStep(null, 30), 3);
});
