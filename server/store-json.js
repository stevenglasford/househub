// store-json.js — plain JSON-file datastore (no database server, no native
// modules). This is the store this version originally shipped with, kept as an
// alternative for anyone who prefers a single human-readable data.json over a
// SQLite database. It is NOT the default: server.js imports store.js (SQLite).
//
// To use this instead, change the import in server.js from "./store.js" to
// "./store-json.js". The public interface (load / mutate / uid) is identical,
// and the document shape is defined once in document.js, so the two stores
// stay in lockstep.
//
// Writes are atomic (temp file + rename). Fine for household-scale write
// concurrency and trivial to back up.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { LEGACY_JSON } from "./config.js";
import { seed, normalize, uid } from "./document.js";

// When running the JSON store, DATA_FILE (via LEGACY_JSON) is the live store,
// not a one-time import source.
const FILE = LEGACY_JSON;

let state = null;

export function load() {
  if (state) return state;
  if (existsSync(FILE)) {
    try { state = JSON.parse(readFileSync(FILE, "utf8")); }
    catch (e) { console.error("data.json unreadable, starting fresh:", e.message); state = seed(); persist(); }
  } else {
    state = seed();
    persist();
  }
  normalize(state);
  return state;
}

function persist() {
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}

export function mutate(fn) {
  load();
  fn(state);
  persist();
  return state;
}

export { uid };
