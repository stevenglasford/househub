// store.js — SQLite-backed datastore (better-sqlite3, WAL mode).
//
// Same interface as the original JSON-file version — load() returns the
// in-memory household document, mutate(fn) applies a change and persists —
// so server.js is unchanged. The difference is what "persist" means: every
// mutation is written to hub.db in one transaction instead of rewriting a
// JSON file.
//
// Layout: one table per collection, one row per entity. Each entity is
// stored whole in a `data` JSON column, so fields the client adds later
// survive without a schema migration; `pos` preserves array order (notes
// are newest-first, etc.). Calendar feed text is large and server-only, so
// it lives in its own column instead of inside the JSON.
//
// A full rewrite per mutation sounds heavy but isn't: household-scale data
// is a few hundred rows and better-sqlite3 clears + reinserts that in well
// under a millisecond. In exchange, the DB always mirrors the in-memory
// document exactly, no matter what shape a mutation takes.
//
// First boot against an empty DB imports an existing data.json (the old
// store) automatically, then renames it to data.json.imported.

import Database from "better-sqlite3";
import { readFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || join(DIR, "hub.db");
const LEGACY_JSON = process.env.DATA_FILE || join(DIR, "data.json");

const uid = () => Math.random().toString(36).slice(2, 9);

/* ---------- schema ---------- */

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

const LISTS = ["people", "events", "chores", "tasks", "grocery", "notes", "dates"];
// top-level keys that are NOT plain meta values (they get their own tables)
const NON_META = new Set([...LISTS, "meals", "calendars"]);

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  ${LISTS.map((t) => `
  CREATE TABLE IF NOT EXISTS ${t} (
    id   TEXT PRIMARY KEY,
    pos  INTEGER NOT NULL,
    data TEXT NOT NULL
  );`).join("")}
  CREATE TABLE IF NOT EXISTS meals (date TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calendars (
    id       TEXT PRIMARY KEY,
    pos      INTEGER NOT NULL,
    data     TEXT NOT NULL,
    ics_text TEXT NOT NULL DEFAULT ''
  );
`);

/* ---------- prepared statements ---------- */

const stmt = {
  metaAll: db.prepare("SELECT key, json FROM meta"),
  metaClear: db.prepare("DELETE FROM meta"),
  metaPut: db.prepare("INSERT OR REPLACE INTO meta (key, json) VALUES (?, ?)"),
  mealsAll: db.prepare("SELECT date, data FROM meals"),
  mealsClear: db.prepare("DELETE FROM meals"),
  mealsPut: db.prepare("INSERT OR REPLACE INTO meals (date, data) VALUES (?, ?)"),
  calsAll: db.prepare("SELECT data, ics_text FROM calendars ORDER BY pos"),
  calsClear: db.prepare("DELETE FROM calendars"),
  calsPut: db.prepare("INSERT OR REPLACE INTO calendars (id, pos, data, ics_text) VALUES (?, ?, ?, ?)"),
  list: {},
};
for (const t of LISTS) {
  stmt.list[t] = {
    all: db.prepare(`SELECT data FROM ${t} ORDER BY pos`),
    clear: db.prepare(`DELETE FROM ${t}`),
    put: db.prepare(`INSERT OR REPLACE INTO ${t} (id, pos, data) VALUES (?, ?, ?)`),
  };
}

/* ---------- read / write the whole document ---------- */

// Returns the document, or null if the DB has never been written to.
function readAll() {
  const metaRows = stmt.metaAll.all();
  if (metaRows.length === 0) return null; // fresh DB — meta always has rows after a persist
  const s = {};
  for (const { key, json } of metaRows) s[key] = JSON.parse(json);
  for (const t of LISTS) s[t] = stmt.list[t].all.all().map((r) => JSON.parse(r.data));
  s.meals = {};
  for (const r of stmt.mealsAll.all()) s.meals[r.date] = JSON.parse(r.data);
  s.calendars = stmt.calsAll.all().map((r) => ({ ...JSON.parse(r.data), icsText: r.ics_text }));
  return s;
}

const writeAll = db.transaction((s) => {
  stmt.metaClear.run();
  for (const [k, v] of Object.entries(s)) {
    if (!NON_META.has(k)) stmt.metaPut.run(k, JSON.stringify(v ?? null));
  }
  for (const t of LISTS) {
    stmt.list[t].clear.run();
    (s[t] || []).forEach((e, i) => stmt.list[t].put.run(String(e.id ?? uid()), i, JSON.stringify(e)));
  }
  stmt.mealsClear.run();
  for (const [date, m] of Object.entries(s.meals || {})) stmt.mealsPut.run(date, JSON.stringify(m));
  stmt.calsClear.run();
  (s.calendars || []).forEach((c, i) => {
    const { icsText, ...meta } = c;
    stmt.calsPut.run(String(c.id ?? uid()), i, JSON.stringify(meta), icsText || "");
  });
});

/* ---------- seed + defaults (unchanged from the JSON version) ---------- */

function seed() {
  const ryan = uid(), steven = uid();
  return {
    householdName: "Ryan & Steven",
    people: [
      { id: ryan, name: "Ryan", color: "#2E9187" },
      { id: steven, name: "Steven", color: "#E86A4C" },
    ],
    events: [],
    meals: {},
    chores: [
      { id: uid(), title: "Feed pets", personId: ryan, done: {} },
      { id: uid(), title: "Dishes", personId: steven, done: {} },
      { id: uid(), title: "Take out trash", personId: "", done: {} },
    ],
    tasks: [],
    grocery: [],
    notes: [],
    dates: [],
    weather: { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "f" },
    layoutMode: "auto",
    noteDisplay: "overlay",
    calendars: [],
  };
}

// Defaults for documents created by older versions of the app.
function normalize(s) {
  if (!Array.isArray(s.tasks)) s.tasks = [];
  if (!Array.isArray(s.grocery)) s.grocery = [];
  if (!Array.isArray(s.notes)) s.notes = [];
  if (!Array.isArray(s.dates)) s.dates = [];
  if (!s.weather) s.weather = { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "f" };
  if (!s.layoutMode) s.layoutMode = "auto";
  if (!s.noteDisplay) s.noteDisplay = "overlay";
  return s;
}

/* ---------- public interface (same as before) ---------- */

let state = null;

export function load() {
  if (state) return state;
  state = readAll();
  if (state) return normalize(state);

  // Empty DB. Import the legacy JSON store if one exists, otherwise seed.
  let imported = false;
  if (existsSync(LEGACY_JSON)) {
    try {
      state = JSON.parse(readFileSync(LEGACY_JSON, "utf8"));
      imported = true;
    } catch (e) {
      console.error(`Legacy ${LEGACY_JSON} unreadable, seeding fresh:`, e.message);
      state = seed();
    }
  } else {
    state = seed();
  }
  normalize(state);
  writeAll(state);
  if (imported) {
    try {
      renameSync(LEGACY_JSON, LEGACY_JSON + ".imported");
      console.log(`Imported ${LEGACY_JSON} into ${DB_FILE} (renamed to data.json.imported)`);
    } catch (e) {
      console.warn(`Imported ${LEGACY_JSON} but couldn't rename it:`, e.message);
    }
  }
  return state;
}

// Apply a mutation function to the state and persist it transactionally.
export function mutate(fn) {
  load();
  fn(state);
  writeAll(state);
  return state;
}

export { uid };
