// legacy-import.test.js — a household comes across intact, or not at all.
//
// This is the highest-stakes code in the app for a household that already has
// years of data in the old one. A calendar that renders slightly wrong is an
// annoyance; an import that silently drops four hundred chore completions, or
// scrambles a hand-ordered grocery list, is a reason never to trust the new
// system again.
//
// The fixtures here are real SQLite files, built by fixtures/make-legacy-db.py
// to the exact schema the old store wrote, including the awkward parts: rows
// large enough to need overflow pages, tables large enough to need interior
// B-tree pages, and a `pos` order that deliberately disagrees with rowid order.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { openDatabase, SqliteError } from "../src/lib/sqlite.js";
import {
  readLegacyFile, readLegacyJson, prepareImport, describeOverwrite, LegacyImportError,
  mergeImport, describeMerge,
} from "../src/lib/legacy-import.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "legacy.db");

const bytes = () => new Uint8Array(readFileSync(FIXTURE));

// The fixture is generated rather than committed as a binary blob; skip loudly
// rather than passing vacuously if it has not been built.
const haveFixture = existsSync(FIXTURE);
const needsFixture = { skip: haveFixture ? false : "run: python3 web/test/fixtures/make-legacy-db.py" };

/* ------------------------------------------------------ the file reader --- */

test("rejects things that are not SQLite databases", () => {
  assert.throws(() => openDatabase(new Uint8Array(8)), SqliteError);
  assert.throws(() => openDatabase(new Uint8Array(200)), /not a SQLite database/i);
});

test("a JSON file is read as the older data.json store", () => {
  const { doc } = readLegacyJson('{"householdName":"Old House","people":[{"id":"p1","name":"Sam"}]}');
  assert.equal(doc.householdName, "Old House");
  assert.equal(doc.people.length, 1);
});

test("the voice-endpoint token is never imported", () => {
  // It was a bearer credential sitting in the clear in the old document. The
  // rewrite authenticates those routes properly, so carrying it over would
  // import a secret from the system we are leaving because it had none.
  const { doc } = readLegacyJson('{"apiToken":"sekrit","householdName":"X"}');
  assert.equal("apiToken" in doc, false);
});

test("junk is refused with an explanation, not a stack trace", () => {
  assert.throws(
    () => readLegacyFile(new TextEncoder().encode("hello, I am a text file"), "notes.txt"),
    LegacyImportError
  );
  assert.throws(() => readLegacyJson("{oh no"), /not valid JSON/);
  assert.throws(() => readLegacyJson("[1,2,3]"), /does not contain a household document/);
});

/* --------------------------------------------------------- the database --- */

test("reads every collection out of a real database", needsFixture, () => {
  const { doc } = readLegacyFile(bytes(), "househub.db");
  assert.equal(doc.people.length, 2);
  assert.equal(doc.chores.length, 400);
  assert.equal(doc.tasks.length, 30);
  assert.equal(doc.grocery.length, 12);
  assert.equal(doc.householdName, "Glasford House");
});

test("list order follows `pos`, not insertion order", needsFixture, () => {
  // The old UI reordered by dragging, which rewrote `pos` and left rowids alone.
  // Reading in rowid order would silently reshuffle every list the household
  // had arranged by hand — and it would look plausible, which is worse.
  const { doc } = readLegacyFile(bytes(), "househub.db");
  assert.deepEqual(
    doc.grocery.map((g) => g.title),
    ["Milk", "Bread", "Eggs", "Butter", "Coffee", "Rice", "Onions", "Cheese", "Apples", "Pasta", "Tomatoes", "Soap"],
    "grocery list came back in the order the household arranged it"
  );
});

test("large rows survive overflow pages", needsFixture, () => {
  // A fetched .ics is far bigger than one 4 KB page, so every calendar row
  // spills onto an overflow chain.
  const { doc } = readLegacyFile(bytes(), "househub.db");
  const ics = doc.calendars[0].icsText;
  assert.ok(ics.length > 40000, `expected a large body, got ${ics.length}`);
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics.trimEnd(), /END:VCALENDAR$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 500, "no events lost mid-chain");
});

test("big tables spanning interior B-tree pages read completely", needsFixture, () => {
  const { doc } = readLegacyFile(bytes(), "househub.db");
  assert.equal(doc.chores.length, 400);
  assert.equal(doc.chores[0].id, "c0");
  assert.equal(doc.chores.at(-1).id, "c399");
  assert.equal(new Set(doc.chores.map((c) => c.id)).size, 400, "no duplicates from re-walking a page");
});

test("non-ASCII text is not mangled", needsFixture, () => {
  const { doc } = readLegacyFile(bytes(), "househub.db");
  assert.equal(doc.notes[0].text, "Ring the plumber — ask about the £120 quote ✅");
});

/* --------------------------------------------------------- the proposal --- */

test("completion history comes across untouched", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { doc } = prepareImport(raw, { unreadable });

  const chore = doc.chores.find((c) => c.id === "c0");
  assert.equal(Object.keys(chore.done).length, 28, "every recorded day kept");
  // Left exactly as recorded. Inventing an actor for a tick from two years ago
  // would be forging a record rather than migrating one — completion.js already
  // reads these as byType 'legacy'.
  assert.ok(Object.values(chore.done).some((m) => m === "skipped"));
  assert.ok(Object.values(chore.done).some((m) => typeof m === "string" && m !== "skipped"));
});

test("person references still resolve after import", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { doc } = prepareImport(raw, { unreadable });
  const ids = new Set(doc.people.map((p) => p.id));
  for (const c of doc.chores) {
    if (c.personId) assert.ok(ids.has(c.personId), `chore ${c.id} points at a missing person`);
  }
});

test("legacy one-dish meals migrate to the per-person shape", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { doc } = prepareImport(raw, { unreadable });
  const day = doc.meals["2026-08-10"];
  assert.ok(Array.isArray(day.dinner), "old string slot became a list");
  assert.equal(day.dinner[0].title, "Roast chicken");
  assert.equal(day.dinner[0].cookId, "p1", "who was cooking survived the shape change");
  assert.equal(day.dinner[0].time, "18:30");
});

test("check-in history survives", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { doc } = prepareImport(raw, { unreadable });
  assert.equal(doc.checkin.log["2026-08-01"].p1.happiness, 4);
});

test("the result is a valid current-shape document", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { doc } = prepareImport(raw, { unreadable });
  // Fields the old app never had must be present, or the app renders undefined.
  for (const key of ["alertSnooze", "alertRelayed", "reminderRelay", "dateJars", "upNextSources", "checkin"]) {
    assert.ok(key in doc, `normalize() did not backfill ${key}`);
  }
  assert.equal(typeof doc.reminderRelay.enabled, "boolean");
  assert.equal(doc.reminderRelay.enabled, false, "phone reminders stay off after an import");

  // The archive is deliberately NOT backfilled: absent means "not recording",
  // which is the right default. An import must not switch on a permanent record
  // that every admin would then have to agree to switch back off.
  assert.equal(doc.archive, undefined);
  assert.equal(doc.archiveSettings, undefined);
});

test("calendar feeds are separated out for re-subscription", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { feeds } = prepareImport(raw, { unreadable });
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].url, "https://example.com/f.ics");
});

test("the summary counts what a person would actually check", needsFixture, () => {
  const { doc: raw, unreadable } = readLegacyFile(bytes(), "househub.db");
  const { summary } = prepareImport(raw, { unreadable });
  const byLabel = Object.fromEntries(summary);
  assert.equal(byLabel.People, 2);
  assert.equal(byLabel.Chores, 400);
  assert.equal(byLabel["Grocery items"], 12);
  // Zero-count rows are omitted rather than shown as a wall of noughts.
  assert.ok(summary.every(([, n]) => n > 0));
});

test("a corrupt row is reported rather than swallowed", () => {
  const { doc } = readLegacyJson('{"householdName":"X"}');
  const { warnings } = prepareImport(doc, { unreadable: ["chores#c9", "notes#n2"] });
  const err = warnings.find((w) => w.level === "error");
  assert.ok(err, "an unreadable record must surface as an error, not a silent skip");
  assert.match(err.text, /chores#c9/);
});

/* ------------------------------------------------------- overwrite guard --- */

test("describes exactly what an import would destroy", () => {
  assert.deepEqual(
    describeOverwrite({ people: [1, 2], chores: [1, 1, 1], grocery: [] }),
    ["2 people", "3 chores"]
  );
  assert.deepEqual(describeOverwrite({ people: [], chores: [] }), [],
    "an empty household reports nothing to lose");
  assert.deepEqual(describeOverwrite(null), []);
});

/* ------------------------------------------------- write-ahead logs --- */
//
// The old store ran SQLite in WAL mode. Copying househub.db off a machine
// where the server is still running leaves the most recent writes behind in a
// separate -wal file — and the main file opens perfectly happily, showing an
// older household with nothing at all to indicate that last week is missing.
//
// That is the worst way this tool could fail: not an error, just a quietly
// incomplete household that nobody notices until they go looking for something.

const LIVE = join(HERE, "fixtures", "live-copy.db");
const haveLive = existsSync(LIVE) && existsSync(`${LIVE}-wal`);
const needsLive = { skip: haveLive ? false : "run: python3 web/test/fixtures/make-legacy-db.py" };

test("a live-copied database without its log is detected and flagged", needsLive, () => {
  const read = readLegacyFile(new Uint8Array(readFileSync(LIVE)), "househub.db");
  assert.equal(read.doc.householdName, "Before the copy", "the main file alone is stale");
  assert.equal(read.missingWal, true, "and we must know that it is");

  const { warnings } = prepareImport(read.doc, read);
  const warned = warnings.find((w) => w.level === "warn" && /-wal/.test(w.text));
  assert.ok(warned, "the person has to be told before they replace their household with stale data");
});

test("supplying the log recovers everything written up to the copy", needsLive, () => {
  const read = readLegacyFile(
    new Uint8Array(readFileSync(LIVE)),
    "househub.db",
    new Uint8Array(readFileSync(`${LIVE}-wal`))
  );
  assert.equal(read.doc.householdName, "After the copy");
  assert.equal(read.missingWal, false);
  assert.equal(read.replayedWal, true);
  assert.equal(read.doc.chores.length, 40, "rows that existed only in the log");
  assert.equal(read.doc.chores[0].id, "late0");
  assert.equal(read.doc.chores.at(-1).id, "late39");
});

test("damage stops the replay at the last good commit", needsLive, () => {
  // The guarantee is that the checksum chain stops at the damage, so what lands
  // is always some *earlier committed* state and never a mixture of before and
  // after. Corrupting the first frame is the sharpest version: nothing in the
  // log is trustworthy, so none of it may be applied.
  const db = new Uint8Array(readFileSync(LIVE));
  const wal = new Uint8Array(readFileSync(`${LIVE}-wal`));
  wal[32 + 24 + 100] ^= 0xff;                 // inside frame 0's page data

  const read = readLegacyFile(db, "househub.db", wal);
  assert.equal(read.doc.householdName, "Before the copy", "fell back cleanly to the main file");
  assert.equal(read.doc.chores.length, 0, "no half-applied transaction");
  assert.equal(read.replayedWal, false);
});

test("a log truncated mid-frame applies only whole frames", needsLive, () => {
  // A copy interrupted partway leaves a final frame that is not all there. It
  // must be ignored rather than read as whatever happens to follow it on disk.
  const db = new Uint8Array(readFileSync(LIVE));
  const full = new Uint8Array(readFileSync(`${LIVE}-wal`));
  const read = readLegacyFile(db, "househub.db", full.slice(0, full.length - 500));

  // Every complete, committed frame before the cut still applies.
  assert.equal(read.doc.householdName, "After the copy");
  assert.equal(read.doc.chores.length, 40);
  // And nothing malformed came through.
  assert.ok(read.doc.chores.every((c) => typeof c.title === "string"));
});

test("a log from a different database is refused outright", needsLive, () => {
  const wal = new Uint8Array(readFileSync(`${LIVE}-wal`));
  wal[8] = 0x00; wal[9] = 0x00; wal[10] = 0x20; wal[11] = 0x00;   // claim a 8192 page size
  assert.throws(
    () => readLegacyFile(new Uint8Array(readFileSync(LIVE)), "househub.db", wal),
    /not from the same database|damaged/i
  );
});

test("a non-WAL database reports nothing missing", needsFixture, () => {
  const read = readLegacyFile(bytes(), "househub.db");
  assert.equal(read.missingWal, false, "the plain fixture must not raise a false alarm");
});

/* ------------------------------------------------------------- merging --- */
//
// An import must never be a word that deletes things. These tests exist because
// "replace the household" was the original design, and it is the wrong default:
// somebody importing years of history should not lose the four chores they added
// this morning learning the new app.

const household = () => ({
  householdName: "Our home", weather: { label: "Minneapolis" }, layoutMode: "wall",
  people: [{ id: "aaa", name: "Steven", color: "#111" }],
  chores: [{ id: "c1", title: "Existing chore", personId: "aaa", done: { "2026-08-01": "aaa" } }],
  tasks: [{ id: "t1", title: "Existing task", personId: "aaa" }],
  notes: [{ id: "n1", text: "keep me" }],
  meals: { "2026-08-10": { dinner: [{ id: "m1", title: "Our dinner", cookId: "aaa" }] } },
  checkin: { log: { "2026-08-01": { aaa: { happiness: 5 } } } },
  status: { "2026-08-01": { aaa: { happiness: 5 } } },
  groceryStores: ["Any"],
  dateJars: [{ id: "cheap", name: "Cheap" }],
});

const imported = () => ({
  householdName: "Old House", weather: { label: "Chicago" }, layoutMode: "compact",
  people: [{ id: "p1", name: "Steven", color: "#999" }, { id: "p2", name: "Alex", color: "#222" }],
  chores: [
    // NOTE: id "c1" deliberately collides with an existing, different chore.
    { id: "c1", title: "Imported chore", personId: "p1", done: { "2026-07-01": "p1", "2026-07-02": "skipped" } },
    { id: "c9", title: "Rotating chore", rotation: ["p1", "p2"], done: {} },
  ],
  tasks: [{ id: "t1", title: "Imported task", personId: "p2" }],
  notes: [{ id: "n9", text: "imported note" }],
  meals: { "2026-08-10": { dinner: [{ id: "m9", title: "Their dinner", cookId: "p2" }] } },
  checkin: { log: { "2026-08-01": { p1: { happiness: 1 } }, "2026-07-01": { p1: { happiness: 3 } } } },
  status: { "2026-08-01": { p1: { happiness: 1 } } },
  groceryStores: ["Any", "Aldi"],
  dateJars: [{ id: "cheap", name: "Cheap" }, { id: "f", name: "Fancy" }],
});

test("an import destroys nothing that was already there", () => {
  const current = household();
  const snapshot = JSON.stringify(current);
  const { doc } = mergeImport(current, imported());

  assert.equal(JSON.stringify(current), snapshot, "the caller's document was mutated");
  assert.ok(doc.chores.some((c) => c.id === "c1" && c.title === "Existing chore"));
  assert.ok(doc.tasks.some((t) => t.title === "Existing task"));
  assert.ok(doc.notes.some((n) => n.text === "keep me"));
  assert.ok(doc.meals["2026-08-10"].dinner.some((m) => m.title === "Our dinner"));
});

test("an existing record of a day is never overwritten by an imported one", () => {
  // This household's own memory of that evening wins. Anything else would let an
  // import quietly rewrite how somebody said they felt.
  const { doc } = mergeImport(household(), imported());
  assert.equal(doc.checkin.log["2026-08-01"].aaa.happiness, 5);
  assert.equal(doc.status["2026-08-01"].aaa.happiness, 5);
  assert.ok(doc.checkin.log["2026-07-01"], "a day with no existing entry is still added");
});

test("settings are not taken from the imported household", () => {
  const { doc } = mergeImport(household(), imported());
  assert.equal(doc.householdName, "Our home");
  assert.equal(doc.weather.label, "Minneapolis");
  assert.equal(doc.layoutMode, "wall");
});

test("the same person in both households is one person, not two", () => {
  const { doc, report } = mergeImport(household(), imported());
  assert.equal(doc.people.length, 2, `expected Steven + Alex, got ${doc.people.map((p) => p.name)}`);
  assert.equal(doc.people.find((p) => p.name === "Steven").id, "aaa", "kept the existing id");
  assert.deepEqual(report.peopleMatched, ["Steven"]);
  assert.deepEqual(report.peopleAdded, ["Alex"]);
});

test("colliding ids are reassigned and every reference follows", () => {
  const { doc } = mergeImport(household(), imported());
  const chore = doc.chores.find((c) => c.title === "Imported chore");
  assert.notEqual(chore.id, "c1", "an id already in use must not be reused");
  assert.equal(chore.personId, "aaa", "re-pointed at the existing Steven");
  assert.equal(chore.done["2026-07-01"], "aaa", "completion attribution followed the person");
  assert.equal(chore.done["2026-07-02"], "skipped", "skip markers are not person ids");

  const alex = doc.people.find((p) => p.name === "Alex");
  const rotating = doc.chores.find((c) => c.title === "Rotating chore");
  assert.deepEqual(rotating.rotation, ["aaa", alex.id]);
  assert.equal(doc.meals["2026-08-10"].dinner.find((m) => m.title === "Their dinner").cookId, alex.id);
});

test("no two things end up sharing an id", () => {
  const { doc } = mergeImport(household(), imported());
  const ids = [];
  for (const key of ["people", "chores", "tasks", "notes", "dateJars"]) {
    for (const item of doc[key] || []) ids.push(item.id);
  }
  assert.equal(new Set(ids).size, ids.length, "duplicate id after merge");
});

test("importing the same file repeatedly changes nothing after the first time", () => {
  // Somebody will do this -- to check it worked, or because they are not sure
  // it did. Doubling their chores as a reward would be unforgivable.
  const first = mergeImport(household(), imported()).doc;
  const second = mergeImport(first, imported()).doc;
  const third = mergeImport(second, imported()).doc;

  assert.equal(second.chores.length, first.chores.length);
  assert.equal(third.chores.length, first.chores.length);
  assert.equal(third.meals["2026-08-10"].dinner.length, first.meals["2026-08-10"].dinner.length);
  assert.equal(third.people.length, 2);
  assert.ok(third.chores.some((c) => c.title === "Existing chore"), "and the original is still there");
});

test("merging into an empty household just brings everything across", () => {
  const { doc } = mergeImport({}, imported());
  assert.equal(doc.people.length, 2);
  assert.equal(doc.chores.length, 2);
  assert.ok(doc.chores.every((c) => c.id));
});

test("the summary says what actually arrived", () => {
  const { report } = mergeImport(household(), imported());
  const lines = describeMerge(report).join("\n");
  assert.match(lines, /Alex/);
  assert.match(lines, /Steven/);
  assert.match(lines, /chores/);
});
