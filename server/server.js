// server.js — Household Hub backend (read-only calendar sync).
//
// - Serves the built frontend from ./public
// - REST API for people, events, meals, chores, and calendar feeds
// - Fetches each calendar's .ics on a timer (server-side, no CORS/OAuth)
// - Exposes merged, recurrence-expanded calendar events (read-only)

import express from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { load, mutate, uid } from "./store.js";
import { parseICS, expandEvents, fetchICS, ymd } from "./ics.js";
import * as ha from "./homeassistant.js";
import {
  PORT, HOST, REFRESH_MINUTES, PUBLIC_DIR, BODY_LIMIT, clientConfig,
} from "./config.js";
/* Mirrors the client: with a rotation, whose turn it is follows from who last
   actually completed it. Skips are not completions, so they don't pass a turn. */
/* Mirrors the client: turns advance only when someone actually completes the
   chore. An unfinished occurrence keeps belonging to whoever owed it, and skips
   don't advance anything. */
function choreAssigneeOf(chore, dateKey) {
  const rot = Array.isArray(chore.rotation) ? chore.rotation.filter(Boolean) : [];
  if (!rot.length) return chore.personId || "";
  const target = dateKey || ymd(new Date());
  const isDone = (v) => Boolean(v) && v !== "skipped" && typeof v === "string";

  const mark = chore.done?.[target];
  if (isDone(mark) && rot.includes(mark)) return mark;

  const prior = Object.entries(chore.done || {})
    .filter(([k, v]) => k < target && isDone(v))
    .sort((a, b) => b[0].localeCompare(a[0]));
  if (!prior.length) return rot[0];
  const base = rot.indexOf(prior[0][1]);
  return base === -1 ? rot[0] : rot[(base + 1) % rot.length];
}

const CAL_COLORS = ["#5D6FE0", "#8A5CC2", "#3D8FD1", "#C98A2B", "#D25B86"];

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));

/* ---------- client-visible configuration ---------- */
// The frontend reads this on boot instead of hardcoding endpoints or defaults.
app.get("/api/config", (req, res) => res.json(clientConfig()));
app.use(express.text({ type: ["text/plain"], limit: "64kb" }));

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
    projects: s.projects,
    grocery: s.grocery,
    groceryStores: s.groceryStores,
    grocerySort: s.grocerySort,
    groceryHistory: s.groceryHistory,
    notes: s.notes,
    dates: s.dates,
    agenda: s.agenda,
    agendaArchive: s.agendaArchive,
    status: s.status,
    agendaPrompts: s.agendaPrompts,
    dateJars: s.dateJars,
    dateIdeas: s.dateIdeas,
    weather: s.weather,
    noteDisplay: s.noteDisplay,
    layoutMode: s.layoutMode,
    showBreakdown: s.showBreakdown,
    apiToken: s.apiToken,
    homeEntities: s.homeEntities,
    homeDashboardUrl: s.homeDashboardUrl,
    checkin: s.checkin,
    homeAvailable: ha.isConfigured(),
    upNextSources: s.upNextSources,
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
  "projects",
  "grocery", "groceryStores", "grocerySort", "groceryHistory",
  "notes", "dates", "weather", "noteDisplay", "layoutMode",
  "showBreakdown", "upNextSources", "homeEntities", "homeDashboardUrl", "checkin",
  "agenda", "agendaArchive", "status", "agendaPrompts", "dateJars", "dateIdeas",
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
  for (const slot of ["breakfast", "lunch", "dinner"]) {
    const v = req.body[slot];
    if (Array.isArray(v)) {
      // new shape: a list of entries, each for a person (or shared)
      const rows = v
        .map((e) => ({
          id: e.id || uid(),
          title: String(e.title || "").trim(),
          personId: e.personId || "",
          togo: !!e.togo,
          time: e.time || "",
          cookId: e.cookId || "",
        }))
        .filter((e) => e.title);
      if (rows.length) clean[slot] = rows;
    } else if (typeof v === "string" && v.trim()) {
      // old shape still accepted, so existing scripts keep working
      clean[slot] = [{
        id: uid(), title: v.trim(), personId: "", togo: false,
        time: (req.body.times || {})[slot] || "",
        cookId: (req.body.cooks || {})[slot] || "",
      }];
    }
  }
  mutate((s) => {
    s.meals = { ...s.meals };
    if (Object.keys(clean).length) s.meals[date] = clean;
    else delete s.meals[date];
  });
  res.json({ ok: true });
});


/* ---------- chores ---------- */
app.post("/api/chores", (req, res) => {
  const id = uid();
  const { title, personId, cadence, rotation } = req.body;
  const rot = Array.isArray(rotation) ? rotation.filter(Boolean) : [];
  mutate((s) => s.chores.push({
    id, title: title || "", personId: personId || "",
    // two or more people means it rotates; whose turn it is is derived from
    // who last completed it rather than stored
    rotation: rot.length > 1 ? rot : [],
    cadence: cadence || { type: "daily" },
    createdOn: ymd(new Date()),
    done: {},
  }));
  res.json({ id });
});
app.put("/api/chores/:id", (req, res) => {
  mutate((s) => { s.chores = s.chores.map((c) => c.id === req.params.id ? { ...c, ...req.body, id: c.id, done: c.done } : c); });
  res.json({ ok: true });
});
/* done[date] holds a personId (who did it), true (unknown), or "skipped".
   Pass ?by=<personId> to credit someone specific, or ?skip=1 to clear the day
   without crediting anyone — a skip leaves the rotation where it is. */
app.post("/api/chores/:id/toggle", (req, res) => {
  const date = req.query.date || ymd(new Date());
  const by = req.query.by;
  const skip = req.query.skip === "1" || req.query.skip === "true";
  mutate((s) => {
    s.chores = s.chores.map((c) => {
      if (c.id !== req.params.id) return c;
      const done = { ...c.done };
      if (skip) done[date] = "skipped";
      else if (done[date]) delete done[date];
      else done[date] = by || choreAssigneeOf(c, date) || true;
      return { ...c, done };
    });
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
// doneAt records the day it was ticked so the Today view can list it under
// that day's "done" group. Pass ?date=YYYY-MM-DD to attribute it to another day.
app.post("/api/tasks/:id/toggle", (req, res) => {
  const date = req.query.date || ymd(new Date());
  mutate((s) => {
    s.tasks = s.tasks.map((t) => t.id === req.params.id
      ? (t.done ? { ...t, done: false, doneAt: "" } : { ...t, done: true, doneAt: date })
      : t);
  });
  res.json({ ok: true });
});
app.delete("/api/tasks/:id", (req, res) => {
  mutate((s) => { s.tasks = s.tasks.filter((t) => t.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- house projects ---------- */
const clampPct = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));

app.post("/api/projects", (req, res) => {
  const id = uid();
  const { title, notes, dates, personId, percent, stages } = req.body;
  const st = Array.isArray(stages)
    ? stages.map((x) => ({ id: x.id || uid(), title: String(x.title || "").trim(), date: x.date || "", done: !!x.done }))
    : [];
  mutate((s) => s.projects.push({
    id, title: (title || "").trim(), notes: (notes || "").trim(),
    // with stages, progress is derived rather than taken from the request
    percent: st.length ? Math.round((st.filter((x) => x.done).length / st.length) * 100) : clampPct(percent),
    dates: Array.isArray(dates) ? dates.filter(Boolean) : [],   // empty = backlog
    stages: st,
    personId: personId || "",
    createdOn: ymd(new Date()), doneOn: "",
  }));
  res.json({ id });
});
app.put("/api/projects/:id", (req, res) => {
  mutate((s) => {
    s.projects = s.projects.map((p) => {
      if (p.id !== req.params.id) return p;
      const next = { ...p, ...req.body, id: p.id };
      if (Array.isArray(req.body.stages)) {
        next.stages = req.body.stages.map((x) => ({ id: x.id || uid(), title: String(x.title || "").trim(), date: x.date || "", done: !!x.done }));
      }
      const st = Array.isArray(next.stages) ? next.stages : [];
      if (st.length) next.percent = Math.round((st.filter((x) => x.done).length / st.length) * 100);
      else if (req.body.percent !== undefined) next.percent = clampPct(req.body.percent);
      if (Array.isArray(req.body.dates)) next.dates = req.body.dates.filter(Boolean);
      // stamp the finish date the first time it reaches 100
      next.doneOn = next.percent >= 100 ? (p.doneOn || ymd(new Date())) : "";
      return next;
    });
  });
  res.json({ ok: true });
});
// Nudge progress along — what you'd call after working on it for an afternoon.
app.post("/api/projects/:id/progress", (req, res) => {
  const to = req.query.to !== undefined ? Number(req.query.to) : null;
  const by = req.query.by !== undefined ? Number(req.query.by) : 25;
  mutate((s) => {
    s.projects = s.projects.map((p) => {
      if (p.id !== req.params.id) return p;
      const percent = clampPct(to !== null ? to : p.percent + by);
      return { ...p, percent, doneOn: percent >= 100 ? (p.doneOn || ymd(new Date())) : "" };
    });
  });
  res.json({ ok: true });
});
// Tick one stage. Progress follows automatically.
app.post("/api/projects/:id/stage/:stageId/toggle", (req, res) => {
  mutate((s) => {
    s.projects = s.projects.map((p) => {
      if (p.id !== req.params.id) return p;
      const stages = (p.stages || []).map((x) => x.id === req.params.stageId ? { ...x, done: !x.done } : x);
      const percent = stages.length ? Math.round((stages.filter((x) => x.done).length / stages.length) * 100) : p.percent;
      return { ...p, stages, percent, doneOn: percent >= 100 ? (p.doneOn || ymd(new Date())) : "" };
    });
  });
  res.json({ ok: true });
});
app.delete("/api/projects/:id", (req, res) => {
  mutate((s) => { s.projects = s.projects.filter((p) => p.id !== req.params.id); });
  res.json({ ok: true });
});

/* ---------- grocery list (shared across the household) ---------- */
app.post("/api/grocery", (req, res) => {
  const id = uid();
  const { title, aisle, qty, store } = req.body;
  mutate((s) => s.grocery.push({
    id, title: title || "", aisle: aisle || "Other",
    store: store || "",                   // "" means any store
    qty: (qty || "").toString().trim(),   // free text: "2", "2 lbs", "a dozen"
    done: false,
  }));
  res.json({ id });
});
app.put("/api/grocery/:id", (req, res) => {
  mutate((s) => { s.grocery = s.grocery.map((g) => g.id === req.params.id ? { ...g, ...req.body, id: g.id } : g); });
  res.json({ ok: true });
});
/* Checking something off stamps it and records it in groceryHistory, so the
   purchase date outlives the item being cleared from the list. */
const singularWord = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) ? w.slice(0, -1) : w;
// must match the client's histKey exactly, or the two would build separate logs
function histKeyOf(title) {
  return String(title || "").toLowerCase().replace(/[^\w\s]/g, " ")
    .split(/\s+/).filter(Boolean).map(singularWord).join(" ");
}

function logPurchase(state, item, dateKey) {
  const key = histKeyOf(item.title);
  if (!key) return;
  const prev = state.groceryHistory[key] || { count: 0 };
  state.groceryHistory = {
    ...state.groceryHistory,
    [key]: {
      title: item.title.trim(),
      last: dateKey,
      count: (prev.count || 0) + 1,
      store: item.store || prev.store || "",
      aisle: item.aisle || prev.aisle || "Other",
    },
  };
}

app.post("/api/grocery/:id/toggle", (req, res) => {
  const date = req.query.date || ymd(new Date());
  mutate((s) => {
    s.grocery = s.grocery.map((g) => {
      if (g.id !== req.params.id) return g;
      if (g.done) return { ...g, done: false, boughtAt: "" };
      logPurchase(s, g, date);
      return { ...g, done: true, boughtAt: date };
    });
  });
  res.json({ ok: true });
});

// What we've bought before, most recent first.
app.get("/api/grocery/history", (req, res) => {
  const h = load().groceryHistory || {};
  res.json(Object.values(h).sort((a, b) => String(b.last).localeCompare(String(a.last))));
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

/* =====================================================================
   Voice / automation endpoints (Siri Shortcuts, curl, anything)

   These are the only routes that require a token, because they're the
   ones you'd expose beyond the local network. Pass it either as
   ?token=... or as an Authorization: Bearer header.

   They accept loosely-structured dictated text rather than strict JSON,
   since Siri hands over whatever you said as one string.
   ===================================================================== */

function requireToken(req, res, next) {
  const s = load();
  const header = req.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const given = req.query.token || bearer || req.body?.token || "";
  if (!s.apiToken || given !== s.apiToken) {
    return res.status(401).json({ error: "Bad or missing token" });
  }
  next();
}

// Aisle guessing from a small keyword list. Deliberately simple and
// predictable — anything it doesn't recognise lands in "Other", which you
// can re-file with the dropdown in the app.
const AISLE_HINTS = {
  Produce: ["apple", "banana", "lettuce", "spinach", "kale", "tomato", "onion", "potato", "carrot",
    "celery", "pepper", "cucumber", "broccoli", "garlic", "lemon", "lime", "berries", "strawberr", "eggplant",
    "blueberr", "grape", "avocado", "mushroom", "salad", "herb", "cilantro", "parsley", "basil", "fruit"],
  Meat: ["chicken", "beef", "pork", "turkey", "bacon", "sausage", "steak", "ground", "ham",
    "fish", "salmon", "shrimp", "tilapia", "deli", "hot dog", "brat"],
  Frozen: ["frozen", "ice cream", "popsicle", "pizza", "waffle", "tater tot"],
  Dairy: ["milk", "cheese", "butter", "yogurt", "yoghurt", "cream", "egg", "sour cream",
    "half and half", "cottage", "mozzarella", "cheddar", "parmesan"],
  Household: ["paper towel", "toilet paper", "detergent", "soap", "shampoo", "toothpaste", "trash bag",
    "sponge", "cleaner", "bleach", "dish", "laundry", "tissue", "napkin", "foil", "wrap", "battery",
    "light bulb", "filter"],
  Pantry: ["bread", "rice", "pasta", "noodle", "flour", "sugar", "oil", "vinegar", "salt", "pepper",
    "spice", "cereal", "oat", "coffee", "tea", "bean", "can", "soup", "sauce", "salsa", "peanut butter",
    "jelly", "jam", "honey", "cracker", "chip", "snack", "tortilla", "broth", "stock", "syrup"],
};

function guessAisle(title) {
  const t = title.toLowerCase();
  // Match on a word boundary rather than a bare substring, otherwise "toilet"
  // matches "oil" and paper goods end up in the pantry. Leading-boundary only,
  // so prefixes still work ("strawberr" catches strawberries).
  const hit = (word) => new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(t);
  for (const [aisle, words] of Object.entries(AISLE_HINTS)) {
    if (words.some(hit)) return aisle;
  }
  return "Other";
}

/* Pull a leading quantity off a dictated item.
   "two gallons of milk" -> { qty: "2 gallons", title: "milk" }
   "3 apples"            -> { qty: "3",         title: "apples" }
   "milk"                -> { qty: "",          title: "milk" }
   Quantity stays free text so "a dozen" and "2 lbs" both survive intact. */
const NUM_WORDS = {
  a: "1", an: "1", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  couple: "2", dozen: "12", half: "0.5",
};
const UNITS = [
  "lb", "lbs", "pound", "pounds", "oz", "ounce", "ounces", "gallon", "gallons",
  "quart", "quarts", "pint", "pints", "liter", "liters", "litre", "litres", "ml",
  "gram", "grams", "kg", "kilo", "kilos", "box", "boxes", "bag", "bags", "can",
  "cans", "bottle", "bottles", "jar", "jars", "pack", "packs", "package", "packages",
  "dozen", "bunch", "bunches", "head", "heads", "loaf", "loaves", "carton", "cartons",
  "case", "cases", "roll", "rolls", "stick", "sticks", "clove", "cloves", "slice", "slices",
];

function extractQty(raw) {
  let t = String(raw).trim();
  const words = t.split(/\s+/);
  if (words.length < 2) return { qty: "", title: t };

  const first = words[0].toLowerCase().replace(/[.,]$/, "");
  const isDigits = /^\d+(?:\.\d+)?$/.test(first);
  const isWord = Object.prototype.hasOwnProperty.call(NUM_WORDS, first);
  if (!isDigits && !isWord) return { qty: "", title: t };

  const second = (words[1] || "").toLowerCase().replace(/[.,]$/, "");
  // "2 percent milk" / "2% milk" is a product name, not a quantity
  if (second === "percent" || second === "%") return { qty: "", title: t };

  const unitIdx = UNITS.includes(second) ? 1 : -1;
  // a bare "a"/"an" only counts as a quantity when a unit follows it
  if (isWord && (first === "a" || first === "an") && unitIdx === -1) return { qty: "", title: t };

  const amount = isDigits ? first : NUM_WORDS[first];
  let rest, qty;
  if (unitIdx === 1) {
    qty = `${amount} ${second}`;
    rest = words.slice(2);
  } else {
    qty = amount;
    rest = words.slice(1);
  }
  if (rest[0] && rest[0].toLowerCase() === "of") rest = rest.slice(1);   // "2 lbs OF coffee"
  let title = rest.join(" ").trim();
  if (title) title = title.charAt(0).toUpperCase() + title.slice(1);
  return title ? { qty, title } : { qty: "", title: t };
}

/* Split one dictated phrase into separate items.
   "milk, eggs and bread" -> ["milk", "eggs", "bread"]              */
function splitDictation(text) {
  return String(text || "")
    // Siri often prefixes what you said with the trigger wording
    .replace(/^\s*(please\s+)?(add|put|append)\s+/i, "")
    .replace(/\s+to\s+(the\s+)?(grocery|shopping)\s+list\s*$/i, "")
    .split(/\s*(?:,|;|\band\b|\n|\+)\s*/i)
    .map((x) => x.trim().replace(/[.\s]+$/, ""))
    .filter((x) => x.length > 0)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1));
}

// Add one or more items to the grocery list from dictated text.
app.post("/api/voice/grocery", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || req.body.item || "");
  const items = splitDictation(raw);
  if (!items.length) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch an item." });

  const added = [];
  mutate((s) => {
    for (const phrase of items) {
      const { qty, title } = extractQty(phrase);
      if (!title) continue;
      // already waiting on the list? bump the quantity rather than duplicating
      const dupe = s.grocery.find((g) => !g.done && g.title.toLowerCase() === title.toLowerCase());
      if (dupe) {
        if (qty && !dupe.qty) dupe.qty = qty;
        continue;
      }
      const item = { id: uid(), title, qty, aisle: req.body.aisle || guessAisle(title), store: req.body.store || "", done: false };
      s.grocery.push(item);
      added.push(item);
    }
  });

  const skipped = items.length - added.length;
  const names = added.map((a) => (a.qty ? `${a.qty} ${a.title}` : a.title));
  const spoken = added.length === 0
    ? "That's already on the list."
    : `Added ${names.join(", ")}.${skipped ? ` ${skipped} already there.` : ""}`;
  res.json({ ok: true, added, skipped, spoken });
});

// Read the list back, so Siri can tell you what's on it.
app.get("/api/voice/grocery", requireToken, (req, res) => {
  const open = load().grocery.filter((g) => !g.done);
  const spoken = open.length === 0
    ? "The grocery list is empty."
    : `${open.length} item${open.length === 1 ? "" : "s"}: ${open.map((g) => (g.qty ? `${g.qty} ${g.title}` : g.title)).join(", ")}.`;
  res.json({
    count: open.length,
    items: open.map((g) => ({ title: g.title, qty: g.qty || "", aisle: g.aisle })),
    spoken,
  });
});

// Same idea for a one-off task and a sticky note.
/* Pull a spoken date off the end of a phrase.
   "renew the car tabs by friday" -> { date: <this coming Friday>, rest: "renew the car tabs" }
   Handles today/tonight/tomorrow, weekday names (with optional "next"),
   "in N days/weeks", and "on the 15th". Returns date "" when nothing matches. */
const WEEKDAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6 };

/* Strip the conversational lead-in. Order matters: "add a project to" has to be
   tried before "add", or the shorter match wins and leaves "a project to ..."
   sitting in the title. */
const LEAD_INS = [
  /^\s*add\s+a\s+(?:new\s+)?(?:project|task|reminder)\s+(?:to\s+|for\s+|called\s+)?/i,
  /^\s*add\s+(?:a\s+)?(?:project|task|reminder)\s+(?:to\s+|for\s+|called\s+)?/i,
  /^\s*(?:remind me to|remind me|remember to|remember)\s+/i,
  /^\s*(?:new\s+)?(?:project|task)\s+(?:to\s+)?/i,
  /^\s*(?:please\s+)?add\s+/i,
];
function stripLeadIn(raw) {
  let t = String(raw || "").trim();
  for (const re of LEAD_INS) {
    if (re.test(t)) { t = t.replace(re, "").trim(); break; }
  }
  return t;
}

function extractDate(raw) {
  let t = String(raw || "").trim();
  const today = new Date();
  const iso = (d) => ymd(d);
  const strip = (re) => { const m = t.match(re); if (m) t = t.replace(re, " ").replace(/\s+/g, " ").trim(); return m; };

  let m;
  if ((m = strip(/\b(?:by|on|for)?\s*tonight\b/i)) || (m = strip(/\b(?:by|on|for)?\s*today\b/i))) {
    return { date: iso(today), rest: t };
  }
  if ((m = strip(/\b(?:by|on|for)?\s*tomorrow\b/i))) {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return { date: iso(d), rest: t };
  }
  if ((m = strip(/\b(?:in)\s+(\d+)\s+(day|days|week|weeks)\b/i))) {
    const n = parseInt(m[1], 10) * (/week/i.test(m[2]) ? 7 : 1);
    const d = new Date(today); d.setDate(d.getDate() + n);
    return { date: iso(d), rest: t };
  }
  if ((m = strip(/\b(?:by|on|for)?\s*(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i))) {
    const want = WEEKDAYS[m[2].toLowerCase()];
    const d = new Date(today);
    let delta = (want - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;                 // "friday" said on a Friday means the next one
    // "next Tuesday" and "Tuesday" both mean the coming Tuesday — adding a week
    // here put it 7 days further out than anyone means.
    d.setDate(d.getDate() + delta);
    return { date: iso(d), rest: t };
  }
  if ((m = strip(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
    const day = parseInt(m[1], 10);
    const d = new Date(today.getFullYear(), today.getMonth(), day);
    if (d < today) d.setMonth(d.getMonth() + 1);   // already past: next month
    return { date: iso(d), rest: t };
  }
  return { date: "", rest: t };
}

/* Pull a named person out of "remind steven to ..." or "... for ryan". */
function extractPerson(raw, people) {
  let t = String(raw || "");
  for (const p of people || []) {
    const name = (p.name || "").trim();
    if (!name) continue;
    const re = new RegExp(`\\b(?:remind\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?:\\s+to)?`, "i");
    if (re.test(t)) {
      t = t.replace(re, " ").replace(/\s+/g, " ").trim();
      return { personId: p.id, rest: t };
    }
  }
  return { personId: "", rest: t };
}

app.post("/api/voice/task", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || "");
  const people = load().people || [];
  const withPerson = extractPerson(stripLeadIn(raw), people);
  const withDate = extractDate(withPerson.rest);
  let title = withDate.rest.replace(/^\s*(?:to|that)\s+/i, "").trim();
  if (!title) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch that." });
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const id = uid();
  const date = req.body.date || withDate.date || "";
  const personId = req.body.personId || withPerson.personId || "";
  mutate((s) => s.tasks.push({ id, title, date, personId, done: false }));

  const who = people.find((p) => p.id === personId);
  const when = date ? ` for ${new Date(date + "T12:00:00").toDateString().slice(0, 10)}` : "";
  res.json({
    ok: true, id, title, date, personId,
    spoken: `Added ${title}${when}${who ? ` for ${who.name}` : ""}.`,
  });
});

// Same idea for a house project. No date means it lands in the backlog.
app.post("/api/voice/project", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || "");
  const people = load().people || [];
  const withPerson = extractPerson(stripLeadIn(raw), people);
  const withDate = extractDate(withPerson.rest);
  let title = withDate.rest.replace(/^\s*(?:to|that)\s+/i, "").trim();
  if (!title) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch that." });
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const id = uid();
  const dates = withDate.date ? [withDate.date] : [];
  mutate((s) => s.projects.push({
    id, title, notes: "", percent: 0, dates,
    personId: withPerson.personId || "", createdOn: ymd(new Date()), doneOn: "",
  }));
  res.json({
    ok: true, id, title, dates,
    spoken: dates.length ? `Added project ${title}, planned for that day.` : `Added ${title} to the project backlog.`,
  });
});

/* Add something to raise tonight, by voice. Same shape as the other voice
   endpoints — free text in, a spoken confirmation out. */
app.post("/api/voice/agenda", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || "");
  const text = String(raw)
    .replace(/^\s*(add|bring up|remember to bring up|remember to mention|mention)\s+/i, "")
    .replace(/\s+to\s+(the\s+)?(agenda|tonights\s+agenda)\s*$/i, "")
    .trim();
  if (!text) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch that." });
  const title = text.charAt(0).toUpperCase() + text.slice(1);
  const people = load().people || [];
  const withPerson = extractPerson(title, people);
  const finalText = withPerson.rest || title;
  const id = uid();
  mutate((s) => s.agenda.push({
    id, text: finalText, personId: req.body.personId || withPerson.personId || "",
    category: req.body.category || "talk", at: Date.now(), resolved: false,
  }));
  res.json({ ok: true, id, spoken: `Added ${finalText} to tonight\u2019s agenda.` });
});

/* Add a date-night idea by voice — the whole point of the jar is catching these
   when they occur to you. Names the jar if you say one ("...to the fancy jar"),
   otherwise it lands in the first jar. */
app.post("/api/voice/date-idea", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || "");
  let text = String(raw)
    .replace(/^\s*(add|remember|put)\s+/i, "")
    .replace(/^\s*(a\s+)?date\s+(night\s+)?idea\s+(to\s+|for\s+)?/i, "")
    .trim();

  const jars = load().dateJars || [];
  let jarId = req.body.jarId || "";
  if (!jarId) {
    for (const j of jars) {
      const re = new RegExp("\\s*(to|in|into)?\\s*(the\\s+)?" + j.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(jar|box|list)?\\s*$", "i");
      if (re.test(text)) { jarId = j.id; text = text.replace(re, "").trim(); break; }
    }
  }
  if (!text) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch that." });

  const title = text.charAt(0).toUpperCase() + text.slice(1);
  const jar = jars.find((j) => j.id === jarId) || jars[0];
  const id = uid();
  mutate((s) => s.dateIdeas.push({
    id, text: title, jarId: (jar || {}).id || "cheap",
    personId: req.body.personId || "", notes: "",
    addedOn: ymd(new Date()), drawnAt: 0, doneCount: 0, lastDoneOn: "", retired: false,
  }));
  res.json({ ok: true, id, spoken: `Added ${title} to the ${(jar || {}).name || "date"} jar.` });
});

app.post("/api/voice/note", requireToken, (req, res) => {
  const raw = typeof req.body === "string" ? req.body : (req.body.text || "");
  const text = String(raw).trim();
  if (!text) return res.status(400).json({ error: "Nothing to add", spoken: "I didn't catch that." });
  mutate((s) => s.notes.unshift({
    id: uid(), text, color: req.body.color || "#FBEFA6",
    personId: req.body.personId || "", at: Date.now(),
  }));
  res.json({ ok: true, spoken: "Note added to the board." });
});

/* =====================================================================
   Home Assistant — read-only. The server holds the token; the browser
   only ever sees states and images. No service calls are exposed, so
   nothing here can change the state of the house.
   ===================================================================== */

app.get("/api/home/status", async (req, res) => {
  if (!ha.isConfigured()) {
    return res.json({ configured: false, reachable: false,
      hint: "Set HA_URL and HA_TOKEN in the server environment." });
  }
  try {
    await ha.ping();
    res.json({ configured: true, reachable: true });
  } catch (e) {
    res.json({ configured: true, reachable: false, error: e.message });
  }
});

// The entities chosen for the Home tab, in the chosen order.
app.get("/api/home/entities", async (req, res) => {
  if (!ha.isConfigured()) return res.json([]);
  try {
    const only = load().homeEntities || [];
    res.json(await ha.getStates({ only: only.length ? only : null }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Everything available, for the picker in Settings.
app.get("/api/home/all-entities", async (req, res) => {
  if (!ha.isConfigured()) return res.json([]);
  try {
    res.json(await ha.getStates());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Camera stills. Cache headers are deliberately no-store so the browser
// re-requests and the ?t= cache-buster in the UI behaves predictably.
app.get("/api/home/camera/:entityId.jpg", async (req, res) => {
  if (!ha.isConfigured()) return res.status(503).end();
  try {
    const { buf, type } = await ha.getSnapshot(req.params.entityId);
    res.set("Content-Type", type);
    res.set("Cache-Control", "no-store, max-age=0");
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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

/* ---------- date-night jars ---------- */
app.post("/api/date-ideas", (req, res) => {
  const id = uid();
  const { text, jarId, personId, notes } = req.body;
  const title = String(text || "").trim();
  if (!title) return res.status(400).json({ error: "text required" });
  mutate((s) => s.dateIdeas.push({
    id, text: title, jarId: jarId || (s.dateJars[0] || {}).id || "cheap",
    personId: personId || "", notes: (notes || "").trim(),
    addedOn: ymd(new Date()), drawnAt: 0, doneCount: 0, lastDoneOn: "", retired: false,
  }));
  res.json({ id });
});
app.put("/api/date-ideas/:id", (req, res) => {
  mutate((s) => { s.dateIdeas = s.dateIdeas.map((x) => x.id === req.params.id ? { ...x, ...req.body, id: x.id } : x); });
  res.json({ ok: true });
});
app.delete("/api/date-ideas/:id", (req, res) => {
  mutate((s) => { s.dateIdeas = s.dateIdeas.filter((x) => x.id !== req.params.id); });
  res.json({ ok: true });
});

/* Draw from a jar. Weighted so never-drawn ideas come first, then whatever was
   drawn longest ago — otherwise a small jar keeps handing back the same thing.
   Records drawnAt so the next draw deprioritises it. */
app.post("/api/date-ideas/draw", (req, res) => {
  const jarId = req.query.jar || req.body?.jarId || "";
  let picked = null;
  mutate((s) => {
    const pool = s.dateIdeas.filter((x) => !x.retired && (!jarId || x.jarId === jarId));
    if (!pool.length) return;

    // Never-drawn ideas come first. After that, rotate by how long ago each was
    // drawn — using a timestamp, not a date, so several draws in one evening
    // still cycle instead of landing on the same idea twice.
    const never = pool.filter((x) => !x.drawnAt);
    let bucket;
    if (never.length) {
      bucket = never;
    } else {
      const byAge = pool.slice().sort((a, b) => (Number(a.drawnAt) || 0) - (Number(b.drawnAt) || 0));
      // never immediately repeat the last thing drawn, as long as there's an alternative
      const candidates = byAge.length > 1 ? byAge.slice(0, byAge.length - 1) : byAge;
      bucket = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 2)));
    }
    picked = bucket[Math.floor(Math.random() * bucket.length)];
    s.dateIdeas = s.dateIdeas.map((x) => x.id === picked.id ? { ...x, drawnAt: Date.now() } : x);
  });
  if (!picked) return res.status(404).json({ error: "That jar is empty", spoken: "That jar is empty." });
  res.json({ idea: picked, spoken: `How about: ${picked.text}` });
});

// Mark one as actually done. Ideas stay in the jar by default, since a good date
// is worth repeating — pass retire=1 for genuinely one-off things.
app.post("/api/date-ideas/:id/done", (req, res) => {
  const retire = req.query.retire === "1" || req.query.retire === "true";
  mutate((s) => {
    s.dateIdeas = s.dateIdeas.map((x) => x.id === req.params.id
      ? { ...x, doneCount: (x.doneCount || 0) + 1, lastDoneOn: ymd(new Date()), retired: retire || !!x.retired }
      : x);
  });
  res.json({ ok: true });
});

/* ---------- nightly status check-in ---------- */
// PUT one person's ratings for a day. Scores are clamped to 1-5.
app.put("/api/status/:date", (req, res) => {
  const { personId, happiness, connection, intimacy } = req.body;
  if (!personId) return res.status(400).json({ error: "personId required" });
  const clamp = (n) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
  mutate((s) => {
    s.status = { ...s.status };
    const day = { ...(s.status[req.params.date] || {}) };
    day[personId] = {
      happiness: clamp(happiness), connection: clamp(connection),
      intimacy: clamp(intimacy), at: Date.now(),
    };
    s.status[req.params.date] = day;
  });
  res.json({ ok: true });
});
app.get("/api/status/:date", (req, res) => {
  res.json(load().status?.[req.params.date] || {});
});

/* ---------- evening agenda (things to discuss, not tasks) ---------- */
app.post("/api/agenda", (req, res) => {
  const id = uid();
  const { text, personId, category } = req.body;
  mutate((s) => s.agenda.push({
    id, text: (text || "").trim(), personId: personId || "",
    category: category || "talk", at: Date.now(), resolved: false,
  }));
  res.json({ id });
});
app.put("/api/agenda/:id", (req, res) => {
  mutate((s) => { s.agenda = s.agenda.map((a) => a.id === req.params.id ? { ...a, ...req.body, id: a.id } : a); });
  res.json({ ok: true });
});
app.post("/api/agenda/:id/toggle", (req, res) => {
  mutate((s) => { s.agenda = s.agenda.map((a) => a.id === req.params.id ? { ...a, resolved: !a.resolved } : a); });
  res.json({ ok: true });
});
app.delete("/api/agenda/:id", (req, res) => {
  mutate((s) => { s.agenda = s.agenda.filter((a) => a.id !== req.params.id); });
  res.json({ ok: true });
});
// File everything discussed into the archive, grouped by the date it happened.
app.post("/api/agenda/archive", (req, res) => {
  let moved = 0;
  mutate((s) => {
    const done = s.agenda.filter((a) => a.resolved);
    moved = done.length;
    if (!done.length) return;
    s.agendaArchive = [{ date: new Date().toISOString(), items: done }, ...(s.agendaArchive || [])].slice(0, 60);
    s.agenda = s.agenda.filter((a) => !a.resolved);
  });
  res.json({ ok: true, archived: moved });
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
const PUBLIC = PUBLIC_DIR;
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
app.listen(PORT, HOST, () => {
  console.log(`Household Hub running on http://${HOST}:${PORT}`);
  refreshAll();
  setInterval(refreshAll, REFRESH_MINUTES * 60 * 1000);
});
