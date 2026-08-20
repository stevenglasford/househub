import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import {
  Calendar as CalIcon, UtensilsCrossed, CheckCircle2, Circle,
  Home, Plus, X, ChevronLeft, ChevronRight, Settings, Trash2,
  Clock, Sun, Coffee, Moon, Sparkles, Users, Link2, Upload,
  RefreshCw, CalendarDays, Lock, Repeat, ChefHat, ShoppingCart,
  Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle,
  Thermometer, MapPin, StickyNote, PartyPopper, Hourglass, Mic, Copy, ListChecks,
  Video, Lightbulb, LockKeyhole, DoorOpen, ExternalLink, Sofa,
  MessageCircle, Hammer, Wallet, History, Archive, ShoppingBag, CopyPlus, Utensils,
  Wrench, Inbox, ListTodo, BellRing, Volume2, VolumeX, Dices, Wine,
  Store,
  HeartHandshake, Pencil, Shuffle,
} from "lucide-react";
import {
  loadState, saveState, loadCalendarEvents,
  addCalendar, refreshCalendar, deleteCalendar,
  loadCaldav, pushCaldav,
  session,
} from "./api.js";
import { getConfig } from "./config.js";
import { useCheckinPrompt } from "./lib/useCheckinPrompt.js";
import HouseholdPanel from "./components/HouseholdPanel.jsx";
import ArchivePanel from "./components/ArchivePanel.jsx";
import ImportPanel from "./components/ImportPanel.jsx";
import SessionPolicyPanel from "./components/SessionPolicyPanel.jsx";
import SuperAdminPanel from "./components/SuperAdminPanel.jsx";
import HomeAssistantPanel from "./components/HomeAssistantPanel.jsx";
import DisplaysPanel from "./components/DisplaysPanel.jsx";
import CamerasPanel from "./components/CamerasPanel.jsx";
import DevicesPanel from "./components/DevicesPanel.jsx";
import AiPanel from "./components/AiPanel.jsx";
import SecondBlock, { SecondBlockSettings } from "./components/SecondBlock.jsx";
import CaldavPanel from "./components/CaldavPanel.jsx";
import PrivacyPanel from "./components/PrivacyPanel.jsx";
import * as COMPLETION from "./lib/completion.js";
import { DEFAULT_ALERT, hasAlert, dueAlerts, escalationStep } from "./lib/alerts.js";
import * as RELAY from "./lib/relay.js";
import * as STATUS from "./lib/status.js";
import * as SUB from "./lib/subtasks.js";
import { urgencyOf, partitionDates, agoLabel } from "./lib/dates.js";
import * as ROT from "./lib/rotation.js";
import { projectEvents, eventsForSync } from "./lib/project-events.js";
import { suggestDateIdeas } from "./lib/checkin.js";
import * as LISTS from "./lib/lists.js";
import { buildCheckinSteps } from "./lib/checkin.js";

/* ---------------------------------------------------------------
   Theme — warm "kitchen paper" palette, pine-green brand.
--------------------------------------------------------------- */
const T = {
  bg: "#F3EDE2", panel: "#FFFFFF", panelAlt: "#FBF7F0",
  ink: "#2C2536", sub: "#867E8F", faint: "#B7AEB9", line: "#E7DECF",
  brand: "#1E6E5C", brandInk: "#12463A", brandSoft: "#E2EEE9", gold: "#C98A2B",
  // Urgency for important dates. Warm red rather than a pure #F00, which would
  // sit outside this palette and read as an error rather than as "soon".
  danger: "#C1442E", dangerInk: "#8E2F1F", dangerSoft: "#FBE7E1",
  goldInk: "#8A5C14", goldSoft: "#FAF0DC",
};
/* How each urgency band is drawn. One table, so the countdown chips on Today
   and the list on the board cannot drift apart -- which they had, the chip
   using the brand colour for "soon" while the list used gold. */
const URGENCY_STYLE = {
  today:     { fg: T.danger, ink: T.dangerInk, bg: T.dangerSoft, border: T.danger, bold: true },
  week:      { fg: T.danger, ink: T.dangerInk, bg: T.dangerSoft, border: T.danger, bold: true },
  fortnight: { fg: T.gold,   ink: T.goldInk,   bg: T.goldSoft,   border: T.gold,   bold: true },
  soon:      { fg: T.brand,  ink: T.brandInk,  bg: T.panel,      border: T.line,   bold: false },
  later:     { fg: T.faint,  ink: T.sub,       bg: T.panel,      border: T.line,   bold: false },
  past:      { fg: T.faint,  ink: T.sub,       bg: T.panelAlt,   border: T.line,   bold: false },
};
const styleFor = (band) => URGENCY_STYLE[band?.key] || URGENCY_STYLE.later;

const PERSON_COLORS = ["#E86A4C", "#E3A72C", "#2E9187", "#5D6FE0", "#D25B86", "#8A5CC2", "#4C9A54", "#3D8FD1"];
const CAL_COLORS = ["#5D6FE0", "#8A5CC2", "#3D8FD1", "#C98A2B", "#D25B86"];
// sticky-note paper colors, tuned to the warm palette
const NOTE_COLORS = ["#FBEFA6", "#D3E8C6", "#F7CFD8", "#CBE0F2", "#EFD9BE", "#E2D6EF"];
const BUILD = "2.8.0 · date-night jars";
const DISPLAY = "'Fraunces', Georgia, serif";
const BODY = "'Inter', system-ui, -apple-system, sans-serif";
const MEALS = [
  { key: "breakfast", label: "Breakfast", Icon: Coffee },
  { key: "lunch", label: "Lunch", Icon: Sun },
  { key: "dinner", label: "Dinner", Icon: Moon },
];

/* Each slot holds a list of entries rather than one dish, because breakfast and
   lunch are usually different per person. An entry with personId "" is shared.
   entry = { id, title, personId, togo, time, cookId }                        */
const mealEntries = (data, dateKey, slot) => {
  const v = (data.meals?.[dateKey] || {})[slot];
  return Array.isArray(v) ? v : [];
};
// shared entries stay visible whoever you've filtered to
const entryVisible = (e, filter) => filter === "all" || !e.personId || e.personId === filter;
const dayHasMeals = (data, dateKey, filter = "all") =>
  MEALS.some(({ key }) => mealEntries(data, dateKey, key).some((e) => entryVisible(e, filter)));

/* Old data stored one dish per slot with cooks/times maps on the day. Fold that
   into the list shape so existing plans survive the upgrade. */
function migrateMealsClient(meals) {
  const out = {};
  for (const [date, day] of Object.entries(meals || {})) {
    if (!day || typeof day !== "object") continue;
    const cooks = day.cooks || {};
    const times = day.times || {};
    const fresh = {};
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const v = day[slot];
      if (Array.isArray(v)) fresh[slot] = v;
      else if (typeof v === "string" && v.trim()) {
        fresh[slot] = [{ id: uid(), title: v.trim(), personId: "", togo: false,
          time: times[slot] || "", cookId: cooks[slot] || "" }];
      }
    }
    if (Object.keys(fresh).length) out[date] = fresh;
  }
  return out;
}

/* ---------------------------------------------------------------
   Date helpers (local-time safe)
--------------------------------------------------------------- */
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(y, m - 1, dd); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(d, -d.getDay());
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtTimeParts = (t) => {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return { clock: `${h % 12 === 0 ? 12 : h % 12}:${pad(m)}`, ap: h >= 12 ? "PM" : "AM" };
};
/* Compact range: "9:00–10:00am" when both share a meridiem, otherwise
   "11:30am–1:00pm". Keeps narrow columns readable. */
const fmtRange = (start, end) => {
  if (!start) return "";
  const a = fmtTimeParts(start);
  if (!end) return fmtTime(start);
  const b = fmtTimeParts(end);
  return a.ap === b.ap
    ? `${a.clock}–${b.clock}${b.ap.toLowerCase()}`
    : `${a.clock}${a.ap.toLowerCase()}–${b.clock}${b.ap.toLowerCase()}`;
};
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${pad(m)}${ap}`;
};

/* ---------------------------------------------------------------
   Nightly check-in.

   Two halves: a reminder that gets you to the table, and a walkthrough of
   whatever actually needs attention. The time can be derived from the
   calendar — "45 minutes after work ends" — but only if work is actually an
   event on a synced calendar. When it isn't, the fallback time applies, and
   an explicit choice for a given night always wins.
--------------------------------------------------------------- */
const DEFAULT_CHECKIN = {
  offsetMinutes: 45,
  anchorPersonId: "",      // whose workday we follow
  workCalendarId: "",      // optionally restrict to one synced calendar
  workMatch: "work",       // title keyword when no calendar is chosen
  fallbackTime: "20:00",   // days with nothing on the calendar
  soundOn: true,
  overrides: {},           // { "YYYY-MM-DD": "HH:MM" } — set the night before
  log: {},                 // { "YYYY-MM-DD": { startedAt, completedAt, covered, skipped } }
};

const minutesOf = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
};
const hhmmOf = (mins) => {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

/* The latest work-ish event that finishes on this day. Requires an end time,
   which only timed single-day events carry. */
function workEndFor(dateKey, allEvents, cfg) {
  const needle = (cfg.workMatch || "").trim().toLowerCase();
  const candidates = (allEvents || []).filter((e) => {
    if (e.date !== dateKey || !e.endTime) return false;
    if (cfg.anchorPersonId && e.personId && e.personId !== cfg.anchorPersonId) return false;
    if (cfg.workCalendarId) return e.calId === cfg.workCalendarId;
    return needle ? String(e.title || "").toLowerCase().includes(needle) : false;
  });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (minutesOf(b.endTime) > minutesOf(a.endTime) ? b : a));
}

/* When to sit down, and why — the reason is shown in the UI so the time never
   looks arbitrary. If the derived slot lands inside another event, it slides to
   the end of that event rather than interrupting it. */
function checkinPlan(data, dateKey, allEvents) {
  const cfg = { ...DEFAULT_CHECKIN, ...(data.checkin || {}) };
  const override = (cfg.overrides || {})[dateKey];
  if (override) return { time: override, reason: "you picked this time", derived: false };

  const work = workEndFor(dateKey, allEvents, cfg);
  let time, reason;
  if (work) {
    time = hhmmOf(minutesOf(work.endTime) + (cfg.offsetMinutes || 0));
    reason = `${cfg.offsetMinutes} min after ${work.title}`;
  } else {
    time = cfg.fallbackTime || "20:00";
    reason = "nothing on the calendar, so the usual time";
  }

  // don't land in the middle of something else
  const mins = minutesOf(time);
  const clash = (allEvents || [])
    .filter((e) => e.date === dateKey && e.time && e.endTime)
    .find((e) => minutesOf(e.time) <= mins && mins < minutesOf(e.endTime));
  if (clash) {
    time = hhmmOf(minutesOf(clash.endTime) + 5);
    reason = `after ${clash.title}`;
  }
  return { time, reason, derived: true };
}

const checkinDoneFor = (data, dateKey) => Boolean((data.checkin?.log || {})[dateKey]?.completedAt);

/* ---------------------------------------------------------------
   House projects. Separate from tasks because they carry percent
   complete, several planned work days, and can exist with no date
   at all — an empty dates array IS the backlog.
--------------------------------------------------------------- */
const clampPercent = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));

/* Stages are optional. A small project ("replace the porch light") doesn't need
   them and keeps its hand-set percent. Break a big one into stages and progress
   becomes derived — done ÷ total — because ticking a real step is a fact,
   whereas a percent you type is a guess. The cost is no partial credit inside a
   stage; if that bites, split the stage. */
const projectStages = (p) => (Array.isArray(p.stages) ? p.stages : []);
const hasStages = (p) => projectStages(p).length > 0;
const projectPercent = (p) => {
  const st = projectStages(p);
  if (!st.length) return clampPercent(p.percent || 0);
  return Math.round((st.filter((x) => x.done).length / st.length) * 100);
};
// planned days come from the stages once they exist, otherwise the project's own list
const projectDates = (p) => hasStages(p)
  ? [...new Set(projectStages(p).filter((x) => x.date).map((x) => x.date))].sort()
  : [...(p.dates || [])].sort();
const projectOn = (p, dateKey) => projectDates(p).includes(dateKey);
const projectOpen = (p) => projectPercent(p) < 100;
const projectInBacklog = (p) => projectOpen(p) && !projectDates(p).length;

/* A planned day that came and went without the project finishing.
   Past days are kept as history rather than rewritten, so "carried" just means:
   it has a past day, no upcoming day, and isn't done. Adding any future day
   clears it. Uses projectDates/projectPercent so it works whether the project
   tracks stages or a plain percentage. */
const pastDatesOf = (p, todayKey) => projectDates(p).filter((k) => k < todayKey);
const futureDatesOf = (p, todayKey) => projectDates(p).filter((k) => k >= todayKey);
const projectCarried = (p, todayKey) =>
  projectOpen(p) && pastDatesOf(p, todayKey).length > 0 && futureDatesOf(p, todayKey).length === 0;
const carriedFrom = (p, todayKey) => {
  const past = pastDatesOf(p, todayKey);
  return past.length ? past[past.length - 1] : null;
};
const stagesOn = (p, dateKey) => projectStages(p).filter((x) => x.date === dateKey);
const nextStage = (p) => projectStages(p).find((x) => !x.done) || null;
/* Where a "plan this for <day>" lands depends on whether the project has stages:
   with stages the project's own dates[] is ignored, so the day has to go on a
   stage — the first one without a date, or failing that the first unfinished
   one. Pure so it can be tested on its own. */
/* The inverse: send it back to the backlog. With stages the days live on the
   stages, so those have to be cleared too or the project would still look
   planned. Progress is untouched. */
function withoutPlannedDays(project) {
  const st = projectStages(project);
  if (!st.length) return { ...project, dates: [] };
  return { ...project, dates: [], stages: st.map((x) => ({ ...x, date: "" })) };
}

function withPlannedDay(project, dateKey) {
  const st = projectStages(project);
  if (!st.length) {
    return { ...project, dates: [...new Set([...(project.dates || []), dateKey])].sort() };
  }
  let placed = false;
  const stages = st.map((x) => {
    if (!placed && !x.date && !x.done) { placed = true; return { ...x, date: dateKey }; }
    return x;
  });
  if (!placed) {
    const i = stages.findIndex((x) => !x.done);
    if (i >= 0) stages[i] = { ...stages[i], date: dateKey };
  }
  return { ...project, stages };
}

const stageCount = (p) => {
  const st = projectStages(p);
  return { done: st.filter((x) => x.done).length, total: st.length };
};

/* ---------------------------------------------------------------
   Chore cadence — when a recurring chore is due.
   No cadence on a chore means daily (back-compat with older data).
   { type: "daily" }
   { type: "weekly", days: [0..6] }          // 0 = Sunday
   { type: "monthly", dayOfMonth: 1..31 }    // clamps to month end
   { type: "interval", everyN: 2, start: "YYYY-MM-DD" }
--------------------------------------------------------------- */
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

function choreDueOn(chore, dateKey) {
  const c = chore.cadence;
  if (!c || c.type === "daily") return true;
  const d = parseYMD(dateKey);
  if (c.type === "weekly") return (c.days || []).includes(d.getDay());
  if (c.type === "monthly") {
    const want = Math.min(c.dayOfMonth || 1, daysInMonth(d.getFullYear(), d.getMonth()));
    return d.getDate() === want;
  }
  if (c.type === "interval") {
    const n = Math.max(1, c.everyN || 2);
    const start = parseYMD(c.start || dateKey);
    const diff = Math.round((d - start) / 86400000);
    return diff >= 0 && diff % n === 0;
  }
  return true;
}

/* ---------------------------------------------------------------
   Completion records live in chore.done, keyed by date:
     personId  -> completed by that person
     true      -> completed, person unknown (legacy data)
     "skipped" -> deliberately skipped; clears the day without
                  crediting anyone or advancing the rotation
   An empty string is never stored, since it would read as falsy.
--------------------------------------------------------------- */
// Completion marks used to be `true`, a person id, or "skipped". They may now
// also be a record carrying who ticked it off and how (lib/completion.js). The
// helpers there read every shape, so old documents keep working untouched.
const { SKIPPED, isSkipped, isCompletion } = COMPLETION;

// Who is ticking things off right now -- a signed-in member, or a shared
// display. Resolved against the document so an account can be matched to the
// person it belongs to.
const actorFor = (doc) => session.currentActor(doc);

// The most recent scheduled day strictly before dateKey.
function previousOccurrence(chore, dateKey, lookback = 400) {
  const t = parseYMD(dateKey);
  const floor = chore.createdOn || null;
  for (let i = 1; i <= lookback; i++) {
    const k = ymd(addDays(t, -i));
    if (floor && k < floor) return null;
    if (choreDueOn(chore, k)) return k;
  }
  return null;
}

/* The earliest occurrence still owed. Walks back and stops at either a
   completion or a skip, since both close out the chain — so this is "how long
   since this was last dealt with", not "since it was created". */
function oldestOwed(chore, dateKey, lookback = 400) {
  const t = parseYMD(dateKey);
  const floor = chore.createdOn || null;
  let owed = null;
  for (let i = 1; i <= lookback; i++) {
    const k = ymd(addDays(t, -i));
    if (floor && k < floor) break;
    if (chore.done?.[k]) break;                 // done or skipped: chain ends
    if (choreDueOn(chore, k)) owed = k;
  }
  return owed;
}

/* An unfinished occurrence carries forward as overdue even onto days that are
   themselves scheduled — a daily chore you skipped yesterday is both due today
   and late. It's still one chore, so it renders as a single row. */
function choreState(chore, dateKey) {
  const dueToday = choreDueOn(chore, dateKey);
  const mark = chore.done?.[dateKey];
  if (mark) return { dueToday, missedSince: null, active: dueToday, mark };
  const missedSince = oldestOwed(chore, dateKey);
  return { dueToday, missedSince, active: dueToday || !!missedSince, mark: null };
}

/* Every occurrence still owed, oldest first — what Skip needs to clear so the
   item actually goes away instead of surfacing again tomorrow. */
function owedOccurrences(chore, dateKey, lookback = 400) {
  const out = [];
  const t = parseYMD(dateKey);
  const floor = chore.createdOn || null;
  for (let i = 1; i <= lookback; i++) {
    const k = ymd(addDays(t, -i));
    if (floor && k < floor) break;
    if (chore.done?.[k]) break;
    if (choreDueOn(chore, k)) out.unshift(k);
  }
  if (choreDueOn(chore, dateKey) && !chore.done?.[dateKey]) out.push(dateKey);
  return out;
}

/* The most recent real completion — date and who. Skips are not completions. */

const lastDoneBy = (chore) => lastDoneEntry(chore)?.by ?? null;

/* Whose turn it is on a given day.

   Turns advance ONLY when someone actually completes it. If nobody does, the
   same person stays up — including on later days — so an unfinished chore keeps
   belonging to whoever owed it rather than sliding onto the other person. Once
   it's done, the next day shows the next person. Skips don't advance anything. */
const choreAssignee = (chore, dateKey) => ROT.assigneeFor(chore, dateKey || ymd(new Date()));
const isRotating = (chore) => ROT.isRotating(chore);
const lastDoneEntry = (chore, beforeKey) => {
  const last = ROT.lastCompletion(chore, beforeKey);
  return last ? { date: last.date, by: last.completion.by } : null;
};

// the next day this chore is actually scheduled, for previewing whose turn it'll be
function nextOccurrenceOf(chore, fromKey, cap = 400) {
  const t = parseYMD(fromKey);
  for (let i = 1; i <= cap; i++) {
    const k = ymd(addDays(t, i));
    if (choreDueOn(chore, k)) return k;
  }
  return fromKey;
}

function cadenceLabel(chore) {
  const c = chore.cadence;
  if (!c || c.type === "daily") return "Every day";
  if (c.type === "weekly") {
    const days = (c.days || []).slice().sort();
    if (!days.length) return "Weekly (no days set)";
    if (days.length === 7) return "Every day";
    if (days.length === 5 && days.every((x) => x >= 1 && x <= 5)) return "Weekdays";
    if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
    return days.map((x) => WD_SHORT[x]).join(", ");
  }
  if (c.type === "monthly") {
    const n = c.dayOfMonth || 1;
    const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `Monthly on the ${n}${suffix}`;
  }
  if (c.type === "interval") return `Every ${c.everyN || 2} days`;
  return "Every day";
}

/* ---------------------------------------------------------------
   Weather — Open-Meteo, no API key, CORS-friendly. Fetched in the
   browser and refreshed every 30 min. Never persisted (re-derivable).
--------------------------------------------------------------- */
// Default location and provider endpoints come from server config
// (WEATHER_LAT / WEATHER_LON / WEATHER_LABEL / WEATHER_UNIT), not literals
// baked into the bundle. A live getter so it reflects whatever the server
// reported at boot.
const dw = () => getConfig().defaultWeather;

// WMO weather interpretation codes → label + icon
function wmo(code) {
  const c = Number(code);
  if (c === 0) return { label: "Clear", Icon: Sun };
  if (c === 1) return { label: "Mostly clear", Icon: Sun };
  if (c === 2) return { label: "Partly cloudy", Icon: Cloud };
  if (c === 3) return { label: "Overcast", Icon: Cloud };
  if (c === 45 || c === 48) return { label: "Fog", Icon: CloudFog };
  if (c >= 51 && c <= 57) return { label: "Drizzle", Icon: CloudDrizzle };
  if (c >= 61 && c <= 67) return { label: "Rain", Icon: CloudRain };
  if (c >= 71 && c <= 77) return { label: "Snow", Icon: CloudSnow };
  if (c >= 80 && c <= 82) return { label: "Showers", Icon: CloudRain };
  if (c === 85 || c === 86) return { label: "Snow showers", Icon: CloudSnow };
  if (c >= 95) return { label: "Thunderstorms", Icon: CloudLightning };
  return { label: "—", Icon: Cloud };
}

function useWeather(cfg) {
  const c = cfg || dw();
  const [w, setW] = useState({ status: "loading" });
  const key = `${c.lat},${c.lon},${c.unit}`;
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const unit = c.unit === "c" ? "celsius" : "fahrenheit";
        const url = `${getConfig().weatherApiBase}?latitude=${c.lat}&longitude=${c.lon}`
          + `&current=temperature_2m,weather_code,apparent_temperature`
          + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max`
          + `&temperature_unit=${unit}&timezone=auto&forecast_days=3`;
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (!j.current) throw new Error("Unexpected response");
        if (!dead) setW({ status: "ok", data: j, at: Date.now() });
      } catch (e) {
        if (!dead) setW({ status: "error", message: e.message || "Request failed" });
      }
    };
    setW({ status: "loading" });
    load();
    const t = setInterval(load, 30 * 60 * 1000);
    return () => { dead = true; clearInterval(t); };
  }, [key]); // eslint-disable-line
  return w;
}

/* ---------------------------------------------------------------
   Countdowns — annual dates roll forward to their next occurrence.
--------------------------------------------------------------- */
function nextOccurrence(dateStr, annual, todayKey) {
  if (!dateStr) return null;
  if (!annual) return dateStr;
  const d = parseYMD(dateStr);
  const t = parseYMD(todayKey);
  let cand = ymd(new Date(t.getFullYear(), d.getMonth(), d.getDate()));
  if (cand < todayKey) cand = ymd(new Date(t.getFullYear() + 1, d.getMonth(), d.getDate()));
  return cand;
}
const daysBetween = (aKey, bKey) => Math.round((parseYMD(bKey) - parseYMD(aKey)) / 86400000);
const lateLabel = (n) => n <= 0 ? "Due today" : n === 1 ? "1 day late" : `${n} days late`;

function countdownLabel(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 7) return `in ${days} days`;
  if (days < 60) return `in ${days} days`;
  const mo = Math.round(days / 30);
  return `in about ${mo} month${mo !== 1 ? "s" : ""}`;
}

/* ---------------------------------------------------------------
   Data layer — everything the UI edits is one document on the server.
   Saves are debounced; while there are unsaved changes we stop polling
   so a background refresh can't clobber what someone is typing.
--------------------------------------------------------------- */
const SAVE_DEBOUNCE_MS = 600;
const POLL_MS = 15000;

function withDefaults(d) {
  const x = { ...d };
  if (!Array.isArray(x.people)) x.people = [];
  if (!Array.isArray(x.events)) x.events = [];
  x.meals = migrateMealsClient(x.meals || {});
  if (!Array.isArray(x.chores)) x.chores = [];
  if (!Array.isArray(x.tasks)) x.tasks = [];
  if (!Array.isArray(x.projects)) x.projects = [];
  x.checkin = { ...DEFAULT_CHECKIN, ...(x.checkin || {}) };
  if (!x.checkin.overrides) x.checkin.overrides = {};
  if (!x.checkin.log) x.checkin.log = {};
  if (!Array.isArray(x.grocery)) x.grocery = [];
  if (!Array.isArray(x.groceryStores)) x.groceryStores = ["Costco", "Aldi", "Target"];
  if (!x.grocerySort) x.grocerySort = "aisle";
  if (!x.groceryHistory || typeof x.groceryHistory !== "object") x.groceryHistory = {};
  if (!Array.isArray(x.notes)) x.notes = [];
  if (!Array.isArray(x.dates)) x.dates = [];
  if (!Array.isArray(x.calendars)) x.calendars = [];
  if (!x.secondBlock || typeof x.secondBlock !== "object") x.secondBlock = {};
  if (!Array.isArray(x.lists)) x.lists = [];
  if (!x.weather) x.weather = { ...dw() };
  if (!x.noteDisplay) x.noteDisplay = "overlay";
  if (x.showBreakdown === undefined) x.showBreakdown = true;
  if (x.upNextSources === undefined) {
    x.upNextSources = (x.upNextSource && x.upNextSource !== "all") ? [x.upNextSource] : null;
  }
  delete x.upNextSource;
  if (!x.householdName) x.householdName = "Our Home";
  return x;
}

function seed() {
  const wk = startOfWeek(new Date());
  const today = ymd(new Date());
  const day = (n) => ymd(addDays(wk, n));
  const ryan = uid(), steven = uid();
  return {
    householdName: getConfig().defaultHouseholdName || "Our Household",
    people: [
      { id: ryan, name: "Person A", color: "#2E9187" },
      { id: steven, name: "Person B", color: "#E86A4C" },
    ],
    events: [
      { id: uid(), title: "Farmers market", date: day(6), time: "09:00", personId: ryan },
      { id: uid(), title: "Dentist", date: day(3), time: "14:30", personId: steven },
      { id: uid(), title: "Movie night", date: day(5), time: "19:30", personId: "" },
    ],
    meals: { [day(1)]: { dinner: "Sheet-pan chicken" }, [day(3)]: { dinner: "Tacos" }, [day(5)]: { dinner: "Pizza + salad" } },
    chores: [
      { id: uid(), title: "Feed pets", personId: ryan, cadence: { type: "daily" }, createdOn: today, done: {} },
      { id: uid(), title: "Dishes", personId: steven, cadence: { type: "daily" }, createdOn: today, done: {} },
      { id: uid(), title: "Take out trash", personId: "", cadence: { type: "weekly", days: [1] }, createdOn: today, done: {} },
      { id: uid(), title: "Water plants", personId: ryan, cadence: { type: "interval", everyN: 3, start: today }, createdOn: today, done: {} },
    ],
    tasks: [
      { id: uid(), title: "Call plumber about sink", personId: ryan, date: ymd(new Date()), done: false },
      { id: uid(), title: "Renew car tabs", personId: steven, date: ymd(addDays(new Date(), 5)), done: false },
      { id: uid(), title: "Order new water filter", personId: "", date: "", done: false },
    ],
    // shared shopping list — not filtered by person, the whole household shares it
    grocery: [],
    groceryStores: ["Costco", "Aldi", "Target"],
    grocerySort: "aisle",
    groceryHistory: {},
    // fridge-door sticky notes, shared
    notes: [],                 // { id, text, color, personId, at }
    // countdowns to anniversaries, trips, deadlines
    dates: [],                 // { id, title, date, annual }
    agenda: [],                // things to discuss together — { id, text, personId, category, at, resolved }
    agendaArchive: [],
    status: {},
    agendaPrompts: [],
    dateJars: [...DEFAULT_DATE_JARS],
    dateIdeas: [],
    weather: { ...dw() },
    noteDisplay: "overlay",   // overlay | row | off
    showBreakdown: true,
    // which sources feed "Up next"; null = all of them
    upNextSources: null,
    calendars: [],
  };
}

/* ---------------------------------------------------------------
   Responsive: a Wall (row) layout for the mounted iPad and a
   Compact (stacked) layout for phones. "Auto" picks by width, but
   the display mode can be locked in Settings so a narrow-pane iPad
   still gets the wall dashboard.
--------------------------------------------------------------- */
const MobileCtx = createContext(false);
const useMobile = () => useContext(MobileCtx);
const AUTO_BP = 640;

/* The on-screen keyboard doesn't change window.innerHeight on iOS — it just
   covers the bottom of the page. So a vertically centred modal ends up with its
   input and Save button hidden underneath it. visualViewport reports the area
   that's actually visible, which is what we size against. */
const ViewportCtx = createContext({ height: 0, offsetTop: 0, keyboardOpen: false });
const useViewport = () => useContext(ViewportCtx);
// browser chrome sliding away also shrinks the viewport; only a big change is a keyboard
const KEYBOARD_MIN_PX = 120;

function useViewportMetrics() {
  const read = () => {
    if (typeof window === "undefined") return { height: 0, offsetTop: 0, keyboardOpen: false };
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const covered = Math.max(0, window.innerHeight - height);
    return { height, offsetTop: vv ? vv.offsetTop : 0, keyboardOpen: covered > KEYBOARD_MIN_PX };
  };
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const on = () => setVp(read());
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", on);
      vv.addEventListener("scroll", on);
    }
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    on();
    return () => {
      if (vv) { vv.removeEventListener("resize", on); vv.removeEventListener("scroll", on); }
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
    };
  }, []);
  return vp;
}

/* Keep whatever is focused above the keyboard. Browsers do this inconsistently
   for elements inside a scrolling container, so nudge it ourselves. */
function useKeepFocusVisible(keyboardOpen) {
  useEffect(() => {
    const onFocus = (e) => {
      const el = e.target;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      // wait for the keyboard animation to settle before measuring
      setTimeout(() => {
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
      }, 250);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [keyboardOpen]);
}

function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    on();
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/* =============================================================== */
export default function HouseholdHub() {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("today");
  const [now, setNow] = useState(new Date());
  const [weekAnchor, setWeekAnchor] = useState(ymd(startOfWeek(new Date())));
  const [filter, setFilter] = useState("all"); // 'all' | personId
  const [viewOffset, setViewOffset] = useState(0); // days from today, for the Today screen
  // Who is signed in. Held by lib/session.js, not by the document -- a member
  // is an account on this server, not a "person" row in the household.
  const [sessionUser, setSessionUser] = useState(() => session.snapshot().user);
  // The Home tab appears only once this household has plugged in its own Home
  // Assistant -- it is per household, not a property of the server.
  const [homeConnected, setHomeConnected] = useState(false);
  useEffect(() => {
    if (session.isDisplay()) {
      setHomeConnected((session.snapshot().displayScopes || []).includes("home"));
      return;
    }
    if (!session.householdId()) return;
    session.request("GET", `api/households/${session.householdId()}/home`)
      .then((c) => setHomeConnected(Boolean(c.connected)))
      .catch(() => setHomeConnected(false));
  }, []);
  useEffect(() => session.onChange((s) => setSessionUser(s.user)), []);

  /* A display must not sit on a tab it was never granted. The tab bar hides
     them, but the default ("today") would otherwise still render for a screen
     scoped to, say, the calendar alone. */
  useEffect(() => {
    if (!session.isDisplay()) return;
    const scopes = session.snapshot().displayScopes || [];
    const allowed = (id) => !TAB_SCOPE[id] || scopes.includes(TAB_SCOPE[id]);
    if (allowed(tab)) return;
    const first = ["today", "calendar", "meals", "chores", "grocery", "agenda", "board", "home"]
      .find(allowed);
    if (first) setTab(first);
  }, [tab]);

  const [modal, setModal] = useState(null);
  const width = useWindowWidth();
  const vp = useViewportMetrics();
  useKeepFocusVisible(vp.keyboardOpen);
  const weather = useWeather(data?.weather);

  const [importedEvents, setImportedEvents] = useState([]);
  /* Calendars a CalDAV account has said we may write to. Kept in App rather
     than in the panel because the project editor needs the same list: "which
     synced calendar does this belong on" is the same question. */
  const [syncTargets, setSyncTargets] = useState([]);
  const [conn, setConn] = useState("connecting"); // connecting | ok | saving | error
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const latest = useRef(null);

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [st, evs] = await Promise.all([loadState(), loadCalendarEvents()]);
        setData(withDefaults(st));
        setImportedEvents(evs);
        setConn("ok");
      } catch (e) {
        console.error("Load failed", e);
        setConn("error");
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // clock
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);

  // pick up other devices' changes, but never mid-edit
  useEffect(() => {
    const t = setInterval(async () => {
      if (dirty.current) return;
      try {
        const [st, evs] = await Promise.all([loadState(), loadCalendarEvents()]);
        if (dirty.current) return;          // a local edit landed while we waited
        setData(withDefaults(st));
        setImportedEvents(evs);
        setConn("ok");
      } catch (e) {
        setConn("error");
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const flush = useCallback(async () => {
    const payload = latest.current;
    if (!payload) return;
    setConn("saving");
    try {
      await saveState(payload);
      dirty.current = false;
      setConn("ok");
    } catch (e) {
      console.error("Save failed", e);
      setConn("error");
    }
  }, []);

  /**
   * Save right now, and tell the caller whether it worked.
   *
   * `update` is fire-and-forget: it queues a debounced save and `flush` swallows
   * any failure into a connection indicator. That is right for ordinary edits --
   * a chore tick should not throw a dialogue at somebody -- but wrong for an
   * action that reports "imported successfully" afterwards. A confirmation that
   * appears before the save completes, or despite the save failing, is a lie.
   *
   * The payload is passed in rather than read from `latest`, because React runs
   * a state updater during render rather than at the call site, so `latest` is
   * not reliably set yet at the moment the caller wants to persist.
   */
  const saveNow = useCallback(async (payload) => {
    clearTimeout(saveTimer.current);
    const doc = payload || latest.current;
    if (!doc) return;
    latest.current = doc;
    setConn("saving");
    try {
      await saveState(doc);
      dirty.current = false;
      setConn("ok");
    } catch (e) {
      setConn("error");
      throw e;                 // the caller is showing a confirmation
    }
  }, []);

  /* Refusals surfaced here rather than thrown.
     
     An updater that throws does so inside setData, which React treats as an
     error during render: it unmounts the tree and the page goes blank until
     somebody reloads. That is exactly what happened when a display tried to
     un-tick a completion it was not allowed to touch -- completion.js throws a
     perfectly sensible message, and the screen went white.
     
     So `update` catches. A refused change leaves the document untouched and the
     reason appears as a notice. No updater anywhere can blank the app again. */
  const [actionError, setActionError] = useState(null);

  const update = useCallback((fn) => {
    setData((d) => {
      let next;
      try {
        next = fn({ ...d });
      } catch (err) {
        // Cannot call setState from inside an updater; defer it by a tick.
        queueMicrotask(() => setActionError(err?.message || "That change was not allowed."));
        return d;
      }
      latest.current = next;
      dirty.current = true;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, [flush]);

  // don't lose a pending save if the tab closes
  useEffect(() => {
    const onHide = () => { if (dirty.current) flush(); };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flush]);

  // After the server adds/refreshes/removes a feed, pull just the calendar list
  // and the expanded events. Everything else in the document is left untouched so
  // this can't stomp on an edit in progress.
  const syncCalendars = useCallback(async () => {
    try {
      const [st, evs] = await Promise.all([loadState(), loadCalendarEvents()]);
      setData((d) => (d ? { ...d, calendars: st.calendars } : withDefaults(st)));
      setImportedEvents(evs);
      setConn("ok");
    } catch (e) {
      console.error("Calendar sync failed", e);
      setConn("error");
    }
  }, []);

  const todayKey = ymd(now);
  const viewKey = ymd(addDays(now, viewOffset));
  // declared before the loading guard so the check-in scheduler can read it
  /* Dated project stages are shown on the calendar as well. Derived on read,
     never stored -- the project stays the one record of what is planned, and
     the calendar is a view of it. */
  useEffect(() => {
    if (!data || session.isDisplay()) return;
    let live = true;
    loadCaldav()
      .then((r) => {
        if (!live) return;
        setSyncTargets((r.accounts || []).flatMap((a) =>
          a.calendars.filter((c) => c.pushEnabled).map((c) => ({ id: c.id, name: c.name, writable: c.writable }))));
      })
      .catch(() => { /* not configured, or not permitted -- the picker just stays empty */ });
    return () => { live = false; };
  }, [data?.householdName]);

    const allEvents = data
    ? [...(data.events || []), ...importedEvents, ...projectEvents(data.projects)]
    : [];

  /* ---- time-of-day reminders ----
     Anything with an alert time that is past due and still unticked. Recomputed
     off `now`, which already ticks, so no second timer is needed; the chime
     fires only when a new escalation step is crossed rather than every render.

     Snoozes come from data.alertSnooze, which is part of the synced document,
     so silencing one on a phone also quiets the tablet in the hall. */
  const alertChime = useChime(data?.checkin?.soundOn !== false, "alert");
  const lastChime = useRef({});

  const activeAlerts = data
    ? dueAlerts(data, todayKey, now.getHours() * 60 + now.getMinutes(),
        { dueOn: choreDueOn, assigneeOf: choreAssignee })
    : [];

  useEffect(() => {
    for (const a of activeAlerts) {
      const step = escalationStep(a.alert, a.overdue);   // step 0 at the due minute
      if (lastChime.current[a.key] !== step) {
        lastChime.current[a.key] = step;
        alertChime();
      }
    }
    // forget anything no longer sounding, so it chimes again next time it does
    const live = new Set(activeAlerts.map((a) => a.key));
    for (const k of Object.keys(lastChime.current)) if (!live.has(k)) delete lastChime.current[k];
  }, [activeAlerts.map((a) => a.key + ":" + escalationStep(a.alert, a.overdue)).join(",")]); // eslint-disable-line

  /* Phone reminders, if the household set one up. Sent from here rather than
     from the server, which cannot read any of this -- see lib/relay.js. The
     "already sent" bookkeeping lives in the document so two awake devices do
     not both send the same push. */
  useEffect(() => {
    if (!data || !RELAY.relayConfigured(data)) return;
    const live = new Set(activeAlerts.map((a) => a.key));
    const pending = activeAlerts.filter(
      (a) => !RELAY.alreadySent(data, a.key, escalationStep(a.alert, a.overdue)));
    if (!pending.length) {
      // Still worth tidying: bookkeeping for finished reminders would otherwise
      // accumulate in the document forever.
      update((d) => RELAY.pruneRelayed(d, live));
      return;
    }
    let cancelled = false;
    (async () => {
      for (const a of pending) {
        const step = escalationStep(a.alert, a.overdue);
        const ok = await RELAY.sendReminder(data.reminderRelay, a);
        if (cancelled) return;
        // Only record a send that actually happened, so a push service that was
        // briefly down gets retried on the next tick instead of being skipped.
        if (ok) update((d) => RELAY.recordSent(RELAY.pruneRelayed(d, live), a.key, step));
      }
    })();
    return () => { cancelled = true; };
  }, [activeAlerts.map((a) => a.key + ":" + escalationStep(a.alert, a.overdue)).join(","),
      data?.reminderRelay?.enabled, data?.reminderRelay?.endpoint]); // eslint-disable-line

  /* Ticking from a reminder has to go through the same completion machinery as
     ticking from the list. Writing the mark directly here would skip the
     archive, drop the actor, and quietly produce a completion that nobody is
     allowed to undo -- so the fast path would corrupt exactly the records the
     archive exists to keep honest. */
  const alertDone = (a) => update((d) => {
    if (a.kind === "chore") {
      return COMPLETION.toggleChore(d, a.id, todayKey, actorFor(d), { assigneeOf: choreAssignee });
    }
    d.tasks = d.tasks.map((t) => t.id === a.id ? { ...t, done: true, doneAt: todayKey } : t);
    return d;
  });
  const alertSnooze = (a, mins) => update((d) => {
    d.alertSnooze = { ...(d.alertSnooze || {}), [a.key]: Date.now() + mins * 60000 };
    return d;
  });
  const alertSkip = (a) => update((d) => {
    if (a.kind === "chore") {
      d.chores = d.chores.map((c) => {
        if (c.id !== a.id) return c;
        const done = { ...c.done };
        for (const k of owedOccurrences(c, todayKey)) done[k] = SKIPPED;
        return { ...c, done };
      });
    } else {
      d.tasks = d.tasks.map((t) => t.id === a.id
        ? { ...t, date: ymd(addDays(parseYMD(t.date || todayKey), 1)) } : t);
    }
    return d;
  });
  /* "It was actually Sam." Second-hand by definition -- whoever is tapping is
     not the person being credited -- so it is recorded as such and stays open
     to correction, rather than forging a first-person claim in the archive. */
  const alertCredit = (a, personId) => update((d) => {
    if (a.kind === "chore") {
      return COMPLETION.completeOnBehalf(d, a.id, todayKey, personId, actorFor(d), { assigneeOf: choreAssignee });
    }
    d.tasks = d.tasks.map((t) => t.id === a.id
      ? { ...t, personId, done: true, doneAt: todayKey } : t);
    return d;
  });
  // split by how insistent each one asked to be
  const popupAlerts = activeAlerts.filter((a) => (a.alert.style || "banner") === "popup");
  const bannerAlerts = activeAlerts.filter((a) => (a.alert.style || "banner") !== "popup");

  /* The check-in reminder. No push service or notification permission needed:
     the wall tablet already has this page open, so at the appointed minute it
     chimes and opens the check-in itself. Fires once a night, and not if the
     check-in is already done. */
  const plan = data ? checkinPlan(data, todayKey, allEvents) : null;
  const chime = useChime(data?.checkin?.soundOn !== false);
  const firedFor = useRef("");
  useEffect(() => {
    if (!data || !plan) return;
    if (checkinDoneFor(data, todayKey)) return;
    if (firedFor.current === todayKey) return;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dueMin = minutesOf(plan.time);
    // only inside a short window, so reopening the app late at night doesn't pounce
    if (dueMin === null || nowMin < dueMin || nowMin > dueMin + 30) return;
    firedFor.current = todayKey;
    chime();
    setModal({ type: "checkin" });
  }, [data, todayKey, now, plan?.time]); // eslint-disable-line


  if (!loaded) {
    return <div style={{ fontFamily: BODY, background: T.bg, color: T.sub }}
      className="w-full h-screen flex items-center justify-center text-lg">Loading your hub…</div>;
  }
  if (!data) {
    return (
      <div style={{ fontFamily: BODY, background: T.bg, color: T.ink }}
        className="w-full h-screen flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Cloud size={40} style={{ color: T.faint }} />
        <h1 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Can't reach the hub</h1>
        <p style={{ color: T.sub, maxWidth: 420 }}>
          The app loaded but the server didn't answer. Check that the backend is running,
          then reload.
        </p>
        <button onClick={() => window.location.reload()} className="tapfade mt-2 px-5 py-3 rounded-2xl font-semibold"
          style={{ background: T.brand, color: "#fff" }}>Reload</button>
      </div>
    );
  }

  const people = data.people;
  const layoutMode = data.layoutMode || "auto";
  const isMobile = layoutMode === "wall" ? false : layoutMode === "compact" ? true : width < AUTO_BP;
  const personById = (id) => people.find((p) => p.id === id);
  const weekStart = parseYMD(weekAnchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // filter: keep item if viewing everyone, or item belongs to person, or item is shared (no person)
  const inFilter = (personId) => filter === "all" || personId === filter || !personId;
  const colorFor = (ev) => personById(ev.personId)?.color || (ev.source === "ics" ? ev.color : null) || T.faint;

  const greeting = (() => { const h = now.getHours(); return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; })();
  // Counts follow the day on screen, so stepping to another day shows that day's picture.
  const choresLeftToday = data.chores.filter((c) => inFilter(choreAssignee(c, viewKey)) && choreState(c, viewKey).active && !c.done[viewKey]).length;
  const taskDueToday = (t) => !t.done && t.date && t.date <= viewKey; // due that day or earlier
  const projectsToday = (data.projects || []).filter((pr) => inFilter(pr.personId)
    && projectOpen(pr) && (projectOn(pr, viewKey) || (viewKey === todayKey && projectCarried(pr, todayKey)))).length;
  const todosLeftToday = choresLeftToday
    + data.tasks.filter((t) => inFilter(t.personId) && taskDueToday(t)).length
    + projectsToday;
  const groceryLeft = data.grocery.filter((g) => !g.done).length;
  const noteCount = data.notes.length;
  // Unticked items across every list — what is actually outstanding.
  const listsOpen = LISTS.listsOf(data)
    .reduce((n, l) => n + LISTS.itemsOf(l).filter((i) => !i.done).length, 0);
  const agendaOpen = data.agenda.filter((a) => !a.resolved).length;
  const overdueTotal = data.chores.filter((c) => inFilter(choreAssignee(c, viewKey)) && !c.done[viewKey] && choreState(c, viewKey).missedSince).length
    + data.tasks.filter((t) => inFilter(t.personId) && !t.done && t.date && t.date < viewKey).length;

  return (
    <MobileCtx.Provider value={isMobile}>
    <ViewportCtx.Provider value={vp}>
    {/* height follows the visible area, so opening the keyboard compresses the
        layout instead of pushing content underneath it */}
    <div style={{ fontFamily: BODY, background: T.bg, color: T.ink, height: vp.height ? `${vp.height}px` : "100vh" }}
      className="w-full flex flex-col overflow-hidden select-none">
      <style>{`
        *::-webkit-scrollbar{width:9px;height:9px}
        *::-webkit-scrollbar-thumb{background:${T.line};border-radius:9px}
        *::-webkit-scrollbar-track{background:transparent}
        input,textarea,select{user-select:text;-webkit-user-select:text}
        .tapfade{transition:transform .12s ease, background .15s ease, opacity .15s ease}
        .tapfade:active{transform:scale(.97)}
        @keyframes hubshake{0%,100%{transform:rotate(0)}20%{transform:rotate(-14deg)}40%{transform:rotate(12deg)}60%{transform:rotate(-8deg)}80%{transform:rotate(6deg)}}
        @media (prefers-reduced-motion: reduce){.tapfade{transition:none}
          [style*="hubshake"]{animation:none !important}}
      `}</style>

      <Header now={now} greeting={greeting} householdName={data.householdName}
        checkin={{ plan, done: checkinDoneFor(data, todayKey), open: () => setModal({ type: "checkin" }) }} conn={conn}
        onSettings={() => setModal({ type: "settings" })} />

      {/* A change the rules refused. Shown, then dismissed -- the alternative
          was the page going blank, which told nobody anything. */}
      {actionError && (
        <div role="alert" className="shrink-0 px-3 md:px-4 pt-2">
          <div className="rounded-2xl px-3.5 py-2.5 flex items-center gap-3"
            style={{ background: "#fdecea", border: "1px solid #f0b4ae", color: "#7a1c12" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }} className="flex-1">{actionError}</span>
            <button onClick={() => setActionError(null)} aria-label="Dismiss"
              className="tapfade shrink-0 px-3 py-1 rounded-full"
              style={{ background: "#7a1c1218", fontSize: 12.5, fontWeight: 700 }}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <AlertBanner alerts={bannerAlerts} people={people} onDone={alertDone} onSkip={alertSkip}
        onSnooze={alertSnooze} onCredit={alertCredit} />

      <GlanceStrip data={data} allEvents={allEvents} now={now} viewKey={viewKey} personById={personById} weather={weather}
        inFilter={inFilter} filter={filter} todosLeft={todosLeftToday} overdueTotal={overdueTotal} onGoto={setTab} hidden={isMobile} />

      <TabBar tab={tab} setTab={setTab} todosLeft={todosLeftToday} groceryLeft={groceryLeft} noteCount={noteCount} agendaOpen={agendaOpen} listsOpen={listsOpen} homeOn={homeConnected}
        people={people} filter={filter} setFilter={setFilter} />

      <main className={`flex-1 min-h-0 px-3 md:px-5 ${tab === "today" && !isMobile ? "overflow-hidden pb-3" : "overflow-y-auto pb-6"}`}
        style={{ background: T.bg }}>
        {tab === "today" && (
          <>
          <TodayView data={data} allEvents={allEvents} now={now} personById={personById}
            todayKey={todayKey} viewKey={viewKey} viewOffset={viewOffset} setViewOffset={setViewOffset}
            filter={filter} inFilter={inFilter} colorFor={colorFor} update={update}
            taskDueToday={taskDueToday}
            openMeal={(k, slot) => setModal({ type: "meal", key: k, slot })}
            openEvent={() => setModal({ type: "event", payload: { date: todayKey } })}
            viewEvent={(ev) => setModal({ type: "viewEvent", payload: ev })}
            openNote={(n) => setModal({ type: "note", payload: n || {} })}
            gotoBoard={() => setTab("board")}
            openProject={(pr) => setModal({ type: "project", payload: pr || {} })}
            openTask={(t) => setModal({ type: "task", payload: t || {} })}
            openChore={(c) => setModal({ type: "chore", payload: c || {} })}
            openChoreDay={(c, key) => setModal({ type: "choreDay", choreId: c.id, dateKey: key })} />
          {/* Whatever this household actually looks at on the way out of the
              door: the shopping list, the back garden, the date jar. Chosen per
              person filter -- see components/SecondBlock.jsx. */}
          <SecondBlock data={data} update={update} filter={filter} theme={T} />
          </>
        )}
        {tab === "calendar" && (
          <CalendarView weekDays={weekDays} allEvents={allEvents} personById={personById} colorFor={colorFor}
            todayKey={todayKey} inFilter={inFilter}
            shiftWeek={(n) => setWeekAnchor(ymd(addDays(weekStart, n * 7)))}
            resetWeek={() => setWeekAnchor(ymd(startOfWeek(new Date())))}
            openEvent={(d) => setModal({ type: "event", payload: { date: d } })}
            editEvent={(ev) => setModal({ type: ev.source === "ics" ? "viewEvent" : "event", payload: ev })} />
        )}
        {tab === "meals" && (
          <MealsView weekDays={weekDays} data={data} todayKey={todayKey} personById={personById} filter={filter}
            shiftWeek={(n) => setWeekAnchor(ymd(addDays(weekStart, n * 7)))}
            resetWeek={() => setWeekAnchor(ymd(startOfWeek(new Date())))}
            openMeal={(k, slot) => setModal({ type: "meal", key: k, slot })} />
        )}
        {tab === "grocery" && (
          <GroceryView data={data} update={update} />
        )}
        {tab === "agenda" && (
          <AgendaView data={data} update={update} personById={personById}
            openCheckin={() => setModal({ type: "checkin" })} />
        )}
        {tab === "home" && (
          <HomeView data={data} />
        )}
        {tab === "lists" && (
          <ListsView data={data} update={update} personById={personById} />
        )}
        {tab === "board" && (
          <BoardView data={data} update={update} personById={personById} todayKey={todayKey}
            openNote={(n) => setModal({ type: "note", payload: n || {} })}
            openDate={(dt) => setModal({ type: "date", payload: dt || {} })} />
        )}
        {tab === "chores" && (
          <ToDosView data={data} personById={personById} todayKey={todayKey} inFilter={inFilter}
            update={update} taskDueToday={taskDueToday}
            openChore={(c) => setModal({ type: "chore", payload: c || {} })}
            openTask={(t) => setModal({ type: "task", payload: t || {} })}
            openProject={(pr) => setModal({ type: "project", payload: pr || {} })}
            openHistory={() => setModal({ type: "history" })} />
        )}
      </main>

      {modal?.type === "event" && <EventModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "viewEvent" && <ViewEventModal ev={modal.payload} personById={personById} close={() => setModal(null)} />}
      {modal?.type === "meal" && <MealModal mealKey={modal.key} slot={modal.slot} data={data} update={update} close={() => setModal(null)} />}
      {modal?.type === "chore" && <ChoreModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "choreDay" && (() => {
        // Read the chore out of the live document rather than trusting the
        // payload: it may have been ticked off from another device since.
        const c = (data.chores || []).find((x) => x.id === modal.choreId);
        return c ? (
          <ChoreDayModal chore={c} dateKey={modal.dateKey} people={people} personById={personById}
            update={update} close={() => setModal(null)}
            openChore={(ch) => setModal({ type: "chore", payload: ch })} />
        ) : null;
      })()}
      {modal?.type === "task" && <TaskModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "project" && <ProjectModal payload={modal.payload} people={people} update={update} calendars={syncTargets} close={() => setModal(null)} />}
      {modal?.type === "history" && <HistoryModal data={data} update={update} personById={personById} close={() => setModal(null)} />}
      {modal?.type === "note" && <NoteModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "date" && <DateModal payload={modal.payload} update={update} close={() => setModal(null)} />}
      {modal?.type === "checkin" && (
        <CheckInOverlay data={data} update={update} personById={personById} allEvents={allEvents}
          todayKey={todayKey} onOpenMeal={(k) => setModal({ type: "meal", key: k, slot: "dinner" })}
          close={() => setModal(null)} />
      )}
      {modal?.type === "settings" && <SettingsModal data={data} update={update} saveNow={saveNow} syncCalendars={syncCalendars} close={() => setModal(null)} currentUser={sessionUser} />}

      {/* Last, so it covers the modals too — a takeover that a settings panel
          could sit on top of would not be a takeover. */}
      <AlertPopup alerts={popupAlerts} people={people} onDone={alertDone} onSkip={alertSkip}
        onSnooze={alertSnooze} onCredit={alertCredit} />
    </div>
    </ViewportCtx.Provider>
    </MobileCtx.Provider>
  );
}

/* ---------------- Header ---------------- */
function Header({ now, greeting, householdName, onSettings, conn, checkin }) {
  const isMobile = useMobile();
  const hr = now.getHours();
  const wash = hr < 12 ? "linear-gradient(120deg,#FDF6E8,#F3EDE2)" : hr < 17 ? "linear-gradient(120deg,#FBF1E2,#F3EDE2)" : "linear-gradient(120deg,#EFE7E5,#F3EDE2)";
  return (
    <header className="px-4 md:px-6 pt-3 pb-2.5 flex items-end justify-between gap-3 shrink-0" style={{ background: wash, borderBottom: `1px solid ${T.line}` }}>
      <div style={{ fontFamily: DISPLAY }} className="leading-none min-w-0">
        <div style={{ color: T.brand, fontSize: isMobile ? 11 : 15, letterSpacing: isMobile ? 1 : 2, fontWeight: 600 }} className="uppercase mb-1 truncate">
          {householdName} · {isMobile ? WD_SHORT[now.getDay()] : WD_LONG[now.getDay()]}
        </div>
        <div style={{ fontSize: isMobile ? 28 : 40, fontWeight: 600, color: T.ink }} className="leading-none">{MO_LONG[now.getMonth()]} {now.getDate()}</div>
      </div>
      <div className="flex items-center gap-3 md:gap-6 shrink-0">
        <div className="text-right">
          <div style={{ color: T.sub, fontSize: isMobile ? 11 : 14, fontWeight: 600 }} className="uppercase tracking-wide">{greeting}</div>
          <div style={{ fontFamily: DISPLAY, fontSize: isMobile ? 22 : 28, fontWeight: 500, color: T.ink }} className="leading-none tabular-nums">
            {fmtTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`)}
          </div>
        </div>
        {conn === "error" && (
          <span className="rounded-full px-3 py-1.5 flex items-center gap-1.5" title="Can't reach the server — changes are only on this device until it reconnects"
            style={{ background: "#E86A4C1F", color: "#B4442A", fontSize: 12.5, fontWeight: 800 }}>
            <Cloud size={14} /> Offline
          </span>
        )}
        {checkin?.plan && (
          <button onClick={checkin.open}
            title={checkin.done ? "Check-in done for tonight" : `Check-in at ${fmtTime(checkin.plan.time)} — ${checkin.plan.reason}`}
            className="tapfade rounded-full px-3 py-2 flex items-center gap-1.5"
            style={{
              background: checkin.done ? T.brandSoft : T.panel,
              border: `1px solid ${checkin.done ? T.brand : T.line}`,
              color: checkin.done ? T.brandInk : T.sub,
            }}>
            {checkin.done ? <CheckCircle2 size={15} /> : <BellRing size={15} />}
            <span style={{ fontSize: 12.5, fontWeight: 700 }} className="tabular-nums">{fmtTime(checkin.plan.time)}</span>
          </button>
        )}
        <button onClick={onSettings} aria-label="Settings" className="tapfade rounded-full p-2.5 md:p-3" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>
          <Settings size={isMobile ? 20 : 22} />
        </button>
      </div>
    </header>
  );
}

/* ---------------- Glance strip ---------------- */
function GlanceStrip({ data, allEvents, now, viewKey, personById, inFilter, filter, todosLeft, overdueTotal, onGoto, hidden, weather }) {
  if (hidden) return null;
  const isToday = viewKey === ymd(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // "Up next" can be limited to a chosen set of calendars. An empty or missing
  // list means every source, so it works before anything is connected.
  const picked = Array.isArray(data.upNextSources) ? data.upNextSources : null;
  const usingAll = !picked || picked.length === 0;
  const fromChosenSource = (e) =>
    usingAll ? true : picked.includes(e.source === "ics" ? e.calId : "local");

  const dayEvents = allEvents.filter((e) => e.date === viewKey && inFilter(e.personId) && fromChosenSource(e));
  const timed = dayEvents.filter((e) => e.time)
    .map((e) => ({ ...e, min: +e.time.split(":")[0] * 60 + +e.time.split(":")[1] }));
  // on today, prefer what's still ahead; on any other day just show the first thing
  const upNext = (isToday
    ? timed.filter((e) => e.min >= nowMin - 30).sort((a, b) => a.min - b.min)[0]
    : timed.sort((a, b) => a.min - b.min)[0])
    || dayEvents.sort((a, b) => (a.time || "").localeCompare(b.time || ""))[0];

  const srcLabel = (() => {
    if (usingAll) return "Up next";
    if (picked.length === 1) {
      const only = picked[0];
      if (only === "local") return "Up next · added here";
      return `Up next · ${(data.calendars.find((c) => c.id === only) || {}).name || "calendar"}`;
    }
    return `Up next · ${picked.length} calendars`;
  })();

  // prefer whoever's being viewed, then a shared meal, then anything planned
  const dinnerRows = mealEntries(data, viewKey, "dinner").filter((e) => entryVisible(e, filter));
  const pick = dinnerRows.find((e) => filter !== "all" && e.personId === filter)
    || dinnerRows.find((e) => !e.personId) || dinnerRows[0];
  const dinner = pick?.title;
  const dinnerCook = personById(pick?.cookId);
  const dinnerTime = pick?.time;
  const dinnerWho = personById(pick?.personId);
  const extraDinners = Math.max(0, dinnerRows.length - 1);

  const Cell = ({ icon, label, value, sub, accent, onClick }) => (
    <button onClick={onClick} className="tapfade flex-1 flex items-center gap-2.5 px-4 py-2.5 text-left rounded-2xl min-w-0" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
      <div className="rounded-xl p-1.5 shrink-0" style={{ background: (accent || T.brand) + "1A", color: accent || T.brand }}>{icon}</div>
      <div className="min-w-0">
        <div style={{ color: T.sub, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8 }} className="uppercase truncate">{label}</div>
        <div style={{ color: T.ink, fontSize: 15.5, fontWeight: 600 }} className="truncate">{value}</div>
        {sub && <div style={{ fontSize: 11.5, fontWeight: 600 }} className="truncate">{sub}</div>}
      </div>
    </button>
  );

  return (
    <div className="px-4 md:px-6 py-2 flex gap-2.5 shrink-0" style={{ background: T.bg }}>
      <WeatherCell weather={weather} label={data.weather?.label} />
      <Cell icon={<Clock size={18} />} label={srcLabel}
        value={upNext ? `${upNext.time ? fmtTime(upNext.time) + " · " : ""}${upNext.title}` : "Nothing scheduled"}
        accent={upNext ? (personById(upNext.personId)?.color || (upNext.source === "ics" ? upNext.color : T.brand)) : T.faint}
        onClick={() => onGoto("calendar")} />
      <Cell icon={<UtensilsCrossed size={18} />} label={isToday ? "Tonight's dinner" : "Dinner"}
        value={dinner || "Not planned yet"}
        sub={dinner
          ? <span style={{ color: dinnerCook ? dinnerCook.color : T.sub }}>
              {[
                dinnerTime ? fmtTime(dinnerTime) : null,
                pick?.togo ? "to-go" : null,
                dinnerCook ? `${dinnerCook.name} cooks` : null,
                dinnerWho ? `for ${dinnerWho.name}` : null,
                extraDinners ? `+${extraDinners} more` : null,
              ].filter(Boolean).join(" · ")}
            </span>
          : null}
        accent={dinner ? T.gold : T.faint} onClick={() => onGoto("meals")} />
      <Cell icon={<CheckCircle2 size={18} />} label={overdueTotal > 0 ? "To-dos · overdue" : "To-dos left"}
        value={overdueTotal > 0 ? `${overdueTotal} overdue · ${todosLeft} left` : todosLeft === 0 ? "All done 🎉" : `${todosLeft} remaining`}
        accent={overdueTotal > 0 ? "#E86A4C" : todosLeft === 0 ? T.brand : T.gold} onClick={() => onGoto("chores")} />
    </div>
  );
}

function WeatherCell({ weather, label }) {
  const base = { background: T.panel, border: `1px solid ${T.line}` };
  if (weather.status === "loading") {
    return (
      <div className="flex-1 flex items-center gap-3 px-5 py-3 rounded-2xl min-w-0" style={base}>
        <div className="rounded-xl p-2 shrink-0" style={{ background: T.brand + "1A", color: T.brand }}><Thermometer size={20} /></div>
        <div className="min-w-0">
          <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase">Weather</div>
          <div style={{ color: T.faint, fontSize: 17, fontWeight: 600 }}>Loading…</div>
        </div>
      </div>
    );
  }
  if (weather.status === "error") {
    return (
      <div className="flex-1 flex items-center gap-3 px-5 py-3 rounded-2xl min-w-0" style={base}>
        <div className="rounded-xl p-2 shrink-0" style={{ background: T.faint + "22", color: T.faint }}><Cloud size={20} /></div>
        <div className="min-w-0">
          <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase">Weather</div>
          <div style={{ color: T.faint, fontSize: 15, fontWeight: 600 }} className="truncate">No connection</div>
        </div>
      </div>
    );
  }
  const cur = weather.data.current;
  const day = weather.data.daily;
  const { label: cond, Icon } = wmo(cur.weather_code);
  const hi = Math.round(day?.temperature_2m_max?.[0]);
  const lo = Math.round(day?.temperature_2m_min?.[0]);
  const pop = day?.precipitation_probability_max?.[0];
  return (
    <div className="flex-1 flex items-center gap-3 px-5 py-3 rounded-2xl min-w-0" style={base}>
      <div className="rounded-xl p-2 shrink-0" style={{ background: T.gold + "1A", color: T.gold }}><Icon size={20} /></div>
      <div className="min-w-0">
        <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase truncate">{label || "Weather"}</div>
        <div style={{ color: T.ink, fontSize: 17, fontWeight: 600 }} className="truncate">
          {Math.round(cur.temperature_2m)}° {cond}
        </div>
        <div style={{ color: T.sub, fontSize: 12, fontWeight: 600 }} className="truncate">
          H {hi}° · L {lo}°{pop > 15 ? ` · ${pop}% precip` : ""}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Countdown strip (Today screen) ----------------
   Deliberately one line only — it must never wrap and steal height
   from the three columns below it. Overflow scrolls sideways.        */
export function CountdownStrip({ dates, todayKey }) {
  const upcoming = (dates || [])
    .map((d) => {
      const when = nextOccurrence(d.date, d.annual, todayKey);
      return when ? { ...d, when, days: daysBetween(todayKey, when) } : null;
    })
    .filter((d) => d && d.days >= 0 && d.days <= 120)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);
  if (!upcoming.length) return null;
  return (
    <div className="flex gap-1.5 flex-nowrap overflow-x-auto pt-1.5" style={{ scrollbarWidth: "none" }}>
      {upcoming.map((d) => {
        /* Red inside a week, amber inside a fortnight, quiet after that. The
           chip is also given a heavier border when it is urgent, because on a
           wall display across a room colour alone is not enough. */
        const u = styleFor(urgencyOf(d.days));
        return (
          <div key={d.id} className="shrink-0 flex items-center gap-1.5 rounded-full px-2.5 py-1 whitespace-nowrap"
            style={{ background: u.bg, border: `${u.bold ? 1.5 : 1}px solid ${u.border}` }}>
            {d.days === 0 ? <PartyPopper size={13} style={{ color: u.fg }} /> : <Hourglass size={12} style={{ color: u.fg }} />}
            <span style={{ fontSize: 12.5, fontWeight: 700, color: u.bold ? u.ink : T.ink }}>{d.title}</span>
            <span style={{ fontSize: 12, fontWeight: u.bold ? 800 : 600, color: u.bold ? u.ink : T.sub }}>{countdownLabel(d.days)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------
   Sticky notes on the Today screen. Two display styles:
   "overlay" — notes stuck on the dashboard, draggable like a fridge
   "row"     — a compact strip, like the countdown chips
   Positions are stored as percentages so they survive screen changes.
--------------------------------------------------------------- */
const OVERLAY_MAX = 6;
const hashNum = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return Math.abs(h); };
const rotFor = (id) => ((hashNum(id) % 81) / 10) - 4;   // steady -4.0..4.0° tilt, fine-grained so notes rarely sit flat
const clampPct = (v, max) => Math.max(0, Math.min(max, v));
// default fan: bottom-right, filling leftward then upward
function autoPos(i) {
  const col = i % 3, row = Math.floor(i / 3);
  return { x: clampPct(68 - col * 21, 88), y: clampPct(58 - row * 27, 84) };
}
const posOf = (n, i) => ({
  x: typeof n.x === "number" ? n.x : autoPos(i).x,
  y: typeof n.y === "number" ? n.y : autoPos(i).y,
});

function NoteOverlay({ notes, update, personById, openNote, onOverflow, drift }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(null);

  /* Optional idle drift. Deliberately slow and small — a wall display that
     twitches constantly is worse than one that sits perfectly still, so this
     nudges each note a few pixels every several seconds and no more. */
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!drift) return;
    const t = setInterval(() => setNudge((n) => n + 1), 6000);
    return () => clearInterval(t);
  }, [drift]);
  const shown = notes.slice(0, OVERLAY_MAX);
  const extra = notes.length - shown.length;

  const down = (e, n, i) => {
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    setDrag({ id: n.id, i, px: e.clientX, py: e.clientY, dx: 0, dy: 0, moved: 0 });
  };
  const move = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    setDrag((d) => d && { ...d, dx, dy, moved: Math.abs(dx) + Math.abs(dy) });
  };
  const up = (e, n, i) => {
    if (!drag || drag.id !== n.id) return;
    const wasTap = drag.moved < 8;           // small movement = tap, not drag
    const box = ref.current?.getBoundingClientRect();
    if (!wasTap && box) {
      const cur = posOf(n, i);
      const nx = clampPct(cur.x + (drag.dx / box.width) * 100, 88);
      const ny = clampPct(cur.y + (drag.dy / box.height) * 100, 84);
      update((d) => { d.notes = d.notes.map((z) => z.id === n.id ? { ...z, x: nx, y: ny } : z); return d; });
    }
    setDrag(null);
    if (wasTap) openNote(n);
  };

  return (
    <div ref={ref} className="absolute inset-0 z-30" style={{ pointerEvents: "none" }}>
      {shown.map((n, i) => {
        const p = personById(n.personId);
        const pos = posOf(n, i);
        const dragging = drag?.id === n.id;
        // a tiny deterministic wander, so each note drifts differently
        const dseed = (n.id.charCodeAt(0) || 7) + nudge;
        const dx = drift && !dragging ? Math.sin(dseed * 1.7) * 6 : 0;
        const dy = drift && !dragging ? Math.cos(dseed * 2.3) * 5 : 0;
        return (
          <div key={n.id}
            onPointerDown={(e) => down(e, n, i)}
            onPointerMove={move}
            onPointerUp={(e) => up(e, n, i)}
            onPointerCancel={() => setDrag(null)}
            className="absolute select-none"
            style={{
              left: `${pos.x}%`, top: `${pos.y}%`, width: 168,
              pointerEvents: "auto", cursor: dragging ? "grabbing" : "grab",
              transform: `rotate(${rotFor(n.id)}deg) translate(${dragging ? drag.dx : dx}px, ${dragging ? drag.dy : dy}px) scale(${dragging ? 1.04 : 1})`,
              // slow while drifting, quick while being dragged
              transition: dragging ? "none" : drift ? "transform 3.5s ease-in-out" : "transform .15s ease",
              zIndex: dragging ? 40 : 30,
              touchAction: "none",
            }}>
            <div className="rounded-md p-3"
              style={{ background: n.color || NOTE_COLORS[0], boxShadow: dragging ? "0 14px 28px #2C253840" : "0 4px 12px #2C253828", minHeight: 96 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#3A3142", whiteSpace: "pre-wrap", lineHeight: 1.3, maxHeight: 132, overflow: "hidden" }}>{n.text}</div>
              {p && <div style={{ fontSize: 11.5, fontWeight: 700, color: "#3A314299" }} className="mt-2">— {p.name}</div>}
            </div>
          </div>
        );
      })}
      {extra > 0 && (
        <button onClick={onOverflow} className="tapfade absolute rounded-full px-3 py-1.5"
          style={{ left: "2%", bottom: 8, pointerEvents: "auto", background: T.panel, border: `1px solid ${T.line}`, color: T.sub, fontSize: 13, fontWeight: 700 }}>
          +{extra} more note{extra !== 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

function NoteRow({ notes, personById, openNote, onOverflow }) {
  const shown = notes.slice(0, 4);
  const extra = notes.length - shown.length;
  if (!notes.length) return null;
  return (
    <div className="flex gap-2 flex-wrap pt-2">
      {shown.map((n) => {
        const p = personById(n.personId);
        return (
          <button key={n.id} onClick={() => openNote(n)} className="tapfade rounded-lg px-3 py-2 text-left max-w-xs"
            style={{ background: n.color || NOTE_COLORS[0], boxShadow: "0 2px 6px #2C253820" }}>
            <div className="flex items-center gap-2">
              <StickyNote size={13} style={{ color: "#3A314299" }} className="shrink-0" />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "#3A3142" }} className="truncate">{n.text}</span>
              {p && <span style={{ fontSize: 11.5, fontWeight: 700, color: "#3A314299" }} className="shrink-0">{p.name}</span>}
            </div>
          </button>
        );
      })}
      {extra > 0 && (
        <button onClick={onOverflow} className="tapfade rounded-lg px-3 py-2" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub, fontSize: 13, fontWeight: 700 }}>
          +{extra} more
        </button>
      )}
    </div>
  );
}

/* ---------------- Tab bar + person filter ---------------- */
/**
 * Which scope has to be granted for a display to reach each tab.
 *
 * A tab with no entry is available to everyone. Members are unaffected -- this
 * only narrows what a *display* can navigate to.
 */
const TAB_SCOPE = {
  today: "today",
  calendar: "calendar",
  meals: "meals",
  chores: "todos",
  grocery: "grocery",
  agenda: "agenda",
  board: "notes",
  lists: "notes",   // shares the notes scope: both are the household's own writing
  home: "home",
};

function TabBar({ tab, setTab, todosLeft, groceryLeft, noteCount, agendaOpen, listsOpen, homeOn, people, filter, setFilter }) {
  const isMobile = useMobile();
  const all = [
    { id: "today", label: "Today", Icon: Home },
    { id: "calendar", label: "Calendar", Icon: CalIcon },
    { id: "meals", label: "Meals", Icon: UtensilsCrossed },
    { id: "chores", label: "To-Dos", Icon: CheckCircle2, badge: todosLeft },
    { id: "grocery", label: "Grocery", Icon: ShoppingCart, badge: groceryLeft },
    { id: "agenda", label: "Agenda", Icon: MessageCircle, badge: agendaOpen },
    { id: "board", label: "Board", Icon: StickyNote, badge: noteCount },
    { id: "lists", label: "Lists", Icon: ListChecks, badge: listsOpen },
    ...(homeOn ? [{ id: "home", label: "Home", Icon: Sofa }] : []),
  ];

  /* Displays only get the tabs their admins granted.
     This was documented behaviour that had never been implemented: every tab
     showed on every screen regardless of scope, so a display "limited" to the
     calendar still had the agenda and the check-in one tap away. It is not a
     confidentiality boundary -- the document is decrypted in the page either way,
     and the threat model says so -- but a wall screen by the front door should
     not offer the household's private conversation topics to whoever walks past. */
  const scopes = session.isDisplay() ? (session.snapshot().displayScopes || []) : null;
  const tabs = scopes
    ? all.filter((t) => !TAB_SCOPE[t.id] || scopes.includes(TAB_SCOPE[t.id]))
    : all;

  const Filters = ({ compact }) => (
    <div className={`flex items-center gap-1 rounded-full p-0.5 shrink-0 ${compact ? "overflow-x-auto" : ""}`}
      style={{ background: T.panel, border: `1px solid ${T.line}` }}>
      <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
      {people.map((p) => (
        <FilterChip key={p.id} label={p.name} color={p.color} active={filter === p.id} onClick={() => setFilter(p.id)} />
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <nav className="flex flex-col gap-1.5 px-3 pt-1.5 pb-1 shrink-0" style={{ background: T.bg }}>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {tabs.map(({ id, label, Icon, badge }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className="tapfade shrink-0 flex flex-col items-center gap-0.5 py-1.5 px-3 rounded-xl font-semibold relative"
                style={{ background: active ? T.brand : T.panel, color: active ? "#fff" : T.sub, border: `1px solid ${active ? T.brand : T.line}`, minWidth: 62 }}>
                <Icon size={18} />
                <span style={{ fontSize: 11 }}>{label}</span>
                {badge > 0 && <span className="absolute top-0.5 right-1 text-xs font-bold rounded-full px-1.5" style={{ background: active ? "#ffffff30" : "#E86A4C", color: "#fff" }}>{badge}</span>}
              </button>
            );
          })}
        </div>
        <Filters compact />
      </nav>
    );
  }

  // Wall: one compact row. The tab group is allowed to shrink and scroll so the
  // person filter can never be pushed off the edge of the screen.
  return (
    <nav className="px-4 md:px-6 py-1.5 flex items-center gap-3 shrink-0" style={{ background: T.bg }}>
      <div className="flex gap-1.5 min-w-0 overflow-x-auto">
        {tabs.map(({ id, label, Icon, badge }) => {
          const active = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)}
              className="tapfade shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full font-semibold relative"
              style={{ background: active ? T.brand : T.panel, color: active ? "#fff" : T.sub, border: `1px solid ${active ? T.brand : T.line}`, fontSize: 14 }}>
              <Icon size={17} />{label}
              {badge > 0 && <span className="text-xs font-bold rounded-full px-1.5" style={{ background: active ? "#ffffff30" : "#E86A4C", color: "#fff" }}>{badge}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex-1" />
      <Filters />
    </nav>
  );
}
function FilterChip({ label, color, active, onClick }) {
  return (
    <button onClick={onClick} className="tapfade shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full font-semibold whitespace-nowrap"
      style={{ background: active ? (color || T.ink) : "transparent", color: active ? "#fff" : T.sub, fontSize: 13.5 }}>
      {color && <span className="w-2 h-2 rounded-full" style={{ background: active ? "#fff" : color }} />}
      {label}
    </button>
  );
}

/* ---------------- Today view ----------------
   In wall mode this fills the viewport exactly: the header rows are fixed
   height and the three columns share the remaining space, each scrolling
   internally. The page itself never scrolls.                              */
function TodayView({ data, allEvents, now, personById, todayKey, viewKey, viewOffset, setViewOffset,
  filter, inFilter, colorFor, update, taskDueToday, openMeal, openEvent, viewEvent, openNote,
  gotoBoard, openProject, openTask, openChore, openChoreDay }) {
  const isMobile = useMobile();
  // each slot is a list now; hide anything belonging to the other person
  const plannedMeals = MEALS
    .map((m) => ({ ...m, entries: mealEntries(data, viewKey, m.key).filter((e) => entryVisible(e, filter)) }))
    .filter((m) => m.entries.length);
  const chores = data.chores.filter((c) => inFilter(choreAssignee(c, viewKey)) && choreState(c, viewKey).active);
  const dueTasks = data.tasks.filter((t) => inFilter(t.personId) && taskDueToday(t)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const todaysEvents = allEvents.filter((e) => e.date === viewKey && inFilter(e.personId))
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));

  // record WHO did it, not just that it happened — the rotation advances from
  // the completion record, so a bare `true` here would freeze everyone's turn
  // Which row has its "who did it" picker open. One at a time.
  const [creditOpen, setCreditOpen] = useState(null);
  const [creditError, setCreditError] = useState(null);

  const skipChore = (id) => update((d) => {
    d.chores = d.chores.map((c) => {
      if (c.id !== id) return c;
      const done = { ...c.done };
      for (const k of owedOccurrences(c, viewKey)) done[k] = SKIPPED;
      return { ...c, done };
    });
    return d;
  });

  const creditChore = (id, personId) => {
    setCreditError(null);
    try {
      update((d) => COMPLETION.attributeChore(d, id, viewKey, personId, actorFor(d)));
    } catch (err) { setCreditError(err.message); }
  };

  const toggleChore = (id) => update((d) => COMPLETION.toggleChore(d, id, viewKey, actorFor(d), { assigneeOf: choreAssignee }))
  // doneAt records which day it was ticked, so a completed task can sit under
  // that day's "done" list instead of vanishing from the view entirely
  const toggleTask = (id) => update((d) => {
    d.tasks = d.tasks.map((t) => t.id === id
      ? (t.done ? { ...t, done: false, doneAt: "" } : { ...t, done: true, doneAt: viewKey })
      : t);
    return d;
  });

  const isChoreLate = (c) => !c.done[viewKey] && !!choreState(c, viewKey).missedSince;
  // finished items drop to a "done" group at the bottom rather than holding their place
  const doneItems = [
    ...chores.filter((c) => c.done[viewKey]).map((c) => {
      const mark = c.done[viewKey];
      return {
        key: "c" + c.id, id: c.id, kind: "chore", title: c.title, mark,
        // Reads every stored shape. The old check was `typeof mark === "string"`,
        // which only matches the legacy bare person id -- so anything ticked off
        // by this version fell through to showing the *assignee* instead of
        // whoever actually did it.
        person: personById(isSkipped(mark) ? "" : COMPLETION.completedBy(mark)) || null,
        skipped: isSkipped(mark),
        editable: COMPLETION.canReattribute(mark, actorFor(data)),
        toggle: () => toggleChore(c.id),
      };
    }),
    ...data.tasks.filter((t) => inFilter(t.personId) && t.done && t.doneAt === viewKey).map((t) => ({
      key: "t" + t.id, id: t.id, kind: "task", title: t.title,
      person: personById(t.personId), editable: false, toggle: () => toggleTask(t.id),
    })),
  ];
  const restChores = chores.filter((c) => !isChoreLate(c) && !c.done[viewKey]);
  const restTasks = dueTasks.filter((t) => !(t.date && t.date < viewKey));
  const overdueItems = [
    ...chores.filter(isChoreLate).map((c) => ({
      key: "c" + c.id, title: c.title, person: personById(choreAssignee(c, viewKey)),
      lateDays: daysBetween(choreState(c, viewKey).missedSince, viewKey),
      toggle: () => toggleChore(c.id),
    })),
    ...dueTasks.filter((t) => t.date && t.date < viewKey).map((t) => ({
      key: "t" + t.id, title: t.title, person: personById(t.personId),
      lateDays: daysBetween(t.date, viewKey),
      toggle: () => toggleTask(t.id),
    })),
  ].sort((a, b) => b.lateDays - a.lateDays);
  const overdueCount = overdueItems.length;

  // projects planned for this day. Progress, not a checkbox — working on
  // something isn't the same as finishing it.
  const dayProjects = (data.projects || []).filter((pr) => inFilter(pr.personId) && projectOn(pr, viewKey) && projectOpen(pr));
  /* Anything whose planned day slipped shows up today too, but tagged and with a
     decision attached — a plan that didn't happen deserves "still on?" rather
     than silently repeating forever. */
  const carriedProjects = viewKey === todayKey
    ? (data.projects || []).filter((pr) => inFilter(pr.personId) && projectCarried(pr, todayKey) && !projectOn(pr, viewKey))
    : [];
  // routed through the shared helpers so it works for staged projects too,
  // where the planned day has to land on a stage rather than on dates[]
  const planProject = (id, target) => update((d) => {
    d.projects = d.projects.map((pr) => pr.id !== id ? pr
      : (target ? withPlannedDay(pr, target) : withoutPlannedDays(pr)));
    return d;
  });
  const toggleProjectStage = (id, stageId) => update((d) => {
    d.projects = d.projects.map((pr) => {
      if (pr.id !== id) return pr;
      const stages = projectStages(pr).map((x) => x.id === stageId ? { ...x, done: !x.done } : x);
      const pct = Math.round((stages.filter((x) => x.done).length / (stages.length || 1)) * 100);
      return { ...pr, stages, doneOn: pct >= 100 ? (pr.doneOn || ymd(new Date())) : "" };
    });
    return d;
  });
  const bumpProject = (id, by) => update((d) => {
    d.projects = d.projects.map((pr) => {
      if (pr.id !== id) return pr;
      const percent = clampPercent((pr.percent || 0) + by);
      return { ...pr, percent, doneOn: percent >= 100 ? (pr.doneOn || ymd(new Date())) : "" };
    });
    return d;
  });

  const noteMode = data.noteDisplay || "overlay";
  const noteStyle = noteMode === "off" ? "off" : (noteMode === "overlay" && !isMobile) ? "overlay" : "row";
  const viewingName = filter === "all" ? "Everyone" : personById(filter)?.name;
  const showBreakdown = data.showBreakdown !== false && filter === "all";
  const vd = parseYMD(viewKey);
  const isToday = viewKey === todayKey;

  const dayNav = (
    <div className="flex items-center gap-1.5 shrink-0">
      <button onClick={() => setViewOffset(viewOffset - 1)} aria-label="Previous day"
        className="tapfade rounded-full p-1.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}>
        <ChevronLeft size={17} />
      </button>
      {!isToday && (
        <button onClick={() => setViewOffset(0)} className="tapfade rounded-full px-3 py-1.5 font-semibold"
          style={{ background: T.brand, color: "#fff", fontSize: 13 }}>Today</button>
      )}
      <button onClick={() => setViewOffset(viewOffset + 1)} aria-label="Next day"
        className="tapfade rounded-full p-1.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}>
        <ChevronRight size={17} />
      </button>
    </div>
  );

  return (
    <div className={`relative ${isMobile ? "pt-1" : "pt-1 h-full flex flex-col min-h-0"}`}>
      {/* fixed-height context row: which day + day stepper */}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {!isToday && (
            <span className="rounded-full px-2.5 py-1 shrink-0" style={{ background: T.gold + "22", color: "#8A5F14", fontSize: 12, fontWeight: 800 }}>
              {viewOffset === 1 ? "Tomorrow" : viewOffset === -1 ? "Yesterday" : `${WD_SHORT[vd.getDay()]}, ${MO_LONG[vd.getMonth()].slice(0, 3)} ${vd.getDate()}`}
            </span>
          )}
          {showBreakdown && (
            <PersonBreakdown people={data.people} allEvents={allEvents} chores={data.chores} tasks={data.tasks}
              taskDueToday={taskDueToday} todayKey={viewKey} />
          )}
        </div>
        {dayNav}
      </div>

      <div className="shrink-0">
        <CountdownStrip dates={data.dates} todayKey={viewKey} />
        {noteStyle === "row" && <NoteRow notes={data.notes} personById={personById} openNote={openNote} onOverflow={gotoBoard} />}
      </div>

      <div className={`grid gap-3 md:gap-4 pt-2 ${isMobile ? "" : "flex-1 min-h-0"}`}
        style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))" }}>
        <Card grow={!isMobile} title={`${viewingName}'s schedule`} Icon={CalIcon} action={<AddBtn onClick={openEvent} />}>
          {todaysEvents.length === 0 ? <Empty text="No plans. Tap + to add one." /> : (
            <div className="flex flex-col gap-2">
              {todaysEvents.map((e) => {
                const p = personById(e.personId);
                return (
                  <button key={e.id} onClick={() => e.source === "ics" ? viewEvent(e) : null}
                    className="tapfade flex items-center gap-3 rounded-xl px-3 py-2.5 text-left w-full"
                    style={{ background: T.panelAlt, borderLeft: `4px solid ${colorFor(e)}` }}>
                    <div className="w-16 shrink-0">
                      <div style={{ color: T.ink, fontWeight: 700, fontSize: 14 }} className="tabular-nums">{e.time ? fmtTime(e.time) : "All day"}</div>
                      {e.endTime && (
                        <div style={{ color: T.sub, fontWeight: 600, fontSize: 11 }} className="tabular-nums">to {fmtTime(e.endTime)}</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div style={{ fontWeight: 600, fontSize: 15.5 }} className="truncate flex items-center gap-1.5">
                        {e.title}{e.source === "ics" && <Lock size={11} style={{ color: T.faint }} />}
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: colorFor(e) }} className="truncate">{p ? p.name : e.source === "ics" ? e.calName : "Everyone"}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card grow={!isMobile} title={isToday ? "Today's meals" : "Meals"} Icon={UtensilsCrossed} action={<AddBtn onClick={() => openMeal(viewKey, "dinner")} />}>
          {plannedMeals.length === 0 ? <Empty text="Nothing planned. Tap + to add a meal." /> : (
            <div className="flex flex-col gap-2.5">
              {plannedMeals.map(({ key, label, Icon, entries }) => (
                <div key={key}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon size={13} style={{ color: T.gold }} />
                    <span style={{ color: T.sub, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8 }} className="uppercase">{label}</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {entries.map((e) => {
                      const who = personById(e.personId);
                      const cook = personById(e.cookId);
                      const togo = !!e.togo;
                      const tp = fmtTimeParts(e.time);
                      // eat-in gets its own badge rather than being "the absence of
                      // a to-go badge", which isn't readable at a glance
                      const badge = togo
                        ? { label: "TO-GO", color: "#8A5CC2", Icon: ShoppingBag }
                        : { label: "EAT IN", color: T.brand, Icon: Utensils };
                      return (
                        <button key={e.id} onClick={() => openMeal(viewKey, key)}
                          className="tapfade flex items-stretch gap-2.5 rounded-xl px-2.5 py-2 text-left"
                          style={{ background: T.panelAlt, borderLeft: `3px solid ${who ? who.color : T.gold}` }}>
                          {/* time in its own column, matching the schedule card so both scan the same way */}
                          <div className="shrink-0 flex flex-col items-center justify-center" style={{ width: 46 }}>
                            {tp ? (
                              <>
                                <span style={{ fontSize: 16, fontWeight: 800, color: T.ink, lineHeight: 1.05 }} className="tabular-nums">{tp.clock}</span>
                                <span style={{ fontSize: 9.5, fontWeight: 800, color: T.sub, letterSpacing: 0.5 }}>{tp.ap}</span>
                              </>
                            ) : (
                              <span style={{ fontSize: 15, fontWeight: 700, color: T.faint }}>–</span>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div style={{ fontWeight: 600, fontSize: 15.5, color: T.ink }} className="truncate">{e.title}</div>
                            <div className="flex items-center gap-1.5 flex-wrap mt-1">
                              <span className="rounded-full px-2 py-0.5 flex items-center gap-1"
                                style={{ background: badge.color + "1F", color: badge.color, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.3 }}>
                                <badge.Icon size={10} />{badge.label}
                              </span>
                              <span style={{ color: who ? who.color : T.sub, fontSize: 11.5, fontWeight: 700 }}>
                                {who ? who.name : "Shared"}
                              </span>
                              {cook && !togo && (
                                <span style={{ color: cook.color, fontSize: 11.5, fontWeight: 600 }} className="flex items-center gap-1">
                                  <ChefHat size={10} />{cook.name}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card grow={!isMobile} title={isToday ? "To-dos today" : "To-dos"} Icon={CheckCircle2}
          action={(
            <div className="flex items-center gap-2 shrink-0">
              {overdueCount > 0 && (
                <span className="rounded-full px-2.5 py-1" style={{ background: "#E86A4C", color: "#fff", fontSize: 12, fontWeight: 800 }}>
                  {overdueCount} overdue
                </span>
              )}
              {/* Adding a to-do from the screen you are already looking at.
                  It used to mean switching to the To-Dos tab, which is two taps
                  and a change of context for the most common thing anyone does. */}
              <AddBtn onClick={() => openTask({ date: viewKey })} />
            </div>
          )}>
          {chores.length === 0 && dueTasks.length === 0 && doneItems.length === 0 && dayProjects.length === 0 && carriedProjects.length === 0 ? <Empty text="Nothing to do here." /> : (
            <div className="flex flex-col gap-1">
              {overdueItems.length > 0 && (
                <>
                  <div style={{ color: "#E86A4C", fontSize: 10.5, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-0.5">Overdue</div>
                  {overdueItems.map((it) => (
                    <button key={it.key} onClick={it.toggle}
                      className="tapfade flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left"
                      style={{ background: "#E86A4C12", borderLeft: "3px solid #E86A4C" }}>
                      <Circle size={25} style={{ color: "#E86A4C" }} className="shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 15.5, fontWeight: 700 }} className="truncate">{it.title}</div>
                        <div style={{ color: "#C2542F", fontSize: 11.5, fontWeight: 700 }}>{lateLabel(it.lateDays)}</div>
                      </div>
                      {/* name, not just a colour dot — with a rotation you need to see who still owes it */}
                      {it.person && (
                        <span className="shrink-0 rounded-full px-2 py-0.5"
                          style={{ background: it.person.color + "1F", color: it.person.color, fontSize: 11, fontWeight: 800 }}>
                          {it.person.name}
                        </span>
                      )}
                    </button>
                  ))}
                  {(restChores.length > 0 || restTasks.length > 0) && <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />}
                </>
              )}
              {restChores.map((c) => {
                const p = personById(choreAssignee(c, viewKey));
                // The row is not a button — only the circle completes the chore.
                // Wrapping the whole row meant reaching for the person's name, or
                // the skip control, ticked it off instead. Irritating on a phone,
                // worse on a wall tablet where people tap in passing.
                return (
                  <div key={c.id} className="rounded-xl px-2 py-2">
                    <div className="flex items-center gap-2.5">
                      <button onClick={() => toggleChore(c.id)} aria-label={`Mark ${c.title} done`}
                        className="tapfade shrink-0" style={{ color: T.faint }}>
                        <Circle size={25} />
                      </button>
                      {/* Tapping the words opens the day, not the whole row --
                          the circle still completes, and only the circle. */}
                      <button onClick={() => openChoreDay(c, viewKey)}
                        aria-label={`Open ${c.title}`}
                        className="tapfade flex-1 min-w-0 truncate text-left"
                        style={{ fontSize: 15.5, fontWeight: 600 }}>
                        {c.title}
                        {SUB.choreNoteOn(c, viewKey) && (
                          <StickyNote size={11} style={{ color: T.gold, display: "inline", marginLeft: 5, verticalAlign: "middle" }} />
                        )}
                        {SUB.choreChecklist(c).length > 0 && (
                          <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700, marginLeft: 5 }}>
                            {SUB.choreChecklist(c).length} steps
                          </span>
                        )}
                      </button>
                      {isRotating(c) && <Repeat size={11} style={{ color: T.faint }} className="shrink-0" />}
                      {p && (
                        <span className="shrink-0 rounded-full px-2 py-0.5" style={{ background: p.color + "1F", color: p.color, fontSize: 11, fontWeight: 800 }}>
                          {p.name}
                        </span>
                      )}
                      <button onClick={() => skipChore(c.id)} title="Skip this one"
                        aria-label={`Skip ${c.title}`} className="tapfade px-2 py-0.5 rounded-full shrink-0"
                        style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 11, fontWeight: 700 }}>
                        Skip
                      </button>
                    </div>
                  </div>
                );
              })}
              {restChores.length > 0 && restTasks.length > 0 && <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />}
              {restTasks.map((t) => {
                const p = personById(t.personId);
                return (
                  <div key={t.id} className="rounded-xl px-2 py-2">
                    <div className="flex items-center gap-2.5">
                      <button onClick={() => toggleTask(t.id)} aria-label={`Mark ${t.title} done`}
                        className="tapfade shrink-0" style={{ color: T.faint }}>
                        <Circle size={25} />
                      </button>
                      <button onClick={() => openTask(t)} aria-label={`Open ${t.title}`}
                        className="tapfade flex-1 min-w-0 truncate text-left"
                        style={{ fontSize: 15.5, fontWeight: 600 }}>
                        {t.title}
                        {SUB.stepProgress(t) && (
                          <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700, marginLeft: 5 }}>
                            {SUB.stepProgress(t).done}/{SUB.stepProgress(t).total}
                          </span>
                        )}
                      </button>
                      <span className="text-xs font-bold rounded-full px-2 py-0.5 shrink-0" style={{ background: T.gold + "1F", color: T.gold }}>Due</span>
                      {p && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />}
                      <button onClick={() => openTask(t)} aria-label={`Edit ${t.title}`}
                        className="tapfade p-1 shrink-0" style={{ color: T.faint }}>
                        <Settings size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {carriedProjects.length > 0 && (
                <>
                  {(overdueItems.length > 0 || restChores.length > 0 || restTasks.length > 0) && (
                    <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />
                  )}
                  <div style={{ color: "#8A5F14", fontSize: 10.5, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-0.5 flex items-center gap-1">
                    <Wrench size={10} /> Still on?
                  </div>
                  {carriedProjects.map((pr) => {
                    const from = carriedFrom(pr, todayKey);
                    const fd = from ? parseYMD(from) : null;
                    return (
                      <div key={pr.id} className="rounded-xl px-2.5 py-2" style={{ background: T.gold + "14", border: `1px solid ${T.gold}55` }}>
                        <div className="flex items-center gap-2">
                          <button onClick={() => openProject(pr)} className="tapfade flex-1 min-w-0 text-left">
                            <span style={{ fontSize: 15, fontWeight: 600 }} className="block truncate">{pr.title}</span>
                            {fd && (
                              <span style={{ color: "#8A5F14", fontSize: 11, fontWeight: 700 }}>
                                planned {WD_SHORT[fd.getDay()]} {MO_LONG[fd.getMonth()].slice(0, 3)} {fd.getDate()} · {pr.percent || 0}% done
                              </span>
                            )}
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          {[["Today", todayKey], ["Tomorrow", ymd(addDays(parseYMD(todayKey), 1))],
                            ["Weekend", ymd(addDays(parseYMD(todayKey), (6 - parseYMD(todayKey).getDay() + 7) % 7 || 7))]]
                            .map(([label, k]) => (
                              <button key={label} onClick={() => planProject(pr.id, k)}
                                className="tapfade px-2.5 py-1 rounded-full font-bold"
                                style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.brand, fontSize: 11.5 }}>{label}</button>
                            ))}
                          <button onClick={() => planProject(pr.id, null)}
                            className="tapfade px-2.5 py-1 rounded-full font-bold"
                            style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub, fontSize: 11.5 }}>Backlog</button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
              {dayProjects.length > 0 && (
                <>
                  {(overdueItems.length > 0 || restChores.length > 0 || restTasks.length > 0) && (
                    <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />
                  )}
                  <div style={{ color: T.gold, fontSize: 10.5, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-0.5 flex items-center gap-1">
                    <Wrench size={10} /> Project work
                  </div>
                  {dayProjects.map((pr) => {
                    const todays = stagesOn(pr, viewKey);
                    return (
                      <div key={pr.id} className="rounded-xl px-2.5 py-2" style={{ background: T.gold + "10" }}>
                        <div className="flex items-center gap-2">
                          <button onClick={() => openProject(pr)} className="tapfade flex-1 min-w-0 text-left">
                            <span style={{ fontSize: 15, fontWeight: 600 }} className="block truncate">{pr.title}</span>
                            {hasStages(pr) && (
                              <span style={{ fontSize: 11, fontWeight: 700, color: T.sub }}>
                                {stageCount(pr).done} of {stageCount(pr).total} stages
                              </span>
                            )}
                          </button>
                          <span style={{ fontSize: 12.5, fontWeight: 800, color: T.sub }} className="shrink-0 tabular-nums">{projectPercent(pr)}%</span>
                          {/* no stages today: nudge the percent. With stages, the
                              checkboxes below are the honest control. */}
                          {!hasStages(pr) && (
                            <button onClick={() => bumpProject(pr.id, 25)}
                              className="tapfade shrink-0 px-2 py-0.5 rounded-full font-bold"
                              style={{ background: T.gold + "26", color: "#8A5F14", fontSize: 11.5 }}>+25%</button>
                          )}
                        </div>
                        {todays.length > 0 && (
                          <div className="flex flex-col gap-1 mt-1.5">
                            {todays.map((st) => (
                              <div key={st.id} className="flex items-center gap-2" style={{ opacity: st.done ? 0.55 : 1 }}>
                                {/* Only the circle ticks a stage off. */}
                                <button onClick={() => toggleProjectStage(pr.id, st.id)}
                                  aria-label={st.done ? "Un-tick this stage" : "Tick this stage"}
                                  className="tapfade shrink-0">
                                  {st.done
                                    ? <CheckCircle2 size={19} style={{ color: T.brand }} />
                                    : <Circle size={19} style={{ color: T.faint }} />}
                                </button>
                                <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13.5, fontWeight: 600, textDecoration: st.done ? "line-through" : "none" }}>
                                  {st.title || "Untitled stage"}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="rounded-full overflow-hidden mt-1.5" style={{ height: 5, background: T.line }}>
                          <div className="h-full rounded-full" style={{ width: `${projectPercent(pr)}%`, background: T.gold, transition: "width .3s ease" }} />
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
              {doneItems.length > 0 && (
                <>
                  {(overdueItems.length > 0 || restChores.length > 0 || restTasks.length > 0) && (
                    <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />
                  )}
                  <div style={{ color: T.faint, fontSize: 10.5, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-0.5">
                    Done · {doneItems.length}
                  </div>
                  {doneItems.map((it) => (
                    <div key={it.key} className="rounded-xl px-2 py-1.5" style={{ opacity: it.skipped ? 0.4 : 0.62 }}>
                      <div className="flex items-center gap-2.5">
                        {/* Only the tick un-does it. */}
                        <button onClick={it.toggle} aria-label={`Un-tick ${it.title}`}
                          className="tapfade shrink-0" style={{ color: T.brand }}>
                          <CheckCircle2 size={22} />
                        </button>
                        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 14.5, fontWeight: 500, textDecoration: "line-through" }}>{it.title}</span>
                        {it.skipped ? (
                          <span style={{ color: T.faint, fontSize: 11, fontWeight: 700 }} className="shrink-0">skipped</span>
                        ) : it.editable ? (
                          <CreditChip mark={it.mark} personById={personById} open={creditOpen === it.key}
                            onOpen={() => setCreditOpen(creditOpen === it.key ? null : it.key)} />
                        ) : it.person ? (
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: it.person.color }} />
                        ) : null}
                      </div>
                      {it.editable && creditOpen === it.key && (
                        <CreditPicker people={data.people} currentId={it.person?.id || ""}
                          onPick={(pid) => { creditChore(it.id, pid); setCreditOpen(null); }}
                          note={creditError} />
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </Card>
      </div>
      {noteStyle === "overlay" && (
        <NoteOverlay notes={data.notes} update={update} personById={personById}
          openNote={openNote} onOverflow={gotoBoard} />
      )}
    </div>
  );
}

function PersonBreakdown({ people, allEvents, chores, tasks, taskDueToday, todayKey }) {
  return (
    <div className="flex gap-1.5 min-w-0 overflow-x-auto">
      {people.map((p) => {
        const evs = allEvents.filter((e) => e.date === todayKey && e.personId === p.id).length;
        const left = chores.filter((c) => choreAssignee(c, todayKey) === p.id && choreState(c, todayKey).active && !c.done[todayKey]).length
          + tasks.filter((t) => t.personId === p.id && taskDueToday(t)).length;
        const late = chores.filter((c) => choreAssignee(c, todayKey) === p.id && !c.done[todayKey] && choreState(c, todayKey).missedSince).length
          + tasks.filter((t) => t.personId === p.id && !t.done && t.date && t.date < todayKey).length;
        return (
          <div key={p.id} className="shrink-0 flex items-center gap-2 rounded-full pl-1.5 pr-3 py-1 whitespace-nowrap"
            style={{ background: T.panel, border: `1px solid ${late > 0 ? "#E86A4C66" : T.line}` }}>
            <span className="w-6 h-6 rounded-full flex items-center justify-center font-bold shrink-0"
              style={{ background: p.color + "22", color: p.color, fontSize: 12 }}>{p.name[0]}</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: p.color }}>{p.name}</span>
            <span style={{ color: T.sub, fontSize: 12, fontWeight: 600 }}>
              {evs}·{left}
              {late > 0 && <span style={{ color: "#E86A4C", fontWeight: 800 }}> ({late} late)</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Calendar view ---------------- */
function CalendarView({ weekDays, allEvents, personById, colorFor, todayKey, inFilter, shiftWeek, resetWeek, openEvent, editEvent }) {
  const isMobile = useMobile();
  const label = `${MO_LONG[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${weekDays[6].getMonth() !== weekDays[0].getMonth() ? MO_LONG[weekDays[6].getMonth()] + " " : ""}${weekDays[6].getDate()}`;
  const eventsFor = (k) => allEvents.filter((e) => e.date === k && inFilter(e.personId)).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));

  if (isMobile) {
    return (
      <div className="pt-1">
        <WeekNav label={label} shiftWeek={shiftWeek} resetWeek={resetWeek} />
        <div className="flex flex-col gap-2.5">
          {weekDays.map((d) => {
            const k = ymd(d); const isToday = k === todayKey; const dayEvents = eventsFor(k);
            return (
              <div key={k} className="rounded-2xl overflow-hidden" style={{ background: T.panel, border: `1px solid ${isToday ? T.brand : T.line}` }}>
                <div className="flex items-center justify-between px-4 py-2.5" style={{ background: isToday ? T.brandSoft : T.panelAlt }}>
                  <div className="flex items-baseline gap-2">
                    <span style={{ color: isToday ? T.brand : T.sub, fontSize: 13, fontWeight: 700 }} className="uppercase">{WD_SHORT[d.getDay()]}</span>
                    <span style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600, color: isToday ? T.brand : T.ink }}>{MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}</span>
                  </div>
                  <button onClick={() => openEvent(k)} aria-label="Add event" className="tapfade rounded-lg p-1.5" style={{ background: T.panel, color: T.brand, border: `1px solid ${T.line}` }}><Plus size={16} /></button>
                </div>
                {dayEvents.length > 0 && (
                  <div className="px-3 py-2 flex flex-col gap-1.5">
                    {dayEvents.map((e) => (
                      <button key={e.id} onClick={() => editEvent(e)} className="tapfade text-left rounded-lg px-3 py-2 flex items-center gap-3" style={{ background: colorFor(e) + "14", borderLeft: `3px solid ${colorFor(e)}` }}>
                        <span className="tabular-nums shrink-0" style={{ color: T.sub, fontSize: 12.5, fontWeight: 700, minWidth: 86 }}>
                          {e.time ? (e.endTime ? fmtRange(e.time, e.endTime) : fmtTime(e.time)) : "All day"}
                        </span>
                        <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }} className="flex-1 min-w-0 truncate">{e.title}</span>
                        {e.source === "ics" && <Lock size={12} style={{ color: T.faint }} className="shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <WeekNav label={label} shiftWeek={shiftWeek} resetWeek={resetWeek} />
      <div className="grid grid-cols-7 gap-3">
        {weekDays.map((d) => {
          const k = ymd(d); const isToday = k === todayKey;
          const dayEvents = eventsFor(k);
          return (
            <div key={k} className="rounded-2xl flex flex-col min-h-[54vh]" style={{ background: T.panel, border: `1px solid ${isToday ? T.brand : T.line}`, boxShadow: isToday ? `0 0 0 1px ${T.brand}` : "none" }}>
              <div className="px-3 pt-3 pb-2 flex items-center justify-between">
                <div>
                  <div style={{ color: isToday ? T.brand : T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase">{WD_SHORT[d.getDay()]}</div>
                  <div style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600, color: isToday ? T.brand : T.ink }}>{d.getDate()}</div>
                </div>
                <button onClick={() => openEvent(k)} aria-label="Add event" className="tapfade rounded-lg p-1.5" style={{ background: T.brandSoft, color: T.brand }}><Plus size={16} /></button>
              </div>
              <div className="px-2 pb-2 flex-1 flex flex-col gap-1.5 overflow-y-auto">
                {dayEvents.map((e) => (
                  <button key={e.id} onClick={() => editEvent(e)} className="tapfade text-left rounded-lg px-2.5 py-2" style={{ background: colorFor(e) + "18", borderLeft: `3px solid ${colorFor(e)}` }}>
                    {e.time && (
                      <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700 }} className="tabular-nums">
                        {e.endTime ? fmtRange(e.time, e.endTime) : fmtTime(e.time)}
                      </div>
                    )}
                    {e.cont && <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }}>cont. · day {e.spanIndex + 1} of {e.spanDays}</div>}
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }} className="leading-tight break-words flex items-start gap-1">
                      <span>{e.title}</span>{e.source === "ics" && <Lock size={11} style={{ color: T.faint, marginTop: 2 }} className="shrink-0" />}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Meals view ---------------- */
function MealsView({ weekDays, data, todayKey, shiftWeek, resetWeek, openMeal, personById, filter }) {
  const isMobile = useMobile();
  const label = `${MO_LONG[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${weekDays[6].getDate()}`;
  const visible = (k, slot) => mealEntries(data, k, slot).filter((e) => entryVisible(e, filter));

  // one compact line per entry: name, who it's for, to-go, cook
  const EntryLine = ({ e, small }) => {
    const who = personById(e.personId);
    const cook = personById(e.cookId);
    return (
      <div className="flex items-start gap-1.5 min-w-0">
        <span className="rounded-full shrink-0" style={{ width: 6, height: 6, marginTop: 5, background: who ? who.color : T.gold }} />
        <span className="min-w-0">
          <span style={{ fontSize: small ? 12.5 : 14, fontWeight: 600, color: T.ink }} className="break-words">{e.title}</span>
          {e.togo && <ShoppingBag size={10} style={{ color: "#8A5CC2", display: "inline", marginLeft: 4, verticalAlign: "middle" }} />}
          <span className="block" style={{ fontSize: 10.5, fontWeight: 700, color: who ? who.color : T.faint }}>
            {who ? who.name : "Shared"}
            {e.time ? ` · ${fmtTime(e.time)}` : ""}
            {cook && !e.togo ? ` · ${cook.name} cooks` : ""}
          </span>
        </span>
      </div>
    );
  };

  if (isMobile) {
    return (
      <div className="pt-1">
        <WeekNav label={label} shiftWeek={shiftWeek} resetWeek={resetWeek} />
        <div className="flex flex-col gap-2.5">
          {weekDays.map((d) => {
            const k = ymd(d); const isToday = k === todayKey;
            return (
              <div key={k} className="rounded-2xl overflow-hidden" style={{ background: T.panel, border: `1px solid ${isToday ? T.brand : T.line}` }}>
                <div className="flex items-baseline gap-2 px-4 py-2.5" style={{ background: isToday ? T.brandSoft : T.panelAlt }}>
                  <span style={{ color: isToday ? T.brand : T.sub, fontSize: 13, fontWeight: 700 }} className="uppercase">{WD_SHORT[d.getDay()]}</span>
                  <span style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600, color: isToday ? T.brand : T.ink }}>{MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}</span>
                </div>
                <div className="flex flex-col">
                  {MEALS.map(({ key, label: ml, Icon }) => {
                    const rows = visible(k, key);
                    return (
                      <button key={key} onClick={() => openMeal(k, key)} className="tapfade flex items-start gap-3 px-4 py-3 text-left" style={{ borderTop: `1px solid ${T.line}` }}>
                        <Icon size={16} style={{ color: T.gold, marginTop: 2 }} className="shrink-0" />
                        <span style={{ color: T.sub, fontSize: 11.5, fontWeight: 700 }} className="uppercase w-20 shrink-0 pt-0.5">{ml}</span>
                        <span className="flex-1 min-w-0 flex flex-col gap-1.5">
                          {rows.length === 0
                            ? <span style={{ fontSize: 14, color: T.faint }}>Tap to plan</span>
                            : rows.map((e) => <EntryLine key={e.id} e={e} />)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <WeekNav label={label} shiftWeek={shiftWeek} resetWeek={resetWeek} />
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${T.line}` }}>
        <div className="grid" style={{ gridTemplateColumns: "108px repeat(7,1fr)", background: T.panelAlt }}>
          <div />
          {weekDays.map((d) => {
            const isToday = ymd(d) === todayKey;
            return (
              <div key={ymd(d)} className="px-2 py-3 text-center" style={{ borderLeft: `1px solid ${T.line}` }}>
                <div style={{ color: isToday ? T.brand : T.sub, fontSize: 12, fontWeight: 700 }} className="uppercase">{WD_SHORT[d.getDay()]}</div>
                <div style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600, color: isToday ? T.brand : T.ink }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>
        {MEALS.map(({ key, label: ml, Icon }) => (
          <div key={key} className="grid" style={{ gridTemplateColumns: "108px repeat(7,1fr)", background: T.panel }}>
            <div className="px-3 py-3 flex items-center gap-2" style={{ borderTop: `1px solid ${T.line}` }}>
              <Icon size={16} style={{ color: T.gold }} /><span style={{ fontWeight: 700, fontSize: 13 }}>{ml}</span>
            </div>
            {weekDays.map((d) => {
              const k = ymd(d); const rows = visible(k, key);
              return (
                <button key={k} onClick={() => openMeal(k, key)} className="tapfade px-2 py-2.5 text-left align-top"
                  style={{ borderTop: `1px solid ${T.line}`, borderLeft: `1px solid ${T.line}`, minHeight: 68 }}>
                  {rows.length === 0
                    ? <span style={{ fontSize: 14, fontWeight: 500, color: T.faint }}>+</span>
                    : <span className="flex flex-col gap-1.5">{rows.map((e) => <EntryLine key={e.id} e={e} small />)}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- To-Dos view (chores + tasks) ---------------- */
/* ---------------- Who did it ----------------
   Tap the name on a completed chore and the people appear underneath it; tap
   one and the credit moves. That is the whole interaction.

   It replaces a flow that required going to Settings, opening the archive, and
   finding the row -- which meant that on the wall tablet, where the correction
   is actually noticed ("that was me, not you"), there was no way to make it at
   all. The people appear below the item rather than in a modal because on a
   display the thing being corrected needs to stay on screen while you do it. */
function CreditChip({ mark, personById, open, onOpen }) {
  const rec = COMPLETION.completionOf(mark);
  if (!rec) return null;
  const credited = personById(rec.by);

  const label = credited ? credited.name : "Who did it?";
  const colour = credited ? credited.color : T.sub;

  return (
    <>
      <button
        onClick={onOpen}
        aria-expanded={open}
        aria-label={credited ? `Change who did this — currently ${credited.name}` : "Say who did this"}
        className="tapfade shrink-0 rounded-full px-2.5 py-1"
        style={{
          background: credited ? colour + "1F" : T.panelAlt,
          color: colour,
          border: `1px solid ${open ? colour : "transparent"}`,
          fontSize: 12,
          fontWeight: 800,
        }}
      >
        {label}
      </button>
    </>
  );
}

/* The picker itself, rendered under the row so the item stays visible. */
export function CreditPicker({ people, currentId, onPick, note }) {
  return (
    <div className="mt-2 pt-2 flex items-center gap-1.5 flex-wrap"
      style={{ borderTop: `1px dashed ${T.line}` }}>
      <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }}>Done by</span>
      {people.map((p) => {
        const on = p.id === currentId;
        return (
          <button key={p.id} onClick={() => onPick(p.id)}
            aria-label={`Credit ${p.name}`}
            className="tapfade px-3 py-1.5 rounded-full font-bold"
            style={{
              background: on ? p.color : T.panelAlt,
              color: on ? "#fff" : T.ink,
              border: `1px solid ${on ? p.color : T.line}`,
              fontSize: 12.5,
            }}>
            {p.name}
          </button>
        );
      })}
      <button onClick={() => onPick("")} className="tapfade px-3 py-1.5 rounded-full font-semibold"
        style={{ background: T.panelAlt, color: T.faint, border: `1px solid ${T.line}`, fontSize: 12.5 }}>
        Nobody
      </button>
      {note && <div style={{ color: T.faint, fontSize: 11.5, width: "100%" }}>{note}</div>}
    </div>
  );
}


function ToDosView({ data, personById, todayKey, inFilter, update, openChore, openTask, openProject, openHistory }) {
  const isMobile = useMobile();
  // Which row currently has its "who did it" picker open. One at a time.
  const [creditOpen, setCreditOpen] = useState(null);
  const [pane, setPane] = useState("work");   // work | projects
  const projects = (data.projects || []).filter((p) => inFilter(p.personId));
  const scheduled = projects.filter((p) => projectOpen(p) && projectDates(p).length);
  const backlog = projects.filter(projectInBacklog);
  const finished = projects.filter((p) => !projectOpen(p));
  const allChores = data.chores.filter((c) => inFilter(choreAssignee(c, todayKey)));
  const chores = allChores.filter((c) => choreState(c, todayKey).active);
  const otherChores = allChores.filter((c) => !choreState(c, todayKey).active);
  const done = chores.filter((c) => c.done[todayKey]).length;
  const toggleChore = (id) => update((d) => COMPLETION.toggleChore(d, id, todayKey, actorFor(d), { assigneeOf: choreAssignee }))
  /* Skip clears every occurrence currently owed — not just one — otherwise a
     chore owed for three days would reappear tomorrow. Nobody is credited, so
     nobody loses their turn. */
  const skipChore = (id) => update((d) => {
    d.chores = d.chores.map((c) => {
      if (c.id !== id) return c;
      const done = { ...c.done };
      for (const k of owedOccurrences(c, todayKey)) done[k] = SKIPPED;
      return { ...c, done };
    });
    return d;
  });
  // Reassign the credit when someone covered for the other person.
  /* Moves the credit through the attribution model rather than overwriting the
     mark. The old version wrote `personId || true` straight into done[], which
     threw away everything the record knew -- which device ticked it, when, and
     whether the claim was somebody's own -- and never touched the archive, so
     the permanent record and the screen disagreed from then on. */
  const [creditError, setCreditError] = useState(null);
  const creditChore = (id, personId) => {
    setCreditError(null);
    try {
      update((d) => COMPLETION.attributeChore(d, id, todayKey, personId, actorFor(d)));
    } catch (err) {
      setCreditError(err.message);
    }
  };
  const removeChore = (id) => update((d) => { d.chores = d.chores.filter((c) => c.id !== id); return d; });

  const tasks = data.tasks.filter((t) => inFilter(t.personId));
  const toggleTask = (id) => update((d) => {
    d.tasks = d.tasks.map((t) => t.id === id
      ? (t.done ? { ...t, done: false, doneAt: "" } : { ...t, done: true, doneAt: todayKey })
      : t);
    return d;
  });
  const removeTask = (id) => update((d) => { d.tasks = d.tasks.filter((t) => t.id !== id); return d; });

  const open = tasks.filter((t) => !t.done);
  const buckets = [
    { label: "Overdue", accent: "#E86A4C", items: open.filter((t) => t.date && t.date < todayKey).sort((a, b) => a.date.localeCompare(b.date)) },
    { label: "Today", accent: T.brand, items: open.filter((t) => t.date === todayKey) },
    { label: "Upcoming", accent: T.gold, items: open.filter((t) => t.date && t.date > todayKey).sort((a, b) => a.date.localeCompare(b.date)) },
    { label: "No date", accent: T.faint, items: open.filter((t) => !t.date) },
  ].filter((b) => b.items.length);
  const doneTasks = tasks.filter((t) => t.done);

  const dateLabel = (date) => {
    if (!date) return null;
    if (date < todayKey) return "Overdue";
    if (date === todayKey) return "Today";
    const d = parseYMD(date), diff = Math.round((d - parseYMD(todayKey)) / 86400000);
    if (diff === 1) return "Tomorrow";
    if (diff < 7) return WD_LONG[d.getDay()];
    return `${MO_LONG[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  };

  return (
    <div className="pt-2 max-w-5xl mx-auto">
    <div className="flex gap-2 mb-4">
      {[["work", "Chores & tasks", ListTodo], ["projects", "Projects", Wrench]].map(([id, label, Icon]) => (
        <button key={id} onClick={() => setPane(id)} className="tapfade flex-1 py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2"
          style={{ background: pane === id ? T.brand : T.panel, color: pane === id ? "#fff" : T.sub, border: `1px solid ${pane === id ? T.brand : T.line}` }}>
          <Icon size={16} />{label}
          {id === "projects" && scheduled.length + backlog.length > 0 && (
            <span className="text-xs font-bold rounded-full px-1.5" style={{ background: pane === id ? "#ffffff30" : T.line, color: pane === id ? "#fff" : T.sub }}>
              {scheduled.length + backlog.length}
            </span>
          )}
        </button>
      ))}
    </div>

    {pane === "projects" ? (
      <ProjectsPane data={data} update={update} personById={personById} todayKey={todayKey}
        openProject={openProject} scheduled={scheduled} backlog={backlog} finished={finished} />
    ) : (
    <div className="grid gap-5 md:gap-6"
      style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))" }}>
      {/* Chores column */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Recurring chores</h2>
            <p style={{ color: T.sub, fontSize: 14 }}>{chores.length === 0 ? "None due today" : `${done} of ${chores.length} done today`}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={openHistory} aria-label="Show completed history"
              className="tapfade flex items-center gap-2 px-3.5 py-2.5 rounded-full font-semibold"
              style={{ background: T.panelAlt, color: T.sub, border: `1px solid ${T.line}` }}>
              <History size={17} /> History
            </button>
          <button onClick={() => openChore(null)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> Chore</button>
          </div>
        </div>
        {chores.length > 0 && (
          <div className="h-2 rounded-full mb-4 overflow-hidden" style={{ background: T.line }}>
            <div className="h-full rounded-full" style={{ width: `${(done / chores.length) * 100}%`, background: T.brand, transition: "width .3s ease" }} />
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {allChores.length === 0 && <Empty text="No chores yet." />}
          {chores.length > 0 && <div style={{ color: T.brand, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase">Due today &amp; carried over</div>}
          {chores.map((c) => {
            const mark = c.done[todayKey];
            const isDone = !!mark && !isSkipped(mark);
            const skipped = isSkipped(mark);
            const st = choreState(c, todayKey);
            const missedD = st.missedSince ? parseYMD(st.missedSince) : null;
            const up = personById(choreAssignee(c, todayKey));
            // Reads every stored shape, not just the legacy bare person id — which
            // is why completions made by this version credited nobody.
            const creditedTo = isDone ? personById(COMPLETION.completedBy(mark)) : null;
            const canFixCredit = isDone && COMPLETION.canReattribute(mark, actorFor(data));
            const lastBy = personById(lastDoneBy(c));
            return (
              <div key={c.id} className="rounded-2xl px-4 py-3.5"
                style={{ background: skipped ? T.panelAlt : T.panel, border: `1px solid ${!mark && st.missedSince ? "#E86A4C55" : T.line}`, opacity: mark ? 0.72 : 1 }}>
                <div className="flex items-center gap-3">
                  <button onClick={() => toggleChore(c.id)} className="tapfade shrink-0" style={{ color: isDone ? T.brand : T.faint }}>
                    {isDone ? <CheckCircle2 size={30} /> : <Circle size={30} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 17, fontWeight: 600, textDecoration: mark ? "line-through" : "none" }} className="truncate">{c.title}</div>
                    {skipped ? (
                      <div style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }}>Skipped — nobody loses their turn</div>
                    ) : !mark && missedD ? (
                      <div style={{ color: "#E86A4C", fontSize: 12.5, fontWeight: 600 }}>Missed {WD_SHORT[missedD.getDay()]}, {MO_LONG[missedD.getMonth()].slice(0, 3)} {missedD.getDate()}</div>
                    ) : (
                      <div style={{ color: T.sub, fontSize: 12.5, fontWeight: 600 }} className="flex items-center gap-1.5 flex-wrap">
                        <span className="flex items-center gap-1"><Repeat size={11} />{cadenceLabel(c)}</span>
                        {isRotating(c) && <span style={{ color: T.faint }}>· taking turns{lastBy ? ` · last ${lastBy.name}` : ""}</span>}
                      </div>
                    )}
                  </div>
                  {up && !mark && (
                    <span className="shrink-0 rounded-full px-2.5 py-1" style={{ background: up.color + "1F", color: up.color, fontSize: 12, fontWeight: 800 }}>
                      {isRotating(c) ? `${up.name}'s turn` : up.name}
                    </span>
                  )}
                  {isDone && (canFixCredit ? (
                    <CreditChip mark={mark} personById={personById} open={creditOpen === c.id}
                      onOpen={() => setCreditOpen(creditOpen === c.id ? null : c.id)} />
                  ) : creditedTo ? (
                    <span className="shrink-0 rounded-full px-2.5 py-1"
                      title="They ticked this off themselves, so it stands"
                      style={{ background: creditedTo.color + "1F", color: creditedTo.color, fontSize: 12, fontWeight: 800 }}>
                      {creditedTo.name}
                    </span>
                  ) : null)}
                  {!mark && (
                    <button onClick={() => skipChore(c.id)} title="Skip this one"
                      className="tapfade px-2.5 py-1 rounded-full shrink-0"
                      style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12, fontWeight: 700 }}>
                      Skip
                    </button>
                  )}
                  <button onClick={() => openChore(c)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                  <button onClick={() => removeChore(c.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                </div>
                {/* Shown on demand, under the item, for any completed chore --
                    not only rotating ones, which was arbitrary: somebody covering
                    a fixed chore is exactly the case worth recording. */}
                {isDone && canFixCredit && creditOpen === c.id && (
                  <div className="pl-11">
                    <CreditPicker
                      people={data.people}
                      currentId={creditedTo?.id || ""}
                      onPick={(pid) => { creditChore(c.id, pid); setCreditOpen(null); }}
                      note={creditError || (COMPLETION.completionOf(mark)?.byType === "display"
                        ? `Ticked on ${COMPLETION.completionOf(mark).source || "a shared display"}.`
                        : null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {otherChores.length > 0 && (
            <>
              <div style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mt-2">Other days</div>
              {otherChores.map((c) => {
                const p = personById(choreAssignee(c, nextOccurrenceOf(c, todayKey)));
                return (
                  <div key={c.id} className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                    <Repeat size={20} style={{ color: T.faint }} className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div style={{ fontSize: 16, fontWeight: 600, color: T.sub }} className="truncate">{c.title}</div>
                      <div style={{ color: T.faint, fontSize: 12.5, fontWeight: 600 }}>{cadenceLabel(c)}</div>
                    </div>
                    {p && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />}
                    <button onClick={() => openChore(c)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                    <button onClick={() => removeChore(c.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Tasks column */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Tasks &amp; reminders</h2>
            <p style={{ color: T.sub, fontSize: 14 }}>One-off to-dos with a due date</p>
          </div>
          <button onClick={() => openTask(null)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> Task</button>
        </div>
        <div className="flex flex-col gap-4">
          {open.length === 0 && doneTasks.length === 0 && <Empty text="No tasks yet. Tap + to add one." />}
          {buckets.map((b) => (
            <div key={b.label}>
              <div style={{ color: b.accent, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">{b.label}</div>
              <div className="flex flex-col gap-2.5">
                {b.items.map((t) => {
                  const p = personById(t.personId); const overdue = t.date && t.date < todayKey;
                  return (
                    <div key={t.id} className="flex items-center gap-3 rounded-2xl px-4 py-3.5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                      <button onClick={() => toggleTask(t.id)} className="tapfade shrink-0" style={{ color: T.faint }}><Circle size={30} /></button>
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 17, fontWeight: 600 }} className="truncate">{t.title}</div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {t.date && <span style={{ fontSize: 13, fontWeight: 600, color: overdue ? "#E86A4C" : T.sub }}>{dateLabel(t.date)}</span>}
                          {/* Steps at a glance, so a half-finished task does not look
                              identical to one nobody has started. */}
                          {SUB.stepProgress(t) && (
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: T.faint }}>
                              {SUB.stepProgress(t).done}/{SUB.stepProgress(t).total} steps
                            </span>
                          )}
                        </div>
                      </div>
                      {p && <span className="rounded-full px-2.5 py-1 text-xs font-semibold shrink-0" style={{ background: p.color + "1F", color: p.color }}>{p.name}</span>}
                      <button onClick={() => openTask(t)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                      <button onClick={() => removeTask(t.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {doneTasks.length > 0 && (
            <div>
              <div style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">Done</div>
              <div className="flex flex-col gap-2">
                {doneTasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-xl px-4 py-2.5" style={{ opacity: 0.6 }}>
                    <button onClick={() => toggleTask(t.id)} className="tapfade shrink-0" style={{ color: T.brand }}><CheckCircle2 size={26} /></button>
                    <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, fontWeight: 500, textDecoration: "line-through" }}>{t.title}</span>
                    <button onClick={() => removeTask(t.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    )}
    </div>
  );
}

/* ---------------- House projects ----------------
   Progress rather than a checkbox: "we worked on it Saturday" is not the same
   as "the project is finished", and a tick can't say both.               */
function ProjectsPane({ data, update, personById, todayKey, openProject, scheduled, backlog, finished }) {
  const isMobile = useMobile();
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");

  const add = () => {
    const t = title.trim();
    if (!t) return;
    update((d) => {
      d.projects = [...(d.projects || []), {
        id: uid(), title: t, notes: "", percent: 0,
        dates: when ? [when] : [], personId: "",
        createdOn: ymd(new Date()), doneOn: "",
      }];
      return d;
    });
    setTitle(""); setWhen("");
  };
  const bump = (id, by) => update((d) => {
    d.projects = d.projects.map((p) => {
      if (p.id !== id) return p;
      const percent = clampPercent((p.percent || 0) + by);
      return { ...p, percent, doneOn: percent >= 100 ? (p.doneOn || ymd(new Date())) : "" };
    });
    return d;
  });
  const remove = (id) => update((d) => { d.projects = d.projects.filter((p) => p.id !== id); return d; });
  const tickStage = (id, stageId) => update((d) => {
    d.projects = d.projects.map((p) => {
      if (p.id !== id) return p;
      const stages = projectStages(p).map((x) => x.id === stageId ? { ...x, done: !x.done } : x);
      const pct = Math.round((stages.filter((x) => x.done).length / (stages.length || 1)) * 100);
      return { ...p, stages, doneOn: pct >= 100 ? (p.doneOn || ymd(new Date())) : "" };
    });
    return d;
  });
  const schedule = (id, dateKey) => update((d) => {
    d.projects = d.projects.map((p) => (p.id === id ? withPlannedDay(p, dateKey) : p));
    return d;
  });

  // group scheduled work by day so a weekend reads as a plan
  const byDate = {};
  scheduled.forEach((p) => projectDates(p).forEach((k) => { (byDate[k] = byDate[k] || []).push(p); }));
  const days = Object.keys(byDate).sort();
  const upcoming = days.filter((k) => k >= todayKey);
  const past = days.filter((k) => k < todayKey).reverse();

  const Bar = ({ percent }) => (
    <div className="rounded-full overflow-hidden" style={{ height: 6, background: T.line }}>
      <div className="h-full rounded-full" style={{ width: `${percent || 0}%`, background: percent >= 100 ? T.brand : T.gold, transition: "width .3s ease" }} />
    </div>
  );

  const Card2 = ({ p, showDates }) => {
    const owner = personById(p.personId);
    return (
      <div className="rounded-2xl px-4 py-3" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex items-start gap-3">
          <button onClick={() => openProject(p)} className="tapfade flex-1 min-w-0 text-left">
            <div style={{ fontSize: 16.5, fontWeight: 600 }} className="truncate">{p.title}</div>
            {p.notes && <div style={{ color: T.sub, fontSize: 12.5 }} className="truncate">{p.notes}</div>}
          </button>
          {owner && (
            <span className="shrink-0 rounded-full px-2 py-0.5" style={{ background: owner.color + "1F", color: owner.color, fontSize: 11, fontWeight: 800 }}>{owner.name}</span>
          )}
          <span style={{ fontSize: 13, fontWeight: 800, color: projectPercent(p) >= 100 ? T.brand : T.sub }} className="shrink-0 tabular-nums">{projectPercent(p)}%</span>
          <button onClick={() => remove(p.id)} className="tapfade p-1 shrink-0" style={{ color: T.faint }}><Trash2 size={15} /></button>
        </div>
        <div className="mt-2"><Bar percent={projectPercent(p)} /></div>
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {hasStages(p) ? (
            <>
              {/* with stages, progress follows what's ticked — no hand-set percent */}
              <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }}>
                {stageCount(p).done} of {stageCount(p).total} stages
              </span>
              {nextStage(p) && (
                <button onClick={() => tickStage(p.id, nextStage(p).id)}
                  className="tapfade px-2.5 py-1 rounded-full font-semibold flex items-center gap-1.5"
                  style={{ background: T.brandSoft, color: T.brand, fontSize: 12 }}>
                  <Circle size={11} /> {nextStage(p).title || "next stage"}
                </button>
              )}
            </>
          ) : (
            <>
              {[25, -25].map((by) => (
                <button key={by} onClick={() => bump(p.id, by)}
                  className="tapfade px-2.5 py-1 rounded-full font-bold"
                  style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12 }}>
                  {by > 0 ? "+25%" : "−25%"}
                </button>
              ))}
              <button onClick={() => bump(p.id, 100)} className="tapfade px-2.5 py-1 rounded-full font-bold"
                style={{ background: T.brandSoft, color: T.brand, fontSize: 12 }}>Done</button>
            </>
          )}
          {showDates && projectDates(p).length > 0 && (
            <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700 }} className="ml-1">
              {projectDates(p).length} day{projectDates(p).length !== 1 ? "s" : ""} planned
            </span>
          )}
          {projectInBacklog(p) && (
            <button onClick={() => schedule(p.id, todayKey)} className="tapfade ml-auto px-2.5 py-1 rounded-full font-semibold"
              style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.brand, fontSize: 12 }}>
              Plan for today
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* add */}
      <div className="rounded-2xl p-3 mb-5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex gap-2 flex-wrap">
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add a project — e.g. refinish the deck"
            className="flex-1 min-w-0 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <input type="date" value={when} onChange={(e) => setWhen(e.target.value)}
            title="Plan a day (optional)"
            className="shrink-0 px-3 py-3.5 rounded-xl text-base outline-none" style={{ ...inputStyle, width: 158 }} />
          <button onClick={add} className="tapfade shrink-0 px-5 rounded-xl font-semibold flex items-center gap-2" style={{ background: T.brand, color: "#fff" }}>
            <Plus size={20} />{!isMobile && "Add"}
          </button>
        </div>
        <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
          Leave the date empty and it waits in the backlog until you plan it.
        </p>
      </div>

      {upcoming.length > 0 && (
        <div className="mb-5">
          <div style={{ color: T.brand, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">Planned</div>
          {upcoming.map((k) => {
            const d = parseYMD(k);
            return (
              <div key={k} className="mb-3">
                <div style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }} className="mb-1.5">
                  {k === todayKey ? "Today" : `${WD_LONG[d.getDay()]}, ${MO_LONG[d.getMonth()].slice(0, 3)} ${d.getDate()}`}
                </div>
                <div className="flex flex-col gap-2">
                  {byDate[k].map((p) => <Card2 key={p.id + k} p={p} showDates />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-5">
        <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2 flex items-center gap-1.5">
          <Inbox size={13} /> Backlog ({backlog.length})
        </div>
        {backlog.length === 0
          ? <p style={{ color: T.faint, fontSize: 14 }}>Nothing waiting. Add a project without a date and it lands here.</p>
          : <div className="flex flex-col gap-2">{backlog.map((p) => <Card2 key={p.id} p={p} />)}</div>}
      </div>

      {past.length > 0 && (
        <div className="mb-5">
          <div style={{ color: "#8A5F14", fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">
            Slipped — still on?
          </div>
          {past.map((k) => {
            const d = parseYMD(k);
            return (
              <div key={k} className="mb-3">
                <div style={{ color: T.faint, fontSize: 12.5, fontWeight: 700 }} className="mb-1.5">
                  {WD_SHORT[d.getDay()]}, {MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}
                </div>
                <div className="flex flex-col gap-2">
                  {byDate[k].map((p) => <Card2 key={p.id + k} p={p} showDates />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {finished.length > 0 && (
        <div>
          <div style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">Finished ({finished.length})</div>
          <div className="flex flex-col gap-1.5">
            {finished.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-xl px-4 py-2.5" style={{ opacity: 0.6 }}>
                <CheckCircle2 size={22} style={{ color: T.brand }} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate" style={{ fontSize: 15, fontWeight: 500, textDecoration: "line-through" }}>{p.title}</span>
                {p.doneOn && <span style={{ color: T.faint, fontSize: 12, fontWeight: 700 }} className="shrink-0">{sinceLabel(p.doneOn)}</span>}
                <button onClick={() => remove(p.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Grocery list (shared, not filtered by person) ---------------- */
const AISLES = ["Produce", "Meat", "Dairy", "Frozen", "Pantry", "Household", "Other"];
const ANY_STORE = "Any store";

/* Checking something off records the date in groceryHistory, keyed by name, so
   the purchase date survives clearing the list — that's what makes "when did we
   last buy this?" answerable. */
/* Normalise so obvious variants land on the same entry: case, punctuation,
   double spaces and simple plurals. Consistency matters more than linguistic
   correctness here — "berries" normalising to "berrie" is fine as long as it
   always does, because then it still matches itself. "Coffee" and "Coffee
   beans" remain separate, which is intentional: they're different products. */
const singular = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) ? w.slice(0, -1) : w;
const histKey = (title) => String(title || "")
  .toLowerCase()
  .replace(/[^\w\s]/g, " ")
  .split(/\s+/)
  .filter(Boolean)
  .map(singular)
  .join(" ");

function sinceLabel(dateKey) {
  if (!dateKey) return null;
  const days = daysBetween(dateKey, ymd(new Date()));
  if (days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}wk ago`;
  const d = parseYMD(dateKey);
  return `${MO_LONG[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

function GroceryView({ data, update }) {
  const isMobile = useMobile();
  const [text, setText] = useState("");
  const [qty, setQty] = useState("");
  const [aisle, setAisle] = useState("Other");
  const [store, setStore] = useState("");
  const [newStore, setNewStore] = useState("");
  const [addingStore, setAddingStore] = useState(false);

  const items = data.grocery;
  const open = items.filter((g) => !g.done);
  const done = items.filter((g) => g.done);
  const stores = data.groceryStores || [];
  const sortBy = data.grocerySort || "aisle";
  const history = data.groceryHistory || {};

  const add = () => {
    const t = text.trim();
    if (!t) return;
    update((d) => {
      d.grocery = [...d.grocery, { id: uid(), title: t, qty: qty.trim(), aisle, store, done: false }];
      return d;
    });
    setText(""); setQty("");
  };
  // toggling records the purchase, and un-toggling only clears the stamp on the
  // item — the history entry stays, since it did get bought at some point
  const toggle = (id) => update((d) => {
    const todayK = ymd(new Date());
    d.grocery = d.grocery.map((g) => {
      if (g.id !== id) return g;
      if (g.done) return { ...g, done: false, boughtAt: "" };
      const k = histKey(g.title);
      if (k) {
        const prev = d.groceryHistory?.[k] || { count: 0 };
        d.groceryHistory = {
          ...(d.groceryHistory || {}),
          [k]: { title: g.title.trim(), last: todayK, count: (prev.count || 0) + 1,
                 store: g.store || prev.store || "", aisle: g.aisle || prev.aisle || "Other" },
        };
      }
      return { ...g, done: true, boughtAt: todayK };
    });
    return d;
  });
  const remove = (id) => update((d) => { d.grocery = d.grocery.filter((g) => g.id !== id); return d; });
  const clearDone = () => update((d) => { d.grocery = d.grocery.filter((g) => !g.done); return d; });
  const setField = (id, patch) => update((d) => { d.grocery = d.grocery.map((g) => g.id === id ? { ...g, ...patch } : g); return d; });
  const setSort = (v) => update((d) => { d.grocerySort = v; return d; });
  const addStore = () => {
    const n = newStore.trim();
    if (!n) return;
    update((d) => {
      const cur = d.groceryStores || [];
      if (!cur.some((x) => x.toLowerCase() === n.toLowerCase())) d.groceryStores = [...cur, n];
      return d;
    });
    setStore(n); setNewStore(""); setAddingStore(false);
  };
  const removeStore = (n) => update((d) => {
    d.groceryStores = (d.groceryStores || []).filter((x) => x !== n);
    d.grocery = d.grocery.map((g) => g.store === n ? { ...g, store: "" } : g);
    return d;
  });

  const bump = (g, delta) => {
    const n = parseFloat(g.qty);
    const next = Number.isFinite(n) ? Math.max(1, n + delta) : Math.max(1, 1 + delta);
    setField(g.id, { qty: String(next) });
  };
  const isNumeric = (v) => /^\d+(\.\d+)?$/.test((v || "").trim());

  // group by whichever dimension is selected; unset store falls into "Any store"
  const groups = (() => {
    if (sortBy === "store") {
      const keys = [...stores, ANY_STORE];
      return keys
        .map((k) => ({ label: k, items: open.filter((g) => (g.store || ANY_STORE) === k) }))
        .filter((g) => g.items.length);
    }
    return AISLES
      .map((a) => ({ label: a, items: open.filter((g) => (g.aisle || "Other") === a) }))
      .filter((g) => g.items.length);
  })();

  const histList = Object.values(history).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  const smallSelect = { background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12.5 };

  return (
    <div className="pt-2 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h2 style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 600 }}>Grocery list</h2>
          <p style={{ color: T.sub, fontSize: 15 }} className="truncate">
            {open.length === 0 ? "Nothing on the list" : `${open.length} item${open.length !== 1 ? "s" : ""} to pick up`}
            {done.length > 0 && ` · ${done.length} in the cart`}
          </p>
        </div>
        {done.length > 0 && (
          <button onClick={clearDone} className="tapfade shrink-0 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>
            Clear {done.length}
          </button>
        )}
      </div>

      {/* quick add */}
      <div className="rounded-2xl p-3 mb-4" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex gap-2 mb-2.5">
          <input value={qty} onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Qty" aria-label="Quantity"
            className="shrink-0 px-3 py-3.5 rounded-xl text-lg outline-none text-center" style={{ ...inputStyle, width: 84 }} />
          <input value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add an item — e.g. coffee beans"
            className="flex-1 min-w-0 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <button onClick={add} className="tapfade shrink-0 px-5 rounded-xl font-semibold flex items-center gap-2" style={{ background: T.brand, color: "#fff" }}>
            <Plus size={20} />{!isMobile && "Add"}
          </button>
        </div>
        {/* last-bought hint while typing */}
        {/* Name the matched entry. Without it, "test" and "test 1" both just say
            "last bought" and you can't tell which one it found. */}
        {text.trim() && history[histKey(text)] && (
          <p style={{ color: T.sub, fontSize: 12.5, fontWeight: 600 }} className="mb-2">
            Matches <span style={{ color: T.ink, fontWeight: 800 }}>“{history[histKey(text)].title}”</span>
            {" — last bought "}{sinceLabel(history[histKey(text)].last)}
            {history[histKey(text)].store ? ` at ${history[histKey(text)].store}` : ""}
            {history[histKey(text)].count > 1 ? ` · ${history[histKey(text)].count} times` : ""}
          </p>
        )}
        <div className="flex gap-1.5 flex-wrap mb-2">
          {AISLES.map((a) => (
            <button key={a} onClick={() => setAisle(a)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
              style={{ background: aisle === a ? T.brand : T.panelAlt, color: aisle === a ? "#fff" : T.sub, border: `1px solid ${aisle === a ? T.brand : T.line}` }}>{a}</button>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <span style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }} className="flex items-center gap-1 shrink-0"><Store size={13} /> Store</span>
          <button onClick={() => setStore("")} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
            style={{ background: store === "" ? T.ink : T.panelAlt, color: store === "" ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Any</button>
          {stores.map((n) => (
            <span key={n} className="flex items-center">
              <button onClick={() => setStore(n)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
                style={{ background: store === n ? T.brand : T.panelAlt, color: store === n ? "#fff" : T.sub, border: `1px solid ${store === n ? T.brand : T.line}` }}>{n}</button>
            </span>
          ))}
          {addingStore ? (
            <span className="flex items-center gap-1">
              <input autoFocus value={newStore} onChange={(e) => setNewStore(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addStore(); if (e.key === "Escape") setAddingStore(false); }}
                placeholder="Store name"
                className="px-2.5 py-1.5 rounded-full text-sm outline-none" style={{ ...inputStyle, width: 130 }} />
              <button onClick={addStore} className="tapfade px-2.5 py-1.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff", fontSize: 12.5 }}>Add</button>
            </span>
          ) : (
            <button onClick={() => setAddingStore(true)} className="tapfade px-2.5 py-1.5 rounded-full font-semibold"
              style={{ background: T.brandSoft, color: T.brand, fontSize: 12.5 }}>+ Store</button>
          )}
        </div>
      </div>

      {/* sort toggle */}
      {items.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }} className="uppercase">Group by</span>
          {[["aisle", "Category"], ["store", "Store"]].map(([v, l]) => (
            <button key={v} onClick={() => setSort(v)} className="tapfade px-3.5 py-1.5 rounded-full font-semibold"
              style={{ background: sortBy === v ? T.brand : T.panel, color: sortBy === v ? "#fff" : T.sub,
                border: `1px solid ${sortBy === v ? T.brand : T.line}`, fontSize: 13 }}>{l}</button>
          ))}
        </div>
      )}

      {items.length === 0 && <Empty text="List is empty. Add something above." />}

      <div className="flex flex-col gap-4">
        {groups.map(({ label, items: list }) => (
          <div key={label}>
            <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2 flex items-center gap-1.5">
              {sortBy === "store" && <Store size={12} />}{label}
            </div>
            <div className="flex flex-col gap-2">
              {list.map((g) => {
                const h = history[histKey(g.title)];
                return (
                  <div key={g.id} className="rounded-2xl px-3 py-2.5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                    <div className="flex items-center gap-2.5">
                      <button onClick={() => toggle(g.id)} className="tapfade shrink-0" style={{ color: T.faint }}><Circle size={28} /></button>
                      <input value={g.qty || ""} onChange={(e) => setField(g.id, { qty: e.target.value })}
                        placeholder="–" aria-label={`Quantity for ${g.title}`}
                        className="shrink-0 rounded-lg text-center outline-none"
                        style={{ width: 58, padding: "5px 4px", fontSize: 15, fontWeight: 700,
                          color: g.qty ? T.ink : T.faint, background: "transparent",
                          border: `1px solid ${g.qty ? T.line : "transparent"}` }} />
                      {isNumeric(g.qty) && (
                        <div className="flex flex-col shrink-0">
                          <button onClick={() => bump(g, 1)} aria-label="Increase" className="tapfade leading-none" style={{ color: T.sub, padding: "0 3px" }}>
                            <ChevronRight size={12} style={{ transform: "rotate(-90deg)" }} />
                          </button>
                          <button onClick={() => bump(g, -1)} aria-label="Decrease" className="tapfade leading-none" style={{ color: T.sub, padding: "0 3px" }}>
                            <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} />
                          </button>
                        </div>
                      )}
                      <span className="flex-1 min-w-0 truncate" style={{ fontSize: 17.5, fontWeight: 600 }}>{g.title}</span>
                      <button onClick={() => remove(g.id)} className="tapfade p-1 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-1.5 pl-10">
                      <select value={g.aisle || "Other"} onChange={(e) => setField(g.id, { aisle: e.target.value })}
                        aria-label="Category" className="rounded-lg px-2 py-1 font-semibold outline-none" style={smallSelect}>
                        {AISLES.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      <select value={g.store || ""} onChange={(e) => setField(g.id, { store: e.target.value })}
                        aria-label="Store" className="rounded-lg px-2 py-1 font-semibold outline-none" style={smallSelect}>
                        <option value="">Any store</option>
                        {stores.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      {h?.last && (
                        <span style={{ color: T.faint, fontSize: 12, fontWeight: 600 }}>
                          {h.title.trim().toLowerCase() !== g.title.trim().toLowerCase()
                            ? `matches “${h.title}” · last bought ${sinceLabel(h.last)}`
                            : `last bought ${sinceLabel(h.last)}`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {done.length > 0 && (
          <div>
            <div style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">In the cart</div>
            <div className="flex flex-col gap-2">
              {done.map((g) => (
                <div key={g.id} className="flex items-center gap-3 rounded-xl px-4 py-2.5" style={{ opacity: 0.55 }}>
                  <button onClick={() => toggle(g.id)} className="tapfade shrink-0" style={{ color: T.brand }}><CheckCircle2 size={26} /></button>
                  <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, fontWeight: 500, textDecoration: "line-through" }}>
                    {g.qty ? `${g.qty} ` : ""}{g.title}
                  </span>
                  {g.store && <span style={{ color: T.faint, fontSize: 12, fontWeight: 700 }} className="shrink-0">{g.store}</span>}
                  <button onClick={() => remove(g.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Always on screen rather than behind a toggle — it's the thing you scan
          while building the list, and it doubles as a one-tap re-add. */}
      {histList.length > 0 && (
        <div className="mt-6">
          <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2 flex items-center gap-1.5">
            <History size={13} /> Bought before ({histList.length}) — tap to add
          </div>
          <div className="flex flex-wrap gap-2">
            {histList.map((h) => {
              const already = open.some((g) => histKey(g.title) === histKey(h.title));
              return (
                <button key={h.title} disabled={already}
                  onClick={() => update((d) => {
                    d.grocery = [...d.grocery, { id: uid(), title: h.title, qty: "", aisle: h.aisle || "Other", store: h.store || "", done: false }];
                    return d;
                  })}
                  className="tapfade flex items-center gap-2 rounded-full pl-3 pr-2.5 py-1.5"
                  style={{ background: already ? T.panelAlt : T.panel, border: `1px solid ${T.line}`, opacity: already ? 0.5 : 1 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{h.title}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: T.faint }}>{sinceLabel(h.last)}</span>
                  {already ? <span style={{ fontSize: 11, fontWeight: 700, color: T.faint }}>on list</span> : <Plus size={13} style={{ color: T.brand }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {stores.length > 0 && (
        <div className="mt-6 flex items-center gap-2 flex-wrap">
          <span style={{ color: T.faint, fontSize: 12, fontWeight: 700 }} className="uppercase">Stores</span>
          {stores.map((n) => (
            <span key={n} className="flex items-center gap-1 rounded-full pl-3 pr-1.5 py-1" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: T.sub }}>{n}</span>
              <button onClick={() => removeStore(n)} className="tapfade" style={{ color: T.faint }} aria-label={`Remove ${n}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Evening agenda ----------------
   Three parts, matching the standalone Evening Agenda app:
     - a conversation prompt that rotates by day of year
     - the discussion list (things to bring up, not tasks)
     - a nightly check-in where each of you rates happiness, connection and
       intimacy 1-5, with a combined "how we're doing" view
   All three can be browsed backwards day by day.                        */
const AGENDA_CATEGORIES = [
  { id: "house", label: "House", Icon: Hammer, color: "#2E9187" },
  { id: "money", label: "Money", Icon: Wallet, color: "#C98A2B" },
  { id: "plans", label: "Plans", Icon: CalendarDays, color: "#5D6FE0" },
  { id: "talk", label: "Just talk", Icon: MessageCircle, color: "#D25B86" },
  { id: "other", label: "Other", Icon: Sparkles, color: "#8A5CC2" },
];
const catOf = (id) => AGENDA_CATEGORIES.find((c) => c.id === id) || AGENDA_CATEGORIES[3];

/* The three things you rate each night. */
/* Date-night jars. Ideas get added whenever one of you thinks of something, then
   you draw from whichever jar suits the mood. Drawing prefers ideas you haven't
   done lately so the same one doesn't keep surfacing. */
const DEFAULT_DATE_JARS = [
  { id: "cheap", name: "Cheap", color: "#2E9187" },
  { id: "long", name: "Long", color: "#5D6FE0" },
  { id: "fancy", name: "Fancy", color: "#C98A2B" },
];
const JAR_COLORS = ["#2E9187", "#5D6FE0", "#C98A2B", "#D25B86", "#8A5CC2", "#E86A4C"];

/* Same rotation rule as the server: never-drawn first, then oldest-drawn, and
   never repeat the last one when there's an alternative. */
function pickDateIdea(ideas, jarId) {
  const pool = (ideas || []).filter((x) => !x.retired && (!jarId || x.jarId === jarId));
  if (!pool.length) return null;
  const never = pool.filter((x) => !x.drawnAt);
  if (never.length) return never[Math.floor(Math.random() * never.length)];
  const byAge = pool.slice().sort((a, b) => (Number(a.drawnAt) || 0) - (Number(b.drawnAt) || 0));
  const candidates = byAge.length > 1 ? byAge.slice(0, byAge.length - 1) : byAge;
  const bucket = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2)));
  return bucket[Math.floor(Math.random() * bucket.length)];
}

const STATUS_DIMS = [
  { key: "happiness", label: "Happiness" },
  { key: "connection", label: "Connection" },
  { key: "intimacy", label: "Intimacy" },
];
const SCALE = ["", "Rough", "Low", "Okay", "Good", "Great"];

/* ---------------- How we're doing, over time ----------------
   The nightly check-in has always shown one evening at a time, which answers
   "how was tonight" and nothing else. The question a household actually has is
   whether things are drifting -- and that is only visible across weeks.

   Drawn as plain SVG rather than pulled from a charting library: it is one
   polyline per person and the app has no other need for 40KB of charts.

   Deliberately restrained. Averages invite grading a relationship, which is not
   what this is for, so the emphasis is on shape and divergence: where the two
   lines separate, and which way each is heading. */

const GRAPH_WINDOWS = [[30, "30 days"], [90, "3 months"], [365, "a year"]];

export function StatusGraph({ data, todayKey }) {
  const isMobile = useMobile();
  const [days, setDays] = useState(90);
  const [dim, setDim] = useState("average");

  const people = (data.people || []).filter(Boolean);
  const status = data.status || {};

  /* One series per person: [{ x: dayIndex, y: score }], oldest first. */
  const { series, count } = useMemo(
    () => STATUS.buildSeries(status, people, { todayKey, days, dimension: dim }),
    [status, people.map((p) => p.id).join(","), days, dim, todayKey]
  );
  const span = days;

  const W = isMobile ? 320 : 560;
  const H = 170;
  const PAD = { l: 26, r: 10, t: 10, b: 20 };
  const px = (x) => PAD.l + (x / Math.max(1, span - 1)) * (W - PAD.l - PAD.r);
  const py = (y) => PAD.t + (1 - (y - 1) / 4) * (H - PAD.t - PAD.b);

  if (!count) {
    return (
      <div className="rounded-2xl p-4 mt-4" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
        <h3 style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600 }} className="mb-1">Over time</h3>
        <p style={{ color: T.faint, fontSize: 14 }}>
          No check-ins recorded in this window yet. A few evenings of the nightly check-in
          and the shape starts to show.
        </p>
        <WindowPicker days={days} setDays={setDays} />
      </div>
    );
  }

  const gap = STATUS.gapDaysFor(days);

  return (
    <div className="rounded-2xl p-4 mt-4" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
      <h3 style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600 }} className="mb-2">Over time</h3>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        {[["average", "All three"], ...STATUS_DIMS.map((d) => [d.key, d.label])].map(([k, label]) => (
          <button key={k} onClick={() => setDim(k)}
            className="tapfade px-3 py-1.5 rounded-full font-semibold"
            style={{ background: dim === k ? T.brand : T.panel, color: dim === k ? "#fff" : T.sub,
              border: `1px solid ${dim === k ? T.brand : T.line}`, fontSize: 12.5 }}>
            {label}
          </button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={`${dim === "average" ? "Overall" : dim} scores over the last ${days} days`}>
        {/* 1-5 gridlines. The scale is fixed so a good week cannot be made to
            look like a bad one by rescaling the axis. */}
        {[1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={py(v)} y2={py(v)}
              stroke={T.line} strokeWidth="1" strokeDasharray={v === 3 ? "0" : "3 4"} />
            <text x={PAD.l - 6} y={py(v) + 4} textAnchor="end"
              style={{ fill: T.faint, fontSize: 10 }}>{v}</text>
          </g>
        ))}

        {people.map((p) => {
          const pts = series.get(p.id) || [];
          if (!pts.length) return null;
          // Split into runs so a long silence is a break, not a straight line
          // drawn confidently through weeks nobody recorded anything.
          const runs = STATUS.splitRuns(pts, gap);

          return (
            <g key={p.id}>
              {runs.filter((r) => r.length > 1).map((r, i) => (
                <polyline key={i} fill="none" stroke={p.color} strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round"
                  points={r.map((pt) => `${px(pt.x)},${py(pt.y)}`).join(" ")} />
              ))}
              {pts.map((pt, i) => (
                <circle key={i} cx={px(pt.x)} cy={py(pt.y)} r={pts.length > 60 ? 1.6 : 2.6}
                  fill={p.color}>
                  <title>{`${p.name} · ${pt.date} · ${pt.y.toFixed(1)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      <div className="flex items-center gap-3 flex-wrap mt-1">
        {people.map((p) => {
          const pts = series.get(p.id) || [];
          return (
            <span key={p.id} className="flex items-center gap-1.5"
              style={{ fontSize: 12.5, fontWeight: 700, color: p.color }}>
              <span className="rounded-full" style={{ width: 10, height: 10, background: p.color, display: "inline-block" }} />
              {p.name}
              <span style={{ color: T.faint, fontWeight: 600 }}>{STATUS.trend(pts).label}</span>
            </span>
          );
        })}
      </div>

      <WindowPicker days={days} setDays={setDays} />

      <p style={{ color: T.faint, fontSize: 12 }} className="mt-2">
        A gap in a line means no check-in that week, not a bad one. Where the lines
        separate is usually the more interesting part.
      </p>
    </div>
  );
}

function WindowPicker({ days, setDays }) {
  return (
    <div className="flex items-center gap-2 flex-wrap mt-3">
      {GRAPH_WINDOWS.map(([n, label]) => (
        <button key={n} onClick={() => setDays(n)}
          className="tapfade px-3 py-1.5 rounded-full font-semibold"
          style={{ background: days === n ? T.ink : T.panel, color: days === n ? "#fff" : T.sub,
            border: `1px solid ${T.line}`, fontSize: 12.5 }}>
          {label}
        </button>
      ))}
    </div>
  );
}



/* Starter conversation prompts. The prompt shown is picked by day of year, so
   both devices land on the same one without storing anything. Add your own in
   the editor and they're used instead. */
const BUILTIN_PROMPTS = [
  "What's something good that happened today that you didn't get to tell me yet?",
  "What's something that was harder today than you expected?",
  "What's the best part of today?",
  "What's something you needed today that you didn't get?",
  "What's something you wish I'd known about your day without having to say it?",
  "What's something you're looking forward to tomorrow?",
  "What's something you're relieved to be done with this week?",
  "What's a small thing I did recently that you appreciated?",
  "What's something you've been carrying that you haven't put down yet?",
  "When did you feel closest to me this week?",
  "What's something you'd like more of from me?",
  "What's something you'd like less of?",
  "What's a way I could make your mornings easier?",
  "What's a memory of us you thought about recently?",
  "What's the first thing you remember thinking about me?",
  "What's a trip we took that you'd do again exactly the same?",
  "What's something we used to do that you miss?",
  "What's a night in you remember better than most nights out?",
  "What's something about the house you're proud of?",
  "What room do you most want to finish next, and why that one?",
  "What's a project you'd quietly like me to stop starting?",
  "What's something about the house that bothers you that you haven't mentioned?",
  "What's a purchase we made that turned out to be worth it?",
  "What's something we spend money on that you'd cut?",
  "What's something you'd spend more on without hesitating?",
  "What's a money worry you haven't said out loud?",
  "What's something you want to save toward together?",
  "Would you rather have a month off or a shorter work week forever?",
  "Would you rather host every holiday or never host again?",
  "Would you rather live somewhere warmer or somewhere with better seasons?",
  "Would you rather have a bigger house or a shorter commute?",
  "What's something you'd try if you knew you'd be bad at it?",
  "What's a place you want to go that I've never mentioned?",
  "What's something fun we haven't done in too long?",
  "What's a way you want us to keep surprising each other?",
  "What's something you hope we never stop making time for?",
  "What's a dream you've had for us that you haven't said out loud recently?",
  "What's something you'd want to be true about us ten years from now?",
  "What's a version of our future that excites you even if it's just a quiet life?",
  "What's a thing you want to make sure we do before we're too old or too busy?",
  "What's a way you want to grow together that scares you a little?",
  "What's a way you want us to show up for our community more?",
  "What's something you've changed your mind about lately?",
  "What's a value of mine you've come to understand better?",
  "What's something you need from me when you're stressed that I forget?",
  "How do you most like to be comforted?",
  "What's a sign you're overwhelmed that I might miss?",
  "What's something you're proud of yourself for this month?",
  "What's something you've been avoiding?",
  "What's a conversation you've been putting off?",
  "What do you need more of right now — rest, fun, or focus?",
  "What's something the pets did this week that you loved?",
  "Which of the pets do you think likes me more, honestly?",
  "What's something silly you thought about today?",
  "What's the most ridiculous thing you'd buy if money didn't matter?",
  "What's a hill you'd die on that nobody asked about?",
  "What's a compliment you've never told me?",
  "What's something I do that makes you laugh every time?",
  "What's a habit of mine you've grown fond of?",
  "What's something you want to do differently next week?",
];

const dayOfYear = (d) => Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
const promptForDate = (dateKey, custom) => {
  const bank = custom && custom.length ? custom : BUILTIN_PROMPTS;
  if (!bank.length) return null;
  const n = dayOfYear(parseYMD(dateKey));
  return bank[((n - 1) % bank.length + bank.length) % bank.length];
};

const relTime = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
};

/* A 1-5 track. Editable renders a real range input; read-only shows each
   person's mark on one track so you can see both at once. */
function ScaleTrack({ value, onChange, color, marks }) {
  if (onChange) {
    return (
      <div>
        <input type="range" min="1" max="5" step="1" value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full" style={{ accentColor: color }} />
        <div className="flex justify-between" style={{ color: T.faint, fontSize: 10.5, fontWeight: 700 }}>
          {SCALE.slice(1).map((l) => <span key={l}>{l}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="relative rounded-full" style={{ height: 8, background: T.line }}>
        {(marks || []).map((m) => (
          <span key={m.id} title={`${m.name}: ${SCALE[m.value]}`}
            className="absolute rounded-full"
            style={{
              left: `calc(${((m.value - 1) / 4) * 100}% - 7px)`, top: -3,
              width: 14, height: 14, background: m.color,
              border: "2px solid #fff", boxShadow: "0 1px 3px #2C253840",
            }} />
        ))}
      </div>
      <div className="flex justify-between mt-1" style={{ color: T.faint, fontSize: 10.5, fontWeight: 700 }}>
        <span>{SCALE[1]}</span><span>{SCALE[5]}</span>
      </div>
    </div>
  );
}

function AgendaView({ data, update, personById, openCheckin }) {
  const isMobile = useMobile();
  const todayKey = ymd(new Date());
  const [dayOffset, setDayOffset] = useState(0);
  const [pane, setPane] = useState("topics");     // topics | status
  const [text, setText] = useState("");
  const [category, setCategory] = useState("talk");
  const [who, setWho] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [editPrompts, setEditPrompts] = useState(false);
  const [newPrompt, setNewPrompt] = useState("");
  const [jarId, setJarId] = useState(() => (data.dateJars || DEFAULT_DATE_JARS)[0]?.id || "cheap");
  const [drawn, setDrawn] = useState(null);        // the idea currently on the table
  const [ideaText, setIdeaText] = useState("");
  const [showJarList, setShowJarList] = useState(false);
  const [newJar, setNewJar] = useState("");
  const [addingJar, setAddingJar] = useState(false);

  const viewKey = ymd(addDays(parseYMD(todayKey), dayOffset));
  const isToday = dayOffset === 0;
  const vd = parseYMD(viewKey);

  const items = data.agenda || [];
  // history: today shows the live list; past days read from the archive
  const archive = data.agendaArchive || [];
  const archivedForDay = archive.filter((e) => ymd(new Date(e.date)) === viewKey).flatMap((e) => e.items || []);
  const liveOpen = items.filter((a) => !a.resolved);
  const liveDone = items.filter((a) => a.resolved);

  // Generated by the local model, conditioned on how the day actually went.
  // promptForDate is the fallback when Ollama is unreachable or AI is off.
  const generated = useCheckinPrompt(viewKey, data, update, promptForDate(viewKey, data.agendaPrompts));
  const prompt = generated.question;
  const dayStatus = (data.status || {})[viewKey] || {};

  const add = () => {
    const t = text.trim();
    if (!t) return;
    update((d) => {
      d.agenda = [...(d.agenda || []), { id: uid(), text: t, personId: who, category, at: Date.now(), resolved: false }];
      return d;
    });
    setText("");
  };
  const toggle = (id) => update((d) => { d.agenda = d.agenda.map((a) => a.id === id ? { ...a, resolved: !a.resolved } : a); return d; });
  const remove = (id) => update((d) => { d.agenda = d.agenda.filter((a) => a.id !== id); return d; });
  const archiveDone = () => update((d) => {
    const finished = (d.agenda || []).filter((a) => a.resolved);
    if (!finished.length) return d;
    d.agendaArchive = [{ date: new Date().toISOString(), items: finished }, ...(d.agendaArchive || [])].slice(0, 120);
    d.agenda = d.agenda.filter((a) => !a.resolved);
    return d;
  });
  const setStatus = (personId, dim, value) => update((d) => {
    d.status = { ...(d.status || {}) };
    const day = { ...(d.status[viewKey] || {}) };
    const cur = day[personId] || { happiness: 3, connection: 3, intimacy: 3 };
    day[personId] = { ...cur, [dim]: value, at: Date.now() };
    d.status[viewKey] = day;
    return d;
  });
  const addPrompt = () => {
    const t = newPrompt.trim();
    if (!t) return;
    update((d) => { d.agendaPrompts = [...(d.agendaPrompts || []), t]; return d; });
    setNewPrompt("");
  };
  const removePrompt = (i) => update((d) => {
    d.agendaPrompts = (d.agendaPrompts || []).filter((_, x) => x !== i); return d;
  });

  const Row = ({ a, muted, readOnly }) => {
    const c = catOf(a.category);
    const pp = personById(a.personId);
    return (
      <div className="flex items-start gap-2.5 rounded-2xl px-3.5 py-3"
        style={{ background: muted ? "transparent" : T.panel, border: `1px solid ${muted ? "transparent" : T.line}`, opacity: muted ? 0.55 : 1 }}>
        {readOnly ? (
          <CheckCircle2 size={24} style={{ color: T.brand, marginTop: 2 }} className="shrink-0" />
        ) : (
          <button onClick={() => toggle(a.id)} className="tapfade shrink-0 mt-0.5" style={{ color: muted ? T.brand : T.faint }}>
            {muted ? <CheckCircle2 size={26} /> : <Circle size={26} />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: 16.5, fontWeight: 600, textDecoration: muted ? "line-through" : "none", lineHeight: 1.35 }}>{a.text}</div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="rounded-full px-2 py-0.5 flex items-center gap-1" style={{ background: c.color + "1A", color: c.color, fontSize: 11.5, fontWeight: 700 }}>
              <c.Icon size={11} />{c.label}
            </span>
            {pp && <span style={{ color: pp.color, fontSize: 12, fontWeight: 700 }}>{pp.name}</span>}
            {a.at && <span style={{ color: T.faint, fontSize: 12 }}>{relTime(a.at)}</span>}
          </div>
        </div>
        {!readOnly && (
          <button onClick={() => remove(a.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
        )}
      </div>
    );
  };

  return (
    <div className="pt-2 max-w-3xl mx-auto">
      {/* date nav — browse back through past evenings */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>
            {isToday ? "Tonight" : `${WD_LONG[vd.getDay()]}, ${MO_LONG[vd.getMonth()]} ${vd.getDate()}`}
          </h2>
          <p style={{ color: T.sub, fontSize: 14 }} className="truncate">
            {pane === "topics"
              ? (isToday
                  ? (liveOpen.length === 0 ? "Nothing to bring up" : `${liveOpen.length} to talk about`)
                  : `${archivedForDay.length} covered that night`)
              : pane === "status"
                ? `${Object.keys(dayStatus).length} of ${data.people.length} checked in`
                : `${(data.dateIdeas || []).filter((x) => !x.retired).length} ideas in the jars`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0" style={{ display: pane === "dates" ? "none" : undefined }}>
          <button onClick={() => setDayOffset(dayOffset - 1)} aria-label="Previous day"
            className="tapfade rounded-full p-1.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}>
            <ChevronLeft size={17} />
          </button>
          {!isToday && (
            <button onClick={() => setDayOffset(0)} className="tapfade rounded-full px-3 py-1.5 font-semibold"
              style={{ background: T.brand, color: "#fff", fontSize: 13 }}>Tonight</button>
          )}
          <button onClick={() => setDayOffset(Math.min(0, dayOffset + 1))} aria-label="Next day" disabled={isToday}
            className="tapfade rounded-full p-1.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: isToday ? T.faint : T.ink }}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      {/* topics / status */}
      <div className="flex gap-2 mb-4">
        {[["topics", "Topics", MessageCircle], ["status", "Status", HeartHandshake], ["dates", "Date jar", Dices]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setPane(id)} className="tapfade flex-1 py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2"
            style={{ background: pane === id ? T.brand : T.panel, color: pane === id ? "#fff" : T.sub, border: `1px solid ${pane === id ? T.brand : T.line}` }}>
            <Icon size={16} />{label}
          </button>
        ))}
      </div>

      {/* prompt of the day */}
      {prompt && pane !== "dates" && (
        <div className="rounded-2xl p-4 mb-4" style={{ background: T.brandSoft }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div style={{ color: T.brand, fontSize: 10.5, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-1">
                Tonight's question
              </div>
              <p style={{ color: T.brandInk, fontSize: 16.5, fontWeight: 600, lineHeight: 1.4 }}>{prompt}</p>
            </div>
            <button onClick={() => setEditPrompts(true)} title="Edit the prompt list"
              className="tapfade shrink-0 rounded-full p-2" style={{ background: T.panel, color: T.brand }}>
              <Pencil size={15} />
            </button>
          </div>
        </div>
      )}

      {pane === "topics" ? (
        <>
          {isToday && (
            <div className="rounded-2xl p-3 mb-4" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
              <div className="flex gap-2 mb-2.5">
                <input value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                  placeholder="Something to bring up tonight…"
                  className="flex-1 min-w-0 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
                <button onClick={add} className="tapfade shrink-0 px-5 rounded-xl font-semibold flex items-center gap-2" style={{ background: T.brand, color: "#fff" }}>
                  <Plus size={20} />{!isMobile && "Add"}
                </button>
              </div>
              <div className="flex gap-1.5 flex-wrap mb-2">
                {AGENDA_CATEGORIES.map((c) => (
                  <button key={c.id} onClick={() => setCategory(c.id)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
                    style={{ background: category === c.id ? c.color : T.panelAlt, color: category === c.id ? "#fff" : T.sub, border: `1px solid ${category === c.id ? c.color : T.line}` }}>
                    <c.Icon size={13} />{c.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 flex-wrap items-center">
                <span style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }}>Raised by:</span>
                <button onClick={() => setWho("")} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
                  style={{ background: who === "" ? T.ink : T.panelAlt, color: who === "" ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Either</button>
                {data.people.map((pp) => (
                  <button key={pp.id} onClick={() => setWho(pp.id)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
                    style={{ background: who === pp.id ? pp.color : T.panelAlt, color: who === pp.id ? "#fff" : T.ink, border: `1px solid ${who === pp.id ? pp.color : T.line}` }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: who === pp.id ? "#fff" : pp.color }} />{pp.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isToday ? (
            <>
              {items.length === 0 && <Empty text="Nothing yet. Add something you want to discuss." />}
              <div className="flex flex-col gap-2">{liveOpen.map((a) => <Row key={a.id} a={a} />)}</div>
              {liveDone.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase">Covered tonight</span>
                    <button onClick={archiveDone} className="tapfade flex items-center gap-2 px-3 py-1.5 rounded-full font-semibold"
                      style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12.5 }}>
                      <Archive size={14} /> File {liveDone.length}
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">{liveDone.map((a) => <Row key={a.id} a={a} muted />)}</div>
                </div>
              )}
            </>
          ) : (
            archivedForDay.length === 0
              ? <Empty text="Nothing was filed for that evening." />
              : <div className="flex flex-col gap-1.5">{archivedForDay.map((a) => <Row key={a.id} a={a} muted readOnly />)}</div>
          )}

          {archive.length > 0 && isToday && (
            <div className="mt-6 text-center">
              <button onClick={() => setShowArchive(!showArchive)} className="tapfade inline-flex items-center gap-2 px-4 py-2 rounded-full font-semibold"
                style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 13.5 }}>
                <History size={15} /> {showArchive ? "Hide" : "Show"} past conversations ({archive.length})
              </button>
            </div>
          )}
          {showArchive && isToday && archive.map((entry, i) => {
            const d2 = new Date(entry.date);
            return (
              <div key={i} className="mt-5">
                <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">
                  {WD_LONG[d2.getDay()]}, {MO_LONG[d2.getMonth()]} {d2.getDate()}
                </div>
                <div className="flex flex-col gap-1.5">
                  {(entry.items || []).map((a) => <Row key={a.id} a={a} muted readOnly />)}
                </div>
              </div>
            );
          })}
        </>
      ) : pane === "status" ? (
        <>
          {/* each person's own check-in */}
          <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0,1fr))" }}>
            {data.people.map((pp) => {
              const cur = dayStatus[pp.id];
              const vals = cur || { happiness: 3, connection: 3, intimacy: 3 };
              return (
                <div key={pp.id} className="rounded-2xl p-4" style={{ background: T.panel, border: `1px solid ${cur ? pp.color + "55" : T.line}` }}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-7 h-7 rounded-full flex items-center justify-center font-bold shrink-0"
                      style={{ background: pp.color + "22", color: pp.color, fontSize: 13 }}>{pp.name[0]}</span>
                    <span style={{ fontWeight: 700, fontSize: 16, color: pp.color }}>{pp.name}</span>
                    {!cur && <span style={{ color: T.faint, fontSize: 12, fontWeight: 600 }} className="ml-auto">not yet</span>}
                  </div>
                  {STATUS_DIMS.map((dim) => (
                    <div key={dim.key} className="mb-3">
                      <div className="flex items-baseline justify-between">
                        <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }} className="uppercase">{dim.label}</span>
                        <span style={{ color: pp.color, fontSize: 13, fontWeight: 800 }}>{SCALE[vals[dim.key]]}</span>
                      </div>
                      <ScaleTrack value={vals[dim.key]} color={pp.color}
                        onChange={(v) => setStatus(pp.id, dim.key, v)} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* The way into the walkthrough. There was no route to it from here at
              all: the only trigger was the header, or the app opening it itself
              at the appointed minute. Somebody looking at tonight's scores and
              wanting to actually do the check-in had nowhere to press. */}
          <button onClick={openCheckin}
            className="tapfade w-full mb-4 py-3 rounded-2xl font-semibold flex items-center justify-center gap-2"
            style={{ background: T.brand, color: "#fff" }}>
            <HeartHandshake size={17} /> Start tonight's check-in
          </button>

          {/* both scores on one track */}
          <div className="rounded-2xl p-4" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
            <h3 style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600 }} className="mb-1">How we're doing</h3>
            {Object.keys(dayStatus).length === 0 ? (
              <p style={{ color: T.faint, fontSize: 14 }}>No check-ins for this day yet.</p>
            ) : (
              <>
                <div className="flex items-center gap-3 flex-wrap mb-3">
                  {data.people.map((pp) => (
                    <span key={pp.id} className="flex items-center gap-1.5" style={{ fontSize: 12.5, fontWeight: 700, color: pp.color }}>
                      <span className="rounded-full" style={{ width: 10, height: 10, background: pp.color, display: "inline-block" }} />{pp.name}
                    </span>
                  ))}
                </div>
                {STATUS_DIMS.map((dim) => {
                  const marks = data.people
                    .filter((pp) => dayStatus[pp.id])
                    .map((pp) => ({ id: pp.id, name: pp.name, color: pp.color, value: dayStatus[pp.id][dim.key] }));
                  const avg = marks.length ? marks.reduce((n, m) => n + m.value, 0) / marks.length : 0;
                  return (
                    <div key={dim.key} className="mb-4">
                      <div className="flex items-baseline justify-between mb-1.5">
                        <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }} className="uppercase">{dim.label}</span>
                        <span style={{ color: T.ink, fontSize: 13, fontWeight: 800 }}>
                          {avg ? avg.toFixed(1) : "—"}
                          {marks.length === 2 && Math.abs(marks[0].value - marks[1].value) >= 2 && (
                            <span style={{ color: "#C2542F", fontWeight: 700 }}> · apart</span>
                          )}
                        </span>
                      </div>
                      <ScaleTrack marks={marks} />
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <StatusGraph data={data} todayKey={todayKey} />
        </>
      ) : (
        <DateJarPane data={data} update={update} personById={personById}
          jarId={jarId} setJarId={setJarId} drawn={drawn} setDrawn={setDrawn}
          ideaText={ideaText} setIdeaText={setIdeaText}
          showJarList={showJarList} setShowJarList={setShowJarList}
          newJar={newJar} setNewJar={setNewJar}
          addingJar={addingJar} setAddingJar={setAddingJar} who={who} setWho={setWho} />
      )}

      {editPrompts && (
        <Overlay close={() => setEditPrompts(false)}>
          <ModalHead title="Conversation prompts" close={() => setEditPrompts(false)} />
          <p style={{ color: T.sub, fontSize: 14, lineHeight: 1.5 }} className="mb-3">
            One prompt shows per night, picked by the day of the year so both of you see the same
            one. Add your own and they replace the built-in list.
          </p>
          <div className="flex gap-2 mb-4">
            <input value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addPrompt(); }}
              placeholder="Add a question…"
              className="flex-1 min-w-0 px-4 py-3 rounded-xl text-base outline-none" style={inputStyle} />
            <button onClick={addPrompt} className="tapfade px-4 rounded-xl font-semibold" style={{ background: T.brand, color: "#fff" }}>
              <Plus size={18} />
            </button>
          </div>
          <div style={{ color: T.sub, fontSize: 12, fontWeight: 700 }} className="uppercase mb-2">
            {(data.agendaPrompts || []).length ? `Yours (${data.agendaPrompts.length})` : `Built-in (${BUILTIN_PROMPTS.length})`}
          </div>
          <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
            {((data.agendaPrompts || []).length ? data.agendaPrompts : BUILTIN_PROMPTS).map((q, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: T.panelAlt }}>
                <span className="flex-1 min-w-0" style={{ fontSize: 14, lineHeight: 1.4 }}>{q}</span>
                {(data.agendaPrompts || []).length > 0 && (
                  <button onClick={() => removePrompt(i)} className="tapfade shrink-0" style={{ color: T.faint }}><Trash2 size={15} /></button>
                )}
              </div>
            ))}
          </div>
        </Overlay>
      )}
    </div>
  );
}

/* ---------------- Date-night jars ----------------
   Fill them whenever an idea occurs to you; draw when you can't decide. Drawing
   is deliberately not pure random — never-drawn ideas come first, then whatever
   was drawn longest ago, and never the same one twice in a row. Done ideas stay
   in the jar by default, since a good date is worth repeating.            */
function DateJarPane({ data, update, personById, jarId, setJarId, drawn, setDrawn,
  ideaText, setIdeaText, showJarList, setShowJarList, newJar, setNewJar,
  addingJar, setAddingJar, who, setWho }) {
  const isMobile = useMobile();
  const jars = data.dateJars || DEFAULT_DATE_JARS;
  const ideas = data.dateIdeas || [];
  const jar = jars.find((j) => j.id === jarId) || jars[0];
  const inJar = (jid) => ideas.filter((x) => x.jarId === jid && !x.retired);
  const jarIdeas = inJar(jar?.id);
  const retired = ideas.filter((x) => x.retired);

  const addIdea = () => {
    const t = ideaText.trim();
    if (!t) return;
    update((d) => {
      d.dateIdeas = [...(d.dateIdeas || []), {
        id: uid(), text: t, jarId: jar?.id || "cheap", personId: who || "",
        notes: "", addedOn: ymd(new Date()), drawnAt: 0, doneCount: 0, lastDoneOn: "", retired: false,
      }];
      return d;
    });
    setIdeaText("");
  };

  const draw = () => {
    const picked = pickDateIdea(ideas, jar?.id);
    if (!picked) { setDrawn({ empty: true }); return; }
    update((d) => {
      d.dateIdeas = d.dateIdeas.map((x) => x.id === picked.id ? { ...x, drawnAt: Date.now() } : x);
      return d;
    });
    setDrawn(picked);
  };

  const markDone = (id, retire) => {
    update((d) => {
      d.dateIdeas = d.dateIdeas.map((x) => x.id === id
        ? { ...x, doneCount: (x.doneCount || 0) + 1, lastDoneOn: ymd(new Date()), retired: retire || !!x.retired }
        : x);
      return d;
    });
    setDrawn(null);
  };
  /* ---- ask the AI to fill the jar ----
     Ryan: "make it so that you can give the AI a prompt to make some more
     additions to the different date jars." Suggestions are shown for approval
     rather than written straight in: the jar is the household's own list, and
     something they did not choose appearing in it is worse than a slower flow. */
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiIdeas, setAiIdeas] = useState([]);

  const askAi = async () => {
    setAiBusy(true); setAiError(null); setAiIdeas([]);
    try {
      const got = await suggestDateIdeas(data, {
        jar: jar?.name || jar?.id,
        existing: jarIdeas.map((x) => x.text),
        prompt: aiPrompt,
        count: 5,
      });
      if (!got.length) setAiError("Nothing came back. Try describing it differently.");
      setAiIdeas(got);
    } catch (err) {
      setAiError(err?.message || "The local model could not be reached.");
    } finally {
      setAiBusy(false);
    }
  };

  const keepIdea = (text) => {
    update((d) => {
      d.dateIdeas = [...(d.dateIdeas || []), {
        id: uid(), text, jarId: jar?.id || "cheap", personId: who || "",
        notes: "", addedOn: ymd(new Date()), drawnAt: 0, doneCount: 0, lastDoneOn: "",
        retired: false, fromAi: true,
      }];
      return d;
    });
    setAiIdeas((cur) => cur.filter((x) => x !== text));
  };

  const keepAll = () => { aiIdeas.forEach(keepIdea); setAiIdeas([]); };

  const removeIdea = (id) => update((d) => { d.dateIdeas = d.dateIdeas.filter((x) => x.id !== id); return d; });
  const setIdeaJar = (id, jid) => update((d) => { d.dateIdeas = d.dateIdeas.map((x) => x.id === id ? { ...x, jarId: jid } : x); return d; });
  const unretire = (id) => update((d) => { d.dateIdeas = d.dateIdeas.map((x) => x.id === id ? { ...x, retired: false } : x); return d; });

  const addJar = () => {
    const n = newJar.trim();
    if (!n) return;
    update((d) => {
      const cur = d.dateJars || [];
      if (cur.some((j) => j.name.toLowerCase() === n.toLowerCase())) return d;
      d.dateJars = [...cur, { id: uid(), name: n, color: JAR_COLORS[cur.length % JAR_COLORS.length] }];
      return d;
    });
    setNewJar(""); setAddingJar(false);
  };
  // removing a jar keeps its ideas — they just move to the first remaining jar,
  // because losing a list of good ideas to a stray tap would be awful
  const removeJar = (jid) => update((d) => {
    const left = (d.dateJars || []).filter((j) => j.id !== jid);
    if (!left.length) return d;
    d.dateJars = left;
    d.dateIdeas = (d.dateIdeas || []).map((x) => x.jarId === jid ? { ...x, jarId: left[0].id } : x);
    if (jarId === jid) setJarId(left[0].id);
    return d;
  });

  return (
    <div>
      {/* jar picker, with how full each one is */}
      <div className="flex gap-2 flex-wrap mb-4">
        {jars.map((j) => {
          const n = inJar(j.id).length;
          const on = j.id === jar?.id;
          return (
            <button key={j.id} onClick={() => { setJarId(j.id); setDrawn(null); }}
              className="tapfade flex items-center gap-2 rounded-2xl px-4 py-3"
              style={{ background: on ? j.color : T.panel, color: on ? "#fff" : T.ink,
                border: `1px solid ${on ? j.color : T.line}` }}>
              <Wine size={16} style={{ opacity: on ? 1 : 0.55 }} />
              <span style={{ fontSize: 15, fontWeight: 700 }}>{j.name}</span>
              <span className="rounded-full px-2 py-0.5" style={{
                background: on ? "#ffffff33" : T.panelAlt,
                color: on ? "#fff" : T.sub, fontSize: 12, fontWeight: 800 }}>{n}</span>
            </button>
          );
        })}
        {addingJar ? (
          <span className="flex items-center gap-1">
            <input autoFocus value={newJar} onChange={(e) => setNewJar(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addJar(); if (e.key === "Escape") setAddingJar(false); }}
              placeholder="Jar name"
              className="px-3 py-2.5 rounded-xl text-base outline-none" style={{ ...inputStyle, width: 140 }} />
            <button onClick={addJar} className="tapfade px-3 py-2.5 rounded-xl font-semibold" style={{ background: T.brand, color: "#fff", fontSize: 13 }}>Add</button>
          </span>
        ) : (
          <button onClick={() => setAddingJar(true)} className="tapfade px-3.5 py-3 rounded-2xl font-semibold"
            style={{ background: T.brandSoft, color: T.brand, fontSize: 13.5 }}>+ Jar</button>
        )}
      </div>

      {/* draw */}
      <div className="rounded-2xl p-5 mb-4 text-center" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
        {drawn && !drawn.empty ? (
          <>
            <div style={{ color: T.sub, fontSize: 11, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-2">
              From the {jar?.name} jar
            </div>
            <p style={{ fontFamily: DISPLAY, fontSize: isMobile ? 24 : 30, fontWeight: 600, lineHeight: 1.25, color: T.ink }}>
              {drawn.text}
            </p>
            {drawn.notes && <p style={{ color: T.sub, fontSize: 14 }} className="mt-1.5">{drawn.notes}</p>}
            <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
              {personById(drawn.personId) && (
                <span style={{ color: personById(drawn.personId).color, fontSize: 12.5, fontWeight: 700 }}>
                  {personById(drawn.personId).name}'s idea
                </span>
              )}
              {drawn.doneCount > 0 && (
                <span style={{ color: T.faint, fontSize: 12.5, fontWeight: 600 }}>
                  done {drawn.doneCount}×{drawn.lastDoneOn ? ` · last ${sinceLabel(drawn.lastDoneOn)}` : ""}
                </span>
              )}
            </div>
            <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
              <button onClick={() => markDone(drawn.id, false)} className="tapfade px-4 py-3 rounded-2xl font-semibold"
                style={{ background: T.brand, color: "#fff" }}>We're doing it</button>
              <button onClick={draw} className="tapfade px-4 py-3 rounded-2xl font-semibold flex items-center gap-2"
                style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}>
                <Dices size={16} /> Draw again
              </button>
              <button onClick={() => markDone(drawn.id, true)} title="Done, and don't offer it again"
                className="tapfade px-4 py-3 rounded-2xl font-semibold"
                style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>Did it, retire</button>
              <button onClick={() => setDrawn(null)} className="tapfade px-3 py-3 rounded-2xl" style={{ color: T.faint }}>
                <X size={17} />
              </button>
            </div>
          </>
        ) : drawn?.empty ? (
          <>
            <p style={{ color: T.sub, fontSize: 15.5 }}>The {jar?.name} jar is empty — add a few ideas below.</p>
            <button onClick={() => setDrawn(null)} className="tapfade mt-3 px-4 py-2.5 rounded-2xl font-semibold"
              style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>OK</button>
          </>
        ) : (
          <>
            <p style={{ color: T.sub, fontSize: 14.5 }} className="mb-3">
              {jarIdeas.length
                ? `${jarIdeas.length} idea${jarIdeas.length !== 1 ? "s" : ""} in the ${jar?.name} jar`
                : `The ${jar?.name} jar is empty`}
            </p>
            <button onClick={draw} disabled={!jarIdeas.length}
              className="tapfade px-6 py-4 rounded-2xl font-semibold text-lg flex items-center gap-2.5 mx-auto"
              style={{ background: jarIdeas.length ? (jar?.color || T.brand) : T.line,
                color: jarIdeas.length ? "#fff" : T.faint }}>
              <Dices size={20} /> Draw from {jar?.name}
            </button>
          </>
        )}
      </div>

      {/* ---- ask the AI for ideas ---- */}
      <div className="rounded-2xl p-3 mb-3" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex gap-2">
          <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !aiBusy) askAi(); }}
            placeholder={`Ask for ${jar?.name} ideas — "cheap, outdoors, under two hours"`}
            className="flex-1 min-w-0 px-4 py-3 rounded-xl outline-none" style={inputStyle} />
          <button onClick={askAi} disabled={aiBusy}
            className="tapfade shrink-0 px-4 rounded-xl font-semibold flex items-center gap-2"
            style={{ background: aiBusy ? T.panelAlt : T.ink, color: aiBusy ? T.faint : "#fff" }}>
            <Sparkles size={17} />{!isMobile && (aiBusy ? "Thinking…" : "Suggest")}
          </button>
        </div>
        <p style={{ color: T.faint, fontSize: 11.5, marginTop: 6 }}>
          Runs on this house's own machine. Nothing is sent anywhere else.
        </p>

        {aiError && (
          <p role="alert" style={{ color: T.dangerInk, fontSize: 12.5, marginTop: 6 }}>{aiError}</p>
        )}

        {aiIdeas.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {aiIdeas.map((text) => (
              <div key={text} className="flex items-center gap-2 rounded-xl px-3 py-2.5"
                style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                <span className="flex-1 min-w-0" style={{ fontSize: 14.5, color: T.ink }}>{text}</span>
                <button onClick={() => keepIdea(text)} className="tapfade shrink-0 px-3 py-1.5 rounded-full font-bold"
                  style={{ background: T.brand, color: "#fff", fontSize: 12 }}>Keep</button>
                <button onClick={() => setAiIdeas((cur) => cur.filter((x) => x !== text))}
                  className="tapfade shrink-0 p-1" style={{ color: T.faint }} aria-label="Discard">
                  <X size={15} />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={keepAll} className="tapfade text-sm font-bold" style={{ color: T.brand }}>
                Keep all {aiIdeas.length}
              </button>
              <button onClick={() => setAiIdeas([])} className="tapfade text-sm font-bold" style={{ color: T.sub }}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      {/* add an idea */}
      <div className="rounded-2xl p-3 mb-4" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex gap-2 mb-2.5">
          <input value={ideaText} onChange={(e) => setIdeaText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addIdea(); }}
            placeholder={`Add an idea to the ${jar?.name} jar…`}
            className="flex-1 min-w-0 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <button onClick={addIdea} className="tapfade shrink-0 px-5 rounded-xl font-semibold flex items-center gap-2"
            style={{ background: T.brand, color: "#fff" }}>
            <Plus size={20} />{!isMobile && "Add"}
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <span style={{ color: T.sub, fontSize: 12.5, fontWeight: 700 }}>Whose idea:</span>
          <button onClick={() => setWho("")} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
            style={{ background: who === "" ? T.ink : T.panelAlt, color: who === "" ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Either</button>
          {data.people.map((pp) => (
            <button key={pp.id} onClick={() => setWho(pp.id)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
              style={{ background: who === pp.id ? pp.color : T.panelAlt, color: who === pp.id ? "#fff" : T.ink,
                border: `1px solid ${who === pp.id ? pp.color : T.line}` }}>
              <span className="w-2 h-2 rounded-full" style={{ background: who === pp.id ? "#fff" : pp.color }} />{pp.name}
            </button>
          ))}
        </div>
      </div>

      {/* what's in this jar */}
      <button onClick={() => setShowJarList(!showJarList)} className="tapfade flex items-center gap-2 mb-2"
        style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
        <ChevronRight size={13} style={{ transform: showJarList ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
        <span className="uppercase">What's in the {jar?.name} jar ({jarIdeas.length})</span>
      </button>

      {showJarList && (
        <div className="flex flex-col gap-2">
          {jarIdeas.length === 0 && <p style={{ color: T.faint, fontSize: 14 }}>Nothing yet.</p>}
          {jarIdeas.map((x) => {
            const pp = personById(x.personId);
            return (
              <div key={x.id} className="flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 15.5, fontWeight: 600 }} className="truncate">{x.text}</div>
                  <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 11.5, fontWeight: 600 }}>
                    {pp && <span style={{ color: pp.color }}>{pp.name}</span>}
                    {x.doneCount > 0 && <span style={{ color: T.faint }}>done {x.doneCount}×</span>}
                    {x.lastDoneOn && <span style={{ color: T.faint }}>last {sinceLabel(x.lastDoneOn)}</span>}
                    {!x.drawnAt && !x.doneCount && <span style={{ color: T.brand }}>never drawn</span>}
                  </div>
                </div>
                <select value={x.jarId} onChange={(e) => setIdeaJar(x.id, e.target.value)}
                  aria-label="Jar" className="rounded-lg px-2 py-1 font-semibold outline-none shrink-0"
                  style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12.5 }}>
                  {jars.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
                <button onClick={() => removeIdea(x.id)} className="tapfade p-1 shrink-0" style={{ color: T.faint }}><Trash2 size={15} /></button>
              </div>
            );
          })}

          {retired.length > 0 && (
            <div className="mt-3">
              <div style={{ color: T.faint, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-1.5">
                Retired ({retired.length})
              </div>
              <div className="flex flex-col gap-1.5">
                {retired.map((x) => (
                  <div key={x.id} className="flex items-center gap-2.5 rounded-xl px-3.5 py-2" style={{ opacity: 0.6 }}>
                    <span className="flex-1 min-w-0 truncate" style={{ fontSize: 14.5, fontWeight: 500, textDecoration: "line-through" }}>{x.text}</span>
                    <button onClick={() => unretire(x.id)} className="tapfade px-2.5 py-1 rounded-full font-semibold"
                      style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.brand, fontSize: 11.5 }}>Put back</button>
                    <button onClick={() => removeIdea(x.id)} className="tapfade p-1 shrink-0" style={{ color: T.faint }}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {jars.length > 1 && (
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700 }} className="uppercase">Jars</span>
              {jars.map((j) => (
                <span key={j.id} className="flex items-center gap-1 rounded-full pl-3 pr-1.5 py-1" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: j.color }}>{j.name}</span>
                  <button onClick={() => removeJar(j.id)} className="tapfade" style={{ color: T.faint }} aria-label={`Remove ${j.name}`}><X size={12} /></button>
                </span>
              ))}
              <span style={{ color: T.faint, fontSize: 11.5 }}>removing a jar keeps its ideas</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Lists: running lists for random things ----------------
   Ryan asked for "notes or running lists for random things, similar to the
   notes app in icloud", manageable in the hub or through a native app.

   The native half is worth being precise about, because the obvious reading is
   wrong: Apple Notes has no third-party sync surface at all. Apple *Reminders*
   does -- it is CalDAV VTODO -- and a list here maps onto one exactly. So a
   list can be pushed to Reminders, and lib/lists.js carries the VTODO shape.

   Deliberately unsorted: a shopping list in aisle order or a packing list in
   the order you actually pack is information that sorting throws away.       */
export function ListsView({ data, update, personById }) {
  const isMobile = useMobile();
  const lists = LISTS.listsOf(data);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState("");

  const open = lists.find((l) => l.id === openId) || null;

  const addList = () => {
    const l = LISTS.createList("New list");
    update((d) => LISTS.upsertList(d, l));
    setOpenId(l.id);
  };
  const mutate = (fn) => update((d) => LISTS.withList(d, openId, fn));

  const addItem = () => {
    const text = draft.trim();
    if (!text) return;
    mutate((l) => LISTS.addItem(l, text));
    setDraft("");
  };

  /* ---- one list, opened ---- */
  if (open) {
    const progress = LISTS.listProgress(open);
    const items = LISTS.itemsOf(open);
    return (
      <div className="pt-2 max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setOpenId(null)} className="tapfade p-1.5 rounded-lg"
            style={{ color: T.sub }} aria-label="Back to lists">
            <ChevronRight size={20} style={{ transform: "rotate(180deg)" }} />
          </button>
          <input
            value={open.title}
            onChange={(e) => mutate((l) => ({ ...l, title: e.target.value, updatedOn: Date.now() }))}
            className="flex-1 min-w-0 bg-transparent outline-none"
            style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600, color: T.ink }}
            aria-label="List title"
          />
          {progress && (
            <span className="rounded-full px-2.5 py-1 shrink-0"
              style={{ background: T.panelAlt, color: T.sub, fontSize: 12, fontWeight: 800 }}>
              {progress.done}/{progress.total}
            </span>
          )}
          <button onClick={() => { update((d) => LISTS.removeList(d, open.id)); setOpenId(null); }}
            className="tapfade p-1.5 shrink-0" style={{ color: T.faint }} aria-label="Delete list">
            <Trash2 size={18} />
          </button>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
            placeholder="Add something…"
            className="flex-1 min-w-0 px-4 py-3 rounded-xl outline-none"
            style={inputStyle}
          />
          <button onClick={addItem} className="tapfade px-4 rounded-xl font-semibold"
            style={{ background: T.brand, color: "#fff" }} aria-label="Add item">
            <Plus size={18} />
          </button>
        </div>

        {items.length === 0 ? (
          <Empty text="Nothing on this list yet." />
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item, i) => (
              <div key={item.id} className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
                style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                {/* Only the circle ticks, the same rule as Today. */}
                <button onClick={() => mutate((l) => LISTS.toggleItem(l, item.id))}
                  className="tapfade shrink-0" aria-label={`${item.done ? "Untick" : "Tick"} ${item.text}`}
                  style={{ color: item.done ? T.brand : T.faint }}>
                  {item.done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
                </button>
                <input
                  value={item.text}
                  onChange={(e) => mutate((l) => LISTS.editItem(l, item.id, { text: e.target.value }))}
                  className="flex-1 min-w-0 bg-transparent outline-none"
                  style={{
                    fontSize: 15.5, fontWeight: 600, color: item.done ? T.faint : T.ink,
                    textDecoration: item.done ? "line-through" : "none",
                  }}
                  aria-label={`Edit ${item.text}`}
                />
                <div className="flex shrink-0">
                  <button onClick={() => mutate((l) => LISTS.moveItem(l, item.id, i - 1))}
                    disabled={i === 0} className="tapfade p-1"
                    style={{ color: i === 0 ? T.line : T.faint }} aria-label="Move up">
                    <ChevronRight size={14} style={{ transform: "rotate(-90deg)" }} />
                  </button>
                  <button onClick={() => mutate((l) => LISTS.moveItem(l, item.id, i + 1))}
                    disabled={i === items.length - 1} className="tapfade p-1"
                    style={{ color: i === items.length - 1 ? T.line : T.faint }} aria-label="Move down">
                    <ChevronRight size={14} style={{ transform: "rotate(90deg)" }} />
                  </button>
                  <button onClick={() => mutate((l) => LISTS.removeItem(l, item.id))}
                    className="tapfade p-1" style={{ color: T.faint }} aria-label={`Remove ${item.text}`}>
                    <X size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {progress && progress.done > 0 && (
          <button onClick={() => mutate((l) => LISTS.clearDone(l))}
            className="tapfade mt-3 text-sm font-bold" style={{ color: T.sub }}>
            Clear {progress.done} ticked
          </button>
        )}
      </div>
    );
  }

  /* ---- the shelf of lists ---- */
  return (
    <div className="pt-2 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Lists</h2>
          <p style={{ color: T.sub, fontSize: 14 }}>
            {lists.length === 0 ? "Running lists for whatever needs one" : `${lists.length} list${lists.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button onClick={addList} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold"
          style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> List</button>
      </div>

      {lists.length === 0 ? (
        <Empty text="No lists yet. Packing, DIY, films to watch — whatever needs one." />
      ) : (
        <div className="grid gap-3"
          style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill,minmax(220px,1fr))" }}>
          {lists.map((l) => {
            const progress = LISTS.listProgress(l);
            const preview = LISTS.itemsOf(l).filter((i) => !i.done).slice(0, 3);
            return (
              <button key={l.id} onClick={() => setOpenId(l.id)} className="tapfade text-left rounded-2xl p-4"
                style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="truncate" style={{ fontSize: 17, fontWeight: 700, color: T.ink }}>{l.title}</span>
                  {progress && (
                    <span className="shrink-0 rounded-full px-2 py-0.5"
                      style={{ background: T.panelAlt, color: T.sub, fontSize: 11.5, fontWeight: 800 }}>
                      {progress.done}/{progress.total}
                    </span>
                  )}
                </div>
                {preview.length === 0 ? (
                  <span style={{ color: T.faint, fontSize: 13 }}>
                    {progress ? "All done" : "Empty"}
                  </span>
                ) : preview.map((i) => (
                  <div key={i.id} className="truncate" style={{ color: T.sub, fontSize: 13.5 }}>· {i.text}</div>
                ))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- Board: sticky notes + important dates ---------------- */
export function BoardView({ data, update, personById, todayKey, openNote, openDate }) {
  const isMobile = useMobile();
  const notes = data.notes;
  const removeNote = (id) => update((d) => { d.notes = d.notes.filter((n) => n.id !== id); return d; });
  const removeDate = (id) => update((d) => { d.dates = d.dates.filter((x) => x.id !== id); return d; });

  /* A date that has gone by used to sit at the top of this list forever,
     counting further and further negative. Split them: what is still ahead
     stays a countdown, what is behind moves into a history you can still look
     at. Annual dates never end up there -- `nextOccurrence` rolls them to next
     year, which is what an anniversary actually does. */
  const { upcoming: dates, past: pastDates } = partitionDates(
    data.dates || [], todayKey, { resolve: nextOccurrence, diff: daysBetween });
  const [showPast, setShowPast] = useState(false);

  return (
    <div className="pt-2 grid gap-5 md:gap-6 max-w-5xl mx-auto"
      style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))" }}>

      {/* Notes */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Notes</h2>
            <p style={{ color: T.sub, fontSize: 14 }}>{notes.length === 0 ? "The fridge door, digitally" : `${notes.length} note${notes.length !== 1 ? "s" : ""} on the board`}</p>
          </div>
          <button onClick={() => openNote(null)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> Note</button>
        </div>
        {notes.length === 0 ? <Empty text="No notes yet. Leave one for the household." /> : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            {notes.map((n) => {
              const p = personById(n.personId);
              return (
                <div key={n.id} className="rounded-xl p-3.5 flex flex-col"
                  style={{ background: n.color || NOTE_COLORS[0], minHeight: 120, boxShadow: "0 2px 8px #2C253618" }}>
                  <button onClick={() => openNote(n)} className="tapfade text-left flex-1">
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#3A3142", whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{n.text}</div>
                  </button>
                  <div className="flex items-center justify-between mt-2 pt-2" style={{ borderTop: "1px solid #2C253614" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#3A3142AA" }}>{p ? p.name : "Household"}</span>
                    <button onClick={() => removeNote(n.id)} className="tapfade" style={{ color: "#3A314288" }}><Trash2 size={15} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Important dates */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Important dates</h2>
            <p style={{ color: T.sub, fontSize: 14 }}>Countdowns to what's coming</p>
          </div>
          <button onClick={() => openDate(null)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> Date</button>
        </div>
        {dates.length === 0 ? <Empty text="No dates yet. Add an anniversary or a trip." /> : (
          <div className="flex flex-col gap-2.5">
            {dates.map((d) => {
              const u = styleFor(d.urgency);
              const w = d.when ? parseYMD(d.when) : null;
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-2xl px-4 py-3.5"
                  style={{ background: u.bg, border: `${u.bold ? 1.5 : 1}px solid ${u.border}` }}>
                  <div className="rounded-xl p-2.5 shrink-0" style={{ background: u.fg + "1A", color: u.fg }}>
                    {d.days === 0 ? <PartyPopper size={19} /> : <Hourglass size={19} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 17, fontWeight: 600 }} className="truncate flex items-center gap-1.5">
                      {d.title}{d.annual && <Repeat size={12} style={{ color: T.faint }} />}
                    </div>
                    {w && <div style={{ color: T.sub, fontSize: 13, fontWeight: 600 }}>{WD_SHORT[w.getDay()]}, {MO_LONG[w.getMonth()].slice(0, 3)} {w.getDate()}{d.annual ? ` ${w.getFullYear()}` : ""}</div>}
                  </div>
                  <span className="rounded-full px-3 py-1.5 text-sm font-bold shrink-0"
                    style={{ background: u.bold ? "#FFFFFFAA" : T.panelAlt, color: u.bold ? u.ink : T.sub }}>
                    {d.days === null ? "—" : d.days === 0 ? "Today" : `${d.days}d`}
                  </span>
                  <button onClick={() => openDate(d)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                  <button onClick={() => removeDate(d.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                </div>
              );
            })}
          </div>
        )}

        {/* ---- dates that have already happened ---- */}
        {pastDates.length > 0 && (
          <div className="mt-4">
            <button onClick={() => setShowPast((v) => !v)}
              className="tapfade flex items-center gap-2 text-sm font-bold"
              style={{ color: T.sub }}>
              <History size={15} />
              {showPast ? "Hide" : "Show"} history · {pastDates.length}
            </button>
            {showPast && (
              <div className="flex flex-col gap-2 mt-2.5">
                {pastDates.map((d) => {
                  const w = d.when ? parseYMD(d.when) : null;
                  return (
                    <div key={d.id} className="flex items-center gap-3 rounded-2xl px-4 py-3"
                      style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                      <div className="rounded-xl p-2 shrink-0" style={{ background: T.faint + "1A", color: T.faint }}>
                        <History size={17} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate" style={{ fontSize: 16, fontWeight: 600, color: T.sub }}>{d.title}</div>
                        {w && (
                          <div style={{ color: T.faint, fontSize: 12.5, fontWeight: 600 }}>
                            {WD_SHORT[w.getDay()]}, {MO_LONG[w.getMonth()].slice(0, 3)} {w.getDate()} {w.getFullYear()} · {agoLabel(d.days)}
                          </div>
                        )}
                      </div>
                      {/* Still editable: a date put in the past by a typo has to
                          be reachable, and so does one worth keeping. */}
                      <button onClick={() => openDate(d)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Settings size={16} /></button>
                      <button onClick={() => removeDate(d.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Home (read-only Home Assistant view) ----------------
   Display only by design: no service calls are exposed by the server, so
   nothing here can change the state of the house. That keeps a wall screen
   from unlocking a door on a stray tap.                                  */

// How often to pull fresh states and camera stills.
const HOME_STATE_MS = 5000;
const HOME_SNAP_MS = 2000;

/**
 * One household's Home Assistant: what it is showing, and whether it can be
 * touched.
 *
 * Routed through lib/session, so the same component works for a signed-in
 * member and for a wall display -- session picks the right endpoints and, for a
 * display, applies the domains that screen was granted.
 */
function useHomeAssistant() {
  const [entities, setEntities] = useState([]);
  const [groups, setGroups] = useState([]);
  const [conn, setConn] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;

    // A display cannot read the setup endpoint; it learns what it may do from
    // its own bootstrap instead.
    if (session.isDisplay()) {
      const snap = session.snapshot();
      setConn({ connected: true, controlEnabled: true, displayDomains: snap.displayControlDomains || [] });
    } else {
      session.request("GET", `api/households/${session.householdId()}/home`)
        .then((c) => { if (!dead) setConn(c); })
        .catch(() => { if (!dead) setConn({ connected: false }); });
    }

    const load = async () => {
      try {
        // The devices endpoint applies the household's own names, rooms and
        // ordering, so the wall display shows "Greenhouse" rather than
        // sensor.0x00158d0004a1b2c3_temperature.
        const d = await session.homeDevices();
        if (!dead) {
          setEntities(Array.isArray(d.entities) ? d.entities : []);
          setGroups(Array.isArray(d.groups) ? d.groups : []);
          setErr(null);
        }
      } catch (e) {
        if (!dead) setErr(e.status === 503 ? null : (e.message || "unavailable"));
      }
    };
    load();
    const t = setInterval(load, HOME_STATE_MS);
    return () => { dead = true; clearInterval(t); };
  }, []);

  /** Switch something, optimistically, and re-read on the next poll. */
  const toggle = useCallback(async (entity) => {
    setEntities((list) => list.map((e) =>
      e.entityId === entity.entityId ? { ...e, state: isOn(e) ? "off" : "on", _pending: true } : e));
    try {
      await session.homeControl(entity.entityId, "toggle");
      const d = await session.homeDevices();
      setEntities(d.entities || []);
      setGroups(d.groups || []);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  return { entities, groups, conn, err, toggle };
}

const ON_STATES = new Set(["on", "open", "unlocked", "playing", "home", "detected"]);
const isOn = (e) => ON_STATES.has(String(e.state).toLowerCase());
// things worth drawing attention to on a glanceable screen
const isAlert = (e) =>
  (e.domain === "lock" && String(e.state).toLowerCase() === "unlocked") ||
  (e.domain === "binary_sensor" && ["door", "window", "garage_door", "opening"].includes(e.deviceClass) && isOn(e)) ||
  (e.domain === "cover" && String(e.state).toLowerCase() === "open");

function CameraTile({ entity }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), HOME_SNAP_MS);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rounded-xl overflow-hidden relative" style={{ background: "#1B1720", aspectRatio: "16/9" }}>
      {!failed ? (
        <img
          src={`${session.cameraUrl(entity.entityId)}${session.cameraUrl(entity.entityId).includes("?") ? "&" : "?"}t=${tick}`}
          alt={entity.name}
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5" style={{ color: "#8A8194" }}>
          <Video size={22} />
          <span style={{ fontSize: 12 }}>No signal</span>
        </div>
      )}
      <div className="absolute left-0 right-0 bottom-0 px-2.5 py-1.5 flex items-center gap-1.5"
        style={{ background: "linear-gradient(transparent,#0009)" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: failed ? "#8A8194" : "#E86A4C" }} />
        <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }} className="truncate">{entity.name}</span>
      </div>
    </div>
  );
}

function HomeView({ data }) {
  const isMobile = useMobile();
  const { entities, groups, conn, err, toggle } = useHomeAssistant();
  const cameras = entities.filter((e) => e.domain === "camera");
  const rest = entities.filter((e) => e.domain !== "camera");
  const alerts = rest.filter(isAlert);
  const others = rest.filter((e) => !isAlert(e));
  const dash = conn?.dashboardUrl || data.homeDashboardUrl;

  const label = (e) => {
    if (e.domain === "sensor") return `${e.state}${e.unit ? ` ${e.unit}` : ""}`;
    if (e.domain === "light" && isOn(e) && e.brightness != null) return `On · ${e.brightness}%`;
    const t = String(e.state);
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const iconFor = (e) =>
    e.domain === "light" ? <Lightbulb size={17} />
      : e.domain === "lock" ? <LockKeyhole size={17} />
        : e.domain === "binary_sensor" || e.domain === "cover" ? <DoorOpen size={17} />
          : e.domain === "sensor" ? <Thermometer size={17} />
            : <Sofa size={17} />;

  // What this viewer may switch. A display gets only the domains it was
  // granted; locks are never in that list and the server refuses them anyway.
  const SWITCHABLE = ["light", "switch", "fan", "cover"];
  const canSwitch = (e) => {
    if (!conn?.controlEnabled) return false;
    if (e.domain === "lock") return !session.isDisplay();   // and adult+, enforced server-side
    if (!SWITCHABLE.includes(e.domain)) return false;
    if (session.isDisplay()) return (conn.displayDomains || []).includes(e.domain);
    return true;
  };

  const Tile = ({ e, alert }) => {
    const on = isOn(e);
    const accent = alert ? "#E86A4C" : on ? T.gold : T.faint;
    const tappable = canSwitch(e);
    const Wrapper = tappable ? "button" : "div";
    return (
      <Wrapper
        {...(tappable ? { onClick: () => toggle(e), type: "button" } : {})}
        className={`rounded-xl px-3 py-2.5 flex items-center gap-2.5 min-w-0 ${tappable ? "tapfade text-left w-full" : ""}`}
        style={{ background: alert ? "#E86A4C10" : T.panelAlt, border: `1px solid ${alert ? "#E86A4C55" : "transparent"}`, opacity: e._pending ? 0.6 : 1 }}>
        <span className="rounded-lg p-1.5 shrink-0" style={{ background: accent + "22", color: accent }}>{iconFor(e)}</span>
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: 14.5, fontWeight: 600 }} className="truncate">{e.name}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: alert ? "#C2542F" : on ? T.sub : T.faint }} className="truncate">{label(e)}</div>
        </div>
      </Wrapper>
    );
  };

  if (conn && !conn.connected) {
    return (
      <div className="pt-6 max-w-lg mx-auto text-center flex flex-col items-center gap-3">
        <Sofa size={34} style={{ color: T.faint }} />
        <h2 style={{ fontFamily: DISPLAY, fontSize: 22, fontWeight: 600 }}>Home Assistant isn't connected</h2>
        <p style={{ color: T.sub, fontSize: 14.5, lineHeight: 1.6 }}>
          Connect your household's own Home Assistant in <strong>Settings → Home Assistant</strong>.
          Each household connects its own; this server does not have one of its own to share.
        </p>
      </div>
    );
  }

  return (
    <div className="pt-2 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Home</h2>
          <p style={{ color: T.sub, fontSize: 14 }} className="truncate">
            {err ? "Can't reach Home Assistant right now" : `${entities.length} things · view only`}
          </p>
        </div>
        {dash && (
          <a href={dash} target="_blank" rel="noreferrer"
            className="tapfade shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold"
            style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink, fontSize: 14 }}>
            <ExternalLink size={16} /> Full controls
          </a>
        )}
      </div>

      {entities.length === 0 && !err && (
        <Empty text="Nothing chosen yet. Pick what to show in Settings → Home." />
      )}

      {cameras.length > 0 && (
        <div className="grid gap-2.5 mb-4"
          style={{ gridTemplateColumns: isMobile ? "1fr" : `repeat(${Math.min(cameras.length, 3)}, minmax(0,1fr))` }}>
          {cameras.map((c) => <CameraTile key={c.id} entity={c} />)}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="mb-4">
          <div style={{ color: "#E86A4C", fontSize: 11, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-1.5">Needs a look</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(210px, 1fr))" }}>
            {alerts.map((e) => <Tile key={e.entityId} e={e} alert />)}
          </div>
        </div>
      )}

      {/* Grouped by the household's own rooms when they have set any up, and a
          single list when they have not -- nobody should have to invent a room
          taxonomy before their lights show up. */}
      {others.length > 0 && (
        groups.filter((g) => g.room).length ? (
          groups.map((g) => {
            const items = g.entities.filter((e) => others.some((o) => o.entityId === e.entityId));
            if (!items.length) return null;
            return (
              <div key={g.room || "_none"} className="mb-3">
                <h3 style={{ fontSize: 12.5, fontWeight: 700, color: T.faint, letterSpacing: 0.3, marginBottom: 6 }}>
                  {(g.room || "Elsewhere").toUpperCase()}
                </h3>
                <div className="grid gap-2" style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(210px, 1fr))" }}>
                  {items.map((e) => <Tile key={e.entityId} e={e} />)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(210px, 1fr))" }}>
            {others.map((e) => <Tile key={e.entityId} e={e} />)}
          </div>
        )
      )}
    </div>
  );
}

/* ---------------- Home settings: pick what appears ---------------- */
// Home Assistant settings now live in components/HomeAssistantPanel.jsx: the
// connection is per household and stored on the server, not a list of entity
// ids inside the document. This shim keeps the Settings tab wiring unchanged.
function HomeSettings() {
  return <HomeAssistantPanel theme={T} />;
}

/* ---------------- Nightly check-in ----------------
   The walkthrough only lists what actually needs attention, so a quiet night is
   a few taps and a busy one is still bounded. It ends by choosing tomorrow's
   time, which is both the override and the fallback when the calendar can't
   tell us when work finishes.                                            */
/* ---------------------------------------------------------------
   Time-of-day reminders.

   A chore having an assignee and a due date is not the same as it getting done.
   These are for the ones with a consequence attached — pet medication, bins out
   before the lorry, a dose at a fixed hour — where "it's on the list" is not
   enough and something has to actually interrupt.

   Deliberately evaluated in the browser rather than on the server. The server
   cannot read the household document at all, so it does not know these chores
   exist, let alone what they are called. See ALERTS in the client notes and the
   reminder-relay settings for how that constraint shapes phone notifications.
--------------------------------------------------------------- */

function AlertEditor({ value, onChange }) {
  const on = hasAlert({ alert: value });
  const a = value && value.at ? value : DEFAULT_ALERT;
  return (
    <Field label="Remind us if it isn't done">
      <div className="flex gap-2 mb-2">
        <button onClick={() => onChange(null)} className="tapfade flex-1 py-2.5 rounded-xl font-semibold"
          style={{ background: !on ? T.brand : T.panelAlt, color: !on ? "#fff" : T.ink, border: `1px solid ${!on ? T.brand : T.line}` }}>
          No reminder
        </button>
        <button onClick={() => onChange({ ...DEFAULT_ALERT, ...(value || {}) })}
          className="tapfade flex-1 py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2"
          style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>
          <BellRing size={15} /> Remind
        </button>
      </div>
      {on && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">By</div>
              <input type="time" value={a.at} onChange={(e) => onChange({ ...a, at: e.target.value })}
                className="w-full px-2.5 py-2.5 rounded-xl text-base outline-none" style={inputStyle} />
            </div>
            <div>
              <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">Repeat</div>
              <select value={a.everyMins} onChange={(e) => onChange({ ...a, everyMins: Number(e.target.value) })}
                className="w-full px-2 py-2.5 rounded-xl text-base outline-none" style={inputStyle}>
                {[5, 10, 15, 30, 60].map((n) => <option key={n} value={n}>every {n}m</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">Stop at</div>
              <input type="time" value={a.until} onChange={(e) => onChange({ ...a, until: e.target.value })}
                className="w-full px-2.5 py-2.5 rounded-xl text-base outline-none" style={inputStyle} />
            </div>
          </div>
          <div className="mt-2.5">
            <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">How loud</div>
            <div className="flex gap-2">
              {[["banner", "Banner", "a strip under the header"],
                ["popup", "Takeover", "fills the screen — hard to miss"]].map(([id, l, hint]) => {
                const sel = (a.style || "banner") === id;
                return (
                  <button key={id} onClick={() => onChange({ ...a, style: id })}
                    className="tapfade flex-1 text-left px-3 py-2.5 rounded-xl"
                    style={{ background: sel ? T.brand : T.panelAlt, color: sel ? "#fff" : T.ink,
                      border: `1px solid ${sel ? T.brand : T.line}` }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{l}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.85 }}>{hint}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
            Chimes from {fmtTime(a.at)} until it's ticked off, stopping at {fmtTime(a.until)}.
            A screen has to be awake to sound — for anything critical also turn on
            phone reminders in Settings.
          </p>
        </>
      )}
    </Field>
  );
}

/* One action set, shared by the banner and the takeover so the two cannot drift
   apart: done, skip, snooze, and correct who actually did it. That last one
   matters because the rotation is frequently wrong about reality — it says it
   was your turn, but the other person was already up. */
function AlertActions({ a, people, onDone, onSkip, onSnooze, onCredit, big, light }) {
  const [who, setWho] = useState(false);
  const btn = (bg, fg) => ({
    background: bg, color: fg, fontSize: big ? 15 : 13.5, fontWeight: 800,
    padding: big ? "12px 20px" : "8px 16px", borderRadius: 999,
  });
  const ghost = light
    ? { background: "#ffffff2e", color: "#fff" }
    : { background: T.panelAlt, color: T.sub, border: `1px solid ${T.line}` };
  return (
    <div className={big ? "flex flex-col gap-2.5 items-stretch" : "flex items-center gap-2 flex-wrap"}>
      <div className={big ? "flex gap-2.5 justify-center flex-wrap" : "flex items-center gap-2 flex-wrap"}>
        <button onClick={() => onDone(a)} aria-label={`Mark ${a.title} done`} className="tapfade shrink-0"
          style={btn(light ? "#fff" : T.brand, light ? "#B4442A" : "#fff")}>Done</button>
        <button onClick={() => onSkip(a)} aria-label={`Skip ${a.title}`}
          className="tapfade shrink-0" style={{ ...btn("", ""), ...ghost }}>Skip</button>
        <button onClick={() => onSnooze(a, 10)} aria-label={`Snooze ${a.title} for ten minutes`}
          className="tapfade shrink-0" style={{ ...btn("", ""), ...ghost }}>Snooze 10m</button>
        <button onClick={() => setWho(!who)} aria-label={`Change who did ${a.title}`}
          className="tapfade shrink-0" style={{ ...btn("", ""), ...ghost }}>
          {a.person ? a.person.name : "Who?"}
        </button>
      </div>
      {who && (
        <div className={`flex items-center gap-1.5 flex-wrap ${big ? "justify-center" : ""}`}>
          <span style={{ fontSize: 12, fontWeight: 700, color: light ? "#ffffffcc" : T.sub }}>Done by</span>
          {people.map((pp) => (
            <button key={pp.id} onClick={() => { onCredit(a, pp.id); setWho(false); }}
              aria-label={`Credit ${pp.name} for ${a.title}`}
              className="tapfade px-3 py-1.5 rounded-full font-bold"
              style={{ background: light ? "#ffffff2e" : T.panelAlt, color: light ? "#fff" : T.ink,
                border: `1px solid ${light ? "#ffffff44" : T.line}`, fontSize: 12.5 }}>
              {pp.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* The takeover. For the ones where a strip along the top is not enough — pet
   medication being the case that prompted it. */
function AlertPopup({ alerts, people, onDone, onSkip, onSnooze, onCredit }) {
  const isMobile = useMobile();
  if (!alerts.length) return null;
  const a = alerts[0];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="alertdialog" aria-modal="true" aria-label={`Reminder: ${a.title}`}
      style={{ background: "#B4442AF0", backdropFilter: "blur(2px)" }}>
      <div className="text-center" style={{ maxWidth: 520 }}>
        <BellRing size={isMobile ? 46 : 60} style={{ color: "#fff", margin: "0 auto 14px",
          animation: "hubshake 1.1s ease-in-out infinite" }} />
        <div style={{ color: "#ffffffcc", fontSize: 12.5, fontWeight: 800, letterSpacing: 1.4 }} className="uppercase mb-1.5">
          {a.overdue < 1 ? "Due now" : `${a.overdue} minutes late`}
        </div>
        <h2 style={{ fontFamily: DISPLAY, fontSize: isMobile ? 32 : 44, fontWeight: 600, color: "#fff", lineHeight: 1.1 }}>
          {a.title}
        </h2>
        <p style={{ color: "#ffffffdd", fontSize: 15, fontWeight: 600 }} className="mt-1.5 mb-5">
          Due at {fmtTime(a.alert.at)}
          {a.person ? ` · ${a.person.name}` : ""}
          {alerts.length > 1 ? ` · and ${alerts.length - 1} more` : ""}
        </p>
        <AlertActions a={a} people={people} onDone={onDone} onSkip={onSkip}
          onSnooze={onSnooze} onCredit={onCredit} big light />
      </div>
    </div>
  );
}

/* The banner. Sits above the tab content and does not scroll away — an alert
   you can navigate past is not an alert. */
function AlertBanner({ alerts, people, onDone, onSkip, onSnooze, onCredit }) {
  if (!alerts.length) return null;
  const worst = alerts[0];
  return (
    <div className="shrink-0 px-3 md:px-4 pt-2" role="alert">
      <div className="rounded-2xl px-3.5 py-3 flex items-center gap-3 flex-wrap"
        style={{ background: "#E86A4C", color: "#fff", boxShadow: "0 6px 18px #E86A4C55" }}>
        <BellRing size={20} className="shrink-0" style={{ animation: "hubshake 1.1s ease-in-out infinite" }} />
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: 16.5, fontWeight: 800 }} className="truncate">{worst.title}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, opacity: 0.92 }}>
            due {fmtTime(worst.alert.at)} · {worst.overdue < 1 ? "now" : `${worst.overdue} min late`}
            {alerts.length > 1 ? ` · +${alerts.length - 1} more` : ""}
            {worst.person ? ` · ${worst.person.name}` : ""}
          </div>
        </div>
        <AlertActions a={worst} people={people} onDone={onDone} onSkip={onSkip}
          onSnooze={onSnooze} onCredit={onCredit} light />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Audio.

   Two things make Web Audio silently do nothing, and the version of this that
   shipped first hit both:

     1. A new AudioContext starts *suspended* until a user gesture. Scheduling
        notes into a suspended context fails quietly -- no error, no sound, and
        nothing in the console to suggest the reminder never rang.
     2. Browsers cap how many AudioContexts a page may create, so building a
        fresh one per chime works in testing and then stops working on the one
        device that has been left open on the wall for a fortnight.

   So: one shared context, resumed on the first tap anywhere, and every play
   attempt resumes again before scheduling in case it was auto-suspended.
--------------------------------------------------------------- */
let sharedAudioCtx = null;
function audioContext() {
  if (sharedAudioCtx) return sharedAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
  } catch (e) { return null; }
  return sharedAudioCtx;
}

/** Whether a chime would actually be audible right now. */
export function audioReady() {
  const ctx = audioContext();
  return Boolean(ctx) && ctx.state === "running";
}

/* Called from a real user gesture. Until this happens the browser will not let
   us make any sound at all, no matter what we schedule. */
function unlockAudio() {
  const ctx = audioContext();
  if (ctx && ctx.state !== "running" && ctx.resume) ctx.resume().catch(() => {});
}

const CHIME_PATTERNS = {
  // two soft notes rather than a buzz — it has to be pleasant nightly
  gentle: {
    wave: "sine", peak: 0.18, decay: 0.55,
    notes: [{ t: 0, f: 587.33 }, { t: 0.28, f: 880 }],
  },
  // deliberately more insistent, and repeated: this one is for something that
  // was supposed to happen and did not
  alert: {
    wave: "triangle", peak: 0.3, decay: 0.34,
    notes: [0, 0.8, 1.6].flatMap((base) => [
      { t: base, f: 880 },            // A5
      { t: base + 0.16, f: 1108.73 }, // C#6
      { t: base + 0.32, f: 1318.51 }, // E6
    ]),
  },
};

function playPattern(patternName) {
  const spec = CHIME_PATTERNS[patternName] || CHIME_PATTERNS.gentle;
  const ctx = audioContext();
  if (!ctx) return false;
  const schedule = () => {
    const t0 = ctx.currentTime;
    for (const n of spec.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.wave;
      osc.frequency.value = n.f;
      gain.gain.setValueAtTime(0, t0 + n.t);
      gain.gain.linearRampToValueAtTime(spec.peak, t0 + n.t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + n.t + spec.decay);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0 + n.t);
      osc.stop(t0 + n.t + spec.decay + 0.05);
    }
  };
  // resume first — a suspended context accepts every call and plays nothing
  if (ctx.state !== "running" && ctx.resume) {
    ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
  return true;
}

function useChime(enabled, pattern = "gentle") {
  // one listener for the whole app: the first tap anywhere makes audio possible
  useEffect(() => {
    const on = () => unlockAudio();
    window.addEventListener("pointerdown", on, { passive: true });
    window.addEventListener("keydown", on, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", on);
      window.removeEventListener("keydown", on);
    };
  }, []);
  return useCallback(() => {
    if (!enabled) return;
    playPattern(pattern);
    if (pattern === "alert") {
      try { navigator.vibrate && navigator.vibrate([220, 120, 220, 120, 380]); } catch (e) { /* not on desktop */ }
    }
  }, [enabled, pattern]);
}

function CheckInOverlay({ data, update, personById, allEvents, todayKey, onOpenMeal, close }) {
  const isMobile = useMobile();
  const cfg = { ...DEFAULT_CHECKIN, ...(data.checkin || {}) };
  const tomorrowKey = ymd(addDays(parseYMD(todayKey), 1));
  const plan = checkinPlan(data, todayKey, allEvents);
  const [started, setStarted] = useState(false);
  const [i, setI] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [tomorrowTime, setTomorrowTime] = useState(() => checkinPlan(data, tomorrowKey, allEvents).time);

  // ---- what needs attention tonight ----
  const overdueChores = (data.chores || []).filter((c) => !c.done?.[todayKey] && choreState(c, todayKey).missedSince);
  const overdueTasks = (data.tasks || []).filter((t) => !t.done && t.date && t.date < todayKey);
  const slipped = (data.projects || []).filter((pr) => projectCarried(pr, todayKey));
  const tomorrowEvents = (allEvents || []).filter((e) => e.date === tomorrowKey)
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const mealsPlanned = dayHasMeals(data, tomorrowKey);
  const openTopics = (data.agenda || []).filter((a) => !a.resolved);
  // Who has not recorded anything yet. Shown as a nudge on the step; it no
  // longer decides *whether* the step exists, which is what deleted it out
  // from under the second person mid-walkthrough.
  const missingStatus = (data.people || []).filter((pp) => !((data.status || {})[todayKey] || {})[pp.id]);
  const generated = useCheckinPrompt(todayKey, data, update, promptForDate(todayKey, data.agendaPrompts));
  const prompt = generated.question;

  const toggleChore = (id) => update((d) => COMPLETION.toggleChore(d, id, todayKey, actorFor(d), { assigneeOf: choreAssignee }))
  const toggleTask = (id) => update((d) => {
    d.tasks = d.tasks.map((t) => t.id === id
      ? (t.done ? { ...t, done: false, doneAt: "" } : { ...t, done: true, doneAt: todayKey }) : t);
    return d;
  });
  const toggleTopic = (id) => update((d) => { d.agenda = d.agenda.map((a) => a.id === id ? { ...a, resolved: !a.resolved } : a); return d; });
  const planProject = (id, target) => update((d) => {
    d.projects = d.projects.map((pr) => pr.id !== id ? pr
      : (target ? withPlannedDay(pr, target) : withoutPlannedDays(pr)));
    return d;
  });
  const setStatus = (personId, dim, value) => update((d) => {
    d.status = { ...(d.status || {}) };
    const day = { ...(d.status[todayKey] || {}) };
    const cur = day[personId] || { happiness: 3, connection: 3, intimacy: 3 };
    day[personId] = { ...cur, [dim]: value, at: Date.now() };
    d.status[todayKey] = day;
    return d;
  });

  /* Worked out ONCE, when the walkthrough opens, and then held still.
     
     These used to be recomputed on every render, with each step included only
     while it was still outstanding — so a step vanished from the list the moment
     you dealt with it. Two consequences, both reported as the check-in being
     broken:
     
       * The status step disappeared as soon as *everybody* had recorded
         something. With two people that meant the second person moving their
         first slider deleted the step out from under themselves, before they
         had set the other two. They could not finish.
       * Every other step did the same, so the list shortened underneath you and
         the walkthrough jumped to whatever now occupied that index.
     
     A walkthrough is a fixed list of things to go through. Deciding what is on
     it belongs at the start; after that, doing something must not change what
     you are being asked. */
  /* Decided once, when the walkthrough opens, and then held still. See
     buildCheckinSteps in lib/checkin.js for why -- the short version is that
     recomputing it deleted the status step out from under the second person
     before they had finished. */
  const [steps] = useState(() => buildCheckinSteps({
    hasPrompt: Boolean(prompt),
    overdueCount: overdueChores.length + overdueTasks.length,
    slippedCount: slipped.length,
    topicsCount: openTopics.length,
    tomorrowCount: tomorrowEvents.length,
    mealsPlanned,
    peopleCount: (data.people || []).length,
  }));

  const finish = () => {
    update((d) => {
      const ci = { ...DEFAULT_CHECKIN, ...(d.checkin || {}) };
      ci.overrides = { ...(ci.overrides || {}), [tomorrowKey]: tomorrowTime };
      ci.log = {
        ...(ci.log || {}),
        [todayKey]: {
          startedAt: (ci.log || {})[todayKey]?.startedAt || Date.now(),
          completedAt: Date.now(),
          covered: steps.length - skipped,
          skipped,
          at: plan.time,
        },
      };
      d.checkin = ci;
      return d;
    });
    close();
  };

  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;
  const logEntries = Object.entries(data.checkin?.log || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);

  // ---- start screen ----
  if (!started) {
    return (
      <Overlay close={close} wide>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 style={{ fontFamily: DISPLAY, fontSize: 27, fontWeight: 600 }}>Nightly check-in</h2>
            <p style={{ color: T.sub, fontSize: 14.5 }}>
              {steps.length - 1} thing{steps.length - 1 !== 1 ? "s" : ""} to cover · planned for {fmtTime(plan.time)}
            </p>
            <p style={{ color: T.faint, fontSize: 12.5 }}>{plan.reason}</p>
          </div>
          <button onClick={close} className="tapfade rounded-full p-2 shrink-0" style={{ background: T.panelAlt, color: T.sub }}><X size={20} /></button>
        </div>

        <div className="flex flex-col gap-1.5 mb-5">
          {steps.map((st) => (
            <div key={st.id} className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5" style={{ background: T.panelAlt }}>
              <span className="rounded-full" style={{ width: 7, height: 7, background: st.count ? T.gold : T.brand }} />
              <span style={{ fontSize: 15, fontWeight: 600 }} className="flex-1 min-w-0 truncate">{st.label}</span>
              {st.count ? <span style={{ color: T.sub, fontSize: 13, fontWeight: 800 }}>{st.count}</span> : null}
            </div>
          ))}
        </div>

        <button onClick={() => { setStarted(true); setI(0); }}
          className="tapfade w-full py-4 rounded-2xl font-semibold text-lg" style={{ background: T.brand, color: "#fff" }}>
          Start
        </button>

        {logEntries.length > 0 && (
          <div className="mt-6">
            <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2 flex items-center gap-1.5">
              <History size={13} /> Past check-ins
            </div>
            <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
              {logEntries.map(([k, v]) => {
                const d = parseYMD(k);
                return (
                  <div key={k} className="flex items-center gap-2.5 rounded-xl px-3.5 py-2" style={{ background: T.panelAlt }}>
                    <CheckCircle2 size={15} style={{ color: v.completedAt ? T.brand : T.faint }} className="shrink-0" />
                    <span style={{ fontSize: 13.5, fontWeight: 600 }} className="flex-1 min-w-0">
                      {WD_SHORT[d.getDay()]}, {MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}
                    </span>
                    {v.at && <span style={{ color: T.faint, fontSize: 12, fontWeight: 700 }}>{fmtTime(v.at)}</span>}
                    <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }}>
                      {v.covered} covered{v.skipped ? ` · ${v.skipped} skipped` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Overlay>
    );
  }

  // ---- walkthrough ----
  return (
    <Overlay close={close} wide>
      <div className="flex items-center gap-3 mb-1">
        <span style={{ color: T.sub, fontSize: 12, fontWeight: 800, letterSpacing: 1 }} className="uppercase">
          Step {i + 1} of {steps.length}
        </span>
        <div className="flex-1 rounded-full overflow-hidden" style={{ height: 5, background: T.line }}>
          <div className="h-full rounded-full" style={{ width: `${((i + 1) / steps.length) * 100}%`, background: T.brand, transition: "width .25s ease" }} />
        </div>
        <button onClick={close} className="tapfade rounded-full p-1.5 shrink-0" style={{ background: T.panelAlt, color: T.sub }}><X size={17} /></button>
      </div>
      <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }} className="mb-3">{step.label}</h2>

      <div className="mb-4" style={{ minHeight: 140 }}>
        {step.id === "prompt" && (
          <div className="rounded-2xl p-4" style={{ background: T.brandSoft }}>
            <p style={{ color: T.brandInk, fontSize: 18, fontWeight: 600, lineHeight: 1.4 }}>{prompt}</p>
          </div>
        )}

        {step.id === "overdue" && (
          <div className="flex flex-col gap-2">
            {overdueChores.map((c) => {
              const st = choreState(c, todayKey);
              const who = personById(choreAssignee(c, todayKey));
              return (
                <div key={c.id} className="flex items-center gap-3 rounded-xl px-3.5 py-3"
                  style={{ background: "#E86A4C10", borderLeft: "3px solid #E86A4C" }}>
                  <button onClick={() => toggleChore(c.id)} className="tapfade shrink-0" style={{ color: "#E86A4C" }}>
                    <Circle size={24} />
                  </button>
                  <span className="flex-1 min-w-0">
                    <span style={{ fontSize: 15.5, fontWeight: 600 }} className="block truncate">{c.title}</span>
                    <span style={{ color: "#C2542F", fontSize: 12, fontWeight: 700 }}>{lateLabel(daysBetween(st.missedSince, todayKey))}</span>
                  </span>
                  {who && <span className="shrink-0 rounded-full px-2 py-0.5" style={{ background: who.color + "1F", color: who.color, fontSize: 11, fontWeight: 800 }}>{who.name}</span>}
                </div>
              );
            })}
            {overdueTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-xl px-3.5 py-3"
                style={{ background: "#E86A4C10", borderLeft: "3px solid #E86A4C" }}>
                <button onClick={() => toggleTask(t.id)} className="tapfade shrink-0" style={{ color: "#E86A4C" }}>
                  <Circle size={24} />
                </button>
                <span className="flex-1 min-w-0">
                  <span style={{ fontSize: 15.5, fontWeight: 600 }} className="block truncate">{t.title}</span>
                  <span style={{ color: "#C2542F", fontSize: 12, fontWeight: 700 }}>{lateLabel(daysBetween(t.date, todayKey))}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {step.id === "slipped" && (
          <div className="flex flex-col gap-2">
            {slipped.map((pr) => {
              const from = carriedFrom(pr, todayKey);
              const fd = from ? parseYMD(from) : null;
              return (
                <div key={pr.id} className="rounded-xl px-3.5 py-3" style={{ background: T.gold + "14", border: `1px solid ${T.gold}55` }}>
                  <div style={{ fontSize: 15.5, fontWeight: 600 }} className="truncate">{pr.title}</div>
                  <div style={{ color: "#8A5F14", fontSize: 12, fontWeight: 700 }}>
                    {fd ? `planned ${WD_SHORT[fd.getDay()]} ${MO_LONG[fd.getMonth()].slice(0, 3)} ${fd.getDate()} · ` : ""}{projectPercent(pr)}% done
                  </div>
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    {[["Tomorrow", tomorrowKey],
                      ["Weekend", ymd(addDays(parseYMD(todayKey), (6 - parseYMD(todayKey).getDay() + 7) % 7 || 7))]].map(([label, k]) => (
                      <button key={label} onClick={() => planProject(pr.id, k)} className="tapfade px-3 py-1.5 rounded-full font-bold"
                        style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.brand, fontSize: 12 }}>{label}</button>
                    ))}
                    <button onClick={() => planProject(pr.id, null)} className="tapfade px-3 py-1.5 rounded-full font-bold"
                      style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12 }}>Backlog</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {step.id === "topics" && (
          <div className="flex flex-col gap-2">
            {openTopics.map((a) => {
              const c = catOf(a.category);
              const who = personById(a.personId);
              return (
                <div key={a.id} className="flex items-start gap-3 rounded-xl px-3.5 py-3"
                  style={{ background: T.panelAlt }}>
                  {/* Only the circle resolves a topic. */}
                  <button onClick={() => toggleTopic(a.id)} aria-label="Mark resolved"
                    className="tapfade shrink-0 mt-0.5" style={{ color: T.faint }}>
                    <Circle size={24} />
                  </button>
                  <span className="flex-1 min-w-0">
                    <span style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35 }} className="block">{a.text}</span>
                    <span className="flex items-center gap-2 mt-1">
                      <span className="rounded-full px-2 py-0.5 flex items-center gap-1" style={{ background: c.color + "1A", color: c.color, fontSize: 11, fontWeight: 700 }}>
                        <c.Icon size={10} />{c.label}
                      </span>
                      {who && <span style={{ color: who.color, fontSize: 11.5, fontWeight: 700 }}>{who.name}</span>}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {step.id === "tomorrow" && (
          <div className="flex flex-col gap-2">
            {tomorrowEvents.map((e) => {
              const who = personById(e.personId);
              return (
                <div key={e.id} className="flex items-center gap-3 rounded-xl px-3.5 py-2.5" style={{ background: T.panelAlt }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }} className="tabular-nums w-16 shrink-0">
                    {e.time ? fmtTime(e.time) : "All day"}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 600 }} className="flex-1 min-w-0 truncate">{e.title}</span>
                  {who && <span style={{ color: who.color, fontSize: 12, fontWeight: 700 }} className="shrink-0">{who.name}</span>}
                </div>
              );
            })}
          </div>
        )}

        {step.id === "meals" && (
          <div>
            <p style={{ color: T.sub, fontSize: 15, lineHeight: 1.5 }} className="mb-3">
              Nothing planned for tomorrow yet.
            </p>
            <button onClick={() => onOpenMeal(tomorrowKey)} className="tapfade px-4 py-3 rounded-2xl font-semibold flex items-center gap-2"
              style={{ background: T.brand, color: "#fff" }}>
              <UtensilsCrossed size={17} /> Plan tomorrow's meals
            </button>
          </div>
        )}

        {step.id === "status" && (
          <div>
          {missingStatus.length > 0 && (
            <p style={{ color: T.sub, fontSize: 13.5 }} className="mb-2">
              {missingStatus.length === (data.people || []).length
                ? "Neither of you has recorded tonight yet."
                : `Still waiting on ${missingStatus.map((pp) => pp.name).join(" and ")}.`}
            </p>
          )}
          <div className="grid gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0,1fr))" }}>
            {(data.people || []).map((pp) => {
              const cur = ((data.status || {})[todayKey] || {})[pp.id] || { happiness: 3, connection: 3, intimacy: 3 };
              const recorded = Boolean(((data.status || {})[todayKey] || {})[pp.id]);
              return (
                <div key={pp.id} className="rounded-2xl p-3.5" style={{ background: T.panelAlt }}>
                  <div className="flex items-center justify-between mb-2">
                    <span style={{ fontWeight: 700, fontSize: 15, color: pp.color }}>{pp.name}</span>
                    {/* So it is obvious that recording is per person, and that yours
                        landed — the confusion was not knowing whether it had. */}
                    <span style={{ color: recorded ? pp.color : T.faint, fontSize: 11.5, fontWeight: 700 }}>
                      {recorded ? "recorded" : "not yet"}
                    </span>
                  </div>
                  {STATUS_DIMS.map((dim) => (
                    <div key={dim.key} className="mb-2.5">
                      <div className="flex items-baseline justify-between">
                        <span style={{ color: T.sub, fontSize: 11.5, fontWeight: 700 }} className="uppercase">{dim.label}</span>
                        <span style={{ color: pp.color, fontSize: 12.5, fontWeight: 800 }}>{SCALE[cur[dim.key]]}</span>
                      </div>
                      <ScaleTrack value={cur[dim.key]} color={pp.color} onChange={(v) => setStatus(pp.id, dim.key, v)} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          </div>
        )}

        {step.id === "time" && (
          <div>
            <p style={{ color: T.sub, fontSize: 15, lineHeight: 1.5 }} className="mb-3">
              When should we do this tomorrow? {checkinPlan(data, tomorrowKey, allEvents).derived
                ? `Suggested from the calendar — ${checkinPlan(data, tomorrowKey, allEvents).reason}.`
                : ""}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="time" value={tomorrowTime} onChange={(e) => setTomorrowTime(e.target.value)}
                className="px-4 py-3 rounded-xl text-lg outline-none" style={{ ...inputStyle, width: 150 }} />
              {[-30, -15, 15, 30].map((n) => (
                <button key={n} onClick={() => setTomorrowTime(hhmmOf(minutesOf(tomorrowTime) + n))}
                  className="tapfade px-3 py-2 rounded-full font-bold"
                  style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12.5 }}>
                  {n > 0 ? `+${n}` : n}m
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 sticky pt-3" style={{ bottom: -2, background: T.panel, borderTop: `1px solid ${T.line}` }}>
        {i > 0 && (
          <button onClick={() => setI(i - 1)} className="tapfade px-4 py-3.5 rounded-2xl font-semibold"
            style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub }}>Back</button>
        )}
        {!last && (
          <button onClick={() => { setSkipped(skipped + 1); setI(i + 1); }}
            className="tapfade px-4 py-3.5 rounded-2xl font-semibold" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.faint }}>
            Skip
          </button>
        )}
        <button onClick={() => (last ? finish() : setI(i + 1))}
          className="tapfade flex-1 py-3.5 rounded-2xl font-semibold text-lg" style={{ background: T.brand, color: "#fff" }}>
          {last ? "Done for tonight" : "Next"}
        </button>
      </div>
    </Overlay>
  );
}

/* ---------------- Shared UI ---------------- */
function Card({ title, Icon, action, children, grow, fit }) {
  return (
    <section className={`rounded-2xl p-3.5 md:p-4 flex flex-col ${grow ? "flex-1 min-h-0" : fit ? "shrink-0" : ""}`} style={{ background: T.panel, border: `1px solid ${T.line}` }}>
      <div className="flex items-center justify-between mb-2.5 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0"><Icon size={18} style={{ color: T.brand }} className="shrink-0" /><h3 style={{ fontFamily: DISPLAY, fontSize: 18, fontWeight: 600 }} className="truncate">{title}</h3></div>
        {action}
      </div>
      <div className={grow ? "flex-1 min-h-0 overflow-y-auto" : ""}>{children}</div>
    </section>
  );
}
const AddBtn = ({ onClick }) => <button onClick={onClick} className="tapfade rounded-lg p-1.5" style={{ background: T.brandSoft, color: T.brand }}><Plus size={18} /></button>;
const Empty = ({ text }) => <div className="flex flex-col items-center justify-center py-8 text-center gap-2" style={{ color: T.faint }}><Sparkles size={26} /><p style={{ fontSize: 15 }}>{text}</p></div>;
function WeekNav({ label, shiftWeek, resetWeek }) {
  const isMobile = useMobile();
  return (
    <div className="flex items-center justify-between mb-4 gap-2">
      <h2 style={{ fontFamily: DISPLAY, fontSize: isMobile ? 19 : 26, fontWeight: 600 }} className="truncate">{label}</h2>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => shiftWeek(-1)} className="tapfade rounded-full p-2.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}><ChevronLeft size={20} /></button>
        <button onClick={resetWeek} className="tapfade rounded-full px-3 md:px-4 py-2 font-semibold" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}>{isMobile ? "Today" : "This week"}</button>
        <button onClick={() => shiftWeek(1)} className="tapfade rounded-full p-2.5" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }}><ChevronRight size={20} /></button>
      </div>
    </div>
  );
}

/* ---------------- Modals ---------------- */
function Overlay({ children, close, wide }) {
  const vp = useViewport();
  const h = vp.height ? `${vp.height}px` : "100vh";
  return (
    <div
      className="fixed left-0 right-0 z-50 flex justify-center p-3 md:p-6"
      style={{
        top: vp.offsetTop || 0,
        height: h,
        background: "#2C253688",
        // when the keyboard is up, pin to the top so the fields stay reachable
        alignItems: vp.keyboardOpen ? "flex-start" : "center",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
      onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`rounded-3xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} p-5 md:p-7 overflow-y-auto`}
        style={{
          background: T.panel,
          boxShadow: "0 24px 60px #2C253633",
          maxHeight: vp.height ? `${Math.max(240, vp.height - 24)}px` : "90vh",
        }}>
        {children}
      </div>
    </div>
  );
}
const ModalHead = ({ title, close }) => (
  <div className="flex items-center justify-between mb-6">
    <h3 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>{title}</h3>
    <button onClick={close} className="tapfade rounded-full p-2" style={{ background: T.panelAlt, color: T.sub }}><X size={22} /></button>
  </div>
);
const inputStyle = { background: T.panelAlt, border: `1px solid ${T.line}`, color: T.ink, fontFamily: BODY };
const Field = ({ label, children }) => (
  <label className="block mb-4"><span style={{ color: T.sub, fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }} className="uppercase block mb-2">{label}</span>{children}</label>
);
// sticky, so Save stays reachable when the panel scrolls under a keyboard
const SaveBar = ({ onSave, onDelete, saveLabel = "Save" }) => (
  <div className="flex items-center gap-3 mt-6 sticky pt-3"
    style={{ bottom: -2, background: T.panel, borderTop: `1px solid ${T.line}` }}>
    <button onClick={onSave} className="tapfade flex-1 py-4 rounded-2xl font-semibold text-lg" style={{ background: T.brand, color: "#fff" }}>{saveLabel}</button>
    {onDelete && <button onClick={onDelete} className="tapfade py-4 px-5 rounded-2xl font-semibold" style={{ background: "#E86A4C18", color: "#E86A4C" }}><Trash2 size={20} /></button>}
  </div>
);

function EventModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [date, setDate] = useState(payload.date || ymd(new Date()));
  const [time, setTime] = useState(payload.time || "");
  const [endTime, setEndTime] = useState(payload.endTime || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const save = () => {
    if (!title.trim()) return;
    // an end with no start is meaningless, and an end before the start is a typo
    const end = time && endTime && endTime > time ? endTime : "";
    update((d) => {
      if (editing) d.events = d.events.map((e) => e.id === payload.id ? { ...e, title, date, time, endTime: end, personId } : e);
      else d.events = [...d.events, { id: uid(), title, date, time, endTime: end, personId }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.events = d.events.filter((e) => e.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit event" : "New event"} close={close} />
      <Field label="What"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Soccer practice" className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-3.5 rounded-xl text-base outline-none" style={inputStyle} /></Field>
        <Field label="Starts"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full px-3 py-3.5 rounded-xl text-base outline-none" style={inputStyle} /></Field>
        <Field label="Ends">
          <input type="time" value={endTime} disabled={!time}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-full px-3 py-3.5 rounded-xl text-base outline-none"
            style={{ ...inputStyle, opacity: time ? 1 : 0.5 }} />
        </Field>
      </div>
      <Field label="Who"><PersonPicker people={people} value={personId} onChange={setPersonId} /></Field>
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function ViewEventModal({ ev, personById, close }) {
  const p = personById(ev.personId);
  const d = parseYMD(ev.date);
  return (
    <Overlay close={close}>
      <ModalHead title={ev.title} close={close} />
      <div className="flex flex-col gap-3">
        <InfoRow icon={<CalendarDays size={18} />} text={`${WD_LONG[d.getDay()]}, ${MO_LONG[d.getMonth()]} ${d.getDate()}`} />
        <InfoRow icon={<Clock size={18} />} text={
          ev.spanDays > 1
            ? `${ev.time ? fmtTime(ev.time) + " start · " : ""}day ${ev.spanIndex + 1} of ${ev.spanDays}`
            : ev.time
              ? (ev.endTime ? `${fmtTime(ev.time)} – ${fmtTime(ev.endTime)}` : fmtTime(ev.time))
              : "All day"
        } />
        <InfoRow icon={<Link2 size={18} />} text={`From ${ev.calName}`} color={ev.color} />
        {p && <InfoRow icon={<Users size={18} />} text={p.name} color={p.color} />}
      </div>
      <div className="mt-6 rounded-2xl px-4 py-3 flex items-center gap-2" style={{ background: T.panelAlt, color: T.sub }}>
        <Lock size={16} /><span style={{ fontSize: 14 }}>Synced from a calendar — edit it in Google or Apple Calendar.</span>
      </div>
    </Overlay>
  );
}
const InfoRow = ({ icon, text, color }) => (
  <div className="flex items-center gap-3">
    <div className="rounded-lg p-2" style={{ background: (color || T.brand) + "18", color: color || T.brand }}>{icon}</div>
    <span style={{ fontSize: 17, fontWeight: 600 }}>{text}</span>
  </div>
);

/* Repeating a meal copies it onto the chosen days rather than storing a
   recurrence rule. Meal plans get tweaked constantly — "Tuesday we're eating
   out" — and independent days make that a one-tap edit instead of an exception
   to a rule. The cost is that changing "my usual breakfast" later means editing
   each day, which is the rarer operation. */
function MealModal({ mealKey, slot, data, update, close }) {
  const [day, setDay] = useState(() => {
    const cur = data.meals?.[mealKey] || {};
    const out = {};
    MEALS.forEach(({ key }) => { out[key] = Array.isArray(cur[key]) ? cur[key].map((e) => ({ ...e })) : []; });
    return out;
  });
  const [repeatFor, setRepeatFor] = useState(null);   // entry id whose repeat row is open
  const [dayCopyOpen, setDayCopyOpen] = useState(false);
  const [picked, setPicked] = useState([]);           // weekday numbers 0..6
  const [weeks, setWeeks] = useState(1);
  const [flash, setFlash] = useState("");

  const d = parseYMD(mealKey);
  const ownDow = d.getDay();
  const weekStart = startOfWeek(d);

  const addEntry = (slotKey, personId) => setDay((s0) => ({
    ...s0,
    [slotKey]: [...s0[slotKey], { id: uid(), title: "", personId, togo: false, time: "", cookId: "" }],
  }));
  const setEntry = (slotKey, id, patch) => setDay((s0) => ({
    ...s0, [slotKey]: s0[slotKey].map((e) => (e.id === id ? { ...e, ...patch } : e)),
  }));
  const removeEntry = (slotKey, id) => setDay((s0) => ({
    ...s0, [slotKey]: s0[slotKey].filter((e) => e.id !== id),
  }));

  // shared by Save and by the copy actions, so a copy never loses unsaved edits
  const commitDay = (dd) => {
    const clean = {};
    MEALS.forEach(({ key }) => {
      const rows = day[key].filter((e) => e.title.trim()).map((e) => ({ ...e, title: e.title.trim() }));
      if (rows.length) clean[key] = rows;
    });
    dd.meals = { ...dd.meals };
    if (Object.keys(clean).length) dd.meals[mealKey] = clean; else delete dd.meals[mealKey];
    return dd;
  };

  const save = () => { update(commitDay); close(); };

  const targetDates = () => {
    const out = [];
    for (let w = 0; w < weeks; w++) {
      for (const dow of picked) {
        const k = ymd(addDays(weekStart, w * 7 + dow));
        if (k !== mealKey) out.push(k);      // it already lives on this date
      }
    }
    return [...new Set(out)];
  };

  // push one entry onto the chosen days
  const repeatEntry = (slotKey, entry) => {
    const dates = targetDates();
    if (!entry.title.trim() || !dates.length) return;
    update((dd) => {
      commitDay(dd);
      for (const k of dates) {
        const target = { ...(dd.meals[k] || {}) };
        const rows = Array.isArray(target[slotKey]) ? [...target[slotKey]] : [];
        const dupe = rows.some((r) => r.title.trim().toLowerCase() === entry.title.trim().toLowerCase() && r.personId === entry.personId);
        if (!dupe) rows.push({ ...entry, id: uid(), title: entry.title.trim() });
        target[slotKey] = rows;
        dd.meals[k] = target;
      }
      return dd;
    });
    setFlash(`Copied to ${dates.length} day${dates.length !== 1 ? "s" : ""}`);
    setRepeatFor(null); setPicked([]);
    setTimeout(() => setFlash(""), 2200);
  };

  // push the whole day's plan onto the chosen days
  const copyWholeDay = () => {
    const dates = targetDates();
    if (!dates.length) return;
    update((dd) => {
      commitDay(dd);
      const source = dd.meals[mealKey] || {};
      for (const k of dates) {
        const target = { ...(dd.meals[k] || {}) };
        for (const { key } of MEALS) {
          const src = source[key] || [];
          if (!src.length) continue;
          const rows = Array.isArray(target[key]) ? [...target[key]] : [];
          for (const e of src) {
            const dupe = rows.some((r) => r.title.trim().toLowerCase() === e.title.trim().toLowerCase() && r.personId === e.personId);
            if (!dupe) rows.push({ ...e, id: uid() });
          }
          target[key] = rows;
        }
        dd.meals[k] = target;
      }
      return dd;
    });
    setFlash(`Whole day copied to ${dates.length} day${dates.length !== 1 ? "s" : ""}`);
    setDayCopyOpen(false); setPicked([]);
    setTimeout(() => setFlash(""), 2200);
  };

  const toggleDow = (n) => setPicked((cur) => cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort());
  const presets = [
    { label: "Weekdays", days: [1, 2, 3, 4, 5] },
    { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
    { label: "Rest of week", days: [...Array(7)].map((_, i) => i).filter((i) => i > ownDow) },
  ].filter((x) => x.days.length);

  const Chip = ({ active, color, onClick, children }) => (
    <button onClick={onClick} className="tapfade px-2.5 py-1.5 rounded-full font-semibold flex items-center gap-1.5 shrink-0"
      style={{ background: active ? (color || T.ink) : T.panel, color: active ? "#fff" : T.sub,
        border: `1px solid ${active ? (color || T.ink) : T.line}`, fontSize: 12.5 }}>
      {children}
    </button>
  );

  // day pickers + week count, shared by the entry repeat and whole-day copy
  const DayPicker = ({ onApply, applyLabel }) => (
    <div className="rounded-xl p-2.5 mt-2" style={{ background: T.brandSoft }}>
      <div className="flex gap-1 mb-2">
        {WD_SHORT.map((w, i) => {
          const isOwn = i === ownDow;
          const on = picked.includes(i);
          return (
            <button key={i} onClick={() => !isOwn && toggleDow(i)} disabled={isOwn}
              title={isOwn ? "This meal already lives on this day" : ""}
              className="tapfade flex-1 py-2 rounded-lg font-bold"
              style={{
                background: isOwn ? T.line : on ? T.brand : T.panel,
                color: isOwn ? T.faint : on ? "#fff" : T.sub,
                border: `1px solid ${on ? T.brand : T.line}`, fontSize: 12.5,
                cursor: isOwn ? "default" : "pointer",
              }}>{w[0]}</button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {presets.map((ps) => (
          <button key={ps.label} onClick={() => setPicked(ps.days.filter((x) => x !== ownDow))}
            className="tapfade px-2.5 py-1.5 rounded-full font-semibold"
            style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub, fontSize: 12 }}>{ps.label}</button>
        ))}
        <span style={{ width: 1, height: 16, background: T.line }} className="mx-0.5" />
        {[1, 2, 4].map((n) => (
          <button key={n} onClick={() => setWeeks(n)} className="tapfade px-2.5 py-1.5 rounded-full font-semibold"
            style={{ background: weeks === n ? T.brand : T.panel, color: weeks === n ? "#fff" : T.sub,
              border: `1px solid ${weeks === n ? T.brand : T.line}`, fontSize: 12 }}>
            {n} wk{n > 1 ? "s" : ""}
          </button>
        ))}
        <button onClick={onApply} disabled={!picked.length}
          className="tapfade ml-auto px-3.5 py-1.5 rounded-full font-bold"
          style={{ background: picked.length ? T.brand : T.line, color: picked.length ? "#fff" : T.faint, fontSize: 12.5 }}>
          {applyLabel}
        </button>
      </div>
    </div>
  );

  return (
    <Overlay close={close} wide>
      <ModalHead title={`${WD_LONG[d.getDay()]}, ${MO_LONG[d.getMonth()]} ${d.getDate()}`} close={close} />
      {flash && (
        <div className="rounded-xl px-4 py-2.5 mb-3 flex items-center gap-2" style={{ background: T.brandSoft, color: T.brandInk, fontSize: 13.5, fontWeight: 600 }}>
          <CheckCircle2 size={15} /> {flash}
        </div>
      )}
      {MEALS.map(({ key, label, Icon }) => (
        <div key={key} className="mb-5 pb-4" style={{ borderBottom: `1px solid ${T.line}` }}>
          <div className="flex items-center justify-between mb-2.5 gap-2">
            <span className="flex items-center gap-2" style={{ color: T.sub, fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>
              <Icon size={16} style={{ color: T.gold }} /> <span className="uppercase">{label}</span>
            </span>
            <div className="flex gap-1.5 flex-wrap justify-end">
              <button onClick={() => addEntry(key, "")} className="tapfade px-2.5 py-1.5 rounded-full font-semibold"
                style={{ background: T.brandSoft, color: T.brand, fontSize: 12.5 }}>+ Shared</button>
              {data.people.map((pp) => (
                <button key={pp.id} onClick={() => addEntry(key, pp.id)} className="tapfade px-2.5 py-1.5 rounded-full font-semibold"
                  style={{ background: pp.color + "1A", color: pp.color, fontSize: 12.5 }}>+ {pp.name}</button>
              ))}
            </div>
          </div>

          {day[key].length === 0 && (
            <p style={{ color: T.faint, fontSize: 13.5 }}>Nothing planned. Add one for each of you, or a shared meal.</p>
          )}

          <div className="flex flex-col gap-2.5">
            {day[key].map((e) => (
              <div key={e.id} className="rounded-xl p-2.5" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                <div className="flex items-center gap-2 mb-2">
                  <input autoFocus={key === slot && !e.title} value={e.title}
                    onChange={(ev) => setEntry(key, e.id, { title: ev.target.value })}
                    placeholder="What's cooking?"
                    className="flex-1 min-w-0 px-3 py-2.5 rounded-lg text-base outline-none"
                    style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink }} />
                  <input type="time" value={e.time || ""} onChange={(ev) => setEntry(key, e.id, { time: ev.target.value })}
                    title="Time (optional)" className="shrink-0 px-2 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink, width: 108 }} />
                  <button onClick={() => removeEntry(key, e.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}>
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip active={!e.personId} onClick={() => setEntry(key, e.id, { personId: "" })}>Shared</Chip>
                  {data.people.map((pp) => (
                    <Chip key={pp.id} active={e.personId === pp.id} color={pp.color} onClick={() => setEntry(key, e.id, { personId: pp.id })}>
                      <span className="w-2 h-2 rounded-full" style={{ background: e.personId === pp.id ? "#fff" : pp.color }} />{pp.name}
                    </Chip>
                  ))}
                  <span style={{ width: 1, height: 18, background: T.line }} className="mx-1 shrink-0" />
                  <Chip active={e.togo} color="#8A5CC2" onClick={() => setEntry(key, e.id, { togo: !e.togo })}>
                    <ShoppingBag size={12} />{e.togo ? "To-go" : "Eat in"}
                  </Chip>
                  {!e.togo && (
                    <>
                      <span style={{ color: T.faint, fontSize: 12, fontWeight: 600 }} className="ml-1 shrink-0">Cook</span>
                      <Chip active={!e.cookId} onClick={() => setEntry(key, e.id, { cookId: "" })}>—</Chip>
                      {data.people.map((pp) => (
                        <Chip key={pp.id} active={e.cookId === pp.id} color={pp.color} onClick={() => setEntry(key, e.id, { cookId: pp.id })}>
                          <ChefHat size={11} />{pp.name}
                        </Chip>
                      ))}
                    </>
                  )}
                  <button
                    onClick={() => { setRepeatFor(repeatFor === e.id ? null : e.id); setDayCopyOpen(false); setPicked([]); }}
                    disabled={!e.title.trim()}
                    className="tapfade ml-auto px-2.5 py-1.5 rounded-full font-semibold flex items-center gap-1.5 shrink-0"
                    style={{ background: repeatFor === e.id ? T.brand : T.panel, color: repeatFor === e.id ? "#fff" : (e.title.trim() ? T.brand : T.faint),
                      border: `1px solid ${repeatFor === e.id ? T.brand : T.line}`, fontSize: 12.5 }}>
                    <Repeat size={12} /> Repeat
                  </button>
                </div>
                {repeatFor === e.id && (
                  <DayPicker onApply={() => repeatEntry(key, e)} applyLabel="Copy meal" />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <button onClick={() => { setDayCopyOpen(!dayCopyOpen); setRepeatFor(null); setPicked([]); }}
        className="tapfade w-full py-3 rounded-2xl font-semibold flex items-center justify-center gap-2"
        style={{ background: dayCopyOpen ? T.brand : T.panelAlt, color: dayCopyOpen ? "#fff" : T.ink, border: `1px solid ${dayCopyOpen ? T.brand : T.line}` }}>
        <CopyPlus size={17} /> Copy this whole day to other days
      </button>
      {dayCopyOpen && <DayPicker onApply={copyWholeDay} applyLabel="Copy day" />}

      <SaveBar onSave={save} />
    </Overlay>
  );
}

/* Steps on a to-do. "Renew the car tabs" is really three things, and a list you
   can tick through beats one line you keep failing to start. */
function StepsEditor({ steps, onChange }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...steps, { id: uid(), title: text, done: false }]);
    setDraft("");
  };
  return (
    <Field label={`Steps${steps.length ? ` · ${steps.filter((s) => s.done).length} of ${steps.length}` : ""}`}>
      {steps.map((s) => (
        <div key={s.id} className="flex items-center gap-2 mb-1.5">
          <button onClick={() => onChange(steps.map((x) => x.id === s.id ? { ...x, done: !x.done } : x))}
            aria-label={s.done ? `Un-tick ${s.title}` : `Tick ${s.title}`}
            className="tapfade shrink-0" style={{ color: s.done ? T.brand : T.faint }}>
            {s.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
          </button>
          <input value={s.title}
            onChange={(e) => onChange(steps.map((x) => x.id === s.id ? { ...x, title: e.target.value } : x))}
            className="flex-1 min-w-0 px-3 py-2 rounded-xl outline-none"
            style={{ ...inputStyle, textDecoration: s.done ? "line-through" : "none", fontSize: 15 }} />
          <button onClick={() => onChange(steps.filter((x) => x.id !== s.id))}
            aria-label={`Remove ${s.title}`} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add a step…" className="flex-1 px-3 py-2.5 rounded-xl outline-none"
          style={{ ...inputStyle, fontSize: 15 }} />
        <button onClick={add} disabled={!draft.trim()} className="tapfade px-4 py-2.5 rounded-xl font-semibold"
          style={{ background: draft.trim() ? T.brand : T.panelAlt, color: draft.trim() ? "#fff" : T.faint,
            border: `1px solid ${draft.trim() ? T.brand : T.line}` }}>
          Add
        </button>
      </div>
    </Field>
  );
}

/* A note about one occurrence of a recurring chore.

   Keyed by date on purpose. "The lorry never came" belongs to that Tuesday, not
   to bin night forever — attaching it to the chore would turn an observation
   into a standing instruction. */
/* A recurring chore's checklist: what the job involves, the same every time.
   No tick boxes — "wheelie bin, recycling, garden waste" is not something you
   complete once. Ticking off one *occurrence* is what the circle on the row
   does, and what happened on a particular day is what the note is for. */
function ChecklistEditor({ items, onChange }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...items, text]);
    setDraft("");
  };
  return (
    <Field label={`Checklist${items.length ? ` · ${items.length}` : ""}`}>
      {items.map((text, i) => (
        <div key={i} className="flex items-center gap-2 mb-1.5">
          <span style={{ color: T.faint, fontSize: 13, width: 14 }} className="shrink-0">{i + 1}.</span>
          <input value={text}
            onChange={(e) => onChange(items.map((x, n) => (n === i ? e.target.value : x)))}
            className="flex-1 min-w-0 px-3 py-2 rounded-xl outline-none"
            style={{ ...inputStyle, fontSize: 15 }} />
          <button onClick={() => onChange(items.filter((_, n) => n !== i))}
            aria-label={`Remove ${text}`} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add to the checklist…" className="flex-1 px-3 py-2.5 rounded-xl outline-none"
          style={{ ...inputStyle, fontSize: 15 }} />
        <button onClick={add} disabled={!draft.trim()} className="tapfade px-4 py-2.5 rounded-xl font-semibold"
          style={{ background: draft.trim() ? T.brand : T.panelAlt, color: draft.trim() ? "#fff" : T.faint,
            border: `1px solid ${draft.trim() ? T.brand : T.line}` }}>
          Add
        </button>
      </div>
      <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-1.5">
        The same every time this chore comes round. Ticking the circle on the row completes
        the whole chore; use the note below for what happened on one particular day.
      </p>
    </Field>
  );
}


function ChoreNotesEditor({ chore, dateKey, notes, onChange }) {
  const [day, setDay] = useState(dateKey);
  const history = Object.entries(notes)
    .map(([k, text]) => ({ dateKey: k, text }))
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  const setNote = (text) => {
    const next = { ...notes };
    const trimmed = text.trim();
    if (trimmed) next[day] = trimmed; else delete next[day];
    onChange(next);
  };

  return (
    <Field label="Note for one day">
      <div className="flex items-center gap-2 mb-2">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)}
          className="px-3 py-2.5 rounded-xl outline-none" style={{ ...inputStyle, fontSize: 15 }} />
        <span style={{ color: T.faint, fontSize: 12 }}>
          {day === dateKey ? "today" : ""}
        </span>
      </div>
      <textarea
        value={notes[day] || ""}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="What happened that day — left out early, skipped, done twice…"
        className="w-full px-3 py-2.5 rounded-xl outline-none"
        style={{ ...inputStyle, fontSize: 15, resize: "vertical" }}
      />
      {history.length > 0 && (
        <div className="mt-2">
          <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">
            Notes so far · {history.length}
          </div>
          <div className="flex flex-col gap-1" style={{ maxHeight: 150, overflowY: "auto" }}>
            {history.map((n) => (
              <button key={n.dateKey} onClick={() => setDay(n.dateKey)}
                className="tapfade text-left rounded-lg px-2.5 py-1.5"
                style={{ background: n.dateKey === day ? T.brandSoft : T.panelAlt, border: `1px solid ${T.line}` }}>
                <span style={{ color: T.sub, fontSize: 11, fontWeight: 700 }}>{n.dateKey}</span>
                <span style={{ color: T.ink, fontSize: 13 }} className="block truncate">{n.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Field>
  );
}


/* ---------------- One day of a recurring chore ----------------
   Ryan asked for two things that turn out to be the same screen:

     "If you click into the item on the row, then it should open the to-do/task
      in order to modify it or see the steps listed in the item."

     "Add option to add subtask or notes section to recurring chores. Make it so
      that you can add a note to the specific time you did that chore."

   The chore editor was already reachable, but it edits the chore *in general* --
   its cadence, its rotation, its standing checklist. What was missing is the
   occurrence: this bin day, the one where the lorry never came. That note
   belongs to the date, not to the chore, or it reads as a standing instruction
   from then on.

   So: the checklist is shown read-only (it is the same every week and ticking
   it here would imply otherwise), and the note is per date and editable.       */
export function ChoreDayModal({ chore, dateKey, people, personById, update, close, openChore }) {
  const [note, setNote] = useState(SUB.choreNoteOn(chore, dateKey));
  const checklist = SUB.choreChecklist(chore);
  const history = SUB.noteHistory(chore).filter((h) => h.dateKey !== dateKey);

  const mark = chore.done?.[dateKey];
  const done = COMPLETION.completionOf(mark);
  const skipped = COMPLETION.isSkipped(mark);
  const owed = personById(ROT.assigneeFor(chore, dateKey));
  const didIt = done?.by ? personById(done.by) : null;
  const coveredFor = done?.onBehalfOf ? personById(done.onBehalfOf) : null;

  /* Saved on close rather than on every keystroke: the document is encrypted
     and pushed to the server, and a save per character is a lot of traffic for
     somebody typing a sentence. */
  const save = () => {
    const trimmed = note.trim();
    if (trimmed === SUB.choreNoteOn(chore, dateKey)) return close();
    update((d) => ({
      ...d,
      chores: (d.chores || []).map((c) =>
        c.id === chore.id ? SUB.setChoreNote(c, dateKey, trimmed) : c),
    }));
    close();
  };

  const when = parseYMD(dateKey);
  return (
    <Overlay close={save}>
      <ModalHead title={chore.title} close={save} />

      <div className="px-1 pb-2" style={{ color: T.sub, fontSize: 13.5, fontWeight: 600 }}>
        {WD_LONG[when.getDay()]}, {MO_LONG[when.getMonth()]} {when.getDate()}
        {owed && <> · {owed.name}'s turn</>}
      </div>

      {(done || skipped) && (
        <div className="mx-1 mb-3 rounded-xl px-3 py-2.5" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
          {skipped ? (
            <span style={{ fontSize: 13.5, color: T.sub, fontWeight: 600 }}>
              Skipped — nobody's turn was used up.
            </span>
          ) : (
            <span style={{ fontSize: 13.5, color: T.sub, fontWeight: 600 }}>
              Done{didIt ? ` by ${didIt.name}` : ""}
              {coveredFor ? ` for ${coveredFor.name}, who is still up next time` : ""}.
            </span>
          )}
        </div>
      )}

      {checklist.length > 0 && (
        <Field label="What it involves">
          <div className="flex flex-col gap-1.5">
            {checklist.map((step, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg px-3 py-2"
                style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                <span style={{ color: T.faint, fontSize: 12, fontWeight: 800, minWidth: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 14.5, color: T.ink }}>{step}</span>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label={`Note for ${MO_LONG[when.getMonth()].slice(0, 3)} ${when.getDate()}`}>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Anything about this particular time — the lorry never came, ran out of salt…"
          className="w-full px-4 py-3 rounded-xl outline-none"
          style={{ ...inputStyle, fontSize: 15, resize: "vertical" }}
        />
      </Field>

      {history.length > 0 && (
        <Field label="Earlier notes">
          <div className="flex flex-col gap-1.5" style={{ maxHeight: 190, overflowY: "auto" }}>
            {history.slice(0, 20).map((h) => {
              const d = parseYMD(h.dateKey);
              return (
                <div key={h.dateKey} className="rounded-lg px-3 py-2"
                  style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
                  <div style={{ color: T.faint, fontSize: 11.5, fontWeight: 800 }}>
                    {WD_SHORT[d.getDay()]}, {MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()} {d.getFullYear()}
                  </div>
                  <div style={{ fontSize: 14, color: T.ink, whiteSpace: "pre-wrap" }}>{h.text}</div>
                </div>
              );
            })}
          </div>
        </Field>
      )}

      <div className="flex gap-2 px-1 pt-1">
        <button onClick={save} className="tapfade flex-1 py-3 rounded-xl font-bold"
          style={{ background: T.brand, color: "#fff" }}>Done</button>
        <button onClick={() => { save(); openChore(chore); }} className="tapfade px-4 py-3 rounded-xl font-bold"
          style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.ink }}>
          Edit chore
        </button>
      </div>
    </Overlay>
  );
}

function ChoreModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const [rotation, setRotation] = useState(Array.isArray(payload.rotation) ? payload.rotation.filter(Boolean) : []);
  const [cad, setCad] = useState(payload.cadence || { type: "daily" });
  const [alert, setAlert] = useState(payload.alert || null);
  const [notes, setNotes] = useState(
    payload.notes && typeof payload.notes === "object" && !Array.isArray(payload.notes) ? payload.notes : {});
  const [checklist, setChecklist] = useState(SUB.choreChecklist(payload));
  const rotating = rotation.length > 0;
  // tapping a person appends them to the end, so the order you tap is the order it rotates
  const toggleRot = (id) => setRotation((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const setType = (type) => setCad(
    type === "weekly" ? { type, days: cad.days?.length ? cad.days : [new Date().getDay()] }
      : type === "monthly" ? { type, dayOfMonth: cad.dayOfMonth || new Date().getDate() }
        : type === "interval" ? { type, everyN: cad.everyN || 2, start: cad.start || ymd(new Date()) }
          : { type: "daily" }
  );
  const toggleDay = (d) => setCad((c) => {
    const days = new Set(c.days || []);
    days.has(d) ? days.delete(d) : days.add(d);
    return { ...c, days: [...days].sort() };
  });
  const save = () => {
    if (!title.trim()) return;
    const cadence = cad.type === "weekly" && !(cad.days || []).length ? { type: "daily" } : cad;
    // a rotation of one is really just a fixed assignee
    const rot = rotation.length > 1 ? rotation : [];
    const fixed = rotation.length === 1 ? rotation[0] : personId;
    update((d) => {
      if (editing) d.chores = d.chores.map((c) => c.id === payload.id ? { ...c, title, personId: fixed, rotation: rot, cadence, alert, notes, checklist: checklist.filter((x) => x.trim()) } : c);
      else d.chores = [...d.chores, { id: uid(), title, personId: fixed, rotation: rot, cadence, alert, notes, checklist: checklist.filter((x) => x.trim()), createdOn: ymd(new Date()), done: {} }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.chores = d.chores.filter((c) => c.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit chore" : "New chore"} close={close} />
      <Field label="Chore"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Empty dishwasher" className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <Field label="Repeats">
        <div className="flex flex-wrap gap-2">
          {[["daily", "Every day"], ["weekly", "Certain days"], ["monthly", "Monthly"], ["interval", "Every N days"]].map(([v, l]) => (
            <button key={v} onClick={() => setType(v)} className="tapfade px-4 py-2.5 rounded-full font-semibold"
              style={{ background: cad.type === v ? T.brand : T.panelAlt, color: cad.type === v ? "#fff" : T.ink, border: `1px solid ${cad.type === v ? T.brand : T.line}` }}>{l}</button>
          ))}
        </div>
      </Field>
      {cad.type === "weekly" && (
        <Field label="On these days">
          <div className="flex gap-1.5">
            {WD_SHORT.map((w, i) => {
              const on = (cad.days || []).includes(i);
              return (
                <button key={i} onClick={() => toggleDay(i)} className="tapfade flex-1 py-3 rounded-xl font-bold"
                  style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.sub, border: `1px solid ${on ? T.brand : T.line}`, fontSize: 13 }}>{w[0]}</button>
              );
            })}
          </div>
        </Field>
      )}
      {cad.type === "monthly" && (
        <Field label="Day of the month">
          <input type="number" min="1" max="31" value={cad.dayOfMonth || 1}
            onChange={(e) => setCad((c) => ({ ...c, dayOfMonth: Math.min(31, Math.max(1, +e.target.value || 1)) }))}
            className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">Months that are too short use their last day.</p>
        </Field>
      )}
      {cad.type === "interval" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Every (days)">
            <input type="number" min="2" value={cad.everyN || 2}
              onChange={(e) => setCad((c) => ({ ...c, everyN: Math.max(2, +e.target.value || 2) }))}
              className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          </Field>
          <Field label="Starting">
            <input type="date" value={cad.start || ymd(new Date())}
              onChange={(e) => setCad((c) => ({ ...c, start: e.target.value }))}
              className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          </Field>
        </div>
      )}
      <Field label="Who does it">
        <div className="flex gap-2 mb-3">
          <button onClick={() => setRotation([])} className="tapfade flex-1 py-3 rounded-xl font-semibold"
            style={{ background: !rotating ? T.brand : T.panelAlt, color: !rotating ? "#fff" : T.ink, border: `1px solid ${!rotating ? T.brand : T.line}` }}>
            Same person
          </button>
          <button onClick={() => setRotation(rotation.length ? rotation : people.map((x) => x.id))}
            className="tapfade flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
            style={{ background: rotating ? T.brand : T.panelAlt, color: rotating ? "#fff" : T.ink, border: `1px solid ${rotating ? T.brand : T.line}` }}>
            <Repeat size={15} /> Take turns
          </button>
        </div>

        {!rotating ? (
          <PersonPicker people={people} value={personId} onChange={setPersonId} />
        ) : (
          <>
            <p style={{ color: T.sub, fontSize: 13, fontWeight: 600 }} className="mb-2">
              Tap in the order you want to rotate:
            </p>
            <div className="flex gap-2 flex-wrap">
              {people.map((pp) => {
                const idx = rotation.indexOf(pp.id);
                const on = idx >= 0;
                return (
                  <button key={pp.id} onClick={() => toggleRot(pp.id)}
                    className="tapfade px-3.5 py-2.5 rounded-full font-semibold flex items-center gap-2"
                    style={{ background: on ? pp.color : T.panelAlt, color: on ? "#fff" : T.ink,
                      border: `1px solid ${on ? pp.color : T.line}` }}>
                    {on && (
                      <span className="rounded-full flex items-center justify-center"
                        style={{ background: "#ffffff33", width: 18, height: 18, fontSize: 11, fontWeight: 800 }}>{idx + 1}</span>
                    )}
                    {pp.name}
                  </button>
                );
              })}
            </div>
            {rotation.length > 1 && (
              <p style={{ color: T.brandInk, fontSize: 13, fontWeight: 600 }} className="mt-2.5">
                Next up: {(people.find((x) => x.id === choreAssignee({ ...payload, rotation }, ymd(new Date()))) || {}).name || "—"}
                {editing ? "" : ` · then ${(people.find((x) => x.id === rotation[1]) || {}).name || "—"}`}
              </p>
            )}
            <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-1.5">
              Turns advance when someone marks it done — so a skipped week leaves the same
              person up, and if one of you covers, the next turn follows from whoever did it.
            </p>
          </>
        )}
      </Field>
      <ChecklistEditor items={checklist} onChange={setChecklist} />
      <ChoreNotesEditor chore={payload} dateKey={ymd(new Date())} notes={notes} onChange={setNotes} />
      <AlertEditor value={alert} onChange={setAlert} />
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function TaskModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [date, setDate] = useState(payload.date || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const [alert, setAlert] = useState(payload.alert || null);
  const [steps, setSteps] = useState(Array.isArray(payload.steps) ? payload.steps : []);
  const [note, setNote] = useState(SUB.taskNote(payload));
  const save = () => {
    if (!title.trim()) return;
    update((d) => {
      if (editing) d.tasks = d.tasks.map((t) => t.id === payload.id ? { ...t, title, date, personId, alert, steps, note: note.trim() } : t);
      else d.tasks = [...d.tasks, { id: uid(), title, date, personId, alert, steps, note: note.trim(), done: false }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.tasks = d.tasks.filter((t) => t.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit task" : "New task"} close={close} />
      <Field label="Task"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Renew car tabs" className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <Field label="Due date (optional)"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <Field label="Assigned to"><PersonPicker people={people} value={personId} onChange={setPersonId} /></Field>
      <StepsEditor steps={steps} onChange={setSteps} />
      <Field label="Notes">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Anything worth remembering — a phone number, where the paperwork is…"
          className="w-full px-3 py-2.5 rounded-xl outline-none"
          style={{ ...inputStyle, fontSize: 15, resize: "vertical" }} />
      </Field>
      <AlertEditor value={alert} onChange={setAlert} />
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function NoteModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [text, setText] = useState(payload.text || "");
  const [color, setColor] = useState(payload.color || NOTE_COLORS[0]);
  const [personId, setPersonId] = useState(payload.personId || "");
  const save = () => {
    if (!text.trim()) return;
    update((d) => {
      if (editing) d.notes = d.notes.map((n) => n.id === payload.id ? { ...n, text: text.trim(), color, personId } : n);
      else d.notes = [{ id: uid(), text: text.trim(), color, personId, at: Date.now() }, ...d.notes];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.notes = d.notes.filter((n) => n.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit note" : "New note"} close={close} />
      <Field label="Note">
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4}
          placeholder="e.g. Vet appointment moved to Thursday — can you take him?"
          className="w-full px-4 py-3.5 rounded-xl text-lg outline-none resize-none" style={inputStyle} />
      </Field>
      <Field label="Paper color">
        <div className="flex gap-2 flex-wrap">
          {NOTE_COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} className="tapfade w-11 h-11 rounded-lg"
              style={{ background: c, border: color === c ? `3px solid ${T.ink}` : "3px solid transparent" }} />
          ))}
        </div>
      </Field>
      <Field label="From"><PersonPicker people={people} value={personId} onChange={setPersonId} /></Field>
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function DateModal({ payload, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [date, setDate] = useState(payload.date || ymd(new Date()));
  const [annual, setAnnual] = useState(!!payload.annual);
  const save = () => {
    if (!title.trim() || !date) return;
    update((d) => {
      if (editing) d.dates = d.dates.map((x) => x.id === payload.id ? { ...x, title: title.trim(), date, annual } : x);
      else d.dates = [...d.dates, { id: uid(), title: title.trim(), date, annual }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.dates = d.dates.filter((x) => x.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit date" : "New important date"} close={close} />
      <Field label="What"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Our anniversary" className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <Field label="Repeats">
        <div className="flex gap-2">
          <button onClick={() => setAnnual(false)} className="tapfade flex-1 py-3 rounded-xl font-semibold"
            style={{ background: !annual ? T.brand : T.panelAlt, color: !annual ? "#fff" : T.ink, border: `1px solid ${!annual ? T.brand : T.line}` }}>One time</button>
          <button onClick={() => setAnnual(true)} className="tapfade flex-1 py-3 rounded-xl font-semibold"
            style={{ background: annual ? T.brand : T.panelAlt, color: annual ? "#fff" : T.ink, border: `1px solid ${annual ? T.brand : T.line}` }}>Every year</button>
        </div>
        <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">Yearly dates roll forward on their own — good for anniversaries and birthdays.</p>
      </Field>
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

/* ---------------- History ----------------
   A window back over what actually got done. Distinct from the archive panel in
   Settings, which is the permanent append-only record that every admin has to
   agree to switch off: this reads the live document, so it works whether or not
   the archive is on, and it is reachable in one tap from the To-Dos tab.

   The tally is the part people actually come for. "Who has been doing more"
   is a question households already ask each other, usually badly, and a count
   over a chosen window answers it without anyone having to keep score.

   Credit can be corrected here, but only where the completion model allows it
   (see lib/completion.js): a signed-in member ticking their own box made a
   first-person claim, and this screen will not rewrite it. Anything ticked on a
   shared display, or recorded on somebody's behalf, is fair game. */
export function HistoryModal({ data, update, personById, close }) {
  const [days, setDays] = useState(14);
  const [who, setWho] = useState("all");
  const [error, setError] = useState("");
  const todayKey = ymd(new Date());
  const actor = actorFor(data);

  const rows = [];
  for (let i = 0; i < days; i++) {
    const k = ymd(addDays(parseYMD(todayKey), -i));
    const items = [];

    for (const c of data.chores || []) {
      const mark = c.done?.[k];
      if (!mark) continue;
      if (COMPLETION.isSkipped(mark)) {
        items.push({ id: "c" + c.id, kind: "chore", title: c.title, skipped: true, personId: "" });
        continue;
      }
      const rec = COMPLETION.completionOf(mark);
      items.push({
        id: "c" + c.id, kind: "chore", title: c.title, personId: rec?.by || "",
        chore: c, mark,
        // A locked completion is somebody's own claim about themselves. It is
        // shown, but not up for editing by whoever happens to be looking.
        editable: COMPLETION.canReattribute(mark, actor),
        note: rec?.byType === "display" ? (rec.source || "shared display") : null,
      });
    }

    for (const t of data.tasks || []) {
      if (t.done && t.doneAt === k) {
        items.push({ id: "t" + t.id, kind: "task", title: t.title, personId: t.personId, task: t, editable: true });
      }
    }

    for (const pr of data.projects || []) {
      if (pr.doneOn === k) {
        items.push({ id: "p" + pr.id, kind: "project", title: pr.title, personId: pr.personId, editable: false });
      }
    }

    const filtered = who === "all" ? items : items.filter((x) => x.personId === who);
    if (filtered.length) rows.push({ date: k, items: filtered });
  }

  // Tally over the whole window, not just the filtered view — otherwise
  // choosing one person makes everybody else's count read zero.
  const tally = {};
  for (let i = 0; i < days; i++) {
    const k = ymd(addDays(parseYMD(todayKey), -i));
    for (const c of data.chores || []) {
      const mark = c.done?.[k];
      if (!mark || COMPLETION.isSkipped(mark)) continue;
      const by = COMPLETION.completedBy(mark);
      if (by) tally[by] = (tally[by] || 0) + 1;
    }
    for (const t of data.tasks || []) if (t.done && t.doneAt === k && t.personId) tally[t.personId] = (tally[t.personId] || 0) + 1;
    for (const pr of data.projects || []) if (pr.doneOn === k && pr.personId) tally[pr.personId] = (tally[pr.personId] || 0) + 1;
  }

  const recredit = (x, dateKey, personId) => {
    setError("");
    try {
      if (x.kind === "chore") {
        update((d) => COMPLETION.attributeChore(d, x.chore.id, dateKey, personId, actorFor(d)));
      } else {
        update((d) => {
          d.tasks = d.tasks.map((t) => t.id === x.task.id ? { ...t, personId } : t);
          return d;
        });
      }
    } catch (err) { setError(err.message); }
  };

  const kindIcon = (k) => k === "chore" ? <Repeat size={11} /> : k === "task" ? <CheckCircle2 size={11} /> : <Wrench size={11} />;
  const pill = (on, bg) => ({
    background: on ? bg : T.panelAlt, color: on ? "#fff" : T.sub,
    border: `1px solid ${on ? bg : T.line}`, fontSize: 12.5,
  });

  return (
    <Overlay close={close} wide>
      <ModalHead title="History" close={close} />

      {error && (
        <div role="alert" className="rounded-xl px-3 py-2 mb-3"
          style={{ background: "#fdecea", border: "1px solid #f0b4ae", color: "#7a1c12", fontSize: 13 }}>
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-3">
        {[[7, "7 days"], [14, "2 weeks"], [30, "30 days"], [90, "3 months"]].map(([n, l]) => (
          <button key={n} onClick={() => setDays(n)} className="tapfade px-3 py-1.5 rounded-full font-semibold"
            style={pill(days === n, T.brand)}>{l}</button>
        ))}
        <span style={{ width: 1, height: 18, background: T.line }} className="mx-1" />
        <button onClick={() => setWho("all")} className="tapfade px-3 py-1.5 rounded-full font-semibold"
          style={pill(who === "all", T.ink)}>Everyone</button>
        {data.people.map((pp) => (
          <button key={pp.id} onClick={() => setWho(pp.id)} className="tapfade px-3 py-1.5 rounded-full font-semibold"
            style={pill(who === pp.id, pp.color)}>{pp.name}</button>
        ))}
      </div>

      {Object.keys(tally).length > 0 && (
        <div className="flex items-center gap-3 flex-wrap rounded-xl px-3 py-2.5 mb-3" style={{ background: T.panelAlt }}>
          <span style={{ color: T.sub, fontSize: 11.5, fontWeight: 800, letterSpacing: 0.5 }} className="uppercase">Completed</span>
          {data.people.map((pp) => (
            <span key={pp.id} className="flex items-center gap-1.5">
              <span className="rounded-full" style={{ width: 8, height: 8, background: pp.color }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{pp.name} {tally[pp.id] || 0}</span>
            </span>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <Empty text="Nothing completed in this window." />
      ) : (
        <div className="flex flex-col gap-3.5">
          {rows.map((r) => {
            const d = parseYMD(r.date);
            return (
              <div key={r.date}>
                <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 800, letterSpacing: 0.8 }} className="uppercase mb-1.5">
                  {r.date === todayKey ? "Today" : `${WD_LONG[d.getDay()]}, ${MO_LONG[d.getMonth()].slice(0, 3)} ${d.getDate()}`}
                </div>
                <div className="flex flex-col gap-1.5">
                  {r.items.map((x) => {
                    const pp = personById(x.personId);
                    return (
                      <div key={r.date + x.id} className="rounded-xl px-3 py-2"
                        style={{ background: T.panel, border: `1px solid ${T.line}`, opacity: x.skipped ? 0.6 : 1 }}>
                        <div className="flex items-center gap-2">
                          <span style={{ color: T.faint }} className="shrink-0">{kindIcon(x.kind)}</span>
                          <span style={{ fontSize: 14.5, fontWeight: 600, color: T.ink, textDecoration: x.skipped ? "line-through" : "none" }}
                            className="truncate flex-1">{x.title}</span>
                          {x.skipped ? (
                            <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700 }}>skipped</span>
                          ) : x.editable ? (
                            <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                              {data.people.map((cand) => {
                                const on = pp?.id === cand.id;
                                return (
                                  <button key={cand.id} onClick={() => recredit(x, r.date, cand.id)}
                                    aria-label={`Credit ${cand.name} for ${x.title}`}
                                    className="tapfade px-2 py-0.5 rounded-full font-semibold"
                                    style={{ background: on ? cand.color : "transparent", color: on ? "#fff" : T.faint,
                                      border: `1px solid ${on ? cand.color : T.line}`, fontSize: 11 }}>
                                    {cand.name}
                                  </button>
                                );
                              })}
                            </div>
                          ) : pp ? (
                            <span style={{ color: pp.color, fontSize: 11.5, fontWeight: 700 }} className="shrink-0">{pp.name}</span>
                          ) : (
                            <span style={{ color: T.faint, fontSize: 11.5, fontWeight: 700 }} className="shrink-0">
                              {x.note || "unattributed"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ color: T.faint, fontSize: 12 }} className="mt-3">
        Tap a name to change who gets credit — handy when the rotation said one of you but
        the other actually did it. Anything one of you ticked off while signed in stays as
        it was recorded, and shows the name without the buttons.
      </p>
    </Overlay>
  );
}


export function ProjectModal({ payload, people, update, close, calendars }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [notes, setNotes] = useState(payload.notes || "");
  const [percent, setPercent] = useState(payload.percent || 0);
  const [dates, setDates] = useState(Array.isArray(payload.dates) ? [...payload.dates].sort() : []);
  const [stages, setStages] = useState(Array.isArray(payload.stages) ? payload.stages.map((x) => ({ ...x })) : []);
  const derivedPct = stages.length ? Math.round((stages.filter((x) => x.done).length / stages.length) * 100) : clampPercent(percent);
  const addStage = () => setStages((cur) => [...cur, { id: uid(), title: "", date: "", done: false }]);
  const editStage = (id, patch) => setStages((cur) => cur.map((x) => x.id === id ? { ...x, ...patch } : x));
  const toggleStage = (id) => setStages((cur) => cur.map((x) => x.id === id ? { ...x, done: !x.done } : x));
  const dropStage = (id) => setStages((cur) => cur.filter((x) => x.id !== id));
  const [personId, setPersonId] = useState(payload.personId || "");
  const [newDate, setNewDate] = useState("");
  /* Which synced calendar these dates belong on. Empty means "stays in
     HouseHub", and that is the default deliberately: a renovation plan should
     not start appearing on a shared work calendar because somebody added a
     stage. */
  const [calendarId, setCalendarId] = useState(payload.calendarId || "");

  const addDate = () => {
    if (!newDate) return;
    setDates((cur) => [...new Set([...cur, newDate])].sort());
    setNewDate("");
  };
  const dropDate = (k) => setDates((cur) => cur.filter((x) => x !== k));

  const save = () => {
    if (!title.trim()) return;
    const clean = stages.filter((x) => x.title.trim() || x.date).map((x) => ({ ...x, title: x.title.trim() }));
    const pct = clean.length ? Math.round((clean.filter((x) => x.done).length / clean.length) * 100) : clampPercent(percent);
    update((d) => {
      const row = {
        title: title.trim(), notes: notes.trim(), percent: pct, dates, stages: clean, personId,
        calendarId,
        doneOn: pct >= 100 ? (payload.doneOn || ymd(new Date())) : "",
      };
      if (editing) d.projects = d.projects.map((x) => x.id === payload.id ? { ...x, ...row } : x);
      else d.projects = [...(d.projects || []), { id: uid(), createdOn: ymd(new Date()), ...row }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.projects = d.projects.filter((x) => x.id !== payload.id); return d; }); close(); };

  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit project" : "New project"} close={close} />
      <Field label="Project">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. refinish the deck"
          className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
      </Field>
      <Field label="Notes (optional)">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
          placeholder="Materials, measurements, anything worth remembering"
          className="w-full px-4 py-3 rounded-xl text-base outline-none resize-none" style={inputStyle} />
      </Field>
      {/* Stages: optional. Once there's at least one, progress is derived from
          what's ticked and the manual slider steps aside. */}
      <Field label={stages.length ? `Stages — ${derivedPct}% (${stages.filter((x) => x.done).length} of ${stages.length})` : "Stages (optional)"}>
        {stages.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-2.5">
            {stages.map((st, i) => (
              <div key={st.id} className="flex items-center gap-2 rounded-xl px-2.5 py-2"
                style={{ background: T.panelAlt, border: `1px solid ${T.line}`, opacity: st.done ? 0.6 : 1 }}>
                <button onClick={() => toggleStage(st.id)} className="tapfade shrink-0" style={{ color: st.done ? T.brand : T.faint }}>
                  {st.done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
                </button>
                <input value={st.title} onChange={(e) => editStage(st.id, { title: e.target.value })}
                  placeholder={`Stage ${i + 1}`}
                  className="flex-1 min-w-0 px-2.5 py-2 rounded-lg text-base outline-none"
                  style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink,
                    textDecoration: st.done ? "line-through" : "none" }} />
                <input type="date" value={st.date || ""} onChange={(e) => editStage(st.id, { date: e.target.value })}
                  title="Day planned for this stage"
                  className="shrink-0 px-2 py-2 rounded-lg text-sm outline-none"
                  style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink, width: 142 }} />
                <button onClick={() => dropStage(st.id)} className="tapfade p-1 shrink-0" style={{ color: T.faint }}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        )}
        <button onClick={addStage} className="tapfade w-full py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2"
          style={{ background: T.brandSoft, color: T.brand }}>
          <Plus size={16} /> Add a stage
        </button>
        <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
          {stages.length
            ? "Progress comes from the stages you've ticked. Give each one a day and the project shows up on those days."
            : "Break a bigger project into steps, each with its own day. Leave this empty and set progress by hand instead."}
        </p>
      </Field>

      {stages.length === 0 && (
        <Field label={`Progress — ${clampPercent(percent)}%`}>
          <input type="range" min="0" max="100" step="5" value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            className="w-full" style={{ accentColor: clampPercent(percent) >= 100 ? T.brand : T.gold }} />
          <div className="flex gap-1.5 mt-2">
            {[0, 25, 50, 75, 100].map((n) => (
              <button key={n} onClick={() => setPercent(n)} className="tapfade flex-1 py-2 rounded-lg font-bold"
                style={{ background: percent === n ? T.brand : T.panelAlt, color: percent === n ? "#fff" : T.sub,
                  border: `1px solid ${percent === n ? T.brand : T.line}`, fontSize: 12.5 }}>{n}%</button>
            ))}
          </div>
        </Field>
      )}
      {/* Which calendar the dated work belongs on. Offered whether the project
          tracks stages or plain days, because both put things on the calendar. */}
      <Field label="Show these dates on">
        <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}
          className="w-full px-4 py-3 rounded-xl outline-none" style={inputStyle}>
          <option value="">HouseHub only</option>
          {(calendars || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name || "Calendar"}{c.writable ? "" : " (read-only)"}</option>
          ))}
        </select>
        <p style={{ color: T.faint, fontSize: 12, marginTop: 6 }}>
          Dated stages always appear on the HouseHub calendar. Choosing a synced
          calendar also writes them out to it, if that calendar allows writing.
        </p>
      </Field>
      {stages.length === 0 && (
      <Field label="Days planned">
        <div className="flex gap-2 mb-2">
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
            className="flex-1 min-w-0 px-4 py-3 rounded-xl text-base outline-none" style={inputStyle} />
          <button onClick={addDate} className="tapfade px-4 rounded-xl font-semibold" style={{ background: T.brand, color: "#fff" }}>
            <Plus size={18} />
          </button>
        </div>
        {dates.length === 0 ? (
          <p style={{ color: T.faint, fontSize: 13 }}>No days planned — it'll sit in the backlog.</p>
        ) : (
          <div className="flex gap-1.5 flex-wrap">
            {dates.map((k) => {
              const d = parseYMD(k);
              return (
                <span key={k} className="flex items-center gap-1 rounded-full pl-3 pr-1.5 py-1.5"
                  style={{ background: T.brandSoft, color: T.brandInk }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{WD_SHORT[d.getDay()]} {MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}</span>
                  <button onClick={() => dropDate(k)} className="tapfade" style={{ color: T.brand }} aria-label="Remove day"><X size={13} /></button>
                </span>
              );
            })}
          </div>
        )}
        <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
          Add several days if it'll take a weekend — it shows up on each one until it's done.
        </p>
      </Field>
      )}
      <Field label="Whose project"><PersonPicker people={people} value={personId} onChange={setPersonId} /></Field>
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function PersonPicker({ people, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => onChange("")} className="tapfade px-4 py-2.5 rounded-full font-semibold" style={{ background: value === "" ? T.ink : T.panelAlt, color: value === "" ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Everyone</button>
      {people.map((p) => (
        <button key={p.id} onClick={() => onChange(p.id)} className="tapfade px-4 py-2.5 rounded-full font-semibold flex items-center gap-2"
          style={{ background: value === p.id ? p.color : T.panelAlt, color: value === p.id ? "#fff" : T.ink, border: `1px solid ${value === p.id ? p.color : T.line}` }}>
          <span className="w-3 h-3 rounded-full" style={{ background: value === p.id ? "#fff" : p.color }} />{p.name}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Settings ---------------- */
function SettingsModal({ data, update, saveNow, syncCalendars, close, currentUser }) {
  const [name, setName] = useState(data.householdName || "Our Home");
  const [tab, setTab] = useState("people");
  const saveName = () => {
    const next = name.trim() || "Our Home";
    update((d) => { d.householdName = next; return d; });
    // The picker reads a separately sealed copy of the name so it can label
    // households without downloading each vault. Push the rename there too.
    session.syncHouseholdName(next);
  };
  const upNextAll = !Array.isArray(data.upNextSources) || data.upNextSources.length === 0;
  const resetAll = () => {
    if (!confirm("Clear everything and start fresh? This wipes events, meals, chores, tasks, groceries, notes and dates on the server.")) return;
    update((d) => {
      const fresh = seed();
      // keep the connected calendar feeds and display prefs; clear the content
      return { ...fresh, calendars: d.calendars, weather: d.weather, layoutMode: d.layoutMode, noteDisplay: d.noteDisplay };
    });
    close();
  };

  return (
    <Overlay close={close} wide>
      <ModalHead title="Settings" close={close} />
      <Field label="Household name">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
      </Field>
      {/* Who is in this household, and letting new people in. The key wrap that
          admits someone happens in the browser, so it has to live in the UI. */}
      <Field label="People">
        <HouseholdPanel theme={T} me={currentUser} householdName={data.householdName} />
      </Field>
      <Field label="Archive">
        <ArchivePanel theme={T} data={data} update={update} me={currentUser} />
      </Field>
      <Field label="Displays">
        <DisplaysPanel theme={T} me={currentUser} />
      </Field>
      <Field label="Home Assistant">
        <HomeAssistantPanel theme={T} />
      </Field>
      <Field label="Devices">
        <DevicesPanel theme={T} />
      </Field>
      <Field label="Cameras">
        <CamerasPanel theme={T} />
      </Field>
      <Field label="AI">
        <AiPanel theme={T} data={data} update={update} />
      </Field>
      <Field label="Two-way calendar sync">
        <CaldavPanel theme={T} iAmAdmin={currentUser?.role === "admin"}
          collectEvents={(calId) => eventsForSync(data, calId)} />
      </Field>
      <Field label="Extra row on Today">
        <SecondBlockSettings data={data} update={update} theme={T} people={data.people} />
      </Field>
      <Field label="Import from the old HouseHub">
        <ImportPanel theme={T} data={data} update={update} saveNow={saveNow} />
      </Field>
      <Field label="Staying signed in">
        <SessionPolicyPanel theme={T} />
      </Field>
      <Field label="Your data">
        <PrivacyPanel theme={T} data={data} me={currentUser} />
      </Field>
      {currentUser?.isSuperAdmin && (
        <Field label="Server (super admin)">
          <SuperAdminPanel theme={T} />
        </Field>
      )}
      <Field label="Account">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="tapfade px-4 py-3 rounded-xl font-semibold"
            style={{ background: T.panelAlt, color: T.ink, border: `1px solid ${T.line}` }}
            onClick={() => window.dispatchEvent(new CustomEvent("househub:switch-household"))}
          >
            Switch household
          </button>
          {/* Signing out was only reachable from the household picker, which you
              cannot get back to once inside a household. */}
          <button
            className="tapfade px-4 py-3 rounded-xl font-semibold"
            style={{ background: T.panelAlt, color: "#a12f1c", border: `1px solid ${T.line}` }}
            onClick={async () => {
              if (!confirm("Sign out?\n\nYour keys are only held in memory, so you will need your password again.")) return;
              await session.signOut();
              window.location.reload();
            }}
          >
            Sign out
          </button>
          <span style={{ color: T.faint, fontSize: 13 }}>{currentUser?.email || ""}</span>
        </div>
      </Field>
      <Field label="Display mode">
        <div className="flex gap-2">
          {[["auto", "Auto"], ["wall", "Wall (row)"], ["compact", "Compact"]].map(([v, l]) => {
            const active = (data.layoutMode || "auto") === v;
            return (
              <button key={v} onClick={() => update((d) => { d.layoutMode = v; return d; })} className="tapfade flex-1 py-3 rounded-xl font-semibold"
                style={{ background: active ? T.brand : T.panelAlt, color: active ? "#fff" : T.ink, border: `1px solid ${active ? T.brand : T.line}` }}>{l}</button>
            );
          })}
        </div>
        <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">Wall keeps the side-by-side dashboard for a mounted iPad. Compact stacks everything for a phone. Auto chooses by screen width.</p>
      </Field>
      <Field label="Sticky notes on Today">
        <div className="flex gap-2">
          {[["overlay", "Stuck on"], ["row", "Compact row"], ["off", "Hidden"]].map(([v, l]) => {
            const active = (data.noteDisplay || "overlay") === v;
            return (
              <button key={v} onClick={() => update((d) => { d.noteDisplay = v; return d; })} className="tapfade flex-1 py-3 rounded-xl font-semibold"
                style={{ background: active ? T.brand : T.panelAlt, color: active ? "#fff" : T.ink, border: `1px solid ${active ? T.brand : T.line}` }}>{l}</button>
            );
          })}
        </div>
        <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">
          "Stuck on" lays notes over the Today screen — drag to move them, tap to edit. Phones always use the compact row.
        </p>

        {(data.noteDisplay || "overlay") === "overlay" && (
          <div className="mt-3">
            <div style={{ color: T.sub, fontSize: 11, fontWeight: 700 }} className="uppercase mb-1">Idle drift</div>
            <div className="flex gap-2">
              {[[false, "Still"], [true, "Gentle drift"]].map(([v, l]) => {
                const on = !!data.noteDrift === v;
                return (
                  <button key={String(v)} onClick={() => update((d) => { d.noteDrift = v; return d; })}
                    className="tapfade flex-1 py-2.5 rounded-xl font-semibold"
                    style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>{l}</button>
                );
              })}
            </div>
            <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-1.5">
              Lets the notes wander a few pixels every so often, which stops a wall display
              burning a fixed image into the panel. Off if you find movement distracting.
            </p>
          </div>
        )}
        {(data.notes || []).some((n) => typeof n.x === "number") && (
          <button onClick={() => update((d) => { d.notes = d.notes.map(({ x, y, ...rest }) => rest); return d; })}
            className="tapfade mt-3 w-full py-2.5 rounded-xl font-semibold" style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub }}>
            Tidy notes back into place
          </button>
        )}
      </Field>
      <Field label="Per-person summary on Today">
        <div className="flex gap-2">
          {[[true, "Show"], [false, "Hide"]].map(([v, l]) => {
            const active = (data.showBreakdown !== false) === v;
            return (
              <button key={String(v)} onClick={() => update((d) => { d.showBreakdown = v; return d; })}
                className="tapfade flex-1 py-3 rounded-xl font-semibold"
                style={{ background: active ? T.brand : T.panelAlt, color: active ? "#fff" : T.ink, border: `1px solid ${active ? T.brand : T.line}` }}>{l}</button>
            );
          })}
        </div>
        <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">Hiding it gives the three columns more vertical room.</p>
      </Field>
      <Field label="“Up next” draws from">
        {(data.calendars || []).length === 0 ? (
          <p style={{ color: T.faint, fontSize: 14, lineHeight: 1.5 }}>
            No calendars connected yet. Add one under <b>Calendar sync</b> and it will appear
            here so you can choose which ones feed the “Up next” card.
          </p>
        ) : (
          <>
            <button onClick={() => update((d) => { d.upNextSources = null; return d; })}
              className="tapfade w-full text-left px-4 py-3 rounded-xl font-semibold mb-2"
              style={{
                background: upNextAll ? T.brand : T.panelAlt,
                color: upNextAll ? "#fff" : T.ink,
                border: `1px solid ${upNextAll ? T.brand : T.line}`,
              }}>
              Every calendar
            </button>
            <div className="flex flex-col gap-2">
              {[{ id: "local", name: "Events added here", color: T.brand }, ...(data.calendars || [])].map((src) => {
                const on = !upNextAll && (data.upNextSources || []).includes(src.id);
                return (
                  <button key={src.id} onClick={() => update((d) => {
                    const cur = Array.isArray(d.upNextSources) ? [...d.upNextSources] : [];
                    const i = cur.indexOf(src.id);
                    if (i >= 0) cur.splice(i, 1); else cur.push(src.id);
                    d.upNextSources = cur.length ? cur : null;   // none picked = back to all
                    return d;
                  })}
                    className="tapfade text-left px-3 py-3 rounded-xl font-semibold flex items-center gap-2.5"
                    style={{ background: on ? T.brandSoft : T.panelAlt, border: `1px solid ${on ? T.brand : T.line}`, color: T.ink }}>
                    <span className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                      style={{ background: on ? T.brand : "transparent", border: `2px solid ${on ? T.brand : T.faint}` }}>
                      {on && <CheckCircle2 size={13} style={{ color: "#fff" }} />}
                    </span>
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: src.color }} />
                    <span className="truncate">{src.name}</span>
                  </button>
                );
              })}
            </div>
            <p style={{ color: T.faint, fontSize: 13 }} className="mt-2">
              Pick any combination. Unchecking everything goes back to using them all.
            </p>
          </>
        )}
      </Field>
      <div className="flex gap-2 mb-5">
        {[["people", "People", Users], ["calendars", "Calendar sync", Link2], ["weather", "Weather", Thermometer], ["voice", "Voice", Mic], ["home", "Home", Sofa], ["checkin", "Check-in", BellRing]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold"
            style={{ background: tab === id ? T.brand : T.panelAlt, color: tab === id ? "#fff" : T.sub, border: `1px solid ${tab === id ? T.brand : T.line}` }}>
            <Icon size={17} />{label}
          </button>
        ))}
      </div>
      {tab === "people" ? <PeopleSettings data={data} update={update} />
        : tab === "voice" ? <VoiceSettings data={data} />
        : tab === "home" ? <HomeSettings data={data} update={update} />
        : tab === "checkin" ? <CheckInSettings data={data} update={update} />
        : tab === "weather" ? <WeatherSettings data={data} update={update} />
          : <CalendarSettings data={data} update={update} syncCalendars={syncCalendars} />}
      <button onClick={resetAll} className="tapfade w-full py-3.5 rounded-2xl font-semibold mt-5" style={{ background: "#E86A4C14", color: "#E86A4C" }}>Reset everything</button>
      <p style={{ color: T.faint, fontSize: 13 }} className="text-center mt-3">Everything saves automatically on this device.</p>
      <p style={{ color: T.faint, fontSize: 12 }} className="text-center mt-1">Build {BUILD} · {useMobile() ? "compact layout" : "wall layout"} · {typeof window !== "undefined" ? window.innerWidth : "?"}px wide</p>
    </Overlay>
  );
}

function PeopleSettings({ data, update }) {
  const addPerson = () => update((d) => {
    const used = d.people.map((p) => p.color);
    const color = PERSON_COLORS.find((c) => !used.includes(c)) || PERSON_COLORS[d.people.length % PERSON_COLORS.length];
    d.people = [...d.people, { id: uid(), name: `Person ${d.people.length + 1}`, color }];
    return d;
  });
  const rename = (id, val) => update((d) => { d.people = d.people.map((p) => p.id === id ? { ...p, name: val } : p); return d; });
  const recolor = (id, color) => update((d) => { d.people = d.people.map((p) => p.id === id ? { ...p, color } : p); return d; });
  const remove = (id) => update((d) => {
    d.people = d.people.filter((p) => p.id !== id);
    d.events = d.events.map((e) => e.personId === id ? { ...e, personId: "" } : e);
    d.chores = d.chores.map((c) => c.personId === id ? { ...c, personId: "" } : c);
    d.calendars = (d.calendars || []).map((c) => c.personId === id ? { ...c, personId: "" } : c);
    return d;
  });
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span style={{ color: T.sub, fontSize: 13, fontWeight: 700 }} className="uppercase">People in this household</span>
        <button onClick={addPerson} className="tapfade flex items-center gap-1.5 px-3 py-2 rounded-full font-semibold text-sm" style={{ background: T.brandSoft, color: T.brand }}><Plus size={16} /> Add</button>
      </div>
      <div className="flex flex-col gap-3">
        {data.people.map((p) => (
          <div key={p.id} className="rounded-2xl p-3" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
            <div className="flex items-center gap-3 mb-2.5">
              <input value={p.name} onChange={(e) => rename(p.id, e.target.value)} className="flex-1 px-3 py-2.5 rounded-lg text-lg outline-none font-semibold" style={{ background: T.panel, border: `1px solid ${T.line}`, color: p.color }} />
              <button onClick={() => remove(p.id)} className="tapfade p-2" style={{ color: T.faint }}><Trash2 size={18} /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {PERSON_COLORS.map((c) => <button key={c} onClick={() => recolor(p.id, c)} className="tapfade w-8 h-8 rounded-full" style={{ background: c, border: p.color === c ? `3px solid ${T.ink}` : "3px solid transparent" }} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VoiceSettings({ data }) {
  const token = data.apiToken || "";
  const [copied, setCopied] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "https://hub.example.com";
  const url = `${origin}/api/voice/grocery`;

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1800);
    } catch (e) {
      setCopied("failed");
    }
  };

  const Row = ({ label, value, what, mono }) => (
    <div className="mb-3">
      <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 0.4 }} className="uppercase mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 px-3 py-2.5 rounded-xl truncate"
          style={{ background: T.panelAlt, border: `1px solid ${T.line}`, fontSize: mono ? 12.5 : 14, color: T.ink }}>
          {value}
        </code>
        <button onClick={() => copy(value, what)} className="tapfade rounded-xl px-3 py-2.5 shrink-0"
          style={{ background: copied === what ? T.brand : T.panel, color: copied === what ? "#fff" : T.sub, border: `1px solid ${copied === what ? T.brand : T.line}` }}>
          {copied === what ? "Copied" : <Copy size={16} />}
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: T.brandSoft }}>
        <p style={{ fontSize: 14, color: T.brandInk, lineHeight: 1.55 }}>
          Add to the grocery list by voice with an Apple Shortcut: <b>“Hey Siri, add to grocery list.”</b>
          Siri asks what to add, you say it, and it lands here — aisle guessed automatically.
        </p>
      </div>

      <Row label="Endpoint" value={url} what="url" mono />
      <Row label="Token" value={token} what="token" mono />

      <div className="rounded-2xl p-4 mb-4" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Build the Shortcut</div>
        <ol style={{ color: T.ink, fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
          <li>Open <b>Shortcuts</b> → <b>+</b> → name it <b>Add to grocery list</b>.</li>
          <li>Add action <b>Ask for Input</b> — type Text, prompt “What should I add?”</li>
          <li>Add action <b>Get Contents of URL</b>, paste the endpoint above.</li>
          <li>Expand it: Method <b>POST</b>, Headers add <code>Authorization</code> = <code>Bearer {token ? "…" : "TOKEN"}</code>, Request Body <b>JSON</b>.</li>
          <li>In the JSON body add one text field named <code>text</code>, value = the <b>Provided Input</b> variable.</li>
          <li>Optional: add <b>Show Result</b> with the <code>spoken</code> value so Siri reads back what it added.</li>
        </ol>
      </div>

      <div className="rounded-2xl p-4" style={{ background: "#E86A4C10", border: "1px solid #E86A4C33" }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#B4442A", marginBottom: 6 }}>Before using this away from home</div>
        <p style={{ fontSize: 13, color: T.ink, lineHeight: 1.55 }}>
          The token only protects these voice endpoints — the rest of the app still has no login.
          To add items from the store, reach the server over a private network (Tailscale or a VPN)
          rather than opening it to the whole internet. Treat the token like a password; anyone
          holding it can add to your lists.
        </p>
      </div>
    </div>
  );
}

function WeatherSettings({ data, update }) {
  const w = data.weather || dw();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState(null);
  const [err, setErr] = useState(null);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(null); setHits(null);
    try {
      const r = await fetch(`${getConfig().geocodeApiBase}?name=${encodeURIComponent(q.trim())}&count=5`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      setHits(j.results || []);
    } catch (e) {
      setErr("Couldn't search — check the connection. You can enter coordinates manually below.");
    }
    setBusy(false);
  };
  const pick = (h) => {
    update((d) => {
      d.weather = { ...(d.weather || dw()), lat: h.latitude, lon: h.longitude, label: h.name };
      return d;
    });
    setHits(null); setQ("");
  };
  const setUnit = (unit) => update((d) => { d.weather = { ...(d.weather || dw()), unit }; return d; });
  const setField = (k, v) => update((d) => { d.weather = { ...(d.weather || dw()), [k]: v }; return d; });

  return (
    <div>
      <div className="rounded-2xl p-4 mb-4 flex items-center gap-3" style={{ background: T.brandSoft }}>
        <MapPin size={20} style={{ color: T.brand }} className="shrink-0" />
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: T.brandInk }}>{w.label || "Not set"}</div>
          <div style={{ fontSize: 13, color: T.brandInk + "BB" }}>{Number(w.lat).toFixed(2)}, {Number(w.lon).toFixed(2)}</div>
        </div>
      </div>

      <Field label="Change location">
        <div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            placeholder="City name" className="flex-1 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <button onClick={search} disabled={busy} className="tapfade px-5 rounded-xl font-semibold" style={{ background: T.brand, color: "#fff", opacity: busy ? 0.6 : 1 }}>
            {busy ? <RefreshCw size={18} className="animate-spin" /> : "Search"}
          </button>
        </div>
      </Field>
      {err && <div className="rounded-xl px-4 py-3 mb-4" style={{ background: "#E86A4C15", color: "#B4442A", fontSize: 14 }}>{err}</div>}
      {hits && hits.length === 0 && <p style={{ color: T.faint, fontSize: 14 }} className="mb-4">No matches.</p>}
      {hits && hits.length > 0 && (
        <div className="flex flex-col gap-2 mb-4">
          {hits.map((h, i) => (
            <button key={i} onClick={() => pick(h)} className="tapfade text-left rounded-xl px-4 py-3" style={{ background: T.panelAlt, border: `1px solid ${T.line}` }}>
              <div style={{ fontWeight: 600 }}>{h.name}</div>
              <div style={{ color: T.sub, fontSize: 13 }}>{[h.admin1, h.country].filter(Boolean).join(", ")}</div>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude">
          <input type="number" step="0.01" value={w.lat} onChange={(e) => setField("lat", Number(e.target.value))}
            className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
        </Field>
        <Field label="Longitude">
          <input type="number" step="0.01" value={w.lon} onChange={(e) => setField("lon", Number(e.target.value))}
            className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
        </Field>
      </div>
      <Field label="Units">
        <div className="flex gap-2">
          <button onClick={() => setUnit("f")} className="tapfade flex-1 py-3 rounded-xl font-semibold"
            style={{ background: w.unit !== "c" ? T.brand : T.panelAlt, color: w.unit !== "c" ? "#fff" : T.ink, border: `1px solid ${w.unit !== "c" ? T.brand : T.line}` }}>Fahrenheit</button>
          <button onClick={() => setUnit("c")} className="tapfade flex-1 py-3 rounded-xl font-semibold"
            style={{ background: w.unit === "c" ? T.brand : T.panelAlt, color: w.unit === "c" ? "#fff" : T.ink, border: `1px solid ${w.unit === "c" ? T.brand : T.line}` }}>Celsius</button>
        </div>
      </Field>
      <p style={{ color: T.faint, fontSize: 13 }}>Weather comes from Open-Meteo — free, no account or API key. It refreshes every 30 minutes.</p>
    </div>
  );
}

function CheckInSettings({ data, update }) {
  const cfg = { ...DEFAULT_CHECKIN, ...(data.checkin || {}) };
  const set = (patch) => update((d) => { d.checkin = { ...DEFAULT_CHECKIN, ...(d.checkin || {}), ...patch }; return d; });

  // null = not tried yet, so the result line stays hidden until it means something
  const [soundTested, setSoundTested] = useState(null);
  const [relayTest, setRelayTest] = useState(null);
  const relay = { ...RELAY.DEFAULT_RELAY, ...(data.reminderRelay || {}) };
  const setRelay = (patch) => {
    setRelayTest(null);
    update((d) => {
      d.reminderRelay = { ...RELAY.DEFAULT_RELAY, ...(d.reminderRelay || {}), ...patch };
      return d;
    });
  };

  return (
    <div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: T.brandSoft }}>
        <p style={{ fontSize: 14, color: T.brandInk, lineHeight: 1.55 }}>
          At the chosen time this screen chimes and opens the check-in — no notification
          permission needed, since the app is already open. It walks through only what needs
          attention, and ends by setting tomorrow's time.
        </p>
      </div>

      <Field label="Follow whose workday">
        <PersonPicker people={data.people} value={cfg.anchorPersonId} onChange={(v) => set({ anchorPersonId: v })} />
        <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
          The time is taken from when their last work event ends. That only works if work is
          actually on a synced calendar — otherwise the usual time below is used.
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Minutes after work">
          <input type="number" min="0" max="240" step="5" value={cfg.offsetMinutes}
            onChange={(e) => set({ offsetMinutes: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })}
            className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
        </Field>
        <Field label="Usual time (fallback)">
          <input type="time" value={cfg.fallbackTime} onChange={(e) => set({ fallbackTime: e.target.value })}
            className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
        </Field>
      </div>

      <Field label="How to spot the workday">
        <div className="flex flex-col gap-2">
          <button onClick={() => set({ workCalendarId: "" })}
            className="tapfade text-left px-4 py-3 rounded-xl font-semibold"
            style={{ background: !cfg.workCalendarId ? T.brand : T.panelAlt, color: !cfg.workCalendarId ? "#fff" : T.ink,
              border: `1px solid ${!cfg.workCalendarId ? T.brand : T.line}` }}>
            Match the event title
          </button>
          {(data.calendars || []).map((c) => {
            const on = cfg.workCalendarId === c.id;
            return (
              <button key={c.id} onClick={() => set({ workCalendarId: c.id })}
                className="tapfade text-left px-4 py-3 rounded-xl font-semibold flex items-center gap-2"
                style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: on ? "#fff" : c.color }} />
                <span className="truncate">Anything on {c.name}</span>
              </button>
            );
          })}
        </div>
        {!cfg.workCalendarId && (
          <input value={cfg.workMatch} onChange={(e) => set({ workMatch: e.target.value })}
            placeholder="Word to look for, e.g. work or shift"
            className="w-full px-4 py-3 rounded-xl text-base outline-none mt-2" style={inputStyle} />
        )}
      </Field>

      <Field label="Chime">
        <div className="flex gap-2">
          {[[true, "On", Volume2], [false, "Silent", VolumeX]].map(([v, l, Icon]) => {
            const on = (cfg.soundOn !== false) === v;
            return (
              <button key={String(v)} onClick={() => set({ soundOn: v })}
                className="tapfade flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
                style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>
                <Icon size={16} />{l}
              </button>
            );
          })}
        </div>

        {/* Pressing this is not just a test: the tap itself is what permits the
            browser to make any sound for the rest of the session. After a tablet
            reboot, a reminder that never chimes is almost always this. */}
        <button onClick={() => { setSoundTested(playPattern("alert") && audioReady()); }}
          className="tapfade w-full mt-2 py-3 rounded-xl font-semibold flex items-center justify-center gap-2"
          style={{ background: T.panelAlt, color: T.ink, border: `1px solid ${T.line}` }}>
          <Volume2 size={15} /> Test the alert sound
        </button>
        {soundTested !== null && (
          <p style={{ color: soundTested ? T.sub : "#B4442A", fontSize: 12.5 }} className="mt-1.5">
            {soundTested
              ? "Sound is armed for this session. Every later chime will play."
              : "The browser is still refusing audio. Tap anywhere on the page, then try again."}
          </p>
        )}

        <p style={{ color: T.faint, fontSize: 12.5 }} className="mt-2">
          Browsers block audio until someone has tapped the page at least once, so the very
          first chime after a reboot may be silent. If the test above is silent too, it is the
          device rather than the app — check the volume, and on an iPad the physical mute
          switch, which Safari honours even for web audio.
        </p>
      </Field>

      {/* ---- phone reminders ---- */}
      <Field label="Phone reminders">
        <p style={{ color: T.faint, fontSize: 12.5 }} className="mb-2">
          A screen has to be awake and showing this page to chime, which is no good for
          anything critical. This sends reminders to a push service you run — an{" "}
          <strong>ntfy</strong> instance, typically — so they reach a phone that is in
          someone's pocket.
        </p>

        {/* Said plainly rather than buried: this is the one place where something
            leaves the house, and a household deserves to make that choice knowing
            what it costs. */}
        <div className="rounded-xl px-3 py-2.5 mb-2" style={{ background: "#fff6e5", border: "1px solid #f0d9a8" }}>
          <div style={{ color: "#6b4708", fontSize: 12.5, lineHeight: 1.5 }}>
            <strong>What this shares.</strong> Your browser sends the reminder's title
            directly to the address below. HouseHub's own server is not involved and
            still cannot read any of this. Whoever runs that push service <em>can</em>{" "}
            see the titles — so point it at one you host if that matters to you.
          </div>
        </div>

        <div className="flex gap-2 mb-2">
          {[[false, "Off"], [true, "On"]].map(([v, l]) => {
            const on = Boolean(relay.enabled) === v;
            return (
              <button key={String(v)} onClick={() => setRelay({ enabled: v })}
                className="tapfade flex-1 py-2.5 rounded-xl font-semibold"
                style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>
                {l}
              </button>
            );
          })}
        </div>

        {relay.enabled && (
          <>
            <input value={relay.endpoint || ""} onChange={(e) => setRelay({ endpoint: e.target.value.trim() })}
              placeholder="https://ntfy.example.com/your-topic"
              className="w-full px-4 py-3 rounded-xl text-base outline-none" style={inputStyle} />
            <div className="flex gap-2 mt-2">
              {[["default", "Normal"], ["urgent", "Urgent"]].map(([v, l]) => {
                const on = (relay.priority || "default") === v;
                return (
                  <button key={v} onClick={() => setRelay({ priority: v })}
                    className="tapfade flex-1 py-2.5 rounded-xl font-semibold"
                    style={{ background: on ? T.brand : T.panelAlt, color: on ? "#fff" : T.ink, border: `1px solid ${on ? T.brand : T.line}` }}>
                    {l}
                  </button>
                );
              })}
            </div>

            <button
              disabled={!relay.endpoint || relayTest === "sending"}
              onClick={async () => {
                setRelayTest("sending");
                const ok = await RELAY.sendReminder(
                  { ...relay, enabled: true },
                  { title: "HouseHub test reminder", overdue: 0, person: null });
                setRelayTest(ok ? "ok" : "failed");
              }}
              className="tapfade w-full mt-2 py-3 rounded-xl font-semibold"
              style={{ background: T.panelAlt, color: T.ink, border: `1px solid ${T.line}`, opacity: relay.endpoint ? 1 : 0.5 }}>
              {relayTest === "sending" ? "Sending…" : "Send a test reminder"}
            </button>

            {relayTest === "ok" && (
              <p style={{ color: T.sub, fontSize: 12.5 }} className="mt-1.5">
                Sent. If nothing arrived, check the topic name and that the app is subscribed.
              </p>
            )}
            {relayTest === "failed" && (
              <p style={{ color: "#B4442A", fontSize: 12.5 }} className="mt-1.5">
                That did not go through. The usual cause is the browser blocking it: whoever
                runs this server has to allow the host in <code>PUSH_HOSTS</code> before any
                page here may contact it. See docs/REMINDERS.md.
              </p>
            )}
          </>
        )}
      </Field>
    </div>
  );
}

function CalendarSettings({ data, update, syncCalendars }) {
  const cals = data.calendars || [];
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  // The server fetches and parses feeds, so the browser only hands it a URL or
  // the contents of an .ics file. That is what sidesteps the CORS problem.
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const text = String(reader.result || "");
      setBusy(true); setMsg(null);
      try {
        const added = await addCalendar({ icsText: text, name: file.name.replace(/\.ics$/i, "") });
        // The server owns the feed; its name and colour are household content
        // and belong in the encrypted document.
        update((d) => ({ ...d, calendars: [...(d.calendars || []), added] }));
        await syncCalendars();
        setMsg({ ok: true, t: "Calendar imported." });
      } catch (err) {
        setMsg({ ok: false, t: err.message || "That file isn't a calendar (.ics) export." });
      }
      setBusy(false);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const onSubscribe = async () => {
    if (!url.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const added = await addCalendar({ url: url.trim() });
      update((d) => ({ ...d, calendars: [...(d.calendars || []), added] }));
      await syncCalendars();
      setUrl("");
      setMsg({ ok: true, t: "Subscribed. The server re-checks this feed every 15 minutes." });
    } catch (err) {
      setMsg({ ok: false, t: `Couldn't load that feed — ${err.message}. Double-check the address, or import the .ics file instead.` });
    }
    setBusy(false);
  };

  const refresh = async (cal) => {
    setBusy(true); setMsg(null);
    try {
      await refreshCalendar(cal.id);
      await syncCalendars();
      setMsg({ ok: true, t: "Refreshed." });
    } catch (err) {
      setMsg({ ok: false, t: `Refresh failed — ${err.message}` });
    }
    setBusy(false);
  };

  const removeCal = async (id) => {
    setBusy(true);
    try {
      await deleteCalendar(id);
      update((d) => ({ ...d, calendars: (d.calendars || []).filter((c) => c.id !== id) }));
      await syncCalendars();
    } catch (err) {
      setMsg({ ok: false, t: err.message });
    }
    setBusy(false);
  };

  // colour + owner are plain document fields, so they save with everything else
  const setCalPerson = (id, personId) => update((d) => { d.calendars = d.calendars.map((c) => c.id === id ? { ...c, personId } : c); return d; });
  const setCalColor = (id, color) => update((d) => { d.calendars = d.calendars.map((c) => c.id === id ? { ...c, color } : c); return d; });

  return (
    <div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: T.brandSoft }}>
        <p style={{ fontSize: 14, color: T.brandInk, lineHeight: 1.5 }}>
          Bring in Google or Apple calendars as read-only feeds. The server fetches them,
          so subscribing by URL works without the browser blocking it — and it keeps them
          fresh on its own every 15 minutes.
        </p>
      </div>

      <div className="flex gap-3 mb-4">
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="tapfade flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl font-semibold"
          style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.ink, opacity: busy ? 0.6 : 1 }}>
          <Upload size={18} /> Import .ics file
        </button>
        <input ref={fileRef} type="file" accept=".ics,text/calendar" onChange={onFile} className="hidden" />
      </div>

      <div className="flex gap-2 mb-3">
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubscribe(); }}
          placeholder="Paste secret .ics address (webcal:// or https://)"
          className="flex-1 px-4 py-3.5 rounded-xl text-base outline-none" style={inputStyle} />
        <button onClick={onSubscribe} disabled={busy} className="tapfade flex items-center gap-2 px-5 rounded-xl font-semibold"
          style={{ background: T.brand, color: "#fff", opacity: busy ? 0.6 : 1 }}>
          {busy ? <RefreshCw size={18} className="animate-spin" /> : <Link2 size={18} />} Subscribe
        </button>
      </div>
      {msg && (
        <div className="rounded-xl px-4 py-3 mb-4"
          style={{ background: msg.ok ? T.brandSoft : "#E86A4C15", color: msg.ok ? T.brandInk : "#B4442A", fontSize: 14, lineHeight: 1.45 }}>
          {msg.t}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {cals.length === 0 && <p style={{ color: T.faint, fontSize: 14 }} className="text-center py-2">No calendars connected yet.</p>}
        {cals.map((cal) => (
          <div key={cal.id} className="rounded-2xl p-3.5" style={{ background: T.panelAlt, border: `1px solid ${cal.error ? "#E86A4C55" : T.line}` }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="w-4 h-4 rounded-full shrink-0" style={{ background: cal.color }} />
              <div className="flex-1 min-w-0">
                <div style={{ fontWeight: 700, fontSize: 16 }} className="truncate">{cal.name}</div>
                <div style={{ color: cal.error ? "#B4442A" : T.sub, fontSize: 13 }} className="truncate">
                  {cal.error
                    ? `Last sync failed — ${cal.error}`
                    : `${cal.eventCount ?? 0} upcoming · ${cal.source === "url" ? "subscribed" : "file import"}`}
                </div>
              </div>
              {cal.url && (
                <button onClick={() => refresh(cal)} disabled={busy} className="tapfade p-2" style={{ color: T.brand }}>
                  <RefreshCw size={18} />
                </button>
              )}
              <button onClick={() => removeCal(cal.id)} disabled={busy} className="tapfade p-2" style={{ color: T.faint }}>
                <Trash2 size={18} />
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span style={{ color: T.sub, fontSize: 13, fontWeight: 600 }}>Belongs to:</span>
              <button onClick={() => setCalPerson(cal.id, "")} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
                style={{ background: cal.personId === "" ? T.ink : T.panel, color: cal.personId === "" ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Everyone</button>
              {data.people.map((p) => (
                <button key={p.id} onClick={() => setCalPerson(cal.id, p.id)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5"
                  style={{ background: cal.personId === p.id ? p.color : T.panel, color: cal.personId === p.id ? "#fff" : T.ink, border: `1px solid ${cal.personId === p.id ? p.color : T.line}` }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: cal.personId === p.id ? "#fff" : p.color }} />{p.name}
                </button>
              ))}
              <div className="flex gap-1.5 ml-1">
                {CAL_COLORS.map((c) => (
                  <button key={c} onClick={() => setCalColor(cal.id, c)} className="tapfade w-5 h-5 rounded-full"
                    style={{ background: c, border: cal.color === c ? `2px solid ${T.ink}` : "2px solid transparent" }} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
