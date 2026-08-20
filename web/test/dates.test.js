// dates.test.js — important dates: urgency, and where they go once they pass.
//
// Ryan asked for two things about important dates:
//
//   "when an important date passes, then make it move to some sort of history"
//   "a week and under away, it needs to turn red ... two weeks out, another colour"
//
// Both are easy to implement and easy to implement *almost* right, which is why
// the boundaries are pinned here rather than eyeballed: 7 days must be red and
// 8 must not, an annual date must never fall into history however long ago it
// was first entered, and a one-off must leave the countdown the day after.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { urgencyOf, isUrgent, partitionDates, agoLabel, URGENCY } from "../src/lib/dates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const ESBUILD = join(WEB, "node_modules", "esbuild", "bin", "esbuild");

/* The same date helpers App.jsx uses, so the tests exercise the real
   arithmetic rather than a simplified stand-in that could agree with a bug. */
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s) => { const [y, m, dd] = s.split("-").map(Number); return new Date(y, m - 1, dd); };
const daysBetween = (a, b) => Math.round((parseYMD(b) - parseYMD(a)) / 86400000);
function nextOccurrence(dateStr, annual, todayKey) {
  if (!dateStr) return null;
  if (!annual) return dateStr;
  const d = parseYMD(dateStr), t = parseYMD(todayKey);
  let cand = ymd(new Date(t.getFullYear(), d.getMonth(), d.getDate()));
  if (cand < todayKey) cand = ymd(new Date(t.getFullYear() + 1, d.getMonth(), d.getDate()));
  return cand;
}
const split = (dates, todayKey) =>
  partitionDates(dates, todayKey, { resolve: nextOccurrence, diff: daysBetween });

/* ------------------------------------------------------------- urgency --- */

test("the urgency bands land exactly where they were asked to", () => {
  assert.equal(urgencyOf(0).key, "today");
  assert.equal(urgencyOf(1).key, "week");
  assert.equal(urgencyOf(7).key, "week", "a week away is still the red band");
  assert.equal(urgencyOf(8).key, "fortnight", "and eight days is not");
  assert.equal(urgencyOf(14).key, "fortnight", "two weeks is the far edge of amber");
  assert.equal(urgencyOf(15).key, "soon", "beyond that it is ordinary");
  assert.equal(urgencyOf(-1).key, "past");
});

test("red means red, and only for the week", () => {
  // The visual promise: two distinct treatments, not one that fades.
  assert.ok(isUrgent(urgencyOf(0)) && isUrgent(urgencyOf(7)));
  assert.ok(!isUrgent(urgencyOf(8)) && !isUrgent(urgencyOf(14)));
  assert.notEqual(URGENCY.week.key, URGENCY.fortnight.key,
    "one week and two weeks must be different bands, or the colours cannot differ");
});

test("an unreadable number of days is quiet, not urgent", () => {
  // Guessing loudly about a date we could not parse is the worse failure.
  for (const bad of [null, undefined, NaN]) assert.equal(urgencyOf(bad).key, "later");
});

/* ------------------------------------------------------------- history --- */

test("a one-off date leaves the countdown the day after it happens", () => {
  const dates = [{ id: "d1", title: "Closing day", date: "2026-08-20", annual: false }];

  let { upcoming, past } = split(dates, "2026-08-20");
  assert.equal(upcoming.length, 1, "on the day itself it is still upcoming");
  assert.equal(upcoming[0].days, 0);
  assert.equal(past.length, 0);

  ({ upcoming, past } = split(dates, "2026-08-21"));
  assert.equal(upcoming.length, 0, "the next day it is history");
  assert.equal(past.length, 1);
  assert.equal(past[0].days, -1);
});

test("an annual date never becomes history", () => {
  /* The failure this guards against: treating "the date is in the past" as
     "the date is over". A birthday first recorded in 2019 is not eleven years
     gone, it is next spring. */
  const dates = [{ id: "d1", title: "Ryan's birthday", date: "2019-04-11", annual: true }];
  const { upcoming, past } = split(dates, "2026-08-20");
  assert.equal(past.length, 0, "an anniversary is never over");
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].when, "2027-04-11", "it rolls forward to the next one");
  assert.ok(upcoming[0].days > 0);
});

test("an annual date on today is today, not next year", () => {
  const { upcoming } = split(
    [{ id: "d1", title: "Anniversary", date: "2015-08-20", annual: true }], "2026-08-20");
  assert.equal(upcoming[0].days, 0);
  assert.equal(upcoming[0].urgency.key, "today");
});

test("history is newest first, and the countdown is soonest first", () => {
  const dates = [
    { id: "a", title: "Far", date: "2026-12-01", annual: false },
    { id: "b", title: "Near", date: "2026-08-22", annual: false },
    { id: "c", title: "Old", date: "2020-01-01", annual: false },
    { id: "d", title: "Recent", date: "2026-08-01", annual: false },
  ];
  const { upcoming, past } = split(dates, "2026-08-20");
  assert.deepEqual(upcoming.map((d) => d.id), ["b", "a"], "soonest first");
  assert.deepEqual(past.map((d) => d.id), ["d", "c"], "most recent first");
});

test("partitioning survives rubbish in the list", () => {
  const { upcoming, past } = split(
    [null, undefined, {}, { id: "x", title: "Real", date: "2026-09-01" }], "2026-08-20");
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].id, "x");
  assert.equal(past.length, 0, "an entry with no date at all is not history");
});

test("ago labels read like a person wrote them", () => {
  assert.equal(agoLabel(0), "today");
  assert.equal(agoLabel(-1), "yesterday");
  assert.equal(agoLabel(-3), "3 days ago");
  assert.equal(agoLabel(-10), "last week");
  assert.equal(agoLabel(-400), "last year");
});

/* ------------------------------------------------------- it renders --- */

const ready = existsSync(ESBUILD);
const needs = { skip: ready ? false : "esbuild binary not found" };

function loadModule(entry, names) {
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-dates-"));
  const shim = join(dir, "entry.jsx");
  writeFileSync(shim, `export { ${names.join(", ")} } from ${JSON.stringify(join(WEB, entry))};\n`);
  const out = join(dir, "bundle.mjs");
  execFileSync(ESBUILD, [
    shim, "--bundle", "--format=esm", "--jsx=automatic", "--platform=node",
    "--external:react", "--external:react-dom", "--external:react/jsx-runtime",
    "--loader:.js=jsx", "--external:*.woff2", "--external:*.css",
    // lucide-react ships both CJS and ESM; under --platform=node esbuild picks
    // the CJS build, which then calls require("react") inside an ES module and
    // dies. Preferring the module field keeps the whole graph ESM.
    "--main-fields=module,main", "--conditions=import,module",
    "--define:import.meta.env={}", `--outfile=${out}`, "--log-level=error",
  ], { cwd: WEB });
  return import(pathToFileURL(out).href);
}

test("the countdown strip and the board actually draw", needs, async () => {
  /* Not a formality. Both of these were edited to read a new module and a new
     style table; either could reference something that does not exist, compile
     cleanly, and white-screen the app the moment somebody opens the board. */
  const { CountdownStrip, BoardView } = await loadModule("src/App.jsx",
    ["CountdownStrip", "BoardView"]);
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");

  const dates = [
    { id: "a", title: "Vet appointment", date: "2026-08-23", annual: false },   // 3d  -> red
    { id: "b", title: "Flights", date: "2026-08-31", annual: false },           // 11d -> amber
    { id: "c", title: "Anniversary", date: "2015-11-02", annual: true },        //     -> quiet
    { id: "d", title: "Closing day", date: "2026-07-04", annual: false },       //     -> history
  ];

  const strip = renderToStaticMarkup(
    React.createElement(CountdownStrip, { dates, todayKey: "2026-08-20" }));
  assert.match(strip, /Vet appointment/);
  assert.ok(strip.includes("#C1442E") || strip.toLowerCase().includes("rgb(193, 68, 46)"),
    "a date three days away must be drawn in the red band");
  assert.doesNotMatch(strip, /Closing day/, "a passed date is not a countdown");

  const board = renderToStaticMarkup(React.createElement(BoardView, {
    data: { dates, notes: [] },
    update: () => {}, personById: () => null, todayKey: "2026-08-20",
    openNote: () => {}, openDate: () => {},
  }));
  assert.match(board, /Vet appointment/);
  assert.match(board, /Show history/, "passed dates must be reachable, not deleted");
  assert.match(board, /history · 1/, "and counted");
});
