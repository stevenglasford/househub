// legacy-import.js — bringing a household over from the old HouseHub.
//
// The old app kept one household in a SQLite file (or, in earlier versions, a
// data.json) with no encryption: anyone with the file had everything. This
// reads that file and turns it back into a household document the encrypted
// rewrite can seal.
//
// WHERE THIS RUNS, AND WHY IT MATTERS
//
// In the browser. It has to be: sealing needs the household key, and the key
// exists only in the tab the member signed into. The old file is read from
// local disk with the File API, converted here, and sealed before anything is
// sent anywhere. The plaintext never touches the network and the server never
// sees it -- which would not be true of the obvious design, where you upload
// the .db and let the server do the work.
//
// FIDELITY
//
// The two documents are close relatives -- the rewrite's document.js started as
// a copy of the old one -- so most collections transfer unchanged. The work is
// in the handful of places they diverge, and in being honest about the few
// things that genuinely cannot come across (listed in `warnings`, and shown to
// the person before they commit).
//
// One deliberate non-conversion: old chore completions are `true`, a person id,
// or "skipped". The new model records who ticked it, from which device, and
// whether the claim is locked. Those old marks are left exactly as they are.
// completion.js already reads them as byType 'legacy', and inventing an actor
// for a tick that happened two years ago would be forging a record, not
// migrating one.

import { openDatabase, SqliteError } from "./sqlite.js";
import { normalize, seed } from "./document.js";

/** Collections the old SQLite store kept as one ordered row per entity. */
const LEGACY_LISTS = [
  "people", "events", "chores", "tasks", "grocery", "notes", "dates",
  "projects", "agenda", "agendaArchive", "agendaPrompts", "dateJars", "dateIdeas",
];

/**
 * Values that must not come across.
 *
 * `apiToken` was a bearer token for the old voice endpoints, sitting in the
 * document in the clear. The rewrite authenticates those routes properly and
 * generates nothing of the kind, so carrying it over would import a credential
 * from a system we are migrating away from precisely because it had none.
 */
const DROP_KEYS = new Set(["apiToken"]);

export class LegacyImportError extends Error {}

/* --------------------------------------------------------- reading in --- */

/**
 * Rebuild the old in-memory document from a SQLite file.
 *
 * Mirrors the old store's readAll(), including the detail that list rows are
 * ordered by their `pos` column rather than by rowid -- reordering a grocery
 * list by dragging changed `pos` and left rowids alone, so trusting insertion
 * order would silently scramble every list the household had arranged.
 */
export function readLegacyDatabase(buffer, wal = null) {
  let db;
  try {
    db = openDatabase(buffer, { wal });
  } catch (err) {
    throw new LegacyImportError(
      err instanceof SqliteError ? err.message : `Could not open that file: ${err.message}`
    );
  }

  if (!db.hasTable("meta")) {
    throw new LegacyImportError(
      "That SQLite file has no `meta` table, so it is not a HouseHub database."
    );
  }

  const doc = {};
  const bad = [];

  for (const row of db.rows("meta")) {
    if (DROP_KEYS.has(row.key)) continue;
    try {
      doc[row.key] = JSON.parse(row.json);
    } catch {
      bad.push(`meta.${row.key}`);
    }
  }

  for (const table of LEGACY_LISTS) {
    if (!db.hasTable(table)) { doc[table] = []; continue; }
    const rows = db.rows(table)
      .slice()
      .sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
    const items = [];
    for (const row of rows) {
      try { items.push(JSON.parse(row.data)); } catch { bad.push(`${table}#${row.id}`); }
    }
    doc[table] = items;
  }

  // Calendars carry their fetched .ics body in a column of its own.
  doc.calendars = [];
  if (db.hasTable("calendars")) {
    const rows = db.rows("calendars").slice().sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
    for (const row of rows) {
      try {
        doc.calendars.push({ ...JSON.parse(row.data), icsText: row.ics_text || "" });
      } catch { bad.push(`calendars#${row.id}`); }
    }
  }

  // Meals moved from their own table into `meta` partway through the old app's
  // life. A database written before that has them only in the legacy table.
  const hasMetaMeals = doc.meals && typeof doc.meals === "object" && Object.keys(doc.meals).length;
  if (!hasMetaMeals && db.hasTable("meals")) {
    const legacy = {};
    for (const row of db.rows("meals")) {
      try { legacy[row.date] = JSON.parse(row.data); } catch { bad.push(`meals#${row.date}`); }
    }
    if (Object.keys(legacy).length) doc.meals = legacy;
  }

  return {
    doc,
    unreadable: bad,
    /* True when this is a WAL-mode database opened without its log. The old
       HouseHub ran in WAL mode, so a file copied while its server was running
       has the most recent writes only in the -wal -- and reading the main file
       alone yields an older household silently, with nothing to indicate that
       last week is missing. The caller must warn. */
    missingWal: db.walMode && !db.wal,
    replayedWal: Boolean(db.wal),
  };
}

/** The even older store: a plain data.json file. */
export function readLegacyJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new LegacyImportError(`That file is not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new LegacyImportError("That JSON file does not contain a household document.");
  }
  for (const key of DROP_KEYS) delete doc[key];
  return { doc, unreadable: [] };
}

/** Dispatch on what the file actually is, not on what it is called. */
export function readLegacyFile(bytes, filename = "", wal = null) {
  const looksSqlite = bytes.length >= 16
    && String.fromCharCode(...bytes.subarray(0, 15)) === "SQLite format 3";
  if (looksSqlite) return readLegacyDatabase(bytes, wal);

  const text = new TextDecoder("utf-8").decode(bytes).trim();
  if (text.startsWith("{")) return readLegacyJson(text);

  throw new LegacyImportError(
    `"${filename || "That file"}" is neither a SQLite database nor a data.json. ` +
    "Look for househub.db (or data.json) next to the old server."
  );
}

/* ------------------------------------------------------------ shaping --- */

const count = (v) => (Array.isArray(v) ? v.length : 0);
const countKeys = (v) => (v && typeof v === "object" ? Object.keys(v).length : 0);

/**
 * Turn a raw legacy document into one this app can seal, plus everything a
 * person needs to decide whether to go through with it.
 *
 * Nothing is destructive here. This returns a proposal; the caller commits it.
 */
export function prepareImport(raw, { unreadable = [], missingWal = false, replayedWal = false } = {}) {
  const doc = normalize({ ...seed(), ...raw });
  const warnings = [];

  if (missingWal) {
    warnings.push({
      level: "warn",
      text: "This database was in WAL mode, and no matching -wal file was provided. If it was "
        + "copied while the old server was running, the most recent changes are in a file "
        + "called the same thing with \"-wal\" on the end, and are NOT in what you just "
        + "opened. Drop that file in too, or stop the old server and copy again.",
    });
  }
  if (replayedWal) {
    warnings.push({
      level: "info",
      text: "The write-ahead log was applied, so changes made right up to the moment the file "
        + "was copied are included.",
    });
  }

  if (unreadable.length) {
    warnings.push({
      level: "error",
      text: `${unreadable.length} record(s) could not be read and will be skipped: `
        + unreadable.slice(0, 5).join(", ") + (unreadable.length > 5 ? "…" : ""),
    });
  }

  // Calendar feeds live server-side in the rewrite, sealed under the server key,
  // because a browser cannot fetch a Google or iCloud feed itself (CORS). They
  // are therefore re-subscribed rather than copied into the document.
  const feeds = (raw.calendars || []).filter((c) => c && (c.url || c.icsText));
  if (feeds.length) {
    warnings.push({
      level: "info",
      text: `${feeds.length} calendar subscription(s) will be re-added. Feeds with a URL `
        + "refresh themselves; ones imported from a file come across as a fixed snapshot.",
    });
  }

  if (raw.apiToken) {
    warnings.push({
      level: "info",
      text: "The old voice-endpoint token was not imported. Those routes now use "
        + "your normal sign-in, so it is not needed and would only be a stray credential.",
    });
  }

  // Old completions are readable but thin: they say who, never who ticked it.
  const legacyMarks = (raw.chores || []).reduce(
    (n, c) => n + Object.values(c?.done || {}).filter((m) => m && typeof m !== "object").length, 0);
  if (legacyMarks) {
    warnings.push({
      level: "info",
      text: `${legacyMarks} chore completion(s) come across as they were recorded. They keep `
        + "who was credited, but the old app never stored which device ticked them, so they "
        + "show as unverified rather than being given an actor they never had.",
    });
  }

  if (!count(raw.people)) {
    warnings.push({
      level: "warn",
      text: "No people found in that file. Chores and tasks will import, but nothing will be "
        + "assigned to anyone until you add members.",
    });
  }

  const summary = [
    ["People", count(doc.people)],
    ["Chores", count(doc.chores)],
    ["Tasks", count(doc.tasks)],
    ["Events", count(doc.events)],
    ["Projects", count(doc.projects)],
    ["Grocery items", count(doc.grocery)],
    ["Notes", count(doc.notes)],
    ["Important dates", count(doc.dates)],
    ["Agenda items", count(doc.agenda)],
    ["Archived agendas", count(doc.agendaArchive)],
    ["Date ideas", count(doc.dateIdeas)],
    ["Days with meals", countKeys(doc.meals)],
    ["Days of check-in history", countKeys(doc.checkin?.log)],
    ["Calendar subscriptions", feeds.length],
  ].filter(([, n]) => n > 0);

  return { doc, feeds, summary, warnings, householdName: doc.householdName || "" };
}

/**
 * What the current document would lose if this import replaced it.
 *
 * Shown before anything happens, because "import" reading as "quietly delete
 * the four chores I already added" is exactly the sort of surprise that makes
 * people distrust a migration tool.
 */
export function describeOverwrite(current) {
  if (!current) return [];
  return [
    ["people", count(current.people)],
    ["chores", count(current.chores)],
    ["tasks", count(current.tasks)],
    ["events", count(current.events)],
    ["notes", count(current.notes)],
    ["grocery items", count(current.grocery)],
    ["projects", count(current.projects)],
  ].filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`);
}

/* -------------------------------------------------------------- merging --- */

/** Collections that are lists of things with ids. */
const MERGEABLE_LISTS = [
  "people", "events", "chores", "tasks", "projects", "grocery",
  "notes", "dates", "agenda", "agendaArchive", "agendaPrompts", "dateIdeas",
];

/** A short id that cannot collide with anything already in either document. */
const freshId = (taken) => {
  let id;
  do { id = Math.random().toString(36).slice(2, 9); } while (taken.has(id));
  taken.add(id);
  return id;
};

const sameName = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * Fold an imported household into the one that already exists, destroying
 * nothing.
 *
 * The earlier design replaced the whole document, which is simple and correct
 * and also the wrong default: "import" should never be a word that deletes four
 * chores somebody added this morning. Nothing here removes or overwrites an
 * existing entry. Every existing item survives untouched; imported items are
 * added alongside.
 *
 * Three problems have to be solved for that to be true:
 *
 *   ids collide       Both documents allocate ids the same way, so an imported
 *                     chore can carry an id an existing note already uses.
 *                     Colliding imports are given fresh ids.
 *   references break  Chores, tasks and meals point at people by id, so any
 *                     person who gets a new id has to be followed through
 *                     everything that referred to them.
 *   people are the    A person called "Sam" in both documents is one human
 *   same human        being, not two. Matching them by name is what stops an
 *                     import turning a two-person household into a four-person
 *                     one, with half the chores assigned to the wrong copies.
 *
 * Returns { doc, report } -- the report is what the UI shows afterwards, so the
 * household can see precisely what arrived.
 */
export function mergeImport(current, incoming) {
  const doc = structuredClone(current || {});
  const add = incoming || {};
  const report = { added: {}, skipped: {}, peopleMatched: [], peopleAdded: [] };

  // Every id in use anywhere in the destination, so fresh ones cannot collide.
  const taken = new Set();
  for (const key of MERGEABLE_LISTS) {
    for (const item of doc[key] || []) if (item?.id) taken.add(String(item.id));
  }
  for (const jar of doc.dateJars || []) if (jar?.id) taken.add(String(jar.id));

  /* ---- people first: everything else points at them ---------------------- */

  const personIdMap = new Map();
  doc.people = Array.isArray(doc.people) ? doc.people : [];

  for (const person of add.people || []) {
    const oldId = String(person?.id ?? "");
    // Same human, already here. Matching on name rather than id because the two
    // documents allocated ids independently and agreement would be a coincidence.
    const existing = doc.people.find((p) => sameName(p.name, person?.name));
    if (existing) {
      personIdMap.set(oldId, existing.id);
      report.peopleMatched.push(existing.name);
      continue;
    }
    const id = taken.has(oldId) || !oldId ? freshId(taken) : (taken.add(oldId), oldId);
    personIdMap.set(oldId, id);
    doc.people.push({ ...person, id });
    report.peopleAdded.push(person?.name || "Unnamed");
  }

  const remapPerson = (id) => {
    const key = String(id ?? "");
    if (!key) return "";
    return personIdMap.has(key) ? personIdMap.get(key) : key;
  };

  /* ---- the list collections --------------------------------------------- */

  for (const key of MERGEABLE_LISTS) {
    if (key === "people") continue;
    const mine = Array.isArray(doc[key]) ? doc[key] : [];
    const theirs = Array.isArray(add[key]) ? add[key] : [];
    if (!theirs.length) { doc[key] = mine; continue; }

    let added = 0, skipped = 0;
    for (const raw of theirs) {
      const item = { ...raw };
      const oldId = String(item.id ?? "");

      /* Has this exact thing already been imported?
         Matching on the current id is not enough: if the id collided the first
         time round it was reassigned, so on a second run the incoming id no
         longer matches anything. Each imported item therefore records the id it
         had in the old household, which is stable across any number of imports
         and is what makes running this twice safe. */
      const duplicate = mine.find((m) =>
        (oldId && String(m?.importedId ?? "") === oldId) ||
        (String(m?.id ?? "") === oldId && sameName(m?.title, item?.title))
      );
      if (duplicate) { skipped++; continue; }

      item.id = !oldId || taken.has(oldId) ? freshId(taken) : (taken.add(oldId), oldId);
      if (oldId) item.importedId = oldId;

      // Follow people through every field that names one.
      if ("personId" in item) item.personId = remapPerson(item.personId);
      if ("cookId" in item) item.cookId = remapPerson(item.cookId);
      if (Array.isArray(item.rotation)) item.rotation = item.rotation.map(remapPerson).filter(Boolean);
      if (item.done && typeof item.done === "object" && !Array.isArray(item.done)) {
        // Chore completions are keyed by date; the value names who did it.
        item.done = Object.fromEntries(Object.entries(item.done).map(([date, mark]) => {
          if (typeof mark === "string" && mark !== "skipped") return [date, remapPerson(mark)];
          if (mark && typeof mark === "object" && mark.by) return [date, { ...mark, by: remapPerson(mark.by) }];
          return [date, mark];
        }));
      }
      mine.push(item);
      added++;
    }
    doc[key] = mine;
    if (added) report.added[key] = added;
    if (skipped) report.skipped[key] = skipped;
  }

  /* ---- date jars, which entries point at ---------------------------------- */

  const jarIdMap = new Map();
  doc.dateJars = Array.isArray(doc.dateJars) ? doc.dateJars : [];
  for (const jar of add.dateJars || []) {
    const oldId = String(jar?.id ?? "");
    const existing = doc.dateJars.find((j) => sameName(j.name, jar?.name));
    if (existing) { jarIdMap.set(oldId, existing.id); continue; }
    const id = taken.has(oldId) || !oldId ? freshId(taken) : (taken.add(oldId), oldId);
    jarIdMap.set(oldId, id);
    doc.dateJars.push({ ...jar, id });
  }
  for (const idea of doc.dateIdeas || []) {
    if (idea?.jarId && jarIdMap.has(String(idea.jarId))) idea.jarId = jarIdMap.get(String(idea.jarId));
  }

  /* ---- date-keyed maps: fill gaps, never overwrite ------------------------ */

  doc.meals = doc.meals && typeof doc.meals === "object" ? doc.meals : {};
  let mealDays = 0;
  for (const [date, day] of Object.entries(add.meals || {})) {
    const mine = doc.meals[date] || {};
    const merged = { ...mine };
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const already = new Set((mine[slot] || []).map((e) => String(e?.importedId ?? "")).filter(Boolean));
      const theirs = (day?.[slot] || [])
        .filter((e) => !already.has(String(e?.id ?? "")))   // not already imported
        .map((e) => ({
          ...e,
          id: freshId(taken),
          importedId: e?.id ? String(e.id) : undefined,
          personId: remapPerson(e?.personId),
          cookId: remapPerson(e?.cookId),
        }));
      if (!theirs.length) continue;
      // Appended, so a day that already had a dinner keeps it and gains theirs.
      merged[slot] = [...(mine[slot] || []), ...theirs];
    }
    if (Object.keys(merged).length) { doc.meals[date] = merged; mealDays++; }
  }
  if (mealDays) report.added.mealDays = mealDays;

  // Check-in history and mood scores: an existing entry for a day always wins,
  // because it is this household's own record of that day.
  doc.status = doc.status && typeof doc.status === "object" ? doc.status : {};
  let statusDays = 0;
  for (const [date, byPerson] of Object.entries(add.status || {})) {
    const mine = doc.status[date] || {};
    const merged = { ...mine };
    for (const [pid, scores] of Object.entries(byPerson || {})) {
      const mapped = remapPerson(pid);
      if (!(mapped in merged)) merged[mapped] = scores;
    }
    doc.status[date] = merged;
    statusDays++;
  }
  if (statusDays) report.added.statusDays = statusDays;

  doc.checkin = doc.checkin && typeof doc.checkin === "object" ? doc.checkin : {};
  doc.checkin.log = doc.checkin.log && typeof doc.checkin.log === "object" ? doc.checkin.log : {};
  let checkinDays = 0;
  for (const [date, entry] of Object.entries(add.checkin?.log || {})) {
    if (date in doc.checkin.log) continue;
    doc.checkin.log[date] = entry;
    checkinDays++;
  }
  if (checkinDays) report.added.checkinDays = checkinDays;

  doc.groceryHistory = doc.groceryHistory && typeof doc.groceryHistory === "object" ? doc.groceryHistory : {};
  for (const [key, entry] of Object.entries(add.groceryHistory || {})) {
    const mine = doc.groceryHistory[key];
    doc.groceryHistory[key] = mine
      ? { ...entry, ...mine, count: (mine.count || 0) + (entry?.count || 0) }
      : entry;
  }

  // Grocery stores are a plain list of names.
  doc.groceryStores = Array.isArray(doc.groceryStores) ? doc.groceryStores : [];
  for (const store of add.groceryStores || []) {
    if (!doc.groceryStores.some((s) => sameName(s, store))) doc.groceryStores.push(store);
  }

  /* ---- settings are never taken from the imported document ---------------- */
  // Household name, weather location, layout, display preferences and the
  // reminder relay all stay as this household has them. An import brings
  // content, not somebody else's configuration.

  return { doc, report };
}

/** A plain-language summary of a merge, for the confirmation screen. */
export function describeMerge(report) {
  const LABELS = {
    people: "people", events: "events", chores: "chores", tasks: "to-dos",
    projects: "projects", grocery: "grocery items", notes: "notes",
    dates: "important dates", agenda: "agenda items", agendaArchive: "archived agendas",
    agendaPrompts: "conversation prompts", dateIdeas: "date ideas",
    mealDays: "days of meals", statusDays: "days of check-in scores",
    checkinDays: "days of check-in history",
  };
  const lines = [];
  if (report.peopleAdded?.length) lines.push(`${report.peopleAdded.length} people added (${report.peopleAdded.join(", ")})`);
  if (report.peopleMatched?.length) {
    lines.push(`${report.peopleMatched.length} matched to people already here (${report.peopleMatched.join(", ")}) — their chores came across attached to the right person`);
  }
  for (const [key, n] of Object.entries(report.added || {})) {
    if (key === "people") continue;
    lines.push(`${n} ${LABELS[key] || key}`);
  }
  const skipped = Object.values(report.skipped || {}).reduce((a, b) => a + b, 0);
  if (skipped) lines.push(`${skipped} already here and left alone`);
  return lines;
}
