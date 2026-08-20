// rotation.test.js — whose turn it is, and what does and does not change that.
//
// Ryan reported two things that turn out to be the same mechanism:
//
//   "add skip ... Ensure that if it's a recurring task it does not skip the
//    turn of that person, simply makes it so that they are responsible for it
//    the next time."
//
//   "When it's a recurring task and someone else did that chore for them,
//    ensure that it does not skip the person who was assigned and did not do
//    the to-do/chore."
//
// Underneath both was a worse bug neither of us had named: the lookup for "who
// went last" required the stored mark to be a string. Completions had become
// objects, so it matched nothing, and every rotation returned the first person
// in the list forever. The chore never took turns at all.
//
// The first test below is that bug. It fails against the old code.

import test from "node:test";
import assert from "node:assert/strict";
import { assigneeFor, lastCompletion, rotationOf, isRotating } from "../src/lib/rotation.js";
import { toggleChore, completeOnBehalf, completionOf } from "../src/lib/completion.js";

const ROT = ["p1", "p2", "p3"];
const chore = (done = {}) => ({ id: "c1", title: "Bins out", rotation: ROT, done });

/* ------------------------------------------------- the rotation advances --- */

test("REGRESSION: a modern completion advances the rotation", () => {
  /* The whole defect in one assertion. With the old `typeof v === "string"`
     filter this returns "p1" -- the rotation frozen on the first person -- for
     every chore completed since completions became objects. */
  const c = chore({ "2026-08-19": { by: "p1", byType: "user", at: 1, locked: true } });
  assert.equal(assigneeFor(c, "2026-08-20"), "p2",
    "after p1 does it, p2 is up; anything else means turns are not being taken");
});

test("the rotation keeps going round", () => {
  assert.equal(assigneeFor(chore({}), "2026-08-20"), "p1", "with no history, the first person");
  assert.equal(assigneeFor(chore({ "2026-08-19": { by: "p2" } }), "2026-08-20"), "p3");
  assert.equal(assigneeFor(chore({ "2026-08-19": { by: "p3" } }), "2026-08-20"), "p1", "and wraps");
});

test("legacy marks still advance it", () => {
  // Households that predate the completion record must not have their
  // rotations freeze either.
  assert.equal(assigneeFor(chore({ "2026-08-19": "p1" }), "2026-08-20"), "p2");
  assert.equal(assigneeFor(chore({ "2026-08-19": true }), "2026-08-20"), "p1",
    "a bare true names nobody, so nobody's turn was consumed");
});

test("only the most recent completion decides", () => {
  const c = chore({
    "2026-08-01": { by: "p3" },
    "2026-08-17": { by: "p1" },
    "2026-08-05": { by: "p2" },
  });
  assert.equal(assigneeFor(c, "2026-08-20"), "p2", "p1 went last, so p2 is up");
});

/* --------------------------------------------------------------- skipping --- */

test("a skip does not advance the rotation", () => {
  // Ryan: "it does not skip the turn of that person, simply makes it so that
  // they are responsible for it the next time."
  const c = chore({ "2026-08-19": "skipped" });
  assert.equal(assigneeFor(c, "2026-08-20"), "p1", "p1 skipped, so p1 still owes it");
});

test("a skip after a completion leaves the right person up", () => {
  const c = chore({ "2026-08-18": { by: "p1" }, "2026-08-19": "skipped" });
  assert.equal(assigneeFor(c, "2026-08-20"), "p2",
    "p1 completed, so it moved to p2; p2 then skipped, so it is still p2");
});

test("a missed day does not slide the chore onto somebody else", () => {
  const c = chore({ "2026-08-10": { by: "p1" } });
  for (const day of ["2026-08-11", "2026-08-15", "2026-08-20", "2026-09-01"]) {
    assert.equal(assigneeFor(c, day), "p2", `still p2 on ${day} — nobody has done it since`);
  }
});

/* ------------------------------------------------------ somebody covering --- */

test("covering for someone does not consume their turn", () => {
  // Ryan: "ensure that it does not skip the person who was assigned and did
  // not do the to-do/chore."
  const c = chore({ "2026-08-19": { by: "p2", byType: "onBehalf", onBehalfOf: "p1" } });
  assert.equal(assigneeFor(c, "2026-08-19"), "p1", "the day itself still belonged to p1");
  assert.equal(assigneeFor(c, "2026-08-20"), "p1", "and p1 is up again, not stepped over");
});

test("covering credits the person who actually did the work", () => {
  const c = chore({ "2026-08-19": { by: "p2", byType: "onBehalf", onBehalfOf: "p1" } });
  const done = completionOf(c.done["2026-08-19"]);
  assert.equal(done.by, "p2", "p2 did it and is credited");
  assert.equal(done.onBehalfOf, "p1", "but the turn was p1's");
});

test("completeOnBehalf records whose turn was covered, through the real API", () => {
  /* End to end rather than on a hand-built mark: the value has to survive
     completeOnBehalf writing it and completionOf reading it back. */
  let doc = {
    people: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    chores: [chore({})],
    archiveSettings: { chores: true }, archive: {},
  };
  const actor = { userId: "u2", personId: "p2", isDisplay: false };
  doc = completeOnBehalf(doc, "c1", "2026-08-20", "p2", actor, { assigneeOf: assigneeFor });

  const mark = completionOf(doc.chores[0].done["2026-08-20"]);
  assert.equal(mark.by, "p2");
  assert.equal(mark.onBehalfOf, "p1", "p1 was up, so p1 is who was covered for");
  assert.equal(assigneeFor(doc.chores[0], "2026-08-21"), "p1", "and p1 is still up tomorrow");

  const row = doc.archive.chores.at(-1);
  assert.equal(row.assignedTo, "p1", "the archive records who owed it");
  assert.equal(row.by, "p2", "and who did it");
});

test("doing your own turn is not recorded as covering", () => {
  let doc = {
    people: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    chores: [chore({})], archiveSettings: { chores: true }, archive: {},
  };
  // p1 is up, and p1 is the one being credited.
  doc = completeOnBehalf(doc, "c1", "2026-08-20", "p1",
    { userId: "u1", personId: "p1" }, { assigneeOf: assigneeFor });
  assert.equal(completionOf(doc.chores[0].done["2026-08-20"]).onBehalfOf, null,
    "no turn was covered, so the rotation must advance normally");
  assert.equal(assigneeFor(doc.chores[0], "2026-08-21"), "p2");
});

test("a normal completion through toggleChore advances the rotation", () => {
  let doc = {
    people: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    chores: [chore({})], archiveSettings: { chores: true }, archive: {},
  };
  doc = toggleChore(doc, "c1", "2026-08-20",
    { userId: "u1", personId: "p1", isDisplay: false }, { assigneeOf: assigneeFor });
  assert.equal(assigneeFor(doc.chores[0], "2026-08-21"), "p2");
});

/* -------------------------------------------------------- non-rotating --- */

test("a fixed chore always belongs to its assignee", () => {
  const fixed = { id: "c2", personId: "p3", done: { "2026-08-19": { by: "p1", byType: "onBehalf", onBehalfOf: "p3" } } };
  assert.equal(assigneeFor(fixed, "2026-08-20"), "p3",
    "somebody else doing it once does not reassign the chore");
  assert.equal(isRotating(fixed), false);
});

test("a rotation of one is just a fixed assignee", () => {
  const one = { id: "c3", rotation: ["p2"], done: {} };
  assert.equal(assigneeFor(one, "2026-08-20"), "p2");
  assert.equal(assigneeFor(one, "2026-09-20"), "p2");
  assert.equal(isRotating(one), false);
});

test("rubbish in the rotation list is ignored", () => {
  assert.deepEqual(rotationOf({ rotation: ["p1", null, "", "p2", undefined] }), ["p1", "p2"]);
  assert.deepEqual(rotationOf({}), []);
  assert.deepEqual(rotationOf(null), []);
});

/* ------------------------------------------------------ the lookup itself --- */

test("lastCompletion ignores skips and looks strictly backwards", () => {
  const c = chore({
    "2026-08-18": { by: "p1" },
    "2026-08-19": "skipped",
    "2026-08-20": { by: "p2" },
  });
  const last = lastCompletion(c, "2026-08-20");
  assert.equal(last.date, "2026-08-18", "the skip is not a completion, and the 20th is not before the 20th");
  assert.equal(last.completion.by, "p1");
  assert.equal(lastCompletion(chore({}), "2026-08-20"), null);
});
