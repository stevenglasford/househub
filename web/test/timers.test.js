// timers.test.js — named kitchen timers, shared across screens.
//
// Ryan: "add a timer ... activated by voice and the ability to set multiple
// times that are named and also have an audio alarm go off with each."
//
// The property worth pinning hardest is that no timer state is stored as a
// flag. Every test below drives the clock rather than calling a tick function,
// because that is exactly what a wall tablet that was asleep for an hour does:
// it wakes up, asks what time it is, and must reach the same answer as the
// phone that watched the whole countdown.

import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/lib/timers.js";

const T0 = 1_700_000_000_000; // a fixed "now" so nothing depends on the real clock
const mins = (n) => n * 60 * 1000;

test("a new timer runs, and knows its own name and duration", () => {
  const t = T.newTimer({ label: "Pasta", durationMs: mins(10), now: T0 });
  assert.equal(t.label, "Pasta");
  assert.equal(t.durationMs, mins(10));
  assert.equal(t.endsAt, T0 + mins(10));
  assert.equal(T.timerState(t, T0), "running");
  assert.equal(T.remainingMs(t, T0), mins(10));
});

test("several timers run at once, each with its own name", () => {
  const data = { timers: [
    T.newTimer({ label: "Pasta", durationMs: mins(10), now: T0, id: "a" }),
    T.newTimer({ label: "Garlic bread", durationMs: mins(4), now: T0, id: "b" }),
  ] };
  const active = T.activeTimers(data, T0 + mins(1));
  assert.deepEqual(active.map((t) => t.label), ["Garlic bread", "Pasta"],
    "soonest first, so the wall display leads with what needs attention next");
});

test("a screen that was asleep computes the same state as one that watched", () => {
  // No tick, no decrement: the timer is a pair of timestamps, so a device that
  // missed the entire countdown still gets the right answer on waking.
  const t = T.newTimer({ label: "Eggs", durationMs: mins(6), now: T0 });
  assert.equal(T.timerState(t, T0 + mins(3)), "running");
  assert.equal(T.timerState(t, T0 + mins(6) + 1), "ringing");
  assert.equal(T.remainingMs(t, T0 + mins(99)), 0, "never counts past zero");
});

test("silencing writes to the timer, so every other screen stops too", () => {
  // The same property reminder snoozes have. A silence held per-device would
  // leave the kitchen tablet sounding after somebody killed it on their phone.
  const t = T.newTimer({ label: "Eggs", durationMs: mins(6), now: T0 });
  const ringing = T.timerState(t, T0 + mins(7));
  assert.equal(ringing, "ringing");

  const silenced = T.silenceTimer(t, T0 + mins(7));
  assert.equal(T.timerState(silenced, T0 + mins(7)), "done");
  assert.equal(T.timerState(silenced, T0 + mins(30)), "done", "and stays done");
  assert.ok(silenced.silencedAt, "the silence is recorded in the document, not in a browser");
});

test("a silenced timer stays in the list so it can be run again", () => {
  const t = T.silenceTimer(T.newTimer({ label: "Eggs", durationMs: mins(6), now: T0 }), T0 + mins(7));
  const again = T.restartTimer(t, T0 + mins(8));
  assert.equal(T.timerState(again, T0 + mins(8)), "running");
  assert.equal(T.remainingMs(again, T0 + mins(8)), mins(6), "restarts at its original duration");
  assert.equal(again.silencedAt, 0, "and the old silence does not carry over");
});

test("pause freezes the countdown; resume moves the end, not the clock", () => {
  const t = T.newTimer({ label: "Rice", durationMs: mins(20), now: T0 });
  const paused = T.pauseTimer(t, T0 + mins(5));
  assert.equal(T.timerState(paused, T0 + mins(5)), "paused");
  assert.equal(T.remainingMs(paused, T0 + mins(5)), mins(15));
  assert.equal(T.remainingMs(paused, T0 + mins(45)), mins(15),
    "still 15 minutes left half an hour later — that is what paused means");

  const resumed = T.resumeTimer(paused, T0 + mins(45));
  assert.equal(T.remainingMs(resumed, T0 + mins(45)), mins(15));
  assert.equal(T.timerState(resumed, T0 + mins(59)), "running");
  assert.equal(T.timerState(resumed, T0 + mins(61)), "ringing");
});

test("adding time to a ringing timer clears the silence", () => {
  // The failure this guards: extend a timer that already rang, and it runs to
  // zero with `silencedAt` still set — finishing in total silence, which is the
  // one thing a timer must never do.
  const t = T.newTimer({ label: "Roast", durationMs: mins(30), now: T0 });
  const rung = T.silenceTimer(t, T0 + mins(31));
  const extended = T.addTime(rung, mins(5), T0 + mins(31));

  assert.equal(extended.silencedAt, 0);
  assert.equal(T.timerState(extended, T0 + mins(33)), "running");
  assert.equal(T.timerState(extended, T0 + mins(37)), "ringing", "and it does ring again");
});

test("adding time to a running timer extends what is left", () => {
  const t = T.newTimer({ label: "Roast", durationMs: mins(30), now: T0 });
  const extended = T.addTime(t, mins(10), T0 + mins(10));
  assert.equal(T.remainingMs(extended, T0 + mins(10)), mins(30), "20 left plus 10");
});

test("ringing timers come back oldest first", () => {
  const data = { timers: [
    T.newTimer({ label: "Late", durationMs: mins(2), now: T0, id: "a" }),
    T.newTimer({ label: "Later", durationMs: mins(5), now: T0, id: "b" }),
    T.newTimer({ label: "Still going", durationMs: mins(50), now: T0, id: "c" }),
  ] };
  const ringing = T.ringingTimers(data, T0 + mins(10));
  assert.deepEqual(ringing.map((t) => t.label), ["Late", "Later"],
    "the one that has been shouting longest is answered first");
});

test("a timer with no name still displays as something", () => {
  assert.equal(T.timerName(T.newTimer({ durationMs: mins(3), now: T0 })), "Timer");
  assert.equal(T.timerName({ label: "  " }), "Timer");
});

test("durations are clamped rather than trusted", () => {
  assert.equal(T.clampDuration(-5), T.DEFAULT_MS, "a negative duration is a mistake, not a timer");
  assert.equal(T.clampDuration(0), T.DEFAULT_MS);
  assert.equal(T.clampDuration("nonsense"), T.DEFAULT_MS);
  assert.equal(T.clampDuration(mins(60 * 48)), T.MAX_MS, "past a day it is an event, not a timer");
});

test("countdowns print the way a clock does", () => {
  assert.equal(T.formatDuration(mins(9) + 5000), "9:05");
  assert.equal(T.formatDuration(7000), "0:07");
  assert.equal(T.formatDuration(mins(62) + 3000), "1:02:03", "hours appear only when there are hours");
  assert.equal(T.formatDuration(-1), "0:00", "never negative on screen");
});

test("durations read back in words, for confirming what was heard", () => {
  assert.equal(T.spokenDuration(mins(10)), "10 minutes");
  assert.equal(T.spokenDuration(mins(1)), "1 minute", "singular, not '1 minutes'");
  assert.equal(T.spokenDuration(mins(90)), "1 hour 30 minutes");
  assert.equal(T.spokenDuration(45000), "45 seconds");
});
