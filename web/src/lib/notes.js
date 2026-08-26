// notes.js — sticky notes that come down on their own, and remember they were up.
//
// Ryan: "Set end date on a sticky note. Keep a history of them that tracks the
// dates that they were displayed for on top of the other things the notes
// already contain."
//
// The board fills with notes that mattered for a week in March. Taking one down
// by hand means noticing it, and nobody notices a note they have walked past
// thirty times -- it stops being information and becomes wallpaper.
//
// So a note can carry an end date. Past it, the note leaves the board and joins
// a history that records the span it was up for, which is the second half of the
// request: what was on the fridge in March is a real question, and deleting the
// note is the only thing that could answer it today.
//
//   note = { id, text, color, personId, at, from, until }
//
// `from` defaults to when it was written and `until` is optional, so every note
// that already exists keeps behaving exactly as it does now.

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };

/** The day a note went up. Falls back to when it was written. */
export function startedOn(note) {
  if (note?.from) return note.from;
  if (typeof note?.at === "number") return ymd(new Date(note.at));
  return "";
}

/**
 * Is this note still on the board on this day?
 *
 * `until` is INCLUSIVE -- a note set to end on the 14th is up all of the 14th
 * and gone on the 15th. The other reading is defensible but it is not what
 * anybody means when they write a date on a note.
 */
export function isUp(note, todayKey) {
  if (!note) return false;
  const from = startedOn(note);
  if (from && todayKey < from) return false;
  if (note.until && todayKey > note.until) return false;
  return true;
}

export const hasExpired = (note, todayKey) => Boolean(note?.until) && todayKey > note.until;

/** How many days a note has left, or null when it has no end date. */
export function daysLeft(note, todayKey) {
  if (!note?.until) return null;
  return Math.round((parseYMD(note.until) - parseYMD(todayKey)) / 86400000);
}

/** Split the board into what is showing and what has come down. */
export function partitionNotes(notes, todayKey) {
  const up = [], down = [];
  for (const n of notes || []) {
    if (!n) continue;
    (isUp(n, todayKey) ? up : down).push(n);
  }
  // Newest first in the history: the thing that just came down is the thing
  // somebody is most likely looking for.
  down.sort((a, b) => String(startedOn(b)).localeCompare(String(startedOn(a))));
  return { up, down };
}

/**
 * How long a note was up, as a span for the history list.
 *
 * A note still up says so rather than pretending to have ended today, and one
 * with no end date at all reports an open span. Both are honest about what is
 * actually known, which matters more here than a tidy uniform label.
 */
export function displayedSpan(note, todayKey) {
  const from = startedOn(note);
  if (!from) return { from: "", to: "", days: null, open: true };

  const end = note.until && note.until < todayKey ? note.until : todayKey;
  const days = Math.max(1, Math.round((parseYMD(end) - parseYMD(from)) / 86400000) + 1);
  return {
    from,
    to: note.until || "",
    days,
    open: !note.until || note.until >= todayKey,
  };
}

/** "3 days", "1 day", "6 weeks" — for the history row. */
export function spanLabel(days) {
  if (days === null || days === undefined) return "";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

/** A sensible default end date offered in the editor: a fortnight out. */
export function suggestedUntil(todayKey, days = 14) {
  const d = parseYMD(todayKey);
  d.setDate(d.getDate() + days);
  return ymd(d);
}
