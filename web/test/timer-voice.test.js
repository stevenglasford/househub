// timer-voice.test.js — what the kitchen actually says, and what it should mean.
//
// Every phrase below is one somebody would really say to a wall display while
// cooking. They are not variations invented to exercise branches: the point of
// the parser is that the household never has to learn a phrasing, so the test
// for it has to be a list of natural sentences rather than a grammar.
//
// Speech recognition hands text back lowercase and unpunctuated, with numbers
// arriving as digits or words unpredictably, so both spellings appear here.

import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../src/lib/timer-voice.js";

const mins = (n) => n * 60 * 1000;

test("the plain case, in the several orders people use", () => {
  for (const said of [
    "set a timer for 10 minutes for the pasta",
    "set a timer for the pasta for 10 minutes",
    "10 minute timer for the pasta",
    "pasta timer 10 minutes",
    "start a ten minute timer called pasta",
  ]) {
    const got = V.parseTimerCommand(said);
    assert.equal(got.durationMs, mins(10), said);
    assert.equal(got.label.toLowerCase(), "pasta", said);
  }
});

test("number words and digits are the same instruction", () => {
  assert.equal(V.parseDuration("twenty minutes"), mins(20));
  assert.equal(V.parseDuration("20 minutes"), mins(20));
  assert.equal(V.parseDuration("twenty five minutes"), mins(25), "compound number words");
  assert.equal(V.parseDuration("45 seconds"), 45000);
  assert.equal(V.parseDuration("2 hours"), mins(120));
});

test("compound durations are summed, not taken first", () => {
  assert.equal(V.parseDuration("one hour thirty minutes"), mins(90));
  assert.equal(V.parseDuration("1 hour 30 minutes"), mins(90));
  assert.equal(V.parseDuration("an hour and a half"), mins(90),
    "the trailing half means half of the unit already said — dropping it turns a 90 minute instruction into a 60 minute timer");
  assert.equal(V.parseDuration("half an hour"), mins(30));
  assert.equal(V.parseDuration("quarter of an hour"), mins(15));
});

test("a spoken duration misheard as a clock time still works", () => {
  // "five thirty" comes back from the recogniser as "5:30" often enough that
  // reading it as half past five would be a daily annoyance.
  assert.equal(V.parseDuration("5:30"), mins(5) + 30000);
  assert.equal(V.parseDuration("1:02:03"), mins(62) + 3000);
});

test("a timer with no duration is not a timer", () => {
  // Guessing a length here would be worse than declining: somebody says "set a
  // timer", walks away, and a five minute default goes off for nothing.
  assert.equal(V.parseTimerCommand("set a timer"), null);
  assert.equal(V.parseTimerCommand("timer for the pasta"), null);
  assert.equal(V.parseTimerCommand(""), null);
  assert.equal(V.parseTimerCommand("what's the weather"), null);
});

test("the wake phrase and politeness are not part of the name", () => {
  const got = V.parseTimerCommand("hey hub can you please set a timer for 3 minutes for the tea");
  assert.equal(got.durationMs, mins(3));
  assert.equal(got.label.toLowerCase(), "tea");
});

test("the household's own capitalisation survives", () => {
  // The recogniser lowercases; a wall display reading "green tea" when
  // somebody wrote "Green Tea" looks like a bug to everybody but the parser.
  const got = V.parseTimerCommand("set a timer for 3 minutes for the Green Tea");
  assert.equal(got.label, "Green Tea");
});

test("an unnamed timer is allowed and left unnamed", () => {
  const got = V.parseTimerCommand("set a timer for 8 minutes");
  assert.equal(got.durationMs, mins(8));
  assert.equal(got.label, "", "not invented — the UI shows 'Timer' rather than a made-up name");
});

test("stopping is told apart from starting", () => {
  assert.equal(V.parseStopCommand("set a timer for 5 minutes"), null);

  const one = V.parseStopCommand("stop the pasta timer");
  assert.equal(one.all, false);
  assert.equal(one.name, "pasta");

  const all = V.parseStopCommand("cancel all timers");
  assert.equal(all.all, true);

  const bare = V.parseStopCommand("stop");
  assert.equal(bare.all, false);
  assert.equal(bare.name, "", "a bare stop means whatever is making noise, which the caller resolves");
});

test("a spoken name finds its timer loosely", () => {
  const timers = [
    { id: "a", label: "Pasta" },
    { id: "b", label: "Garlic bread" },
  ];
  assert.equal(V.matchTimerByName(timers, "pasta").id, "a", "case does not matter");
  assert.equal(V.matchTimerByName(timers, "garlic").id, "b", "a partial name is enough");
  assert.equal(V.matchTimerByName(timers, "the garlic bread one").id, "b", "and so is a longer one");
  assert.equal(V.matchTimerByName(timers, "rice"), null);
  assert.equal(V.matchTimerByName(timers, ""), null);
});
