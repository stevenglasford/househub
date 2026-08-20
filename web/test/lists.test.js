// lists.test.js — shared running lists.
//
// Ryan asked for "notes or running lists for random things, similar to the notes
// app in icloud", manageable in the hub or through a native app.
//
// The native half needs stating plainly, because the obvious reading is wrong:
// Apple Notes has no third-party sync surface at all — no CloudKit access, no
// CalDAV equivalent. Apple *Reminders* does, over CalDAV VTODO, and a list here
// maps onto one exactly. So toVTodos is tested as the thing that makes the
// "manage it in the native app" half real.

import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/lib/lists.js";

const build = (...items) => items.reduce((l, t) => L.addItem(l, t), L.createList("Packing"));

test("a list keeps the order things were added", () => {
  // Aisle order, or the order you actually pack. Sorting destroys information.
  const l = build("Socks", "Passport", "Charger");
  assert.deepEqual(L.itemsOf(l).map((i) => i.text), ["Socks", "Passport", "Charger"]);
});

test("blank items are refused rather than stored", () => {
  let l = L.createList("X");
  const before = L.itemsOf(l).length;
  l = L.addItem(l, "   ");
  l = L.addItem(l, "");
  assert.equal(L.itemsOf(l).length, before);
});

test("ticking an item records when, and unticking clears it", () => {
  const l = build("Socks");
  const id = L.itemsOf(l)[0].id;
  const ticked = L.toggleItem(l, id, { at: 1000 });
  assert.equal(L.itemsOf(ticked)[0].done, true);
  assert.equal(L.itemsOf(ticked)[0].doneAt, 1000);

  const back = L.toggleItem(ticked, id, { at: 2000 });
  assert.equal(L.itemsOf(back)[0].done, false);
  assert.equal(L.itemsOf(back)[0].doneAt, null, "an unticked item was not done at any time");
});

test("an item cannot be renamed into nothing", () => {
  // Deleting is a separate act; a stray select-all-delete should not silently
  // destroy the row and leave a blank line.
  const l = build("Socks");
  const id = L.itemsOf(l)[0].id;
  assert.equal(L.itemsOf(L.editItem(l, id, { text: "  " }))[0].text, "Socks");
  assert.equal(L.itemsOf(L.editItem(l, id, { text: " Wool socks " }))[0].text, "Wool socks");
});

test("moving an item is clamped to the list", () => {
  const l = build("A", "B", "C");
  const c = L.itemsOf(l)[2].id;
  assert.deepEqual(L.itemsOf(L.moveItem(l, c, 0)).map((i) => i.text), ["C", "A", "B"]);
  assert.deepEqual(L.itemsOf(L.moveItem(l, c, 99)).map((i) => i.text), ["A", "B", "C"], "past the end stays at the end");
  assert.deepEqual(L.itemsOf(L.moveItem(l, c, -5)).map((i) => i.text), ["C", "A", "B"], "before the start is the start");
  assert.equal(L.moveItem(l, "nope", 0), l, "an unknown id changes nothing");
});

test("progress is null for an empty list", () => {
  // "0/0" on an empty list is noise, not information.
  assert.equal(L.listProgress(L.createList("Empty")), null);
  const l = L.toggleItem(build("A", "B"), L.itemsOf(build("A", "B"))[0].id);
  assert.equal(L.listProgress(build("A", "B")).total, 2);
});

test("clearing done leaves the list alone when nothing is ticked", () => {
  const l = build("A", "B");
  assert.equal(L.clearDone(l), l, "same object — nothing was written, so nothing syncs");
  const ticked = L.toggleItem(l, L.itemsOf(l)[0].id);
  assert.equal(L.itemsOf(L.clearDone(ticked)).length, 1);
});

test("updatedOn moves only when the list actually changed", () => {
  const l = L.addItem(L.createList("X", { at: 1 }), "A", { at: 5 });
  assert.equal(l.updatedOn, 5);
  assert.equal(L.addItem(l, "  ", { at: 9 }).updatedOn, 5, "a refused add is not a change");
});

/* ------------------------------------------------ the collection of lists --- */

test("lists are added, replaced and removed without touching the others", () => {
  const a = L.createList("A"), b = L.createList("B");
  let data = L.upsertList(L.upsertList({ lists: [] }, a), b);
  assert.equal(L.listsOf(data).length, 2);

  data = L.upsertList(data, { ...a, title: "A2" });
  assert.equal(L.listsOf(data).length, 2, "upserting an existing list replaces it");
  assert.equal(L.listsOf(data).find((l) => l.id === a.id).title, "A2");
  assert.equal(L.listsOf(data).find((l) => l.id === b.id).title, "B", "the other is untouched");

  data = L.removeList(data, a.id);
  assert.deepEqual(L.listsOf(data).map((l) => l.title), ["B"]);
});

test("withList changes one list and leaves an unknown id alone", () => {
  const a = L.createList("A"), b = L.createList("B");
  const data = { lists: [a, b] };
  const out = L.withList(data, a.id, (l) => L.addItem(l, "Thing"));
  assert.equal(L.itemsOf(L.listsOf(out)[0]).length, 1);
  assert.equal(L.itemsOf(L.listsOf(out)[1]).length, 0);
  assert.equal(L.withList(data, "nope", () => null), data);
});

/* ------------------------------------------------------------- exporting --- */

test("a list becomes VTODOs that Reminders understands", () => {
  let l = build("Socks", "Passport");
  l = L.toggleItem(l, L.itemsOf(l)[0].id);
  const todos = L.toVTodos(l);

  assert.equal(todos.length, 2);
  assert.match(todos[0], /^BEGIN:VTODO/m);
  assert.match(todos[0], /STATUS:COMPLETED/);
  assert.match(todos[1], /STATUS:NEEDS-ACTION/);
  assert.match(todos[0], /X-APPLE-SORT-ORDER:0/);
  assert.match(todos[1], /X-APPLE-SORT-ORDER:1/, "position survives a client that sorts");
});

test("the UID is stable, so re-exporting updates rather than duplicates", () => {
  const l = build("Socks");
  const id = L.itemsOf(l)[0].id;
  assert.equal(L.todoUid(l.id, id), L.todoUid(l.id, id));
  assert.match(L.toVTodos(l)[0], new RegExp(`UID:${L.todoUid(l.id, id)}`));
});

test("separators in an item cannot break the exported field", () => {
  /* A comma or semicolon is a field separator in iCalendar. Unescaped, "milk,
     eggs; bread" silently truncates in a strict parser. */
  const l = L.addItem(L.createList("Shop"), "milk, eggs; bread");
  const out = L.toVTodos(l)[0];
  const summary = out.split("\r\n").find((x) => x.startsWith("SUMMARY:"));
  const B = String.fromCharCode(92);
  assert.equal(summary, `SUMMARY:milk${B}, eggs${B}; bread`);
});

test("escaping covers backslash, comma, semicolon and newline", () => {
  const B = String.fromCharCode(92);
  assert.equal(L.escapeICS("a,b"), `a${B},b`);
  assert.equal(L.escapeICS("a;b"), `a${B};b`);
  assert.equal(L.escapeICS("a\nb"), `a${B}nb`);
  assert.equal(L.escapeICS(`a${B}b`), `a${B}${B}b`);
});
