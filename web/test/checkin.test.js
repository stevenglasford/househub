// checkin.test.js — what leaves the browser when a question is generated.
//
// This is the one place in the client where anything decrypted is sent to the
// server, so the assertions below are about *absence*: household content must
// not appear in the context object at the default privacy level.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, PRIVACY_LEVELS } from "../src/lib/checkin.js";

const doc = () => ({
  people: [{ id: "1", name: "Steven" }, { id: "2", name: "Ryan" }],
  tasks: [
    { id: "t1", title: "Call the clinic", date: "2026-08-01", done: false },
    { id: "t2", title: "Renew prescription", date: "2026-08-02", done: false },
    { id: "t3", title: "Already done", date: "2026-08-01", done: true },
  ],
  agenda: [{ id: "a1", text: "whether to move to Portland", resolved: false }],
  projects: [{ id: "p1", title: "Restain the deck", dates: ["2026-08-01"], percent: 40 }],
  events: [], meals: {}, notes: [{ id: "n1", text: "a private note" }],
  status: { "2026-08-04": { 1: { happiness: 5 }, 2: { happiness: 4 } } },
  checkin: {},
});

// Every string in the document that must never be transmitted.
const SECRETS = [
  "Steven", "Ryan", "Call the clinic", "Renew prescription",
  "whether to move to Portland", "Restain the deck", "a private note",
];

test("the default privacy level sends counts, never content", () => {
  const ctx = buildContext(doc(), "2026-08-05");
  const wire = JSON.stringify(ctx);
  for (const secret of SECRETS) {
    assert.ok(!wire.includes(secret), `"${secret}" must not leave the browser: ${wire}`);
  }
  // But the counts that make the question feel observant are there.
  assert.equal(ctx.signals.overdueCount, 2, "the completed task should not count");
  assert.equal(ctx.signals.agendaCount, 1);
  assert.equal(ctx.signals.projectsSlipped, 1);
  assert.equal(ctx.signals.mealsUnplanned, true);
});

test("minimal sends nothing about the household at all", () => {
  const ctx = buildContext(doc(), "2026-08-05", { privacy: "minimal" });
  assert.deepEqual(Object.keys(ctx).sort(), ["householdSize", "tone"]);
  assert.equal(ctx.signals, undefined);
  assert.equal(ctx.mood, undefined);
});

test("mood is banded, never a raw score", () => {
  const ctx = buildContext(doc(), "2026-08-05");
  assert.equal(ctx.mood, "good");
  assert.ok(!JSON.stringify(ctx).includes("happiness"));
});

test("full is opt-in and is the only level that sends titles", () => {
  const ctx = buildContext(doc(), "2026-08-05", { privacy: "full" });
  assert.ok(JSON.stringify(ctx).includes("whether to move to Portland"));
  assert.deepEqual(PRIVACY_LEVELS, ["minimal", "signals", "full"]);
});

test("recent topics are the model's own questions, not household content", () => {
  const d = doc();
  d.checkin.generated = { "2026-08-04": { question: "What made today easier?" } };
  const ctx = buildContext(d, "2026-08-05");
  assert.deepEqual(ctx.recentTopics, ["What made today easier?"]);
});

test("an empty document does not throw", () => {
  // A household on its first evening has none of these fields yet.
  const ctx = buildContext({}, "2026-08-05");
  assert.equal(ctx.householdSize, 2);
  assert.equal(ctx.signals.overdueCount, 0);
});

/* ------------------------------------------------- walkthrough steps --- */
//
// The bug these lock in: the step list was recomputed on every render, with
// each step present only while it was still outstanding. The status step
// therefore vanished the moment everybody had recorded something — so with two
// people, the second person's first slider deleted the step before they had set
// the other two, and they could not finish. Every other step behaved the same
// way, so the list shortened underneath you mid-walkthrough.

import { buildCheckinSteps } from "../src/lib/checkin.js";

test("the status step is offered whenever there is anybody to ask", () => {
  const steps = buildCheckinSteps({ peopleCount: 2 });
  assert.ok(steps.some((s) => s.id === "status"));
});

test("the status step does not depend on who has already recorded", () => {
  // This is the whole fix. Nothing about what people have already done may
  // decide whether they are still offered the chance to record or change it.
  const before = buildCheckinSteps({ peopleCount: 2 });
  const after = buildCheckinSteps({ peopleCount: 2 });
  assert.deepEqual(before.map((s) => s.id), after.map((s) => s.id));
});

test("a household with nobody in it is not asked how they are", () => {
  assert.ok(!buildCheckinSteps({ peopleCount: 0 }).some((s) => s.id === "status"));
});

test("the walkthrough always ends with tomorrow's time", () => {
  for (const opts of [{}, { peopleCount: 2 }, { hasPrompt: true, overdueCount: 3, peopleCount: 1 }]) {
    assert.equal(buildCheckinSteps(opts).at(-1).id, "time");
  }
});

test("steps appear in a stable order", () => {
  const steps = buildCheckinSteps({
    hasPrompt: true, overdueCount: 2, slippedCount: 1, topicsCount: 4,
    tomorrowCount: 3, mealsPlanned: false, peopleCount: 2,
  });
  assert.deepEqual(steps.map((s) => s.id),
    ["prompt", "overdue", "slipped", "topics", "tomorrow", "meals", "status", "time"]);
});

test("empty sections are left out, but the list is never empty", () => {
  const steps = buildCheckinSteps({ mealsPlanned: true, peopleCount: 0 });
  assert.deepEqual(steps.map((s) => s.id), ["time"]);
});

test("counts are carried through for the progress display", () => {
  const steps = buildCheckinSteps({ overdueCount: 5, topicsCount: 2, peopleCount: 1 });
  assert.equal(steps.find((s) => s.id === "overdue").count, 5);
  assert.equal(steps.find((s) => s.id === "topics").count, 2);
});
