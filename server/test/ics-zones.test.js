// ics-zones.test.js — the timezone names real calendar feeds actually contain.
//
// Ryan's report was "the times are off on every calendar item", and it was not
// an exaggeration: 302 of the 671 timed events in the household's own feeds
// were wrong, every one of them by the household's whole UTC offset.
//
// The cause was a defensive `catch` returning an offset of 0. Outlook and
// Exchange write Windows zone names -- "Central Standard Time" -- which are not
// IANA names, so `Intl` threw, the catch answered "zero minutes from UTC", and
// the wall time was read as UTC. A 9am clinic came out at 4am. Nothing logged,
// nothing errored; the calendar was simply wrong.
//
// Each test below fails if that behaviour returns.

import test from "node:test";
import assert from "node:assert/strict";
import { parseICS, expandEvents } from "../src/services/ics.js";
import {
  ianaFromWindows, nthWeekdayOfMonth, parseVTimezones, offsetFromVTimezone,
} from "../src/services/ics-zones.js";

const HH = "America/Chicago";

/** A one-event feed, so a test states only what it is about. */
const feed = (dtstart, extra = "") => `BEGIN:VCALENDAR
${extra}BEGIN:VEVENT
UID:e1
SUMMARY:Appointment
DTSTART${dtstart}
END:VEVENT
END:VCALENDAR`;

const startOf = (text, tz = HH) => parseICS(text, tz).events[0].start;
const hhmm = (s) => `${String(s.h).padStart(2, "0")}:${String(s.mi).padStart(2, "0")}`;
const ymd = (s) => `${s.y}-${String(s.mo).padStart(2, "0")}-${String(s.d).padStart(2, "0")}`;

/* --------------------------------------------------- Windows zone names --- */

test("a Windows zone name is not read as UTC", () => {
  // The exact shape of the reported bug. Before the fix this produced 04:00.
  const s = startOf(feed(";TZID=Central Standard Time:20250916T090000"));
  assert.equal(hhmm(s), "09:00", "9am Central in a Central household is 9am");
  assert.equal(ymd(s), "2025-09-16", "and it must not slide to another day");
});

test("the same name is right in winter, when the offset differs", () => {
  // "Central Standard Time" names the zone, not a fixed -6: in February the
  // household is on CST, in September on CDT. A hardcoded offset passes one of
  // these two tests and fails the other.
  const winter = startOf(feed(";TZID=Central Standard Time:20260209T180000"));
  assert.equal(hhmm(winter), "18:00");
  const summer = startOf(feed(";TZID=Central Standard Time:20260709T180000"));
  assert.equal(hhmm(summer), "18:00");
});

test("a Windows zone in a different region shifts by the right amount", () => {
  const eastern = startOf(feed(";TZID=Eastern Standard Time:20260209T180000"));
  assert.equal(hhmm(eastern), "17:00", "6pm Eastern is 5pm Central");

  const mountain = startOf(feed(";TZID=Mountain Standard Time:20260209T180000"));
  assert.equal(hhmm(mountain), "19:00", "6pm Mountain is 7pm Central");
});

test("a Windows zone can move the event to another day", () => {
  // Singapore is far enough ahead that the date changes, which is precisely the
  // case where being wrong is most visible on a wall display.
  const s = startOf(feed(";TZID=Singapore Standard Time:20260210T090000"));
  assert.equal(ymd(s), "2026-02-09", "9am in Singapore is the previous evening here");
  assert.equal(hhmm(s), "19:00");
});

test("the alias table maps the names, and only those names", () => {
  assert.equal(ianaFromWindows("Central Standard Time"), "America/Chicago");
  assert.equal(ianaFromWindows('"Eastern Standard Time"'), "America/New_York");
  assert.equal(ianaFromWindows("  central standard time  "), "America/Chicago");
  assert.equal(ianaFromWindows("America/Chicago"), null, "a real IANA name is not an alias");
  assert.equal(ianaFromWindows("Nonsense Time"), null);
  assert.equal(ianaFromWindows(null), null);
});

/* ------------------------------------------------- what must not regress --- */

test("an IANA TZID and a UTC stamp still work", () => {
  assert.equal(hhmm(startOf(feed(";TZID=America/Chicago:20260709T191500"))), "19:15");
  assert.equal(hhmm(startOf(feed(";TZID=America/New_York:20260709T191500"))), "18:15");

  const z = startOf(feed(":20260830T000000Z"));
  assert.equal(ymd(z), "2026-08-29", "midnight UTC is the evening before, here");
  assert.equal(hhmm(z), "19:00");
});

test("an all-day date never moves", () => {
  // A birthday is on that date everywhere on earth. Shifting it by an offset is
  // the classic off-by-one-day.
  const s = startOf(feed(";VALUE=DATE:20260830"));
  assert.equal(s.allDay, true);
  assert.equal(ymd(s), "2026-08-30");
});

test("an unrecognisable zone falls back to floating, not to UTC", () => {
  /* The guard on the original defect. Both readings are guesses, but they are
     not equally bad: floating is wrong only by however far the writer's zone
     differs from ours, while UTC is wrong by our entire offset even when the
     two zones are the same -- which is the common case, and was what made the
     bug affect every row rather than a few. */
  const s = startOf(feed(";TZID=Nonsense Standard Time:20260709T090000"));
  assert.equal(hhmm(s), "09:00");
  assert.notEqual(hhmm(s), "04:00", "reading it as UTC is the bug being tested for");
});

/* ------------------------------------------------- VTIMEZONE in the feed --- */

const CUSTOM = `BEGIN:VTIMEZONE
TZID:Customized Time Zone
BEGIN:STANDARD
DTSTART:16011104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
END:DAYLIGHT
END:VTIMEZONE
`;

test("a zone nobody recognises is read from the feed's own VTIMEZONE", () => {
  // Outlook writes "Customized Time Zone" when somebody has hand-edited one.
  // No alias can help; the offsets are stated in the file.
  const summer = startOf(feed(";TZID=Customized Time Zone:20260709T090000", CUSTOM));
  assert.equal(hhmm(summer), "09:00", "-0500 in July, and the household is -0500");

  const winter = startOf(feed(";TZID=Customized Time Zone:20260209T090000", CUSTOM));
  assert.equal(hhmm(winter), "09:00", "-0600 in February, and the household is -0600");
});

test("the VTIMEZONE reader picks the rules still in force", () => {
  const zones = parseVTimezones(CUSTOM);
  const z = zones.get("Customized Time Zone");
  assert.ok(z, "the block should be found by its TZID");
  assert.equal(z.std.offset, -360);
  assert.equal(z.dst.offset, -300);

  // July is daylight, February is standard.
  assert.equal(offsetFromVTimezone(z, 2026, 7, 9, 9, 0), -300);
  assert.equal(offsetFromVTimezone(z, 2026, 2, 9, 9, 0), -360);
  // The boundary itself: 2nd Sunday of March 2026 is the 8th.
  assert.equal(offsetFromVTimezone(z, 2026, 3, 8, 1, 0), -360, "before the change");
  assert.equal(offsetFromVTimezone(z, 2026, 3, 8, 3, 0), -300, "after it");
});

test("historical rules do not displace current ones", () => {
  /* Google writes every rule a zone has ever had -- America/Chicago starts in
     1883 -- and caps the expired ones with UNTIL. Taking the last block in the
     file would pick an obsolete rule. */
  const historical = `BEGIN:VTIMEZONE
TZID:Test/Zone
BEGIN:STANDARD
DTSTART:19181027T020000
RRULE:FREQ=YEARLY;UNTIL=19191026T070000Z;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
END:STANDARD
BEGIN:STANDARD
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
END:DAYLIGHT
END:VTIMEZONE`;
  const z = parseVTimezones(historical).get("Test/Zone");
  assert.equal(z.std.month, 11, "the November rule is current; the October one expired");
  assert.equal(z.std.byday, "1SU");
});

test("a zone with no daylight rule keeps one offset all year", () => {
  const fixed = `BEGIN:VTIMEZONE
TZID:Fixed/Zone
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0800
TZOFFSETTO:+0800
END:STANDARD
END:VTIMEZONE`;
  const z = parseVTimezones(fixed).get("Fixed/Zone");
  assert.equal(offsetFromVTimezone(z, 2026, 1, 15), 480);
  assert.equal(offsetFromVTimezone(z, 2026, 7, 15), 480);
});

/* ------------------------------------------------------- the weekday maths --- */

test("nth-weekday-of-month handles both counting directions", () => {
  assert.equal(nthWeekdayOfMonth(2026, 3, "2SU"), 8);
  assert.equal(nthWeekdayOfMonth(2026, 11, "1SU"), 1);
  assert.equal(nthWeekdayOfMonth(2026, 3, "-1SU"), 29, "last Sunday of March 2026");
  assert.equal(nthWeekdayOfMonth(2026, 2, "-1SA"), 28, "last Saturday of February 2026");
  assert.equal(nthWeekdayOfMonth(2026, 1, "1TH"), 1, "1 Jan 2026 is itself a Thursday");
  assert.equal(nthWeekdayOfMonth(2026, 3, "nonsense"), null);
});

/* --------------------------------------------------- end to end, expanded --- */

test("expansion carries the corrected time through to the day tile", () => {
  // parseDT being right is not enough: the value the UI reads is the `time`
  // string expandEvents emits.
  const text = feed(";TZID=Central Standard Time:20260209T180000");
  const out = expandEvents(parseICS(text, HH), new Date("2026-02-01"), new Date("2026-03-01"), HH);
  assert.equal(out.length, 1);
  assert.equal(out[0].date, "2026-02-09");
  assert.equal(out[0].time, "18:00", "the tile must show 6pm, not noon");
});
