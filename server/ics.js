// ics.js — parse iCalendar (.ics) feeds and expand recurring events.
// Handles a practical subset of RRULE: FREQ DAILY/WEEKLY/MONTHLY/YEARLY,
// INTERVAL, COUNT, UNTIL, and BYDAY (for weekly). Times are interpreted in
// the server's local timezone, so set the server TZ to your household's zone.

import { ICS_FETCH_TIMEOUT_MS } from "./config.js";

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(d, -d.getDay());

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}
function parseDT(value, param) {
  const isDate = (param && param.VALUE === "DATE") || /^\d{8}$/.test(value.trim());
  const utc = /Z$/.test(value.trim());
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2], D = +m[3], H = +(m[4] || 0), Mi = +(m[5] || 0);
  if (isDate) return { y: Y, mo: Mo, d: D, allDay: true };
  if (utc) {
    const dt = new Date(Date.UTC(Y, Mo - 1, D, H, Mi));
    return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), allDay: false };
  }
  return { y: Y, mo: Mo, d: D, h: H, mi: Mi, allDay: false };
}
const mkDate = (s) => new Date(s.y, s.mo - 1, s.d, s.h || 0, s.mi || 0);

export function parseICS(text) {
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
    else if (name === "DTSTART") cur.start = parseDT(value, param);
    else if (name === "DTEND") cur.end = parseDT(value, param);
    else if (name === "RRULE") { const o = {}; value.split(";").forEach((p) => { const [k, v] = p.split("="); o[k] = v; }); cur.rrule = o; }
  }
  return { calName, events };
}

export function expandEvents(parsed, winStart, winEnd) {
  const out = [];
  const seen = new Set();
  // Calendar days covered. All-day DTEND is exclusive (Aug 1–4 = Aug 1,2,3);
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
      const key = dstr + time + (ev.summary || "");
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
  for (const ev of parsed.events) {
    const base = mkDate(ev.start);
    if (!ev.rrule) {
      const endsAt = addDays(base, spanDaysOf(ev) - 1);
      if (endsAt >= winStart && base <= winEnd) push(base, ev);
      continue;
    }
    const r = ev.rrule, freq = r.FREQ, interval = +(r.INTERVAL || 1);
    const count = r.COUNT ? +r.COUNT : null;
    const until = r.UNTIL ? mkDate(parseDT(r.UNTIL, {})) : null;
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
          if (occ >= base && occ >= winStart && occ <= winEnd && (!until || occ <= until)) push(occ, ev);
        });
      } else if (cursor >= winStart && cursor <= winEnd) push(cursor, ev);
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

// Fetch a feed server-side. webcal:// is rewritten to https://. No CORS here
// because this runs on the server, not in the browser.
export async function fetchICS(url) {
  const u = url.replace(/^webcal:/i, "https:");
  // Timeout is configurable (ICS_FETCH_TIMEOUT_MS) so one unresponsive feed
  // can't stall the refresh loop.
  const res = await fetch(u, {
    redirect: "follow",
    signal: AbortSignal.timeout(ICS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Not a calendar feed");
  return text;
}
