// subtasks.test.js — steps on a to-do, and notes about one day of a chore.
//
// The distinction is the point. A task's steps belong to the task and are done
// once. A chore recurs, so a note belongs to a single occurrence: "the lorry
// never came" is about that Tuesday, and attaching it to the chore would turn
// an observation into a standing instruction.

import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/lib/subtasks.js";

/* ------------------------------------------------------------ task steps --- */

test("a task with no steps has none, and no progress", () => {
  const t = { id: "t1", title: "Renew car tabs" };
  assert.deepEqual(S.stepsOf(t), []);
  // Not "0 of 0" — a task without steps should not render a progress badge.
  assert.equal(S.stepProgress(t), null);
});

test("steps are added, ticked, renamed and removed", () => {
  let t = S.addStep(S.addStep({ id: "t1" }, "Find the paperwork"), "Pay the fee");
  assert.equal(S.stepsOf(t).length, 2);
  assert.deepEqual(S.stepProgress(t), { done: 0, total: 2 });

  const first = S.stepsOf(t)[0].id;
  t = S.toggleStep(t, first);
  assert.equal(S.stepProgress(t).done, 1);
  assert.equal(S.stepsOutstanding(t), 1);
  t = S.toggleStep(t, first);
  assert.equal(S.stepProgress(t).done, 0);

  t = S.renameStep(t, first, "Find the £45 paperwork");
  assert.equal(S.stepsOf(t)[0].title, "Find the £45 paperwork");

  t = S.removeStep(t, first);
  assert.equal(S.stepsOf(t).length, 1);
});

test("blank input never creates or destroys a step", () => {
  let t = S.addStep({ id: "t1" }, "   ");
  assert.equal(S.stepsOf(t).length, 0, "a blank step is not added");

  t = S.addStep(t, "Real step");
  const id = S.stepsOf(t)[0].id;
  t = S.renameStep(t, id, "   ");
  assert.equal(S.stepsOf(t)[0].title, "Real step", "a blank rename must not wipe the step");
});

test("every step gets an id, so React keys and toggles are stable", () => {
  let t = { id: "t1" };
  for (const title of ["a", "b", "c"]) t = S.addStep(t, title);
  const ids = S.stepsOf(t).map((s) => s.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(Boolean));
});

test("steps operations do not mutate the task they are given", () => {
  const t = S.addStep({ id: "t1" }, "one");
  const before = JSON.stringify(t);
  S.toggleStep(t, S.stepsOf(t)[0].id);
  S.removeStep(t, S.stepsOf(t)[0].id);
  S.addStep(t, "two");
  assert.equal(JSON.stringify(t), before);
});

/* ----------------------------------------------------- chore day notes --- */

test("a note belongs to the day it was written about", () => {
  let c = S.setChoreNote({ id: "c1", title: "Bins out" }, "2026-08-11", "The lorry never came");
  c = S.setChoreNote(c, "2026-08-18", "Extra garden waste");

  assert.equal(S.choreNoteOn(c, "2026-08-11"), "The lorry never came");
  assert.equal(S.choreNoteOn(c, "2026-08-18"), "Extra garden waste");
  // The crucial one: it must not become a standing note on every occurrence.
  assert.equal(S.choreNoteOn(c, "2026-08-25"), "");
});

test("history is newest first", () => {
  let c = S.setChoreNote({ id: "c1" }, "2026-08-11", "older");
  c = S.setChoreNote(c, "2026-08-18", "newer");
  assert.deepEqual(S.noteHistory(c).map((n) => n.dateKey), ["2026-08-18", "2026-08-11"]);
});

test("clearing a note removes it rather than storing a blank", () => {
  let c = S.setChoreNote({ id: "c1" }, "2026-08-11", "something");
  c = S.setChoreNote(c, "2026-08-18", "another");
  c = S.setChoreNote(c, "2026-08-11", "   ");

  assert.equal(S.choreNoteOn(c, "2026-08-11"), "");
  assert.deepEqual(Object.keys(S.choreNotes(c)), ["2026-08-18"],
    "no empty key left behind for a day somebody opened and thought better of");
});

test("removing the last note drops the field entirely", () => {
  let c = S.setChoreNote({ id: "c1", title: "Bins" }, "2026-08-11", "x");
  c = S.setChoreNote(c, "2026-08-11", "");
  assert.equal("notes" in c, false, "an untouched chore should not carry an empty object");
  assert.equal(c.title, "Bins", "and the rest of the chore is intact");
});

test("a chore with junk in `notes` is read safely", () => {
  // Documents written by other versions, or by hand, must not crash the row.
  assert.deepEqual(S.choreNotes({ notes: null }), {});
  assert.deepEqual(S.choreNotes({ notes: ["a"] }), {});
  assert.deepEqual(S.choreNotes({}), {});
  assert.equal(S.choreNoteOn(undefined, "2026-08-11"), "");
});

/* ------------------------------------------------- chore checklist --- */
//
// Distinct from both the task steps above and the per-day notes: a recurring
// chore's checklist is what the job involves *every* time, so it carries no
// completion state. "Wheelie bin, recycling, garden waste" is not something you
// tick once and leave ticked.

test("a chore checklist holds titles and nothing else", () => {
  let c = S.setChoreChecklist({ id: "c1", title: "Bins" },
    ["Wheelie bin", "  Recycling  ", "", "Garden waste"]);
  assert.deepEqual(S.choreChecklist(c), ["Wheelie bin", "Recycling", "Garden waste"],
    "blanks dropped, whitespace trimmed");
  assert.ok(S.choreChecklist(c).every((x) => typeof x === "string"),
    "no done flags — a recurring chore's checklist is not completable");
});

test("emptying a checklist removes the field", () => {
  let c = S.setChoreChecklist({ id: "c1", title: "Bins" }, ["one"]);
  c = S.setChoreChecklist(c, []);
  assert.equal("checklist" in c, false);
  assert.equal(c.title, "Bins");
});

test("a chore with junk in `checklist` is read safely", () => {
  assert.deepEqual(S.choreChecklist({ checklist: "nope" }), []);
  assert.deepEqual(S.choreChecklist({ checklist: [1, null, "ok", "  "] }), ["ok"]);
  assert.deepEqual(S.choreChecklist(undefined), []);
});

/* ------------------------------------------------------- task note --- */

test("a task note is trimmed, and clearing it removes the field", () => {
  let t = S.setTaskNote({ id: "t1", title: "Renew tabs" }, "  Ring the DVLA first  ");
  assert.equal(S.taskNote(t), "Ring the DVLA first");
  t = S.setTaskNote(t, "   ");
  assert.equal("note" in t, false);
  assert.equal(t.title, "Renew tabs");
});

test("a task note and its steps are independent", () => {
  // Both were asked for; neither may clobber the other.
  let t = S.addStep({ id: "t1", title: "x" }, "Find papers");
  t = S.setTaskNote(t, "Reference 12345");
  assert.equal(S.stepsOf(t).length, 1);
  assert.equal(S.taskNote(t), "Reference 12345");
  t = S.toggleStep(t, S.stepsOf(t)[0].id);
  assert.equal(S.taskNote(t), "Reference 12345", "ticking a step must not drop the note");
});
