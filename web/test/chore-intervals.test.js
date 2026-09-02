// chore-intervals.test.js — how often a chore actually comes round.
//
// Ryan: "we want to see the amount of time between when different chores have
// been completed. something like the filling the cat feeder and are trying to
// figure out on average how many days in between when it needs to get refilled."
//
// This is a different question from the schedule, and the more useful one. The
// schedule says what the household intended; this says what the house needs.

import test from "node:test";
import assert from "node:assert/strict";
import * as I from "../src/lib/chore-intervals.js";

const feeder = (days, cadence = { type: "interval", everyN: 4 }) => ({
  id: "cat", title: "Fill the cat feeder", cadence,
  done: Object.fromEntries(days.map((d) => [d, { by: "p1", at: 1, byType: "user" }])),
});

test("the gaps between refills come back in days", () => {
  const c = feeder(["2026-08-01", "2026-08-04", "2026-08-06", "2026-08-09"]);
  assert.deepEqual(I.gaps(c), [3, 2, 3]);
});

test("it answers the actual question: how many days between", () => {
  const st = I.intervalStats(feeder(["2026-08-01", "2026-08-04", "2026-08-06", "2026-08-09"]), "2026-08-11");
  assert.equal(st.count, 4);
  assert.equal(st.typicalDays, 3);
  assert.equal(st.shortestDays, 2);
  assert.equal(st.longestDays, 3);
  assert.equal(st.last, "2026-08-09");
  assert.equal(st.daysSince, 2, "and how long it has been since the last one");
});

test("a fortnight away does not wreck the answer", () => {
  // Exactly the shape household data has, and the reason the headline number is
  // the median. The mean here is dragged past 4 by a single holiday.
  const c = feeder(["2026-08-01", "2026-08-04", "2026-08-07", "2026-08-10", "2026-08-24"]);
  const st = I.intervalStats(c);
  assert.equal(st.typicalDays, 3, "typically every three days, which is true");
  assert.ok(st.averageDays > 5, `the mean is ${st.averageDays}, which is not`);
});

test("skips are not evidence about how often it fills up", () => {
  const c = feeder(["2026-08-01", "2026-08-04"]);
  c.done["2026-08-02"] = "skipped";
  assert.deepEqual(I.completionDates(c), ["2026-08-01", "2026-08-04"]);
  assert.deepEqual(I.gaps(c), [3]);
});

test("one completion is a date, not an interval", () => {
  // Reporting "every 0 days" off a single tick would be worse than saying
  // nothing, because it looks like an answer.
  const st = I.intervalStats(feeder(["2026-08-01"]), "2026-08-05");
  assert.equal(st.count, 1);
  assert.equal(st.typicalDays, null);
  assert.equal(st.samples, 0);
  assert.match(I.describeInterval(st), /One more/);
});

test("a chore never done says so plainly", () => {
  const st = I.intervalStats(feeder([]));
  assert.equal(st.count, 0);
  assert.equal(st.typicalDays, null);
  assert.match(I.describeInterval(st), /nothing to measure/);
});

test("it reads back as a sentence, not a table", () => {
  const st = I.intervalStats(feeder(["2026-08-01", "2026-08-04", "2026-08-06", "2026-08-09"]));
  const said = I.describeInterval(st);
  assert.match(said, /usually every 3 days/);
  assert.match(said, /between 2 and 3/);
  assert.match(said, /4 times/);
});

test("a regular chore does not claim a spread it does not have", () => {
  const st = I.intervalStats(feeder(["2026-08-01", "2026-08-04", "2026-08-07"]));
  assert.doesNotMatch(I.describeInterval(st), /between/, "every gap is 3 — there is no range to report");
});

test("the schedule is checked against reality, and only when that is worth saying", () => {
  // The cat feeder set to every 4 days and actually needing 2.5.
  const drifting = feeder(["2026-08-01", "2026-08-04", "2026-08-06", "2026-08-09", "2026-08-11"]);
  const drift = I.scheduleDrift(drifting, I.intervalStats(drifting));
  assert.ok(drift, "a feeder set to 4 days and filled every 2.5 is worth mentioning");
  assert.equal(drift.planned, 4);
  assert.equal(drift.faster, true);
});

test("it stays quiet when the schedule is about right", () => {
  // An app that reports a discrepancy every time is one nobody reads.
  const fine = feeder(["2026-08-01", "2026-08-05", "2026-08-09", "2026-08-13", "2026-08-17"]);
  assert.equal(I.scheduleDrift(fine, I.intervalStats(fine)), null);
});

test("it will not claim drift from two data points", () => {
  const thin = feeder(["2026-08-01", "2026-08-02"]);
  assert.equal(I.scheduleDrift(thin, I.intervalStats(thin)), null);
});

test("only interval chores get checked against their schedule", () => {
  // "Every N days" is a claim that can be wrong. "Saturdays" is not.
  const weekly = feeder(["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"], { type: "weekly", days: [6] });
  assert.equal(I.scheduleDrift(weekly, I.intervalStats(weekly)), null);
});
