// store.js — SQLite-backed datastore (better-sqlite3, WAL mode).
//
// Public interface matches the JSON store exactly — load() returns the whole
// in-memory household document, mutate(fn) applies a change and persists — so
// server.js doesn't care which store is underneath. (A plain JSON store with
// the same interface lives in store-json.js for anyone who prefers it.)
//
// SCHEMA COMPATIBILITY: the deployed hub already runs on a SQLite database
// written by an earlier version of this store. That database is the whole
// reason for this upgrade, so this store uses the SAME on-disk schema and
// simply reads it in place:
//   meta       (key, json)
//   <list>     (id, pos, data)   one table per list collection
//   meals      (date, data)      legacy per-day meals, its own table
//   calendars  (id, pos, data, ics_text)
//
// The list collections have grown since that schema was written (projects,
// agenda, dateIdeas, …). New list tables are created on first boot; old ones
// are read as-is. Meals changed shape too — old rows are one dish per slot,
// the new model is a per-person entry list — so meals are read from the legacy
// `meals` table if present, put back into the in-memory document, and migrated
// by normalize() (document.js). From then on meals live in the `meta` table
// like every other non-list value, and the legacy table is left empty.
//
// A mutation clears and rewrites the affected tables in a single transaction,
// so the database always mirrors the in-memory document exactly.
//
// First boot against a genuinely empty DB imports an existing data.json (the
// store this version shipped with, or an even older one) automatically, then
// renames it to data.json.imported.

import Database from "better-sqlite3";
import { readFileSync, renameSync, existsSync } from "node:fs";
import { DB_FILE, LEGACY_JSON } from "./config.js";
import { seed, normalize, uid } from "./document.js";

/* ---------- which top-level keys are stored as ordered rows ---------- */

// Every array-of-entities collection in the current document. The first seven
// match the deployed schema; the rest are new and get fresh tables.
const LISTS = [
  "people", "events", "chores", "tasks", "grocery", "notes", "dates",
  "projects", "agenda", "agendaArchive", "agendaPrompts", "dateJars", "dateIdeas",
];
// Keys with bespoke storage; everything else is a plain JSON meta value.
// (meals is read from its legacy table but written into meta after migration.)
const SPECIAL = new Set([...LISTS, "calendars", "meals"]);

/* ---------- schema (matches the deployed database) ---------- */

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  ${LISTS.map((t) => `
  CREATE TABLE IF NOT EXISTS "${t}" (
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
  calsAll: db.prepare("SELECT data, ics_text FROM calendars ORDER BY pos"),
  calsClear: db.prepare("DELETE FROM calendars"),
  calsPut: db.prepare("INSERT OR REPLACE INTO calendars (id, pos, data, ics_text) VALUES (?, ?, ?, ?)"),
  list: {},
};
for (const t of LISTS) {
  stmt.list[t] = {
    all: db.prepare(`SELECT data FROM "${t}" ORDER BY pos`),
    clear: db.prepare(`DELETE FROM "${t}"`),
    put: db.prepare(`INSERT OR REPLACE INTO "${t}" (id, pos, data) VALUES (?, ?, ?)`),
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
  s.calendars = stmt.calsAll.all().map((r) => ({ ...JSON.parse(r.data), icsText: r.ics_text }));

  // Meals: a document migrated by a previous run has meals in `meta` already.
  // A database from the older store has them only in the legacy `meals` table.
  // Prefer meta if it's there; otherwise pull the legacy rows in so normalize()
  // can migrate them to the per-person shape.
  if (!s.meals || typeof s.meals !== "object" || !Object.keys(s.meals).length) {
    const legacy = {};
    for (const r of stmt.mealsAll.all()) legacy[r.date] = JSON.parse(r.data);
    if (Object.keys(legacy).length) s.meals = legacy;
  }
  return s;
}

const writeAll = db.transaction((s) => {
  stmt.metaClear.run();
  for (const [k, v] of Object.entries(s)) {
    if (!SPECIAL.has(k)) stmt.metaPut.run(k, JSON.stringify(v ?? null));
  }
  // meals now live in meta alongside the other non-list values.
  stmt.metaPut.run("meals", JSON.stringify(s.meals ?? {}));
  // and the legacy meals table is emptied once, so it can never shadow meta.
  stmt.mealsClear.run();

  for (const t of LISTS) {
    stmt.list[t].clear.run();
    (s[t] || []).forEach((e, i) => stmt.list[t].put.run(String(e.id ?? uid()), i, JSON.stringify(e)));
  }
  stmt.calsClear.run();
  (s.calendars || []).forEach((c, i) => {
    const { icsText, ...meta } = c;
    stmt.calsPut.run(String(c.id ?? uid()), i, JSON.stringify(meta), icsText || "");
  });
});

/* ---------- public interface ---------- */

let state = null;

export function load() {
  if (state) return state;
  state = readAll();
  if (state) {
    const before = JSON.stringify(state);
    normalize(state);
    // If normalize changed anything (new fields backfilled, meals migrated to
    // the per-person shape and moved into meta, an old upNextSource folded in),
    // persist once so the database matches what the server serves from here on.
    if (JSON.stringify(state) !== before) writeAll(state);
    return state;
  }

  // Empty DB. Import a legacy JSON store if one exists, otherwise seed.
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
