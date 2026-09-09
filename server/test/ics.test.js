// ics.test.js — calendar feeds land on the right day.
//
// The failure this guards against is not a crash. It is a 7:30pm dinner
// appearing on tomorrow's tile because the server is in UTC and the household
// is not. Nothing errors, nobody files a bug, they just quietly stop believing
// the wall display.
//
// No database needed: this file parses text and does no I/O.

import test from "node:test";
import assert from "node:assert/strict";
import { parseICS, expandEvents, zoneOffsetMinutes, isValidTimeZone, icsInstant } from "../src/services/ics.js";

const CHI = "America/Chicago";
const WIN = [new Date(2026, 7, 1), new Date(2026, 7, 31)];

const run = (body, tz = CHI) =>
  expandEvents(parseICS(`BEGIN:VCALENDAR\n${body}\nEND:VCALENDAR`, tz), WIN[0], WIN[1], tz);

const vevent = (lines) => `BEGIN:VEVENT\n${lines.join("\n")}\nEND:VEVENT`;

/* ------------------------------------------------------------- zones --- */

test("a UTC evening event lands on the household's day, not the server's", () => {
  // 00:30Z on the 12th is 19:30 on the 11th in Chicago. Getting this wrong is
  // the entire reason the zone handling exists.
  const [e] = run(vevent(["UID:a", "SUMMARY:Dinner", "DTSTART:20260812T003000Z"]));
  assert.equal(e.date, "2026-08-11");
  assert.equal(e.time, "19:30");
});

test("an event published in another zone is converted", () => {
  const [e] = run(vevent([
    "UID:b", "SUMMARY:Call", "DTSTART;TZID=America/New_York:20260812T090000",
  ]));
  assert.equal(e.time, "08:00", "9am New York is 8am Chicago");
  assert.equal(e.date, "2026-08-12");
});

test("all-day events never shift, whatever the zone", () => {
  // A birthday is on that date everywhere on earth. Shifting it by zone is
  // always wrong, and the extremes are where a naive implementation breaks.
  for (const tz of ["Pacific/Kiritimati", "UTC", "Pacific/Midway", CHI]) {
    const [e] = run(vevent(["UID:c", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:20260812"]), tz);
    assert.equal(e.date, "2026-08-12", `shifted in ${tz}`);
    assert.equal(e.allDay, true);
  }
});

test("offsets follow daylight saving", () => {
  assert.equal(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), CHI), -360, "CST");
  assert.equal(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), CHI), -300, "CDT");
});

test("an unknown zone falls back to UTC instead of throwing", () => {
  assert.equal(zoneOffsetMinutes(new Date(), "Mars/Olympus_Mons"), 0);
  assert.doesNotThrow(() => run(vevent(["UID:x", "DTSTART:20260812T003000Z"]), "Not/AZone"));
});

test("isValidTimeZone accepts real zones and rejects the rest", () => {
  assert.equal(isValidTimeZone("America/Chicago"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone("'; DROP TABLE households; --"), false);
});

/* -------------------------------------------------- recurrence rules --- */

test("EXDATE removes one occurrence from a series", () => {
  const dates = run(vevent([
    "UID:bin", "SUMMARY:Bins out",
    "DTSTART;VALUE=DATE:20260803",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "EXDATE;VALUE=DATE:20260817",
  ])).map((e) => e.date);

  assert.ok(dates.includes("2026-08-10"), "other Mondays survive");
  assert.ok(!dates.includes("2026-08-17"), "the excluded Monday is gone");
});

test("a moved occurrence appears once, at its new date", () => {
  // Without RECURRENCE-ID handling this shows up twice: where the rule says it
  // should be, and where it actually is.
  const out = run([
    vevent(["UID:std", "SUMMARY:Standup", "DTSTART;VALUE=DATE:20260803", "RRULE:FREQ=WEEKLY;BYDAY=MO"]),
    vevent(["UID:std", "RECURRENCE-ID;VALUE=DATE:20260810", "SUMMARY:Standup (moved)", "DTSTART;VALUE=DATE:20260812"]),
  ].join("\n"));

  const byDate = out.map((e) => `${e.date}:${e.title}`);
  assert.ok(!byDate.some((x) => x.startsWith("2026-08-10")), "original slot suppressed");
  assert.ok(byDate.includes("2026-08-12:Standup (moved)"), "shows at the new date");
});

test("a cancelled event does not render", () => {
  const out = run(vevent([
    "UID:z", "SUMMARY:Cancelled thing", "STATUS:CANCELLED", "DTSTART;VALUE=DATE:20260814",
  ]));
  assert.equal(out.length, 0);
});

test("two different events sharing a title and date both survive", () => {
  // The dedup key used to be date+time+title, which silently swallowed one of
  // two genuinely separate appointments. UID leads the key now.
  const out = run([
    vevent(["UID:p1", "SUMMARY:Vet", "DTSTART;VALUE=DATE:20260815"]),
    vevent(["UID:p2", "SUMMARY:Vet", "DTSTART;VALUE=DATE:20260815"]),
  ].join("\n"));
  assert.equal(out.length, 2);
});

/* ------------------------------------------------------------ shapes --- */

test("a multi-day all-day event covers the right days", () => {
  // All-day DTEND is exclusive: Aug 1-4 means the 1st, 2nd and 3rd.
  const out = run(vevent([
    "UID:trip", "SUMMARY:Away", "DTSTART;VALUE=DATE:20260801", "DTEND;VALUE=DATE:20260804",
  ]));
  assert.deepEqual(out.map((e) => e.date), ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("malformed input yields no events rather than throwing", () => {
  for (const junk of ["", "BEGIN:VCALENDAR\nEND:VCALENDAR", "not a calendar at all"]) {
    assert.doesNotThrow(() => expandEvents(parseICS(junk, CHI), WIN[0], WIN[1], CHI));
  }
  assert.equal(run(vevent(["UID:bad", "SUMMARY:No start"])).length, 0);
});

/* --------------------------------------------------------- added when? --- */
// So the client can show "what has been added since you last looked"
// (web/src/lib/new-events.js). A subscribed event with no age at all can never
// be shown as new, which is the honest outcome rather than a reason to guess.

test("an event carries when the feed says it was written", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:a1",
    "DTSTAMP:20260901T090000Z",
    "CREATED:20260830T140000Z",
    "SUMMARY:Dentist",
    "DTSTART:20260905T090000Z",
    "DTEND:20260905T093000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const parsed = parseICS(ics, "UTC");
  const out = expandEvents(parsed, new Date(2026, 8, 1), new Date(2026, 8, 30), "UTC");
  assert.equal(out.length, 1);
  assert.equal(out[0].addedAt, Date.UTC(2026, 7, 30, 14, 0, 0),
    "CREATED is the truthful answer and wins over DTSTAMP");
});

test("DTSTAMP stands in when CREATED is absent", () => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a2",
    "DTSTAMP:20260901T090000Z", "SUMMARY:Standup",
    "DTSTART:20260905T090000Z", "DTEND:20260905T091500Z",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");

  const out = expandEvents(parseICS(ics, "UTC"), new Date(2026, 8, 1), new Date(2026, 8, 30), "UTC");
  assert.equal(out[0].addedAt, Date.UTC(2026, 8, 1, 9, 0, 0));
});

test("an event with neither has no age, and says so", () => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a3", "SUMMARY:Old thing",
    "DTSTART:20260905T090000Z", "DTEND:20260905T093000Z",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");

  const out = expandEvents(parseICS(ics, "UTC"), new Date(2026, 8, 1), new Date(2026, 8, 30), "UTC");
  assert.equal(out[0].addedAt, 0, "zero, not now — guessing would mark it new forever");
});

test("a malformed stamp is not a date", () => {
  assert.equal(icsInstant("not a date"), 0);
  assert.equal(icsInstant(""), 0);
  assert.equal(icsInstant("20260901"), 0, "a bare date is not an instant");
});
