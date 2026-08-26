// feed-events.test.js — subscribed events belonging to the right person.
//
// Ryan: "The calendar, on today and the tab, are not corresponding to the
// correct person from the settings. On the calendar item, once you open it,
// there should be the start and end time, location, and any other details
// available, along with saying what calendar it belongs to."
//
// Both halves came from the same gap. The server holds the subscription URL and
// cannot read the encrypted document, so it returns events tagged only with a
// `feedId`; the name, colour and person live in the document. Nothing joined
// the two, so every subscribed event arrived with no person and no colour, the
// colour lookup fell through to grey, and the detail sheet said "From undefined".

import test from "node:test";
import assert from "node:assert/strict";
import { decorateFeedEvents, sortEvents, whenLabel } from "../src/lib/feed-events.js";

const calendars = [
  { id: "f1", name: "Ryan's Calendar", color: "#5D6FE0", personId: "p2" },
  { id: "f2", name: "Shared", color: "#2E9187", personId: "" },
];
const raw = [
  { id: "ics:a", feedId: "f1", title: "Dinner", date: "2026-09-04", time: "19:00", endTime: "21:00", calName: "Provider name" },
  { id: "ics:b", feedId: "f2", title: "Bins", date: "2026-09-04", allDay: true },
  { id: "ics:c", feedId: "gone", title: "Orphan", date: "2026-09-04" },
];

test("REGRESSION: an event takes the person its calendar is assigned to", () => {
  // Without the join every one of these has personId "" and draws grey,
  // whatever the household chose in settings.
  const [dinner] = decorateFeedEvents(raw, calendars);
  assert.equal(dinner.personId, "p2");
  assert.equal(dinner.color, "#5D6FE0");
});

test("the calendar's household name wins over the provider's", () => {
  // If somebody renamed it, that is the name they expect to see.
  const [dinner] = decorateFeedEvents(raw, calendars);
  assert.equal(dinner.calName, "Ryan's Calendar");
});

test("a calendar the household never renamed keeps the provider's name", () => {
  const [dinner] = decorateFeedEvents(raw, [{ id: "f1", personId: "p2" }]);
  assert.equal(dinner.calName, "Provider name", "better than going blank");
});

test("a calendar assigned to nobody stays assigned to nobody", () => {
  const bins = decorateFeedEvents(raw, calendars)[1];
  assert.equal(bins.personId, "", "shared calendars belong to the household");
  assert.equal(bins.color, "#2E9187", "but still carry their colour");
});

test("an event from a calendar that no longer exists still renders", () => {
  /* A feed deleted on another device leaves its events in flight. They must not
     throw, and must not silently borrow another calendar's identity. */
  const orphan = decorateFeedEvents(raw, calendars)[2];
  assert.equal(orphan.personId, "");
  assert.equal(orphan.calName, "Calendar");
  assert.equal(orphan.source, "ics");
});

test("subscribed events are marked read-only", () => {
  // Their authority is the calendar they came from. Routing on this is what
  // stops the app opening them in an editor that cannot save anywhere.
  for (const e of decorateFeedEvents(raw, calendars)) assert.equal(e.readOnly, true);
});

test("decorating copes with nothing at all", () => {
  assert.deepEqual(decorateFeedEvents(null, null), []);
  assert.deepEqual(decorateFeedEvents([], undefined), []);
  assert.equal(decorateFeedEvents(raw, []).length, 3);
  assert.equal(decorateFeedEvents(raw, [null, { name: "no id" }]).length, 3);
});

/* ------------------------------------------------------------- ordering --- */

test("all-day events come first, then by time, then by title", () => {
  const evs = [
    { id: "1", title: "Late", time: "21:00" },
    { id: "2", title: "Zebra", allDay: true },
    { id: "3", title: "Early", time: "08:00" },
    { id: "4", title: "Apple", allDay: true },
  ];
  assert.deepEqual(sortEvents(evs).map((e) => e.id), ["4", "2", "3", "1"]);
});

test("ordering is stable regardless of which feed answered first", () => {
  const a = [{ id: "1", title: "A", time: "09:00" }, { id: "2", title: "B", time: "09:00" }];
  assert.deepEqual(sortEvents(a).map((e) => e.id), sortEvents([...a].reverse()).map((e) => e.id));
});

/* --------------------------------------------------------------- when --- */

const fmt = (t) => t;

test("an event says when it starts AND finishes", () => {
  // Start-only is what it did before, and an evening is planned around the end.
  assert.equal(whenLabel({ time: "19:00", endTime: "21:00" }, fmt), "19:00 – 21:00");
  assert.equal(whenLabel({ time: "19:00" }, fmt), "19:00");
  assert.equal(whenLabel({ allDay: true }, fmt), "All day");
  assert.equal(whenLabel({}, fmt), "All day");
});

test("a multi-day event says which day of it this is", () => {
  assert.equal(whenLabel({ time: "09:00", spanDays: 3, spanIndex: 1 }, fmt), "09:00 start · day 2 of 3");
  assert.equal(whenLabel({ spanDays: 3, spanIndex: 2 }, fmt), "day 3 of 3");
});
