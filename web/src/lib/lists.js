// lists.js — shared running lists, the notes-app-shaped hole in the hub.
//
// Ryan: "Make another list tab that allows us the ability to make some notes or
// running lists for random things, similar to the notes app in icloud. or
// better yet, make it so that we can add shared lists to the hub and we can
// manage them either in the hub or through the native Notes app."
//
// On the second half: Apple Notes has no sync API of any kind. There is no
// CloudKit surface for it, no CalDAV/CardDAV equivalent, nothing a third party
// can write to. Apple *Reminders* is different -- it is CalDAV VTODO, and a
// list here maps onto one cleanly. So the honest answer is that lists sync with
// Reminders rather than Notes, and `toVTodos` below is what makes that possible;
// see services/caldav.js for the transport.
//
// The model is deliberately close to a paper list:
//
//   list  = { id, title, icon, color, items[], createdOn, updatedOn }
//   item  = { id, text, done, note, doneAt, createdAt }
//
// Items keep their position rather than sorting themselves. A shopping list in
// aisle order, or a packing list in the order you actually pack, is information
// that sorting destroys.

const newId = () => Math.random().toString(36).slice(2, 9);
const nowStamp = (at) => (typeof at === "number" ? at : Date.now());

export const LIST_ICONS = ["list", "cart", "plane", "home", "gift", "book", "tool", "heart"];

/* ------------------------------------------------------------- the list --- */

export function createList(title, { icon = "list", color = "", at } = {}) {
  const text = String(title || "").trim();
  return {
    id: newId(),
    title: text || "Untitled list",
    icon: LIST_ICONS.includes(icon) ? icon : "list",
    color: color || "",
    items: [],
    createdOn: nowStamp(at),
    updatedOn: nowStamp(at),
  };
}

export const itemsOf = (list) => (Array.isArray(list?.items) ? list.items : []);

/** Done / total, or null for an empty list — a "0/0" badge says nothing. */
export function listProgress(list) {
  const items = itemsOf(list);
  if (!items.length) return null;
  return { done: items.filter((i) => i.done).length, total: items.length };
}

const touch = (list, items, at) => ({ ...list, items, updatedOn: nowStamp(at) });

/* ------------------------------------------------------------- the items --- */

export function addItem(list, text, { at } = {}) {
  const t = String(text || "").trim();
  if (!t) return list;
  return touch(list, [...itemsOf(list), {
    id: newId(), text: t, done: false, note: "", doneAt: null, createdAt: nowStamp(at),
  }], at);
}

export function toggleItem(list, itemId, { at } = {}) {
  return touch(list, itemsOf(list).map((i) =>
    i.id === itemId ? { ...i, done: !i.done, doneAt: i.done ? null : nowStamp(at) } : i), at);
}

export function editItem(list, itemId, patch, { at } = {}) {
  return touch(list, itemsOf(list).map((i) => {
    if (i.id !== itemId) return i;
    const next = { ...i, ...patch };
    if (typeof next.text === "string") next.text = next.text.trim();
    // An item cannot be renamed into nothing; deleting is a separate act.
    return next.text ? next : i;
  }), at);
}

export function removeItem(list, itemId, { at } = {}) {
  return touch(list, itemsOf(list).filter((i) => i.id !== itemId), at);
}

/**
 * Move an item to a new index.
 *
 * Order is meaningful -- aisle order, packing order -- so it is preserved
 * everywhere else and only changes here, deliberately.
 */
export function moveItem(list, itemId, toIndex, { at } = {}) {
  const items = [...itemsOf(list)];
  const from = items.findIndex((i) => i.id === itemId);
  if (from === -1) return list;
  const clamped = Math.max(0, Math.min(items.length - 1, toIndex));
  const [row] = items.splice(from, 1);
  items.splice(clamped, 0, row);
  return touch(list, items, at);
}

/** Clear the ticked items. Returns the list unchanged when none are ticked. */
export function clearDone(list, { at } = {}) {
  const items = itemsOf(list);
  const kept = items.filter((i) => !i.done);
  return kept.length === items.length ? list : touch(list, kept, at);
}

/* ------------------------------------------------- the collection of lists --- */

export const listsOf = (data) => (Array.isArray(data?.lists) ? data.lists : []);

export function upsertList(data, list) {
  const lists = listsOf(data);
  const i = lists.findIndex((l) => l.id === list.id);
  return { ...data, lists: i === -1 ? [...lists, list] : lists.map((l) => (l.id === list.id ? list : l)) };
}

export function removeList(data, listId) {
  return { ...data, lists: listsOf(data).filter((l) => l.id !== listId) };
}

/** Apply a change to one list, leaving the others alone. */
export function withList(data, listId, fn) {
  const lists = listsOf(data);
  const found = lists.find((l) => l.id === listId);
  if (!found) return data;
  return { ...data, lists: lists.map((l) => (l.id === listId ? fn(l) : l)) };
}

/* ------------------------------------------------------------- exporting --- */

/**
 * A list as CalDAV VTODOs — the shape Apple Reminders understands.
 *
 * One VTODO per item, carrying a stable UID derived from the ids so that
 * re-exporting updates the same task rather than creating a duplicate. Escaping
 * matters: a comma or semicolon in somebody's shopping list is a field
 * separator in iCalendar, and an unescaped one silently truncates the text.
 */
export const escapeICS = (v) => String(v == null ? "" : v)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

export const todoUid = (listId, itemId) => `hh-list-${listId}-${itemId}`;

export function toVTodos(list, { stamp = "20260101T000000Z" } = {}) {
  return itemsOf(list).map((item, i) => [
    "BEGIN:VTODO",
    `UID:${todoUid(list.id, item.id)}`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeICS(item.text)}`,
    item.note ? `DESCRIPTION:${escapeICS(item.note)}` : null,
    `STATUS:${item.done ? "COMPLETED" : "NEEDS-ACTION"}`,
    // Position, so the order survives a round trip through a client that sorts.
    `X-APPLE-SORT-ORDER:${i}`,
    "END:VTODO",
  ].filter(Boolean).join("\r\n"));
}
