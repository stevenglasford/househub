// new-events.test.js — "what's been added since I last looked".
//
// Ryan: "I want to be able to see what are new items that have been added to
// the calendar somehow that can be specific to the calendar and the person
// viewing."
//
// The distinction the tests exist to hold onto is that "recently added" and
// "new to me" are different questions, and only the second one was asked. Two
// people who last looked on different days must see different things.

import test from "node:test";
import assert from "node:assert/strict";
import * as N from "../src/lib/new-events.js";

const HOUR = 3600 * 1000;
const NOW = 1_700_000_000_000;
const ev = (over = {}) => ({ id: "e1", title: "Dentist", addedAt: NOW - HOUR, ...over });

test("new is per reader, not per event", () => {
  const data = { seenCalendar: { ryan: NOW - 2 * HOUR, alex: NOW - 30 * 60 * 1000 } };
  const e = ev({ addedAt: NOW - HOUR });

  assert.equal(N.isNewTo(e, { mark: N.seenAt(data, "ryan") }), true,
    "Ryan last looked before it was added, so it is new to him");
  assert.equal(N.isNewTo(e, { mark: N.seenAt(data, "alex") }), false,
    "Alex looked after it was added, so it is not new to her");
});

test("a reader with no mark is shown nothing as new", () => {
  // Zero would mean "last looked at the dawn of time" and light up the entire
  // calendar for a member who just joined.
  assert.equal(N.seenAt({}, "newbie"), null);
  assert.equal(N.isNewTo(ev(), { mark: null }), false);
});

test("an event that does not say when it was added is never new", () => {
  // Everything written before this feature has no addedAt. Treating those as
  // new would light up the whole calendar on the day it ships, which teaches
  // people to ignore the marker before it has been useful once.
  assert.equal(N.isNewTo({ id: "old", title: "Standup" }, { mark: NOW - 99 * HOUR }), false);
  assert.equal(N.addedAt({}), null);
  assert.equal(N.addedAt({ addedAt: 0 }), null);
});

test("a display uses household recency, not a personal mark", () => {
  // A wall tablet is looked at by everybody and by nobody. A mark it moved
  // would clear the dots for a household that had not seen anything.
  const fresh = ev({ addedAt: NOW - 2 * 24 * HOUR });
  const stale = ev({ addedAt: NOW - 9 * 24 * HOUR });

  assert.equal(N.isNewTo(fresh, { isDisplay: true, now: NOW }), true);
  assert.equal(N.isNewTo(stale, { isDisplay: true, now: NOW }), false, "and it clears on its own");
});

test("a display never writes a mark", () => {
  const data = { seenCalendar: { ryan: 1 } };
  assert.equal(N.markSeen(data, ""), data, "unchanged, not a mark under an empty key");
  assert.deepEqual(N.markSeen(data, "ryan", 500).seenCalendar, { ryan: 500 });
});

test("marking seen leaves other people's marks alone", () => {
  const data = { seenCalendar: { ryan: 100, alex: 200 } };
  assert.deepEqual(N.markSeen(data, "ryan", 999).seenCalendar, { ryan: 999, alex: 200 });
});

test("new can be narrowed to one calendar, subscribed or hub-made", () => {
  // The join key is feedId for a subscribed event and calendarId for one made
  // here. Checking only one of them is the bug that made every subscribed event
  // arrive unowned — see lib/feed-events.js.
  const events = [
    ev({ id: "a", feedId: "work", addedAt: NOW - HOUR }),
    ev({ id: "b", calendarId: "home", addedAt: NOW - HOUR }),
    ev({ id: "c", feedId: "work", addedAt: NOW - 99 * HOUR }),
  ];
  const opts = { mark: NOW - 2 * HOUR };

  assert.deepEqual(N.newEvents(events, opts).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(N.newEvents(events, { ...opts, calendarId: "work" }).map((e) => e.id), ["a"]);
  assert.deepEqual(N.newEvents(events, { ...opts, calendarId: "home" }).map((e) => e.id), ["b"]);
});

test("counts come back per calendar", () => {
  const events = [
    ev({ id: "a", feedId: "work", addedAt: NOW - HOUR }),
    ev({ id: "b", feedId: "work", addedAt: NOW - HOUR }),
    ev({ id: "c", calendarId: "home", addedAt: NOW - HOUR }),
    ev({ id: "d", feedId: "work", addedAt: NOW - 99 * HOUR }),
  ];
  assert.deepEqual(N.newCountByCalendar(events, { mark: NOW - 2 * HOUR }), { work: 2, home: 1 });
});

test("an event belonging to no calendar is not counted against one", () => {
  const events = [ev({ id: "a", addedAt: NOW - HOUR })];
  assert.deepEqual(N.newCountByCalendar(events, { mark: NOW - 2 * HOUR }), {});
});
