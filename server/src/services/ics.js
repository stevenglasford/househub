// ics.js — parse iCalendar (.ics) feeds and expand recurring events.
// Handles a practical subset of RRULE: FREQ DAILY/WEEKLY/MONTHLY/YEARLY,
// INTERVAL, COUNT, UNTIL, and BYDAY (for weekly), plus EXDATE and
// RECURRENCE-ID overrides.
//
// Timezones are handled explicitly rather than by leaning on the server's own
// TZ. A host left on UTC pushes every evening event onto the next day: a 7:30pm
// event publishes as 00:30Z tomorrow, and the calendar quietly shows it on the
// wrong day. Nobody reports that as a bug, they just stop trusting the wall
// display.
//
// Unlike the single-household original this is multi-tenant, so the zone is a
// parameter rather than one process-wide constant -- two households on the same
// server can be in different zones, and neither of them is "the server's".

import { ianaFromWindows, parseVTimezones, offsetFromVTimezone } from "./ics-zones.js";

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(d, -d.getDay());

/** Fallback when a household has not chosen a zone. */
export const DEFAULT_TZ =
  process.env.HOUSEHOLD_TZ || process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Is this a zone Intl actually knows? Used to validate what a household saves. */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* How far ahead of UTC a zone is at a given instant, in minutes. Goes through
   Intl so DST is handled without carrying a tz database. */
export function zoneOffsetMinutes(instant, tz) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = {};
    for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
    const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return (asIfUTC - instant.getTime()) / 60000;
  } catch {
    return 0;   // unknown zone: treat as UTC rather than throwing mid-parse
  }
}

/* A wall-clock time stated in some zone -> the actual instant. Iterates twice
   so the offset used matches the offset in effect at the resulting instant,
   which is what makes it correct across a DST boundary. */
function wallTimeToInstant(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    guess = naive - zoneOffsetMinutes(new Date(guess), tz) * 60000;
  }
  return new Date(guess);
}

/* An instant -> its wall-clock fields in the household zone. This is the step
   that decides which calendar day an event lands on. */
function instantToHouseholdFields(instant, tz) {
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(instant, tz) * 60000);
  return {
    y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
    h: shifted.getUTCHours(), mi: shifted.getUTCMinutes(), allDay: false,
  };
}

/**
 * The current date and minute-of-day in a household's zone.
 *
 * Anything that asks "is this reminder due yet?" has to go through here rather
 * than the server's own clock, or a UTC host decides it is a different time of
 * day than the people standing in the kitchen do.
 */
export function householdNow(tz = DEFAULT_TZ, at = new Date()) {
  const f = instantToHouseholdFields(at, tz);
  return {
    dateKey: `${f.y}-${pad(f.mo)}-${pad(f.d)}`,
    minutes: f.h * 60 + f.mi,
    h: f.h, mi: f.mi,
  };
}

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

/* Resolve a DTSTART/DTEND/EXDATE/RECURRENCE-ID value into household-local
   fields. Four cases, and mixing them up is the classic off-by-one-day:

     VALUE=DATE   a floating calendar day -- never shift it. Someone's birthday
                  is on that date everywhere on earth.
     trailing Z   an instant in UTC; convert into the household zone
     TZID=...     wall time in some other zone; convert into the household zone
     bare         already local wall time; use as-is                          */
function parseDT(value, param, tz, zones) {
  const v = String(value || "").trim();
  const isDate = (param && param.VALUE === "DATE") || /^\d{8}$/.test(v);
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2], D = +m[3], H = +(m[4] || 0), Mi = +(m[5] || 0);

  if (isDate) return { y: Y, mo: Mo, d: D, allDay: true };
  if (/Z$/.test(v)) return instantToHouseholdFields(new Date(Date.UTC(Y, Mo - 1, D, H, Mi)), tz);

  if (param && param.TZID) {
    const from = param.TZID.replace(/^["']|["']$/g, "").trim();
    if (from && from !== tz) {
      /* Resolve the name, most trustworthy source first. The alias step is not
         a nicety: Outlook and Exchange write Windows zone names, `Intl` does
         not know them, and the offset lookup used to quietly answer zero for
         anything it could not parse -- which read every one of those wall times
         as UTC and moved the event by the household's whole offset. A 9am
         appointment showed up at 4am and nothing anywhere reported a problem. */
      const iana = isValidTimeZone(from) ? from : ianaFromWindows(from);
      if (iana) return instantToHouseholdFields(wallTimeToInstant(Y, Mo, D, H, Mi, iana), tz);

      // No such IANA zone, but the feed may state its own offsets.
      const stated = offsetFromVTimezone(zones && zones.get(from), Y, Mo, D, H, Mi);
      if (stated !== null && stated !== undefined) {
        const instant = new Date(Date.UTC(Y, Mo - 1, D, H, Mi) - stated * 60000);
        return instantToHouseholdFields(instant, tz);
      }

      /* Nothing identified the zone. Treat the time as floating -- i.e. already
         household-local -- rather than as UTC. Both are guesses; this one is
         wrong by however far the writer's zone differs from ours, while the UTC
         reading is wrong by our full offset even when the zones agree. */
    }
  }
  return { y: Y, mo: Mo, d: D, h: H, mi: Mi, allDay: false };
}
const mkDate = (s) => new Date(s.y, s.mo - 1, s.d, s.h || 0, s.mi || 0);

export function parseICS(text, tz = DEFAULT_TZ) {
  // Read before the events, because a VEVENT may reference a zone the feed
  // defines further down.
  const zones = parseVTimezones(text);
  const lines = unfold(text).split("\n");
  let calName = "";
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("X-WR-CALNAME")) { calName = line.split(":").slice(1).join(":").trim() || calName; continue; }
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const left = line.slice(0, idx), value = line.slice(idx + 1);
    const [name, ...params] = left.split(";");
    const param = {};
    params.forEach((p) => { const [k, v] = p.split("="); param[k] = v; });
    if (name === "SUMMARY") cur.summary = value.replace(/\\,/g, ",").replace(/\\n/gi, " ").replace(/\\;/g, ";");
    else if (name === "DTSTART") cur.start = parseDT(value, param, tz, zones);
    else if (name === "DTEND") cur.end = parseDT(value, param, tz, zones);
    else if (name === "UID") cur.uid = value.trim();
    else if (name === "STATUS") cur.status = value.trim().toUpperCase();
    // A moved or edited single occurrence of a series: this VEVENT replaces the
    // occurrence that would otherwise fall on RECURRENCE-ID's date.
    else if (name === "RECURRENCE-ID") cur.recurrenceId = parseDT(value, param, tz, zones);
    // Dates removed from the series. The property can repeat and can also hold
    // a comma-separated list, so both forms have to accumulate.
    else if (name === "EXDATE") {
      cur.exdates = cur.exdates || [];
      value.split(",").forEach((one) => { const p = parseDT(one, param, tz, zones); if (p) cur.exdates.push(p); });
    }
    else if (name === "RRULE") { const o = {}; value.split(";").forEach((p) => { const [k, v] = p.split("="); o[k] = v; }); cur.rrule = o; }
  }
  return { calName, events };
}

export function expandEvents(parsed, winStart, winEnd, tz = DEFAULT_TZ) {
  const out = [];
  const seen = new Set();
  // Calendar days covered. All-day DTEND is exclusive (Aug 1-4 = Aug 1,2,3);
  // timed DTEND is inclusive of its own date.
  const spanDaysOf = (ev) => {
    if (!ev.end) return 1;
    const s = new Date(ev.start.y, ev.start.mo - 1, ev.start.d);
    const e = new Date(ev.end.y, ev.end.mo - 1, ev.end.d);
    const diff = Math.round((e - s) / 86400000);
    return Math.max(1, ev.start.allDay ? diff : diff + 1);
  };
  const push = (dt, ev) => {
    const span = spanDaysOf(ev);
    for (let i = 0; i < span; i++) {
      const day = addDays(dt, i);
      if (day > winEnd) break;
      const dstr = ymd(day);
      const time = i === 0 && !ev.start.allDay ? `${pad(ev.start.h)}:${pad(ev.start.mi)}` : "";
      // UID leads the key so two genuinely different events that happen to
      // share a title and a time both survive, while one event seen twice
      // (master plus override) collapses to one.
      const key = (ev.uid || "") + "|" + dstr + time + (ev.summary || "");
      if (seen.has(key)) continue;
      seen.add(key);
      // endTime only on the first day, and only for timed events — the check-in
      // scheduler needs to know when something like a work shift finishes
      const endTime = (i === 0 && !ev.start.allDay && ev.end && !ev.end.allDay
        && ev.end.h !== undefined && span === 1)
        ? `${pad(ev.end.h)}:${pad(ev.end.mi)}` : "";
      out.push({
        title: ev.summary || "(No title)", date: dstr, time, endTime,
        allDay: !!ev.start.allDay || i > 0,
        spanDays: span, spanIndex: i, cont: i > 0,
      });
    }
  };
  const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /* Split the feed into masters and per-occurrence overrides. Without this a
     moved occurrence appears twice: once where the RRULE says it should be and
     once where it actually is. Overrides win; the original slot is suppressed. */
  const overrides = parsed.events.filter((e) => e.recurrenceId);
  const masters = parsed.events.filter((e) => !e.recurrenceId);
  const suppressed = new Set();   // "uid|YYYY-MM-DD" slots a master must skip
  for (const o of overrides) {
    if (!o.uid || !o.recurrenceId) continue;
    suppressed.add(`${o.uid}|${ymd(mkDate(o.recurrenceId))}`);
  }
  for (const ev of masters) {
    (ev.exdates || []).forEach((x) => {
      if (ev.uid) suppressed.add(`${ev.uid}|${ymd(mkDate(x))}`);
    });
  }
  const isSuppressed = (ev, dt) => ev.uid && suppressed.has(`${ev.uid}|${ymd(dt)}`);

  // A cancelled event should not render at all.
  const live = (e) => e.status !== "CANCELLED";

  // Overrides are standalone one-offs at their new DTSTART.
  for (const ev of overrides) {
    if (!live(ev) || !ev.start) continue;
    const base = mkDate(ev.start);
    const endsAt = addDays(base, spanDaysOf(ev) - 1);
    if (endsAt >= winStart && base <= winEnd) push(base, ev);
  }

  for (const ev of masters) {
    if (!live(ev)) continue;
    const base = mkDate(ev.start);
    if (!ev.rrule) {
      const endsAt = addDays(base, spanDaysOf(ev) - 1);
      if (endsAt >= winStart && base <= winEnd && !isSuppressed(ev, base)) push(base, ev);
      continue;
    }
    const r = ev.rrule, freq = r.FREQ, interval = +(r.INTERVAL || 1);
    const count = r.COUNT ? +r.COUNT : null;
    const until = r.UNTIL ? mkDate(parseDT(r.UNTIL, {}, tz)) : null;
    const byday = r.BYDAY ? r.BYDAY.split(",") : null;
    let cursor = new Date(base), n = 0, guard = 0;
    while (guard++ < 2000) {
      if (until && cursor > until) break;
      if (count && n >= count) break;
      if (cursor > winEnd) break;
      if (freq === "WEEKLY" && byday) {
        const ws = startOfWeek(cursor);
        byday.forEach((bd) => {
          const dow = map[bd];
          if (dow == null) return;
          const occ = addDays(ws, dow);
          if (occ >= base && occ >= winStart && occ <= winEnd && (!until || occ <= until)
            && !isSuppressed(ev, occ)) push(occ, ev);
        });
      } else if (cursor >= winStart && cursor <= winEnd && !isSuppressed(ev, cursor)) push(cursor, ev);
      n++;
      if (freq === "DAILY") cursor = addDays(cursor, interval);
      else if (freq === "WEEKLY") cursor = addDays(cursor, 7 * interval);
      else if (freq === "MONTHLY") { const c = new Date(cursor); c.setMonth(c.getMonth() + interval); cursor = c; }
      else if (freq === "YEARLY") { const c = new Date(cursor); c.setFullYear(c.getFullYear() + interval); cursor = c; }
      else break;
    }
  }
  return out;
}

// NOTE: the feed fetcher that used to live here has been removed deliberately.
// It called fetch() on a user-supplied URL with no address checks, which is a
// server-side request forgery primitive (see services/safe-fetch.js for what
// replaced it, and test/safe-fetch.test.js for what it now refuses). This file
// parses iCalendar text and does no I/O at all.
