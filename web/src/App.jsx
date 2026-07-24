import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import {
  Calendar as CalIcon, UtensilsCrossed, CheckCircle2, Circle,
  Home, Plus, X, ChevronLeft, ChevronRight, Settings, Trash2,
  Clock, Sun, Coffee, Moon, Sparkles, Users, Link2, Upload,
  RefreshCw, CalendarDays, Lock, Repeat, ChefHat, ShoppingCart,
  Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle,
  Thermometer, MapPin, StickyNote, PartyPopper, Hourglass,
} from "lucide-react";
import {
  loadState, saveState, loadCalendarEvents,
  addCalendar, refreshCalendar, deleteCalendar,
} from "./api.js";

/* ---------------------------------------------------------------
   Theme — warm "kitchen paper" palette, pine-green brand.
--------------------------------------------------------------- */
const T = {
  bg: "#F3EDE2", panel: "#FFFFFF", panelAlt: "#FBF7F0",
  ink: "#2C2536", sub: "#867E8F", faint: "#B7AEB9", line: "#E7DECF",
  brand: "#1E6E5C", brandInk: "#12463A", brandSoft: "#E2EEE9", gold: "#C98A2B",
};
const PERSON_COLORS = ["#E86A4C", "#E3A72C", "#2E9187", "#5D6FE0", "#D25B86", "#8A5CC2", "#4C9A54", "#3D8FD1"];
const CAL_COLORS = ["#5D6FE0", "#8A5CC2", "#3D8FD1", "#C98A2B", "#D25B86"];
// sticky-note paper colors, tuned to the warm palette
const NOTE_COLORS = ["#FBEFA6", "#D3E8C6", "#F7CFD8", "#CBE0F2", "#EFD9BE", "#E2D6EF"];
const BUILD = "1.0.0 · self-hosted";
const DISPLAY = "'Fraunces', Georgia, serif";
const BODY = "'Inter', system-ui, -apple-system, sans-serif";
const MEALS = [
  { key: "breakfast", label: "Breakfast", Icon: Coffee },
  { key: "lunch", label: "Lunch", Icon: Sun },
  { key: "dinner", label: "Dinner", Icon: Moon },
];

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
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${pad(m)}${ap}`;
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

/* A chore that was due earlier and never checked off carries forward.
   Walking back, any completed date settles everything before it, so
   checking a carried-over chore today clears the backlog. */
function choreMissedSince(chore, todayKey, lookback = 60) {
  const t = parseYMD(todayKey);
  const floor = chore.createdOn || todayKey;   // never look back past the chore's own start
  let missed = null;
  for (let i = 1; i <= lookback; i++) {
    const k = ymd(addDays(t, -i));
    if (k < floor) break;
    if (chore.done[k]) break;
    if (choreDueOn(chore, k)) missed = k;
  }
  return missed;
}

// dueToday = scheduled for today; missedSince = earliest unfinished past due date
function choreState(chore, todayKey) {
  const dueToday = choreDueOn(chore, todayKey);
  const missedSince = chore.done[todayKey] ? null : choreMissedSince(chore, todayKey);
  return { dueToday, missedSince, active: dueToday || !!missedSince };
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
const DEFAULT_WEATHER = { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "f" };

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
  const c = cfg || DEFAULT_WEATHER;
  const [w, setW] = useState({ status: "loading" });
  const key = `${c.lat},${c.lon},${c.unit}`;
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const unit = c.unit === "c" ? "celsius" : "fahrenheit";
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}`
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
  if (!x.meals) x.meals = {};
  if (!Array.isArray(x.chores)) x.chores = [];
  if (!Array.isArray(x.tasks)) x.tasks = [];
  if (!Array.isArray(x.grocery)) x.grocery = [];
  if (!Array.isArray(x.notes)) x.notes = [];
  if (!Array.isArray(x.dates)) x.dates = [];
  if (!Array.isArray(x.calendars)) x.calendars = [];
  if (!x.weather) x.weather = { ...DEFAULT_WEATHER };
  if (!x.noteDisplay) x.noteDisplay = "overlay";
  if (!x.householdName) x.householdName = "Our Home";
  return x;
}

function seed() {
  const wk = startOfWeek(new Date());
  const today = ymd(new Date());
  const day = (n) => ymd(addDays(wk, n));
  const ryan = uid(), steven = uid();
  return {
    householdName: "Ryan & Steven",
    people: [
      { id: ryan, name: "Ryan", color: "#2E9187" },
      { id: steven, name: "Steven", color: "#E86A4C" },
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
    // fridge-door sticky notes, shared
    notes: [],                 // { id, text, color, personId, at }
    // countdowns to anniversaries, trips, deadlines
    dates: [],                 // { id, title, date, annual }
    weather: { ...DEFAULT_WEATHER },
    noteDisplay: "overlay",   // overlay | row | off
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
  const [modal, setModal] = useState(null);
  const width = useWindowWidth();
  const weather = useWeather(data?.weather);

  const [importedEvents, setImportedEvents] = useState([]);
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

  const update = useCallback((fn) => {
    setData((d) => {
      const next = fn({ ...d });
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
  const allEvents = [...data.events, ...importedEvents];

  // filter: keep item if viewing everyone, or item belongs to person, or item is shared (no person)
  const inFilter = (personId) => filter === "all" || personId === filter || !personId;
  const colorFor = (ev) => personById(ev.personId)?.color || (ev.source === "ics" ? ev.color : null) || T.faint;

  const greeting = (() => { const h = now.getHours(); return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; })();
  const choresLeftToday = data.chores.filter((c) => inFilter(c.personId) && choreState(c, todayKey).active && !c.done[todayKey]).length;
  const taskDueToday = (t) => !t.done && t.date && t.date <= todayKey; // due today or overdue
  const todosLeftToday = choresLeftToday + data.tasks.filter((t) => inFilter(t.personId) && taskDueToday(t)).length;
  const groceryLeft = data.grocery.filter((g) => !g.done).length;
  const noteCount = data.notes.length;
  const overdueTotal = data.chores.filter((c) => inFilter(c.personId) && !c.done[todayKey] && choreState(c, todayKey).missedSince).length
    + data.tasks.filter((t) => inFilter(t.personId) && !t.done && t.date && t.date < todayKey).length;

  return (
    <MobileCtx.Provider value={isMobile}>
    <div style={{ fontFamily: BODY, background: T.bg, color: T.ink }}
      className="w-full h-screen flex flex-col overflow-hidden select-none">
      <style>{`
        *::-webkit-scrollbar{width:9px;height:9px}
        *::-webkit-scrollbar-thumb{background:${T.line};border-radius:9px}
        *::-webkit-scrollbar-track{background:transparent}
        .tapfade{transition:transform .12s ease, background .15s ease, opacity .15s ease}
        .tapfade:active{transform:scale(.97)}
        @media (prefers-reduced-motion: reduce){.tapfade{transition:none}}
      `}</style>

      <Header now={now} greeting={greeting} householdName={data.householdName} conn={conn}
        onSettings={() => setModal({ type: "settings" })} />

      <GlanceStrip data={data} allEvents={allEvents} now={now} personById={personById} weather={weather}
        inFilter={inFilter} todosLeft={todosLeftToday} overdueTotal={overdueTotal} onGoto={setTab} hidden={isMobile} />

      <TabBar tab={tab} setTab={setTab} todosLeft={todosLeftToday} groceryLeft={groceryLeft} noteCount={noteCount}
        people={people} filter={filter} setFilter={setFilter} />

      <main className="flex-1 overflow-y-auto px-3 md:px-5 pb-6" style={{ background: T.bg }}>
        {tab === "today" && (
          <TodayView data={data} allEvents={allEvents} now={now} personById={personById}
            todayKey={todayKey} filter={filter} inFilter={inFilter} colorFor={colorFor} update={update}
            taskDueToday={taskDueToday}
            openMeal={(k, slot) => setModal({ type: "meal", key: k, slot })}
            openEvent={() => setModal({ type: "event", payload: { date: todayKey } })}
            viewEvent={(ev) => setModal({ type: "viewEvent", payload: ev })}
            openNote={(n) => setModal({ type: "note", payload: n || {} })}
            gotoBoard={() => setTab("board")} />
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
          <MealsView weekDays={weekDays} data={data} todayKey={todayKey} personById={personById}
            shiftWeek={(n) => setWeekAnchor(ymd(addDays(weekStart, n * 7)))}
            resetWeek={() => setWeekAnchor(ymd(startOfWeek(new Date())))}
            openMeal={(k, slot) => setModal({ type: "meal", key: k, slot })} />
        )}
        {tab === "grocery" && (
          <GroceryView data={data} update={update} />
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
            openTask={(t) => setModal({ type: "task", payload: t || {} })} />
        )}
      </main>

      {modal?.type === "event" && <EventModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "viewEvent" && <ViewEventModal ev={modal.payload} personById={personById} close={() => setModal(null)} />}
      {modal?.type === "meal" && <MealModal mealKey={modal.key} slot={modal.slot} data={data} update={update} close={() => setModal(null)} />}
      {modal?.type === "chore" && <ChoreModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "task" && <TaskModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "note" && <NoteModal payload={modal.payload} people={people} update={update} close={() => setModal(null)} />}
      {modal?.type === "date" && <DateModal payload={modal.payload} update={update} close={() => setModal(null)} />}
      {modal?.type === "settings" && <SettingsModal data={data} update={update} syncCalendars={syncCalendars} close={() => setModal(null)} />}
    </div>
    </MobileCtx.Provider>
  );
}

/* ---------------- Header ---------------- */
function Header({ now, greeting, householdName, onSettings, conn }) {
  const isMobile = useMobile();
  const hr = now.getHours();
  const wash = hr < 12 ? "linear-gradient(120deg,#FDF6E8,#F3EDE2)" : hr < 17 ? "linear-gradient(120deg,#FBF1E2,#F3EDE2)" : "linear-gradient(120deg,#EFE7E5,#F3EDE2)";
  return (
    <header className="px-4 md:px-6 pt-4 md:pt-5 pb-3 md:pb-4 flex items-end justify-between gap-3" style={{ background: wash, borderBottom: `1px solid ${T.line}` }}>
      <div style={{ fontFamily: DISPLAY }} className="leading-none min-w-0">
        <div style={{ color: T.brand, fontSize: isMobile ? 11 : 15, letterSpacing: isMobile ? 1 : 2, fontWeight: 600 }} className="uppercase mb-1 truncate">
          {householdName} · {isMobile ? WD_SHORT[now.getDay()] : WD_LONG[now.getDay()]}
        </div>
        <div style={{ fontSize: isMobile ? 30 : 56, fontWeight: 600, color: T.ink }} className="leading-none">{MO_LONG[now.getMonth()]} {now.getDate()}</div>
      </div>
      <div className="flex items-center gap-3 md:gap-6 shrink-0">
        <div className="text-right">
          <div style={{ color: T.sub, fontSize: isMobile ? 11 : 14, fontWeight: 600 }} className="uppercase tracking-wide">{greeting}</div>
          <div style={{ fontFamily: DISPLAY, fontSize: isMobile ? 22 : 34, fontWeight: 500, color: T.ink }} className="leading-none tabular-nums">
            {fmtTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`)}
          </div>
        </div>
        {conn === "error" && (
          <span className="rounded-full px-3 py-1.5 flex items-center gap-1.5" title="Can't reach the server — changes are only on this device until it reconnects"
            style={{ background: "#E86A4C1F", color: "#B4442A", fontSize: 12.5, fontWeight: 800 }}>
            <Cloud size={14} /> Offline
          </span>
        )}
        <button onClick={onSettings} aria-label="Settings" className="tapfade rounded-full p-2.5 md:p-3" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>
          <Settings size={isMobile ? 20 : 22} />
        </button>
      </div>
    </header>
  );
}

/* ---------------- Glance strip ---------------- */
function GlanceStrip({ data, allEvents, now, personById, inFilter, todosLeft, overdueTotal, onGoto, hidden, weather }) {
  if (hidden) return null;
  const todayKey = ymd(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todays = allEvents.filter((e) => e.date === todayKey && inFilter(e.personId));
  const upNext = todays.filter((e) => e.time)
    .map((e) => ({ ...e, min: +e.time.split(":")[0] * 60 + +e.time.split(":")[1] }))
    .filter((e) => e.min >= nowMin - 30).sort((a, b) => a.min - b.min)[0]
    || todays.sort((a, b) => (a.time || "").localeCompare(b.time || ""))[0];
  const dinner = data.meals[todayKey]?.dinner;

  const Cell = ({ icon, label, value, accent, onClick }) => (
    <button onClick={onClick} className="tapfade flex-1 flex items-center gap-3 px-5 py-3 text-left rounded-2xl min-w-0" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
      <div className="rounded-xl p-2 shrink-0" style={{ background: (accent || T.brand) + "1A", color: accent || T.brand }}>{icon}</div>
      <div className="min-w-0">
        <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase">{label}</div>
        <div style={{ color: T.ink, fontSize: 17, fontWeight: 600 }} className="truncate">{value}</div>
      </div>
    </button>
  );
  return (
    <div className="px-6 py-3 flex gap-3" style={{ background: T.bg }}>
      <WeatherCell weather={weather} label={data.weather?.label} />
      <Cell icon={<Clock size={20} />} label="Up next"
        value={upNext ? `${upNext.time ? fmtTime(upNext.time) + " · " : ""}${upNext.title}` : "Nothing scheduled"}
        accent={upNext ? (personById(upNext.personId)?.color || (upNext.source === "ics" ? upNext.color : T.brand)) : T.faint}
        onClick={() => onGoto("calendar")} />
      <Cell icon={<UtensilsCrossed size={20} />} label="Tonight's dinner" value={dinner || "Not planned yet"}
        accent={dinner ? T.gold : T.faint} onClick={() => onGoto("meals")} />
      <Cell icon={<CheckCircle2 size={20} />} label={overdueTotal > 0 ? "To-dos · overdue" : "To-dos left today"}
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

/* ---------------- Countdown strip (Today screen) ---------------- */
function CountdownStrip({ dates, todayKey }) {
  const upcoming = (dates || [])
    .map((d) => {
      const when = nextOccurrence(d.date, d.annual, todayKey);
      return when ? { ...d, when, days: daysBetween(todayKey, when) } : null;
    })
    .filter((d) => d && d.days >= 0 && d.days <= 120)
    .sort((a, b) => a.days - b.days)
    .slice(0, 4);
  if (!upcoming.length) return null;
  return (
    <div className="flex gap-2 flex-wrap pt-2">
      {upcoming.map((d) => {
        const soon = d.days <= 7;
        return (
          <div key={d.id} className="flex items-center gap-2 rounded-full px-3.5 py-2"
            style={{ background: soon ? T.brandSoft : T.panel, border: `1px solid ${soon ? T.brand : T.line}` }}>
            {d.days === 0 ? <PartyPopper size={15} style={{ color: T.brand }} /> : <Hourglass size={14} style={{ color: soon ? T.brand : T.faint }} />}
            <span style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>{d.title}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: soon ? T.brandInk : T.sub }}>{countdownLabel(d.days)}</span>
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

function NoteOverlay({ notes, update, personById, openNote, onOverflow }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(null);
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
              transform: `rotate(${rotFor(n.id)}deg) translate(${dragging ? drag.dx : 0}px, ${dragging ? drag.dy : 0}px) scale(${dragging ? 1.04 : 1})`,
              transition: dragging ? "none" : "transform .15s ease",
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
function TabBar({ tab, setTab, todosLeft, groceryLeft, noteCount, people, filter, setFilter }) {
  const isMobile = useMobile();
  const tabs = [
    { id: "today", label: "Today", Icon: Home },
    { id: "calendar", label: "Calendar", Icon: CalIcon },
    { id: "meals", label: "Meals", Icon: UtensilsCrossed },
    { id: "chores", label: "To-Dos", Icon: CheckCircle2, badge: todosLeft },
    { id: "grocery", label: "Grocery", Icon: ShoppingCart, badge: groceryLeft },
    { id: "board", label: "Board", Icon: StickyNote, badge: noteCount },
  ];

  if (isMobile) {
    return (
      <nav className="flex flex-col gap-2 px-3 pt-2 pb-1" style={{ background: T.bg }}>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {tabs.map(({ id, label, Icon, badge }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className="tapfade shrink-0 flex flex-col items-center gap-1 py-2 px-3 rounded-xl font-semibold relative"
                style={{ background: active ? T.brand : T.panel, color: active ? "#fff" : T.sub, border: `1px solid ${active ? T.brand : T.line}`, minWidth: 64 }}>
                <Icon size={19} />
                <span style={{ fontSize: 11.5 }}>{label}</span>
                {badge > 0 && <span className="absolute top-1 right-1.5 text-xs font-bold rounded-full px-1.5" style={{ background: active ? "#ffffff30" : "#E86A4C", color: "#fff" }}>{badge}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto rounded-full p-1" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
          <FilterChip label="Everyone" active={filter === "all"} onClick={() => setFilter("all")} />
          {people.map((p) => (
            <FilterChip key={p.id} label={p.name} color={p.color} active={filter === p.id} onClick={() => setFilter(p.id)} />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav className="px-6 py-3 flex items-center justify-between gap-4" style={{ background: T.bg }}>
      <div className="flex gap-2">
        {tabs.map(({ id, label, Icon, badge }) => {
          const active = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)}
              className="tapfade flex items-center gap-2.5 px-5 py-3 rounded-full text-lg font-semibold relative"
              style={{ background: active ? T.brand : T.panel, color: active ? "#fff" : T.sub, border: `1px solid ${active ? T.brand : T.line}` }}>
              <Icon size={20} />{label}
              {badge > 0 && <span className="text-xs font-bold rounded-full px-2 py-0.5" style={{ background: active ? "#ffffff30" : "#E86A4C", color: "#fff" }}>{badge}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 rounded-full p-1" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <FilterChip label="Everyone" active={filter === "all"} onClick={() => setFilter("all")} />
        {people.map((p) => (
          <FilterChip key={p.id} label={p.name} color={p.color} active={filter === p.id} onClick={() => setFilter(p.id)} />
        ))}
      </div>
    </nav>
  );
}
function FilterChip({ label, color, active, onClick }) {
  return (
    <button onClick={onClick} className="tapfade flex items-center gap-2 px-4 py-2 rounded-full font-semibold whitespace-nowrap"
      style={{ background: active ? (color || T.ink) : "transparent", color: active ? "#fff" : T.sub }}>
      {color && <span className="w-2.5 h-2.5 rounded-full" style={{ background: active ? "#fff" : color }} />}
      {label}
    </button>
  );
}

/* ---------------- Today view ---------------- */
function TodayView({ data, allEvents, now, personById, todayKey, filter, inFilter, colorFor, update, taskDueToday, openMeal, openEvent, viewEvent, openNote, gotoBoard }) {
  const todaysEvents = allEvents.filter((e) => e.date === todayKey && inFilter(e.personId))
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const isMobile = useMobile();
  const meal = data.meals[todayKey] || {};
  // overlay is awkward on a phone, so it degrades to the row there
  const noteMode = data.noteDisplay || "overlay";
  const noteStyle = noteMode === "off" ? "off" : (noteMode === "overlay" && !isMobile) ? "overlay" : "row";
  const plannedMeals = MEALS.filter(({ key }) => meal[key]);
  const chores = data.chores.filter((c) => inFilter(c.personId) && choreState(c, todayKey).active);
  const dueTasks = data.tasks.filter((t) => inFilter(t.personId) && taskDueToday(t)).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const toggleChore = (id) => update((d) => { d.chores = d.chores.map((c) => c.id === id ? { ...c, done: { ...c.done, [todayKey]: !c.done[todayKey] } } : c); return d; });
  const toggleTask = (id) => update((d) => { d.tasks = d.tasks.map((t) => t.id === id ? { ...t, done: !t.done } : t); return d; });

  // Overdue = a chore whose scheduled day has passed unchecked, or a task past its date.
  // These get pulled to the top of the card and flagged in red.
  const isChoreLate = (c) => !c.done[todayKey] && !!choreState(c, todayKey).missedSince;
  const restChores = chores.filter((c) => !isChoreLate(c));
  const restTasks = dueTasks.filter((t) => !(t.date && t.date < todayKey));
  const overdueItems = [
    ...chores.filter(isChoreLate).map((c) => ({
      key: "c" + c.id, title: c.title, person: personById(c.personId),
      lateDays: daysBetween(choreState(c, todayKey).missedSince, todayKey),
      toggle: () => toggleChore(c.id),
    })),
    ...dueTasks.filter((t) => t.date && t.date < todayKey).map((t) => ({
      key: "t" + t.id, title: t.title, person: personById(t.personId),
      lateDays: daysBetween(t.date, todayKey),
      toggle: () => toggleTask(t.id),
    })),
  ].sort((a, b) => b.lateDays - a.lateDays);   // most overdue first
  const overdueCount = overdueItems.length;
  const viewingName = filter === "all" ? "Everyone" : personById(filter)?.name;

  return (
    <div className={`relative ${isMobile ? "pt-1" : "pt-1 h-full flex flex-col"}`}>
      {filter === "all" && <PersonBreakdown people={data.people} allEvents={allEvents} chores={data.chores} tasks={data.tasks} taskDueToday={taskDueToday} todayKey={todayKey} />}
      <CountdownStrip dates={data.dates} todayKey={todayKey} />
      {noteStyle === "row" && <NoteRow notes={data.notes} personById={personById} openNote={openNote} onOverflow={gotoBoard} />}
      <div className={`grid gap-4 md:gap-5 pt-3 ${isMobile ? "" : "flex-1 min-h-0"}`}
        style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))" }}>
        <Card grow={!isMobile} title={`${viewingName}'s schedule`} Icon={CalIcon} action={<AddBtn onClick={openEvent} />}>
          {todaysEvents.length === 0 ? <Empty text="No plans today. Tap + to add one." /> : (
            <div className="flex flex-col gap-2.5">
              {todaysEvents.map((e) => {
                const p = personById(e.personId);
                return (
                  <button key={e.id} onClick={() => e.source === "ics" ? viewEvent(e) : null}
                    className="tapfade flex items-center gap-3 rounded-xl px-3 py-3 text-left w-full"
                    style={{ background: T.panelAlt, borderLeft: `4px solid ${colorFor(e)}` }}>
                    <div style={{ color: T.ink, fontWeight: 700, fontSize: 15 }} className="tabular-nums w-16 shrink-0">{e.time ? fmtTime(e.time) : "All day"}</div>
                    <div className="min-w-0 flex-1">
                      <div style={{ fontWeight: 600, fontSize: 16 }} className="truncate flex items-center gap-1.5">
                        {e.title}{e.source === "ics" && <Lock size={12} style={{ color: T.faint }} />}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: colorFor(e) }}>{p ? p.name : e.source === "ics" ? e.calName : "Everyone"}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card grow={!isMobile} title="Today's meals" Icon={UtensilsCrossed} action={<AddBtn onClick={() => openMeal(todayKey, "dinner")} />}>
          {plannedMeals.length === 0 ? <Empty text="Nothing planned. Tap + to add a meal." /> : (
            <div className="flex flex-col gap-2.5">
              {plannedMeals.map(({ key, label, Icon }) => {
                const cook = personById(meal.cooks?.[key]);
                return (
                  <button key={key} onClick={() => openMeal(todayKey, key)} className="tapfade flex items-center gap-3 rounded-xl px-3 py-3 text-left" style={{ background: T.panelAlt }}>
                    <div className="rounded-lg p-2" style={{ background: T.gold + "1A", color: T.gold }}><Icon size={18} /></div>
                    <div className="min-w-0 flex-1">
                      <div style={{ color: T.sub, fontSize: 11.5, fontWeight: 700, letterSpacing: 1 }} className="uppercase">{label}</div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: T.ink }} className="truncate">{meal[key]}</div>
                      {cook && <div style={{ color: cook.color, fontSize: 12.5, fontWeight: 600 }} className="flex items-center gap-1"><ChefHat size={12} />{cook.name} cooks</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card grow={!isMobile} title={filter === "all" ? "To-dos today" : `${viewingName}'s to-dos`} Icon={CheckCircle2}
          action={overdueCount > 0 ? (
            <span className="rounded-full px-2.5 py-1 shrink-0" style={{ background: "#E86A4C", color: "#fff", fontSize: 12, fontWeight: 800 }}>
              {overdueCount} overdue
            </span>
          ) : null}>
          {chores.length === 0 && dueTasks.length === 0 ? <Empty text="Nothing to do here." /> : (
            <div className="flex flex-col gap-1">
              {/* overdue first, visibly flagged */}
              {overdueItems.length > 0 && (
                <>
                  <div style={{ color: "#E86A4C", fontSize: 11, fontWeight: 800, letterSpacing: 1 }} className="uppercase mb-1">Overdue</div>
                  {overdueItems.map((it) => (
                    <button key={it.key} onClick={it.toggle}
                      className="tapfade flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left"
                      style={{ background: "#E86A4C12", borderLeft: "3px solid #E86A4C" }}>
                      <Circle size={27} style={{ color: "#E86A4C" }} className="shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 16, fontWeight: 700 }} className="truncate">{it.title}</div>
                        <div style={{ color: "#C2542F", fontSize: 12, fontWeight: 700 }}>{lateLabel(it.lateDays)}</div>
                      </div>
                      {it.person && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: it.person.color }} />}
                    </button>
                  ))}
                  {(restChores.length > 0 || restTasks.length > 0) && <div className="my-1.5" style={{ borderTop: `1px dashed ${T.line}` }} />}
                </>
              )}

              {restChores.map((c) => {
                const p = personById(c.personId); const isDone = !!c.done[todayKey];
                return (
                  <button key={c.id} onClick={() => toggleChore(c.id)} className="tapfade flex items-center gap-3 rounded-xl px-2 py-2.5 text-left" style={{ opacity: isDone ? 0.55 : 1 }}>
                    {isDone ? <CheckCircle2 size={27} style={{ color: T.brand }} className="shrink-0" /> : <Circle size={27} style={{ color: T.faint }} className="shrink-0" />}
                    <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, fontWeight: 600, textDecoration: isDone ? "line-through" : "none" }}>{c.title}</span>
                    {p && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />}
                  </button>
                );
              })}
              {restChores.length > 0 && restTasks.length > 0 && <div className="my-1" style={{ borderTop: `1px dashed ${T.line}` }} />}
              {restTasks.map((t) => {
                const p = personById(t.personId);
                return (
                  <button key={t.id} onClick={() => toggleTask(t.id)} className="tapfade flex items-center gap-3 rounded-xl px-2 py-2.5 text-left">
                    <Circle size={27} style={{ color: T.faint }} className="shrink-0" />
                    <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, fontWeight: 600 }}>{t.title}</span>
                    <span className="text-xs font-bold rounded-full px-2 py-0.5 shrink-0" style={{ background: T.gold + "1F", color: T.gold }}>Today</span>
                    {p && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />}
                  </button>
                );
              })}
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
    <div className="flex flex-wrap gap-2 md:gap-3 pt-2">
      {people.map((p) => {
        const evs = allEvents.filter((e) => e.date === todayKey && e.personId === p.id).length;
        const left = chores.filter((c) => c.personId === p.id && choreState(c, todayKey).active && !c.done[todayKey]).length
          + tasks.filter((t) => t.personId === p.id && taskDueToday(t)).length;
        const late = chores.filter((c) => c.personId === p.id && !c.done[todayKey] && choreState(c, todayKey).missedSince).length
          + tasks.filter((t) => t.personId === p.id && !t.done && t.date && t.date < todayKey).length;
        return (
          <div key={p.id} className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ background: T.panel, border: `1px solid ${late > 0 ? "#E86A4C66" : T.line}`, flex: "1 1 45%" }}>
            <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0" style={{ background: p.color + "22", color: p.color }}>{p.name[0]}</div>
            <div className="min-w-0">
              <div style={{ fontWeight: 700, fontSize: 16, color: p.color }} className="truncate">{p.name}</div>
              <div style={{ color: T.sub, fontSize: 13, fontWeight: 500 }}>
                {evs} event{evs !== 1 ? "s" : ""} · {left} to-do{left !== 1 ? "s" : ""} left
                {late > 0 && <span style={{ color: "#E86A4C", fontWeight: 800 }}> · {late} overdue</span>}
              </div>
            </div>
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
                        <span style={{ color: T.sub, fontSize: 13, fontWeight: 700 }} className="tabular-nums w-16 shrink-0">{e.time ? fmtTime(e.time) : "All day"}</span>
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
                    {e.time && <div style={{ color: T.sub, fontSize: 12, fontWeight: 700 }} className="tabular-nums">{fmtTime(e.time)}</div>}
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
function MealsView({ weekDays, data, todayKey, shiftWeek, resetWeek, openMeal, personById }) {
  const isMobile = useMobile();
  const label = `${MO_LONG[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${weekDays[6].getDate()}`;

  if (isMobile) {
    return (
      <div className="pt-1">
        <WeekNav label={label} shiftWeek={shiftWeek} resetWeek={resetWeek} />
        <div className="flex flex-col gap-2.5">
          {weekDays.map((d) => {
            const k = ymd(d); const isToday = k === todayKey; const m = data.meals[k] || {};
            return (
              <div key={k} className="rounded-2xl overflow-hidden" style={{ background: T.panel, border: `1px solid ${isToday ? T.brand : T.line}` }}>
                <div className="flex items-baseline gap-2 px-4 py-2.5" style={{ background: isToday ? T.brandSoft : T.panelAlt }}>
                  <span style={{ color: isToday ? T.brand : T.sub, fontSize: 13, fontWeight: 700 }} className="uppercase">{WD_SHORT[d.getDay()]}</span>
                  <span style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600, color: isToday ? T.brand : T.ink }}>{MO_LONG[d.getMonth()].slice(0, 3)} {d.getDate()}</span>
                </div>
                <div className="flex flex-col">
                  {MEALS.map(({ key, label: ml, Icon }) => {
                    const cook = personById(m.cooks?.[key]);
                    return (
                      <button key={key} onClick={() => openMeal(k, key)} className="tapfade flex items-center gap-3 px-4 py-3 text-left" style={{ borderTop: `1px solid ${T.line}` }}>
                        <Icon size={17} style={{ color: T.gold }} className="shrink-0" />
                        <span style={{ color: T.sub, fontSize: 12, fontWeight: 700 }} className="uppercase w-20 shrink-0">{ml}</span>
                        <span style={{ fontSize: 15, fontWeight: 500, color: m[key] ? T.ink : T.faint }} className="flex-1 min-w-0 truncate">{m[key] || "Tap to plan"}</span>
                        {cook && <span className="rounded-full px-2 py-0.5 text-xs font-semibold shrink-0 flex items-center gap-1" style={{ background: cook.color + "1F", color: cook.color }}><ChefHat size={11} />{cook.name}</span>}
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
        <div className="grid" style={{ gridTemplateColumns: "120px repeat(7,1fr)", background: T.panelAlt }}>
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
          <div key={key} className="grid" style={{ gridTemplateColumns: "120px repeat(7,1fr)", background: T.panel }}>
            <div className="px-3 py-4 flex items-center gap-2" style={{ borderTop: `1px solid ${T.line}` }}>
              <Icon size={17} style={{ color: T.gold }} /><span style={{ fontWeight: 700, fontSize: 14 }}>{ml}</span>
            </div>
            {weekDays.map((d) => {
              const k = ymd(d); const dayMeals = data.meals[k] || {}; const val = dayMeals[key];
              const cook = personById(dayMeals.cooks?.[key]);
              return (
                <button key={k} onClick={() => openMeal(k, key)} className="tapfade px-2.5 py-4 text-left min-h-[64px] flex flex-col gap-1" style={{ borderTop: `1px solid ${T.line}`, borderLeft: `1px solid ${T.line}` }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: val ? T.ink : T.faint }}>{val || "+"}</span>
                  {cook && <span className="rounded-full px-2 py-0.5 text-xs font-semibold self-start flex items-center gap-1" style={{ background: cook.color + "1F", color: cook.color }}><ChefHat size={10} />{cook.name}</span>}
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
function ToDosView({ data, personById, todayKey, inFilter, update, openChore, openTask }) {
  const isMobile = useMobile();
  const allChores = data.chores.filter((c) => inFilter(c.personId));
  const chores = allChores.filter((c) => choreState(c, todayKey).active);
  const otherChores = allChores.filter((c) => !choreState(c, todayKey).active);
  const done = chores.filter((c) => c.done[todayKey]).length;
  const toggleChore = (id) => update((d) => { d.chores = d.chores.map((c) => c.id === id ? { ...c, done: { ...c.done, [todayKey]: !c.done[todayKey] } } : c); return d; });
  const removeChore = (id) => update((d) => { d.chores = d.chores.filter((c) => c.id !== id); return d; });

  const tasks = data.tasks.filter((t) => inFilter(t.personId));
  const toggleTask = (id) => update((d) => { d.tasks = d.tasks.map((t) => t.id === id ? { ...t, done: !t.done } : t); return d; });
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
    <div className="pt-2 grid gap-5 md:gap-6 max-w-5xl mx-auto"
      style={{ gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))" }}>
      {/* Chores column */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 600 }}>Recurring chores</h2>
            <p style={{ color: T.sub, fontSize: 14 }}>{chores.length === 0 ? "None due today" : `${done} of ${chores.length} done today`}</p>
          </div>
          <button onClick={() => openChore(null)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold" style={{ background: T.brand, color: "#fff" }}><Plus size={18} /> Chore</button>
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
            const p = personById(c.personId); const isDone = !!c.done[todayKey];
            const st = choreState(c, todayKey);
            const missedD = st.missedSince ? parseYMD(st.missedSince) : null;
            return (
              <div key={c.id} className="flex items-center gap-3 rounded-2xl px-4 py-3.5" style={{ background: T.panel, border: `1px solid ${!isDone && st.missedSince ? "#E86A4C55" : T.line}`, opacity: isDone ? 0.6 : 1 }}>
                <button onClick={() => toggleChore(c.id)} className="tapfade shrink-0" style={{ color: isDone ? T.brand : T.faint }}>{isDone ? <CheckCircle2 size={30} /> : <Circle size={30} />}</button>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 17, fontWeight: 600, textDecoration: isDone ? "line-through" : "none" }} className="truncate">{c.title}</div>
                  {!isDone && missedD ? (
                    <div style={{ color: "#E86A4C", fontSize: 12.5, fontWeight: 600 }}>Missed since {WD_SHORT[missedD.getDay()]}, {MO_LONG[missedD.getMonth()].slice(0, 3)} {missedD.getDate()}</div>
                  ) : (
                    <div style={{ color: T.sub, fontSize: 12.5, fontWeight: 600 }} className="flex items-center gap-1"><Repeat size={11} />{cadenceLabel(c)}</div>
                  )}
                </div>
                {p && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: p.color }} />}
                <button onClick={() => openChore(c)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                <button onClick={() => removeChore(c.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
              </div>
            );
          })}
          {otherChores.length > 0 && (
            <>
              <div style={{ color: T.faint, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mt-2">Other days</div>
              {otherChores.map((c) => {
                const p = personById(c.personId);
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
                        {t.date && <div style={{ fontSize: 13, fontWeight: 600, color: overdue ? "#E86A4C" : T.sub }}>{dateLabel(t.date)}</div>}
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
  );
}

/* ---------------- Grocery list (shared, not filtered by person) ---------------- */
const AISLES = ["Produce", "Meat", "Dairy", "Frozen", "Pantry", "Household", "Other"];

function GroceryView({ data, update }) {
  const isMobile = useMobile();
  const [text, setText] = useState("");
  const [aisle, setAisle] = useState("Other");
  const items = data.grocery;
  const open = items.filter((g) => !g.done);
  const done = items.filter((g) => g.done);

  const add = () => {
    const t = text.trim();
    if (!t) return;
    update((d) => { d.grocery = [...d.grocery, { id: uid(), title: t, aisle, done: false }]; return d; });
    setText("");
  };
  const toggle = (id) => update((d) => { d.grocery = d.grocery.map((g) => g.id === id ? { ...g, done: !g.done } : g); return d; });
  const remove = (id) => update((d) => { d.grocery = d.grocery.filter((g) => g.id !== id); return d; });
  const clearDone = () => update((d) => { d.grocery = d.grocery.filter((g) => !g.done); return d; });
  const setItemAisle = (id, a) => update((d) => { d.grocery = d.grocery.map((g) => g.id === id ? { ...g, aisle: a } : g); return d; });

  // group open items by aisle, keeping AISLES order
  const grouped = AISLES.map((a) => ({ aisle: a, items: open.filter((g) => (g.aisle || "Other") === a) })).filter((g) => g.items.length);

  return (
    <div className="pt-2 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 600 }}>Grocery list</h2>
          <p style={{ color: T.sub, fontSize: 15 }}>
            {open.length === 0 ? "Nothing on the list" : `${open.length} item${open.length !== 1 ? "s" : ""} to pick up`}
            {done.length > 0 && ` · ${done.length} in the cart`}
          </p>
        </div>
        {done.length > 0 && (
          <button onClick={clearDone} className="tapfade px-4 py-2.5 rounded-full font-semibold" style={{ background: T.panel, border: `1px solid ${T.line}`, color: T.sub }}>
            Clear {done.length} picked up
          </button>
        )}
      </div>

      {/* quick add */}
      <div className="rounded-2xl p-3 mb-5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
        <div className="flex gap-2 mb-2.5">
          <input value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add an item — e.g. 2 lbs coffee"
            className="flex-1 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          <button onClick={add} className="tapfade px-5 rounded-xl font-semibold flex items-center gap-2" style={{ background: T.brand, color: "#fff" }}>
            <Plus size={20} />{!isMobile && "Add"}
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {AISLES.map((a) => (
            <button key={a} onClick={() => setAisle(a)} className="tapfade px-3 py-1.5 rounded-full text-sm font-semibold"
              style={{ background: aisle === a ? T.brand : T.panelAlt, color: aisle === a ? "#fff" : T.sub, border: `1px solid ${aisle === a ? T.brand : T.line}` }}>{a}</button>
          ))}
        </div>
      </div>

      {items.length === 0 && <Empty text="List is empty. Add something above." />}

      <div className="flex flex-col gap-4">
        {grouped.map(({ aisle: a, items: list }) => (
          <div key={a}>
            <div style={{ color: T.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }} className="uppercase mb-2">{a}</div>
            <div className="flex flex-col gap-2">
              {list.map((g) => (
                <div key={g.id} className="flex items-center gap-3 rounded-2xl px-4 py-3.5" style={{ background: T.panel, border: `1px solid ${T.line}` }}>
                  <button onClick={() => toggle(g.id)} className="tapfade shrink-0" style={{ color: T.faint }}><Circle size={30} /></button>
                  <span className="flex-1 min-w-0 truncate" style={{ fontSize: 18, fontWeight: 600 }}>{g.title}</span>
                  <select value={g.aisle || "Other"} onChange={(e) => setItemAisle(g.id, e.target.value)}
                    className="rounded-lg px-2 py-1.5 text-sm font-semibold outline-none shrink-0"
                    style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub }}>
                    {AISLES.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <button onClick={() => remove(g.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                </div>
              ))}
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
                  <span className="flex-1 min-w-0 truncate" style={{ fontSize: 16, fontWeight: 500, textDecoration: "line-through" }}>{g.title}</span>
                  <button onClick={() => remove(g.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Board: sticky notes + important dates ---------------- */
function BoardView({ data, update, personById, todayKey, openNote, openDate }) {
  const isMobile = useMobile();
  const notes = data.notes;
  const removeNote = (id) => update((d) => { d.notes = d.notes.filter((n) => n.id !== id); return d; });
  const removeDate = (id) => update((d) => { d.dates = d.dates.filter((x) => x.id !== id); return d; });

  const dates = (data.dates || [])
    .map((d) => {
      const when = nextOccurrence(d.date, d.annual, todayKey);
      return { ...d, when, days: when ? daysBetween(todayKey, when) : null };
    })
    .sort((a, b) => (a.days ?? 9e9) - (b.days ?? 9e9));

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
              const soon = d.days !== null && d.days <= 7;
              const w = d.when ? parseYMD(d.when) : null;
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-2xl px-4 py-3.5"
                  style={{ background: T.panel, border: `1px solid ${soon ? T.brand : T.line}` }}>
                  <div className="rounded-xl p-2.5 shrink-0" style={{ background: (soon ? T.brand : T.gold) + "1A", color: soon ? T.brand : T.gold }}>
                    {d.days === 0 ? <PartyPopper size={19} /> : <Hourglass size={19} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 17, fontWeight: 600 }} className="truncate flex items-center gap-1.5">
                      {d.title}{d.annual && <Repeat size={12} style={{ color: T.faint }} />}
                    </div>
                    {w && <div style={{ color: T.sub, fontSize: 13, fontWeight: 600 }}>{WD_SHORT[w.getDay()]}, {MO_LONG[w.getMonth()].slice(0, 3)} {w.getDate()}{d.annual ? ` ${w.getFullYear()}` : ""}</div>}
                  </div>
                  <span className="rounded-full px-3 py-1.5 text-sm font-bold shrink-0"
                    style={{ background: soon ? T.brandSoft : T.panelAlt, color: soon ? T.brandInk : T.sub }}>
                    {d.days === null ? "—" : d.days === 0 ? "Today" : `${d.days}d`}
                  </span>
                  <button onClick={() => openDate(d)} className="tapfade p-1.5 shrink-0" style={{ color: T.sub }}><Settings size={17} /></button>
                  <button onClick={() => removeDate(d.id)} className="tapfade p-1.5 shrink-0" style={{ color: T.faint }}><Trash2 size={17} /></button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Shared UI ---------------- */
function Card({ title, Icon, action, children, grow, fit }) {
  return (
    <section className={`rounded-2xl p-4 md:p-5 flex flex-col ${grow ? "flex-1 min-h-0" : fit ? "shrink-0" : ""}`} style={{ background: T.panel, border: `1px solid ${T.line}` }}>
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-2.5"><Icon size={20} style={{ color: T.brand }} /><h3 style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 600 }} className="truncate">{title}</h3></div>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6" style={{ background: "#2C253688" }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} className={`rounded-3xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} p-5 md:p-7 max-h-[90vh] overflow-y-auto`} style={{ background: T.panel, boxShadow: "0 24px 60px #2C253633" }}>
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
const SaveBar = ({ onSave, onDelete, saveLabel = "Save" }) => (
  <div className="flex items-center gap-3 mt-6">
    <button onClick={onSave} className="tapfade flex-1 py-4 rounded-2xl font-semibold text-lg" style={{ background: T.brand, color: "#fff" }}>{saveLabel}</button>
    {onDelete && <button onClick={onDelete} className="tapfade py-4 px-5 rounded-2xl font-semibold" style={{ background: "#E86A4C18", color: "#E86A4C" }}><Trash2 size={20} /></button>}
  </div>
);

function EventModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [date, setDate] = useState(payload.date || ymd(new Date()));
  const [time, setTime] = useState(payload.time || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const save = () => {
    if (!title.trim()) return;
    update((d) => {
      if (editing) d.events = d.events.map((e) => e.id === payload.id ? { ...e, title, date, time, personId } : e);
      else d.events = [...d.events, { id: uid(), title, date, time, personId }];
      return d;
    });
    close();
  };
  const del = () => { update((d) => { d.events = d.events.filter((e) => e.id !== payload.id); return d; }); close(); };
  return (
    <Overlay close={close}>
      <ModalHead title={editing ? "Edit event" : "New event"} close={close} />
      <Field label="What"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Soccer practice" className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
        <Field label="Time (optional)"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} /></Field>
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
        <InfoRow icon={<Clock size={18} />} text={ev.spanDays > 1 ? `${ev.time ? fmtTime(ev.time) + " start · " : ""}day ${ev.spanIndex + 1} of ${ev.spanDays}` : ev.time ? fmtTime(ev.time) : "All day"} />
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

function MealModal({ mealKey, slot, data, update, close }) {
  const meal = data.meals[mealKey] || {};
  const [values, setValues] = useState({ breakfast: meal.breakfast || "", lunch: meal.lunch || "", dinner: meal.dinner || "" });
  const [cooks, setCooks] = useState({ ...(meal.cooks || {}) });
  const d = parseYMD(mealKey);
  const save = () => {
    update((dd) => {
      const clean = {}; const cleanCooks = {};
      Object.entries(values).forEach(([k, v]) => {
        if (v.trim()) { clean[k] = v.trim(); if (cooks[k]) cleanCooks[k] = cooks[k]; }
      });
      dd.meals = { ...dd.meals };
      if (Object.keys(clean).length) dd.meals[mealKey] = { ...clean, ...(Object.keys(cleanCooks).length ? { cooks: cleanCooks } : {}) };
      else delete dd.meals[mealKey];
      return dd;
    });
    close();
  };
  return (
    <Overlay close={close}>
      <ModalHead title={`${WD_LONG[d.getDay()]}, ${MO_LONG[d.getMonth()]} ${d.getDate()}`} close={close} />
      {MEALS.map(({ key, label, Icon }) => (
        <div key={key} className="mb-5 pb-4" style={{ borderBottom: `1px solid ${T.line}` }}>
          <span style={{ color: T.sub, fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }} className="uppercase block mb-2">{label}</span>
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-lg p-2.5" style={{ background: T.gold + "1A", color: T.gold }}><Icon size={18} /></div>
            <input autoFocus={key === slot} value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} placeholder="What's cooking?" className="flex-1 px-4 py-3.5 rounded-xl text-lg outline-none" style={inputStyle} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ color: T.sub, fontSize: 13, fontWeight: 700 }} className="flex items-center gap-1.5"><ChefHat size={15} /> Who's cooking?</span>
            <button onClick={() => setCooks((c) => ({ ...c, [key]: "" }))} className="tapfade px-3 py-2 rounded-full text-sm font-semibold"
              style={{ background: !cooks[key] ? T.ink : T.panelAlt, color: !cooks[key] ? "#fff" : T.sub, border: `1px solid ${T.line}` }}>Not set</button>
            {data.people.map((p) => (
              <button key={p.id} onClick={() => setCooks((c) => ({ ...c, [key]: p.id }))} className="tapfade px-3.5 py-2 rounded-full text-sm font-semibold flex items-center gap-1.5"
                style={{ background: cooks[key] === p.id ? p.color : T.panelAlt, color: cooks[key] === p.id ? "#fff" : T.ink, border: `1px solid ${cooks[key] === p.id ? p.color : T.line}` }}>
                <span className="w-2 h-2 rounded-full" style={{ background: cooks[key] === p.id ? "#fff" : p.color }} />{p.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <SaveBar onSave={save} />
    </Overlay>
  );
}

function ChoreModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const [cad, setCad] = useState(payload.cadence || { type: "daily" });
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
    update((d) => {
      if (editing) d.chores = d.chores.map((c) => c.id === payload.id ? { ...c, title, personId, cadence } : c);
      else d.chores = [...d.chores, { id: uid(), title, personId, cadence, createdOn: ymd(new Date()), done: {} }];
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
      <Field label="Assigned to"><PersonPicker people={people} value={personId} onChange={setPersonId} /></Field>
      <SaveBar onSave={save} onDelete={editing ? del : null} />
    </Overlay>
  );
}

function TaskModal({ payload, people, update, close }) {
  const editing = !!payload.id;
  const [title, setTitle] = useState(payload.title || "");
  const [date, setDate] = useState(payload.date || "");
  const [personId, setPersonId] = useState(payload.personId || "");
  const save = () => {
    if (!title.trim()) return;
    update((d) => {
      if (editing) d.tasks = d.tasks.map((t) => t.id === payload.id ? { ...t, title, date, personId } : t);
      else d.tasks = [...d.tasks, { id: uid(), title, date, personId, done: false }];
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
function SettingsModal({ data, update, syncCalendars, close }) {
  const [name, setName] = useState(data.householdName || "Our Home");
  const [tab, setTab] = useState("people");
  const saveName = () => update((d) => { d.householdName = name.trim() || "Our Home"; return d; });
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
        {(data.notes || []).some((n) => typeof n.x === "number") && (
          <button onClick={() => update((d) => { d.notes = d.notes.map(({ x, y, ...rest }) => rest); return d; })}
            className="tapfade mt-3 w-full py-2.5 rounded-xl font-semibold" style={{ background: T.panelAlt, border: `1px solid ${T.line}`, color: T.sub }}>
            Tidy notes back into place
          </button>
        )}
      </Field>
      <div className="flex gap-2 mb-5">
        {[["people", "People", Users], ["calendars", "Calendar sync", Link2], ["weather", "Weather", Thermometer]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)} className="tapfade flex items-center gap-2 px-4 py-2.5 rounded-full font-semibold"
            style={{ background: tab === id ? T.brand : T.panelAlt, color: tab === id ? "#fff" : T.sub, border: `1px solid ${tab === id ? T.brand : T.line}` }}>
            <Icon size={17} />{label}
          </button>
        ))}
      </div>
      {tab === "people" ? <PeopleSettings data={data} update={update} />
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

function WeatherSettings({ data, update }) {
  const w = data.weather || DEFAULT_WEATHER;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState(null);
  const [err, setErr] = useState(null);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(null); setHits(null);
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=5`);
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
      d.weather = { ...(d.weather || DEFAULT_WEATHER), lat: h.latitude, lon: h.longitude, label: h.name };
      return d;
    });
    setHits(null); setQ("");
  };
  const setUnit = (unit) => update((d) => { d.weather = { ...(d.weather || DEFAULT_WEATHER), unit }; return d; });
  const setField = (k, v) => update((d) => { d.weather = { ...(d.weather || DEFAULT_WEATHER), [k]: v }; return d; });

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
        await addCalendar({ icsText: text, name: file.name.replace(/\.ics$/i, "") });
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
      await addCalendar({ url: url.trim() });
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
