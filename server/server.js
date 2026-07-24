// server.js — Household Hub backend (read-only calendar sync).
//
// - Serves the built frontend from ./public
// - REST API for people, events, meals, chores, and calendar feeds
// - Fetches each calendar's .ics on a timer (server-side, no CORS/OAuth)
// - Exposes merged, recurrence-expanded calendar events (read-only)

import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { load, mutate, uid } from "./store.js";
import { parseICS, expandEvents, fetchICS, ymd } from "./ics.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 15);
const CAL_COLORS = ["#5D6FE0", "#8A5CC2", "#3D8FD1", "#C98A2B", "#D25B86"];

const app = express();
app.use(express.json({ limit: "5mb" }));

/* ---------- hub state (single hydrate call) ---------- */
app.get("/api/state", (req, res) => {
  const s = load();
  res.json({
    householdName: s.householdName,
    people: s.people,
    events: s.events,
    meals: s.meals,
    chores: s.chores,
    tasks: s.tasks,
    grocery: s.grocery,
    notes: s.notes,
    dates: s.dates,
    weather: s.weather,
    noteDisplay: s.noteDisplay,
    layoutMode: s.layoutMode,
    // never ship the raw feed text to the browser — only metadata.
    // count from the original object, since `meta` no longer has icsText.
    calendars: s.calendars.map((cal) => {
      const { icsText, ...meta } = cal;
      return { ...meta, eventCount: countCal(cal) };
    }),
  });
});

/* Save the whole document. The browser is the source of truth for everything
   except calendar feeds: it never receives icsText (that's a server-side cache),
   so we merge incoming calendar metadata onto the stored feeds instead of
   letting a save wipe them. Last write wins, which is fine at household scale. */
const CLIENT_OWNED = [
  "householdName", "people", "events", "meals", "chores", "tasks",
  "grocery", "notes", "dates", "weather", "noteDisplay", "layoutMode",
];
app.put("/api/state", (req, res) => {
  const incoming = req.body || {};
  mutate((s) => {
    for (const k of CLIENT_OWNED) {
      if (incoming[k] !== undefined) s[k] = incoming[k];
    }
    if (Array.isArray(incoming.calendars)) {
      const stored = new Map((s.calendars || []).map((c) => [c.id, c]));
      s.calendars = incoming.calendars.map((c) => {
        const { eventCount, ...meta } = c;          // eventCount is derived, don't persist
        const prev = stored.get(c.id);
        return prev ? { ...prev, ...meta, icsText: prev.icsText } : { ...meta, icsText: "" };
      });
    }
  });
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, at: Date.now() }));

app.put("/api/settings", (req, res) => {
  const { householdName } = req.body;
  mutate((s) => { if (typeof householdName === "string") s.householdName = householdName.trim() || "Our Home"; });
  res.json({ ok: true });
});

/* ---------- people ---------- */
app.post("/api/people", (req, res) => {
  const { name, color } = req.body;
  const id = uid();
  mutate((s) => s.people.push({ id, name: name || "New person", color: color || "#2E9187" }));
  res.json({ id });
});
app.put("/api/people/:id", (req, res) => {
  mutate((s) => { s.people = s.people.map((p) => p.id === req.params.id ? { ...p, ...req.body, id: p.id } : p); });
  res.json({ ok: true });
});
app.delete("/api/people/:id", (req, res) => {
  const id = req.params.id;
  mutate((s) => {
    s.people = s.people.filter((p) => p.id !== id);
    s.events = s.events.map((e) => e.personId === id ? { ...e, personId: "" } : e);
    s.chores = s.chores.map((c) => c.personId === id ? { ...c, personId: "" } : c);
    s.calendars = s.calendars.map((c) => c.personId === id ? { ...c, personId: "" } : c);
  });
  res.json({ ok: true });
});

/* ---------- events (hub-local, editable) ---------- */
app.post("/api/events", (req, res) => {
  const id = uid();
  const { title, date, time, personId } = req.body;
  mutate((s) => s.events.push({ id, title: title || "", date, time: time || "", personId: personId || "" }));
  res.json({ id });
});
app.put("/api/events/:id", (req, res) => {
  mutate((s) => { s.events = s.events.map((e) => e.id === req.params.id ? { ...e, ...req.body, id: e.id } : e); });
  res.json({ ok: true });
});
app.delete("/api/events/:id", (req, res) => {
  mutate((s) => { s.events = s.events.filter((e) => e.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- meals ---------- */
app.put("/api/meals/:date", (req, res) => {
  const date = req.params.date;
  const clean = {};
  const cooks = {};
  ["breakfast", "lunch", "dinner"].forEach((k) => {
    const v = (req.body[k] || "").trim();
    if (v) {
      clean[k] = v;
      const cook = req.body.cooks && req.body.cooks[k];
      if (cook) cooks[k] = cook;   // who's cooking this meal
    }
  });
  mutate((s) => {
    s.meals = { ...s.meals };
    if (Object.keys(clean).length) s.meals[date] = { ...clean, ...(Object.keys(cooks).length ? { cooks } : {}) };
    else delete s.meals[date];
  });
  res.json({ ok: true });
});

/* ---------- chores ---------- */
app.post("/api/chores", (req, res) => {
  const id = uid();
  const { title, personId, cadence } = req.body;
  mutate((s) => s.chores.push({
    id, title: title || "", personId: personId || "",
    cadence: cadence || { type: "daily" },
    createdOn: ymd(new Date()),   // bounds missed-chore carryover
    done: {},
  }));
  res.json({ id });
});
app.put("/api/chores/:id", (req, res) => {
  mutate((s) => { s.chores = s.chores.map((c) => c.id === req.params.id ? { ...c, ...req.body, id: c.id, done: c.done } : c); });
  res.json({ ok: true });
});
app.post("/api/chores/:id/toggle", (req, res) => {
  const date = req.query.date || ymd(new Date());
  mutate((s) => {
    s.chores = s.chores.map((c) => c.id === req.params.id
      ? { ...c, done: { ...c.done, [date]: !c.done[date] } } : c);
  });
  res.json({ ok: true });
});
app.delete("/api/chores/:id", (req, res) => {
  mutate((s) => { s.chores = s.chores.filter((c) => c.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- tasks (one-off, dated, editable) ---------- */
app.post("/api/tasks", (req, res) => {
  const id = uid();
  const { title, date, personId } = req.body;
  mutate((s) => s.tasks.push({ id, title: title || "", date: date || "", personId: personId || "", done: false }));
  res.json({ id });
});
app.put("/api/tasks/:id", (req, res) => {
  mutate((s) => { s.tasks = s.tasks.map((t) => t.id === req.params.id ? { ...t, ...req.body, id: t.id } : t); });
  res.json({ ok: true });
});
app.post("/api/tasks/:id/toggle", (req, res) => {
  mutate((s) => { s.tasks = s.tasks.map((t) => t.id === req.params.id ? { ...t, done: !t.done } : t); });
  res.json({ ok: true });
});
app.delete("/api/tasks/:id", (req, res) => {
  mutate((s) => { s.tasks = s.tasks.filter((t) => t.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- grocery list (shared across the household) ---------- */
app.post("/api/grocery", (req, res) => {
  const id = uid();
  const { title, aisle } = req.body;
  mutate((s) => s.grocery.push({ id, title: title || "", aisle: aisle || "Other", done: false }));
  res.json({ id });
});
app.put("/api/grocery/:id", (req, res) => {
  mutate((s) => { s.grocery = s.grocery.map((g) => g.id === req.params.id ? { ...g, ...req.body, id: g.id } : g); });
  res.json({ ok: true });
});
app.post("/api/grocery/:id/toggle", (req, res) => {
  mutate((s) => { s.grocery = s.grocery.map((g) => g.id === req.params.id ? { ...g, done: !g.done } : g); });
  res.json({ ok: true });
});
app.delete("/api/grocery/:id", (req, res) => {
  mutate((s) => { s.grocery = s.grocery.filter((g) => g.id !== req.params.id); });
  res.json({ ok: true });
});
// clear everything already picked up
app.post("/api/grocery/clear-done", (req, res) => {
  mutate((s) => { s.grocery = s.grocery.filter((g) => !g.done); });
  res.json({ ok: true });
});

/* ---------- sticky notes (shared board) ---------- */
app.post("/api/notes", (req, res) => {
  const id = uid();
  const { text, color, personId } = req.body;
  mutate((s) => s.notes.unshift({ id, text: text || "", color: color || "#FBEFA6", personId: personId || "", at: Date.now() }));
  res.json({ id });
});
app.put("/api/notes/:id", (req, res) => {
  mutate((s) => { s.notes = s.notes.map((n) => n.id === req.params.id ? { ...n, ...req.body, id: n.id } : n); });
  res.json({ ok: true });
});
app.delete("/api/notes/:id", (req, res) => {
  mutate((s) => { s.notes = s.notes.filter((n) => n.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- important dates / countdowns ---------- */
app.post("/api/dates", (req, res) => {
  const id = uid();
  const { title, date, annual } = req.body;
  mutate((s) => s.dates.push({ id, title: title || "", date: date || "", annual: !!annual }));
  res.json({ id });
});
app.put("/api/dates/:id", (req, res) => {
  mutate((s) => { s.dates = s.dates.map((d) => d.id === req.params.id ? { ...d, ...req.body, id: d.id } : d); });
  res.json({ ok: true });
});
app.delete("/api/dates/:id", (req, res) => {
  mutate((s) => { s.dates = s.dates.filter((d) => d.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- weather location ---------- */
app.put("/api/weather", (req, res) => {
  const { lat, lon, label, unit } = req.body;
  mutate((s) => {
    s.weather = {
      ...s.weather,
      ...(lat !== undefined ? { lat: Number(lat) } : {}),
      ...(lon !== undefined ? { lon: Number(lon) } : {}),
      ...(label ? { label } : {}),
      ...(unit ? { unit } : {}),
    };
  });
  res.json({ ok: true });
});

/* ---------- calendars (read-only feeds) ---------- */
app.post("/api/calendars", async (req, res) => {
  const { url, icsText, name, personId } = req.body;
  let text = icsText, source = "file";
  try {
    if (url) { text = await fetchICS(url); source = "url"; }
    if (!text || !/BEGIN:VCALENDAR/i.test(text)) throw new Error("Not a calendar feed");
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const parsed = parseICS(text);
  const id = uid();
  mutate((s) => {
    const color = CAL_COLORS[s.calendars.length % CAL_COLORS.length];
    s.calendars.push({
      id, name: name || parsed.calName || "Imported calendar", color,
      personId: personId || "", source, url: url || "", icsText: text,
      lastSync: Date.now(), error: null,
    });
  });
  res.json({ id });
});
app.put("/api/calendars/:id", (req, res) => {
  const { personId, color, name } = req.body;
  mutate((s) => {
    s.calendars = s.calendars.map((c) => c.id === req.params.id
      ? { ...c, ...(personId !== undefined ? { personId } : {}), ...(color ? { color } : {}), ...(name ? { name } : {}) } : c);
  });
  res.json({ ok: true });
});
app.post("/api/calendars/:id/refresh", async (req, res) => {
  const s = load();
  const cal = s.calendars.find((c) => c.id === req.params.id);
  if (!cal) return res.status(404).json({ error: "Not found" });
  if (!cal.url) return res.status(400).json({ error: "File imports can't be refreshed; re-import the file." });
  try {
    const text = await fetchICS(cal.url);
    mutate((st) => { st.calendars = st.calendars.map((c) => c.id === cal.id ? { ...c, icsText: text, lastSync: Date.now(), error: null } : c); });
    res.json({ ok: true });
  } catch (e) {
    mutate((st) => { st.calendars = st.calendars.map((c) => c.id === cal.id ? { ...c, error: e.message } : c); });
    res.status(502).json({ error: e.message });
  }
});
app.delete("/api/calendars/:id", (req, res) => {
  mutate((s) => { s.calendars = s.calendars.filter((c) => c.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- read-only merged calendar occurrences ---------- */
app.get("/api/calendar-events", (req, res) => {
  const now = new Date();
  const winStart = req.query.start ? new Date(req.query.start) : addDays(now, -31);
  const winEnd = req.query.end ? new Date(req.query.end) : addDays(now, 160);
  const s = load();
  const out = [];
  for (const cal of s.calendars) {
    if (!cal.icsText) continue;
    let parsed;
    try { parsed = parseICS(cal.icsText); } catch { continue; }
    for (const occ of expandEvents(parsed, winStart, winEnd)) {
      out.push({
        id: `${cal.id}-${occ.date}-${occ.time}-${occ.title}`.slice(0, 80),
        ...occ, source: "ics", calId: cal.id, calName: cal.name,
        color: cal.color, personId: cal.personId || "",
      });
    }
  }
  res.json(out);
});

/* ---------- serve the built frontend ---------- */
const PUBLIC = join(DIR, "public");
if (existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  app.get("*", (req, res) => res.sendFile(join(PUBLIC, "index.html")));
}

/* ---------- background feed refresh ---------- */
function countCal(cal) {
  if (!cal.icsText) return 0;
  try {
    const now = new Date();
    return expandEvents(parseICS(cal.icsText), addDays(now, -31), addDays(now, 160)).length;
  } catch { return 0; }
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

async function refreshAll() {
  const s = load();
  for (const cal of s.calendars) {
    if (!cal.url) continue;
    try {
      const text = await fetchICS(cal.url);
      mutate((st) => { st.calendars = st.calendars.map((c) => c.id === cal.id ? { ...c, icsText: text, lastSync: Date.now(), error: null } : c); });
    } catch (e) {
      mutate((st) => { st.calendars = st.calendars.map((c) => c.id === cal.id ? { ...c, error: e.message } : c); });
      console.warn(`Feed refresh failed for "${cal.name}": ${e.message}`);
    }
  }
}

load();
app.listen(PORT, () => {
  console.log(`Household Hub running on http://localhost:${PORT}`);
  refreshAll();
  setInterval(refreshAll, REFRESH_MINUTES * 60 * 1000);
});
