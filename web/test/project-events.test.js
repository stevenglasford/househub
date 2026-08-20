// project-events.test.js — project work on the calendar, and what leaves the house.
//
// Ryan: "With the projects, when a subtask has a date, add it to the calendar.
// Also make it so that you can choose which synced calendar that it applies to."
//
// The second half is the one with consequences. These events can be written to
// a real iCloud calendar, so the tests below care most about what does NOT get
// sent: a project with no calendar chosen must stay inside HouseHub, and the
// default must be that nothing leaves.

import test from "node:test";
import assert from "node:assert/strict";
import {
  projectEvents, eventsForProject, projectEventsFor, eventsForSync, projectEventId,
} from "../src/lib/project-events.js";

const kitchen = {
  id: "pr1", title: "Kitchen", calendarId: "cal1", personId: "p1",
  stages: [
    { id: "s1", title: "Order tiles", date: "2026-09-01" },
    { id: "s2", title: "Fit them", date: "2026-09-08", done: true },
    { id: "s3", title: "Not scheduled", date: "" },
  ],
};
const garden = { id: "pr2", title: "Garden", dates: ["2026-09-03", "2026-09-03", "2026-09-01"] };

test("a dated stage becomes a calendar event", () => {
  const evs = eventsForProject(kitchen);
  assert.equal(evs.length, 2, "an undated stage contributes nothing");
  assert.deepEqual(evs.map((e) => e.date), ["2026-09-01", "2026-09-08"]);
  assert.equal(evs[0].title, "Kitchen — Order tiles", "the stage is named, not just the project");
  assert.equal(evs[1].done, true, "a finished stage still happened and stays visible");
});

test("a project without stages contributes its own days, deduped and sorted", () => {
  const evs = eventsForProject(garden);
  assert.deepEqual(evs.map((e) => e.date), ["2026-09-01", "2026-09-03"]);
  assert.equal(evs[0].title, "Garden");
});

test("event ids are stable, so the same stage is always the same event", () => {
  // This is what stops a re-sync creating a duplicate on somebody's phone.
  assert.equal(eventsForProject(kitchen)[0].id, projectEventId("pr1", "s1"));
  assert.equal(eventsForProject(kitchen)[0].id, eventsForProject(kitchen)[0].id);
});

test("derived events are read-only", () => {
  // The project is the record of what is planned; the calendar is a view of it.
  for (const e of projectEvents([kitchen, garden])) assert.equal(e.readOnly, true);
});

test("rubbish in the project list does not throw", () => {
  assert.deepEqual(projectEvents([null, undefined, {}, { id: "x" }]), []);
  assert.deepEqual(eventsForProject(null), []);
});

/* ------------------------------------------------- what leaves the house --- */

test("a project with no calendar chosen never leaves HouseHub", () => {
  /* The default, and the important one. A renovation plan must not start
     appearing on a shared calendar because somebody added a stage. */
  assert.deepEqual(projectEventsFor([garden], "cal1"), [], "garden chose no calendar");
  assert.deepEqual(projectEventsFor([kitchen, garden], ""), [], "and no target means nothing at all");
});

test("only the events pointed at a calendar are sent to it", () => {
  const both = projectEventsFor([kitchen, garden], "cal1");
  assert.equal(both.length, 2);
  assert.ok(both.every((e) => e.projectId === "pr1"));
  assert.deepEqual(projectEventsFor([kitchen], "cal2"), [], "a different calendar gets nothing");
});

test("the sync set combines events and project work for one calendar", () => {
  const data = {
    events: [
      { id: "e1", title: "Dinner", date: "2026-09-04", time: "19:00", calendarId: "cal1" },
      { id: "e2", title: "Private", date: "2026-09-05", calendarId: "" },
      { id: "e3", title: "Elsewhere", date: "2026-09-06", calendarId: "cal2" },
    ],
    projects: [kitchen, garden],
  };
  const out = eventsForSync(data, "cal1");
  const ids = out.map((e) => e.id).sort();
  assert.deepEqual(ids, ["e1", projectEventId("pr1", "s1"), projectEventId("pr1", "s2")].sort());

  const dinner = out.find((e) => e.id === "e1");
  assert.equal(dinner.time, "19:00");
  assert.equal(dinner.allDay, false, "a timed event is not all-day");
  assert.equal(out.find((e) => e.id === projectEventId("pr1", "s1")).allDay, true);
});

test("nothing is sent without a calendar, whatever the document holds", () => {
  const data = { events: [{ id: "e1", title: "X", date: "2026-09-04", calendarId: "cal1" }], projects: [kitchen] };
  assert.deepEqual(eventsForSync(data, ""), []);
  assert.deepEqual(eventsForSync(data, null), []);
  assert.deepEqual(eventsForSync(null, "cal1"), []);
});

test("an event with no date is never sent", () => {
  // toVEvent would refuse it server-side; not sending it is the cheaper refusal.
  const data = { events: [{ id: "e1", title: "Someday", date: "", calendarId: "cal1" }], projects: [] };
  assert.deepEqual(eventsForSync(data, "cal1"), []);
});

test("the sync set carries no duplicate ids", () => {
  /* A collision would make one event silently replace the other on the remote
     calendar. Project ids are namespaced so it cannot happen — checked rather
     than assumed. */
  const data = {
    events: [{ id: "dup", title: "A", date: "2026-09-01", calendarId: "cal1" },
             { id: "dup", title: "B", date: "2026-09-02", calendarId: "cal1" }],
    projects: [kitchen],
  };
  const out = eventsForSync(data, "cal1");
  assert.equal(new Set(out.map((e) => e.id)).size, out.length);
});

test("the sync set carries only calendar fields, never household ones", () => {
  // personId is not written to somebody's iCloud calendar, and must not be.
  const data = {
    events: [{ id: "e1", title: "X", date: "2026-09-04", calendarId: "cal1", personId: "p1", secretNote: "x" }],
    projects: [],
  };
  const [only] = eventsForSync(data, "cal1");
  assert.deepEqual(Object.keys(only).sort(),
    ["allDay", "date", "endTime", "id", "location", "notes", "time", "title"]);
});
