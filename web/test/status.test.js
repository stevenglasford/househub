// status.test.js — the check-in graph tells the truth about a household.
//
// This is a small amount of arithmetic that gets shown to two people as a
// statement about their own relationship. Overstating a trend, drawing a
// confident line across weeks nobody recorded, or letting one tired evening read
// as a decline are all worse failures than the graph simply not existing.

import test from "node:test";
import assert from "node:assert/strict";
import { buildSeries, splitRuns, trend, scoreOf, gapDaysFor, axisTicks } from "../src/lib/status.js";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const END = new Date(2026, 7, 14);
const TODAY = ymd(END);
const PEOPLE = [{ id: "p1", name: "A" }, { id: "p2", name: "B" }];

/** A status map over `days`, optionally silent for a stretch. */
function history({ days = 90, silentFrom = null, silentTo = null } = {}) {
  const status = {};
  for (let i = days - 1; i >= 0; i--) {
    if (silentFrom !== null && i <= silentFrom && i >= silentTo) continue;
    const key = ymd(addDays(END, -i));
    const t = (days - 1 - i) / (days - 1);
    status[key] = {
      p1: { happiness: Math.max(1, Math.round(5 - 3 * t)), connection: 3, intimacy: 3 },
      p2: { happiness: 4, connection: 4, intimacy: 4 },
    };
  }
  return status;
}

/* --------------------------------------------------------------- scoring --- */

test("a single dimension reads straight through", () => {
  assert.equal(scoreOf({ happiness: 4, connection: 2, intimacy: 5 }, "happiness"), 4);
});

test("the average is over whatever was actually recorded", () => {
  assert.equal(scoreOf({ happiness: 4, connection: 2, intimacy: 3 }, "average"), 3);
  // A dimension somebody skipped must not be counted as zero, which would drag
  // the average down and invent a bad evening.
  assert.equal(scoreOf({ happiness: 4, connection: 4 }, "average"), 4);
});

test("nothing recorded reads as nothing, not as a score", () => {
  assert.equal(scoreOf({}, "average"), null);
  assert.equal(scoreOf(null, "happiness"), null);
  assert.equal(scoreOf({ happiness: 0 }, "happiness"), null);
  assert.equal(scoreOf({ happiness: 9 }, "happiness"), null);
});

/* ---------------------------------------------------------------- series --- */

test("builds one series per person from a real history", () => {
  const { series, count } = buildSeries(history(), PEOPLE, { todayKey: TODAY, days: 90 });
  assert.equal(count, 180);
  assert.equal(series.get("p1").length, 90);
  assert.equal(series.get("p2").length, 90);
});

test("days with no check-in are absent, not filled in", () => {
  const { series } = buildSeries(
    history({ silentFrom: 61, silentTo: 40 }), PEOPLE, { todayKey: TODAY, days: 90 });
  const pts = series.get("p1");
  assert.equal(pts.length, 68, "the silent days are simply not there");
  // and nothing was carried forward to paper over them
  const xs = pts.map((p) => p.x);
  assert.ok(!xs.includes(30), "no invented point inside the silence");
});

test("a person who never checked in gets an empty series rather than a crash", () => {
  const { series } = buildSeries(history(), [...PEOPLE, { id: "p3", name: "C" }],
    { todayKey: TODAY, days: 30 });
  assert.deepEqual(series.get("p3"), []);
});

test("an empty history yields nothing to draw", () => {
  const { series, count } = buildSeries({}, PEOPLE, { todayKey: TODAY, days: 30 });
  assert.equal(count, 0);
  assert.deepEqual(series.get("p1"), []);
});

/* ------------------------------------------------------------------ gaps --- */

test("a long silence breaks the line instead of being drawn through", () => {
  // Three weeks with no check-in is the case that matters: a single straight
  // segment across it would assert a mood for evenings nobody recorded.
  const { series } = buildSeries(
    history({ silentFrom: 61, silentTo: 40 }), PEOPLE, { todayKey: TODAY, days: 90 });
  const runs = splitRuns(series.get("p1"), gapDaysFor(90));
  assert.equal(runs.length, 2);
});

test("ordinary daily data stays one continuous line", () => {
  const { series } = buildSeries(history(), PEOPLE, { todayKey: TODAY, days: 90 });
  assert.equal(splitRuns(series.get("p1"), gapDaysFor(90)).length, 1);
});

test("the gap threshold scales with the window", () => {
  assert.equal(gapDaysFor(30), 3);
  assert.equal(gapDaysFor(90), 9);
  assert.equal(gapDaysFor(365), 37);
});

test("splitting nothing is not an error", () => {
  assert.deepEqual(splitRuns([], 5), []);
});

/* ----------------------------------------------------------------- trend --- */

test("a genuine decline is reported as one", () => {
  const { series } = buildSeries(history(), PEOPLE, { todayKey: TODAY, days: 90, dimension: "happiness" });
  const t = trend(series.get("p1"));
  assert.equal(t.direction, "down");
});

test("a flat series is steady, not noise", () => {
  const { series } = buildSeries(history(), PEOPLE, { todayKey: TODAY, days: 90, dimension: "happiness" });
  assert.equal(trend(series.get("p2")).direction, "steady");
});

test("one rough evening is not a verdict", () => {
  // Nineteen good nights and one bad one is not a household in decline, and
  // saying so to two people would be both wrong and unkind.
  const points = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i === 19 ? 1 : 4 }));
  assert.notEqual(trend(points).direction, "down");
});

test("too little data says nothing rather than guessing", () => {
  assert.equal(trend([]).label, "");
  assert.equal(trend([{ x: 0, y: 3 }, { x: 1, y: 5 }, { x: 2, y: 1 }]).label, "");
  assert.equal(trend([{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 5 }, { x: 3, y: 5 }]).direction, "up");
});

test("a rise is reported as a rise", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 1 + (i / 29) * 4 }));
  const t = trend(points);
  assert.equal(t.direction, "up");
  assert.match(t.label, /up \d\.\d/);
});

/* ------------------------------------------------------------ axis dates --- */
// Ryan: "make it so that the 'agenda' has dates associated with the history on
// the bottom of the graph so we can tell what day was what."
//
// The graph reserved a band at the bottom and drew nothing in it, so the shape
// of a fortnight was readable and which fortnight was not.

test("a week is labelled by weekday, every day", () => {
  const ticks = axisTicks("2026-09-01", 7); // a Tuesday
  assert.equal(ticks.length, 7, "a week is short enough to label every day");
  assert.equal(ticks[0].label, "Wed", "seven days back from Tuesday is a Wednesday");
  assert.equal(ticks[ticks.length - 1].label, "today");
});

test("a month is labelled by date, thinned out", () => {
  const ticks = axisTicks("2026-09-01", 30);
  assert.ok(ticks.length <= 8, `expected a readable number of ticks, got ${ticks.length}`);
  assert.match(ticks[0].label, /^\d{1,2} [A-Z][a-z]{2}$/, "e.g. '7 Aug'");
  assert.equal(ticks[ticks.length - 1].label, "today");
});

test("a long window is labelled by month, at the boundaries", () => {
  // An evenly spaced "23 Jul" is a date nobody navigates by. Month starts are.
  const ticks = axisTicks("2026-09-01", 90);
  assert.deepEqual(ticks.map((t) => t.label), ["Jun", "Jul", "Aug", "today"]);
});

test("today is always labelled, and never doubled up", () => {
  for (const days of [7, 14, 30, 60, 90, 180]) {
    const ticks = axisTicks("2026-09-01", days);
    const todays = ticks.filter((t) => t.label === "today");
    assert.equal(todays.length, 1, `${days}-day window should label today exactly once`);
    assert.equal(todays[0].x, days - 1, "and at the right-hand end, where today is");

    const xs = ticks.map((t) => t.x);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, `${days}: ticks must run left to right`);
    assert.equal(new Set(xs).size, xs.length, `${days}: no two ticks share a position`);
  }
});

test("ticks stay inside the plotted window", () => {
  const days = 30;
  for (const t of axisTicks("2026-09-01", days)) {
    assert.ok(t.x >= 0 && t.x <= days - 1, `tick at ${t.x} is outside 0..${days - 1}`);
  }
});

test("a nonsense window produces no labels rather than throwing", () => {
  assert.deepEqual(axisTicks("", 30), []);
  assert.deepEqual(axisTicks("2026-09-01", 0), []);
});
