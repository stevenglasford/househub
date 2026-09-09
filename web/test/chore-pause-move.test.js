// chore-pause-move.test.js — a chore that sleeps for the winter, and one
// occurrence pushed to another day.
//
// Ryan: "instill a pause feature for chores in the case of which it's a
// seasonal one" and "there should be a 'reschedule this occurrence' of a chore
// if we want or need to push it to another day that week."
//
// The property both features live or die on is the same one, and it is not the
// obvious one: `oldestOwed` walks backwards asking `dueOn` for every past day.
// So anything that makes a chore "not due" must make it not *owed* either, or a
// lawn paused for the winter wakes in April with twenty overdue occurrences and
// a red badge, and a bin moved to Wednesday is still late on Tuesday.

import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/lib/cadence.js";

const mower = (over = {}) => ({
  id: "c1", title: "Mow the lawn",
  cadence: { type: "weekly", days: [6] },   // Saturdays
  done: {}, ...over,
});

/* ------------------------------------------------------------- pausing --- */

test("a paused chore is not due, so it accrues nothing", () => {
  const c = C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31" });
  assert.equal(C.dueOn(c, "2026-10-31"), true, "the Saturday before the pause is still a mowing day");
  assert.equal(C.dueOn(c, "2026-11-07"), false, "a Saturday inside the pause");
  assert.equal(C.dueOn(c, "2027-04-03"), true, "and a Saturday after it wakes up again");
});

test("a seasonal pause repeats every year", () => {
  // The point of "seasonal": pausing the mower once should not mean doing it
  // again every autumn forever.
  const c = C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31", annual: true });
  assert.equal(C.isPausedOn(c, "2026-12-05"), true);
  assert.equal(C.isPausedOn(c, "2027-12-04"), true, "the next winter too");
  assert.equal(C.isPausedOn(c, "2029-01-06"), true, "and the one after that");
  assert.equal(C.isPausedOn(c, "2027-06-05"), false, "but not in June");
});

test("a seasonal window that crosses the new year works", () => {
  // Every genuinely seasonal pause does, which is why this is not an edge case.
  const winter = C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31", annual: true });
  assert.equal(C.isPausedOn(winter, "2026-12-25"), true, "December, before the year turns");
  assert.equal(C.isPausedOn(winter, "2027-01-15"), true, "January, after it");

  const summer = C.pauseChore(mower(), { from: "2026-06-01", until: "2026-08-31", annual: true });
  assert.equal(C.isPausedOn(summer, "2027-07-04"), true);
  assert.equal(C.isPausedOn(summer, "2027-12-25"), false, "a window that does not wrap must not wrap");
});

test("an open-ended pause sleeps until somebody resumes it", () => {
  const c = C.pauseChore(mower(), { from: "2026-11-01" });
  assert.equal(C.isPausedOn(c, "2027-08-01"), true, "no end date means no end");
  const woken = C.resumeChore(c);
  assert.equal(woken.pause, undefined, "resuming drops it rather than leaving a spent one behind");
  assert.equal(C.dueOn(woken, "2027-08-07"), true, "Saturdays are mowing days again");
  assert.equal(C.dueOn(woken, "2027-08-01"), false, "and a Sunday is not");
});

test("a pause that has not started yet changes nothing", () => {
  const c = C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31" });
  assert.equal(C.dueOn(c, "2026-10-03"), true, "a Saturday in October is still a Saturday");
});

test("pause reads back in words", () => {
  assert.match(C.pauseLabel(C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31", annual: true })),
    /each year/i);
  assert.match(C.pauseLabel(C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31" })), /until 31 Mar/);
  assert.equal(C.pauseLabel(mower()), "", "a chore that is not paused says nothing");
});

/* ------------------------------------------- moving one occurrence --- */

test("a moved occurrence leaves its day and lands on another", () => {
  const bins = { id: "c2", cadence: { type: "weekly", days: [2] }, done: {} }; // Tuesdays
  const moved = C.moveOccurrence(bins, "2026-09-01", "2026-09-02");

  assert.equal(C.dueOn(moved, "2026-09-01"), false, "not on the Tuesday any more");
  assert.equal(C.dueOn(moved, "2026-09-02"), true, "and it is on the Wednesday");
  assert.equal(C.dueOn(moved, "2026-09-08"), true, "next Tuesday is untouched — one occurrence, not the schedule");
});

test("moving it back clears the move", () => {
  const bins = { id: "c2", cadence: { type: "weekly", days: [2] }, done: {} };
  const there = C.moveOccurrence(bins, "2026-09-01", "2026-09-02");
  const back = C.moveOccurrence(there, "2026-09-01", "2026-09-01");
  assert.equal(back.moved, undefined, "no empty map left behind");
  assert.equal(C.dueOn(back, "2026-09-01"), true);
});

test("a move is remembered in both directions", () => {
  const bins = C.moveOccurrence({ cadence: { type: "weekly", days: [2] } }, "2026-09-01", "2026-09-04");
  assert.equal(C.movedTo(bins, "2026-09-01"), "2026-09-04");
  assert.equal(C.movedFrom(bins, "2026-09-04"), "2026-09-01",
    "so the row on Friday can say which day it belongs to");
});

test("old moves are pruned rather than growing forever", () => {
  let c = { cadence: { type: "weekly", days: [2] } };
  c = C.moveOccurrence(c, "2025-01-07", "2025-01-08");
  c = C.moveOccurrence(c, "2026-09-01", "2026-09-02");
  const pruned = C.pruneMoves(c, "2026-01-01");
  assert.deepEqual(Object.keys(pruned.moved), ["2026-09-01"]);
});

test("a move beats a pause, because somebody asked for it", () => {
  const c = C.moveOccurrence(
    C.pauseChore(mower(), { from: "2026-11-01", until: "2027-03-31" }),
    "2026-11-07", "2026-11-09");
  assert.equal(C.dueOn(c, "2026-11-09"), true,
    "deliberately moving an occurrence into a paused stretch is an instruction, not an accident");
});

/* ------------------------------------------- pausing clears the board --- */
// Ryan: "when i pause one (the hoover) it doesn't take it off of the chores
// list."
//
// It did not, and the reason is the interesting part: pausing stopped the chore
// being DUE, but the occurrences it already OWED were from before the pause
// started, so `oldestOwed` still found them. The chore was "not due" and "three
// days late" at the same moment, and being late is what kept it on screen.
//
// The same walk is what would have surfaced November's missed mowing in April,
// which is precisely the nagging a seasonal pause exists to stop.

import { isPausedOn as paused } from "../src/lib/cadence.js";

/** The owed-chain walk, mirrored from App.jsx's oldestOwed. */
function oldestOwed(chore, dateKey, lookback = 400) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  const key = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  let owed = null;
  for (let i = 1; i <= lookback; i++) {
    const dt = new Date(t); dt.setDate(dt.getDate() - i);
    const k = key(dt);
    if (chore.createdOn && k < chore.createdOn) break;
    if (chore.done?.[k]) break;
    if (paused(chore, k)) break;
    if (C.dueOn(chore, k)) owed = k;
  }
  return owed;
}

test("the owed chain stops at a pause rather than reaching through it", () => {
  // Walking back through a paused stretch is what would surface November's
  // missed mowing in April — precisely the nagging a seasonal pause exists to
  // stop. The walk ends at the pause; anything owed since it ended still counts.
  const mower = {
    id: "c8", title: "Mow the lawn", createdOn: "2026-04-01",
    cadence: { type: "weekly", days: [6] },   // Saturdays
    done: {},
    pause: { from: "2026-11-01", until: "2027-03-31", annual: true, paused: true },
  };

  const owed = oldestOwed(mower, "2027-04-06");
  assert.equal(owed, "2027-04-03",
    "the Saturday since it woke up is genuinely missed, and is the oldest thing owed");
  assert.ok(owed > "2027-03-31", "nothing from before the pause is reached");
});

test("a completion recorded during a pause still counts", () => {
  // Somebody mowed it anyway in a warm February. The record stands.
  const mower = C.pauseChore({
    id: "c8", cadence: { type: "weekly", days: [6] },
    done: { "2027-02-06": { by: "p1", at: 1, byType: "user" } },
  }, { from: "2026-11-01", until: "2027-03-31", annual: true });
  assert.ok(mower.done["2027-02-06"], "the completion is not discarded by the pause");
});
