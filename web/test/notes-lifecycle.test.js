// notes-lifecycle.test.js — sticky notes that come down, and are remembered.
//
// Ryan: "Set end date on a sticky note. Keep a history of them that tracks the
// dates that they were displayed for on top of the other things the notes
// already contain."
//
// The detail worth pinning is the inclusivity of the end date. A note set to
// end on the 14th is up all of the 14th and gone on the 15th — the other
// reading is defensible in the abstract and wrong about what anybody means when
// they write a date on a note.

import test from "node:test";
import assert from "node:assert/strict";
import * as N from "../src/lib/notes.js";

const note = (over = {}) => ({ id: "n1", text: "Vet Thursday", color: "#FBEFA6", ...over });

test("a note is up on its last day and gone the next", () => {
  const n = note({ from: "2026-08-10", until: "2026-08-14" });
  assert.equal(N.isUp(n, "2026-08-13"), true);
  assert.equal(N.isUp(n, "2026-08-14"), true, "the end date is inclusive");
  assert.equal(N.isUp(n, "2026-08-15"), false);
});

test("a note is not up before it starts", () => {
  assert.equal(N.isUp(note({ from: "2026-08-20" }), "2026-08-19"), false);
  assert.equal(N.isUp(note({ from: "2026-08-20" }), "2026-08-20"), true);
});

test("existing notes are unaffected", () => {
  /* Every note already on the board has neither `from` nor `until`. They must
     keep behaving exactly as they do now, or this feature silently clears
     somebody's fridge. */
  assert.equal(N.isUp(note({ at: Date.parse("2020-01-01") }), "2026-08-21"), true);
  assert.equal(N.isUp(note(), "2026-08-21"), true, "not even a timestamp");
  assert.equal(N.hasExpired(note(), "2026-08-21"), false);
  assert.equal(N.daysLeft(note(), "2026-08-21"), null);
});

test("the start falls back to when the note was written", () => {
  const at = new Date(2026, 7, 10, 14, 30).getTime();
  assert.equal(N.startedOn(note({ at })), "2026-08-10");
  assert.equal(N.startedOn(note({ at, from: "2026-08-12" })), "2026-08-12", "an explicit start wins");
  assert.equal(N.startedOn(note()), "");
});

test("days left counts down and goes negative once it is past", () => {
  const n = note({ until: "2026-08-21" });
  assert.equal(N.daysLeft(n, "2026-08-19"), 2);
  assert.equal(N.daysLeft(n, "2026-08-21"), 0, "the last day is zero, not one");
  assert.equal(N.daysLeft(n, "2026-08-23"), -2);
});

test("the board is split into what is up and what came down", () => {
  const up = note({ id: "a", from: "2026-08-01" });
  const down = note({ id: "b", from: "2026-07-01", until: "2026-07-10" });
  const future = note({ id: "c", from: "2026-09-01" });

  const r = N.partitionNotes([up, down, future, null], "2026-08-21");
  assert.deepEqual(r.up.map((n) => n.id), ["a"]);
  assert.deepEqual(r.down.map((n) => n.id).sort(), ["b", "c"],
    "a note not yet started is also not on the board");
});

test("history is newest first", () => {
  const older = note({ id: "old", from: "2026-01-01", until: "2026-01-05" });
  const newer = note({ id: "new", from: "2026-06-01", until: "2026-06-05" });
  const { down } = N.partitionNotes([older, newer], "2026-08-21");
  assert.deepEqual(down.map((n) => n.id), ["new", "old"]);
});

test("the span counts both end days", () => {
  // 10th to 14th inclusive is five days, not four.
  const s = N.displayedSpan(note({ from: "2026-08-10", until: "2026-08-14" }), "2026-08-21");
  assert.equal(s.days, 5);
  assert.equal(s.open, false);
  assert.equal(s.from, "2026-08-10");
  assert.equal(s.to, "2026-08-14");
});

test("a note still up reports an open span, not one ending today", () => {
  const s = N.displayedSpan(note({ from: "2026-08-19" }), "2026-08-21");
  assert.equal(s.open, true, "it has not ended, so it must not claim to have");
  assert.equal(s.days, 3, "up for three days so far");
  assert.equal(s.to, "");
});

test("a note whose end date is still ahead is open", () => {
  const s = N.displayedSpan(note({ from: "2026-08-19", until: "2026-08-30" }), "2026-08-21");
  assert.equal(s.open, true);
});

test("a one-day note reads as one day, not zero", () => {
  const s = N.displayedSpan(note({ from: "2026-08-21", until: "2026-08-21" }), "2026-08-21");
  assert.equal(s.days, 1);
});

test("span labels read like a person wrote them", () => {
  assert.equal(N.spanLabel(1), "1 day");
  assert.equal(N.spanLabel(5), "5 days");
  assert.equal(N.spanLabel(21), "3 weeks");
  assert.equal(N.spanLabel(90), "3 months");
  assert.equal(N.spanLabel(null), "");
});

test("the suggested end date is a fortnight out", () => {
  assert.equal(N.suggestedUntil("2026-08-21"), "2026-09-04");
  assert.equal(N.suggestedUntil("2026-12-28"), "2027-01-11", "and crosses a year end");
});
