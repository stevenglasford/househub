// cadence.js — when a recurring chore is due, and whose it is that day.
//
// Three requests from Ryan land on the same piece of logic, so they are built
// together rather than bolted on separately:
//
//   "add a 'weekly' option and be able to select the day"
//   "an option to reset a start date ... I take the trash out today, but it
//    says it doesn't need to be done until tomorrow (every 2 days). I'd want to
//    say that I did it today and then adjust the pattern"
//   "if it's a rotating one, each person can choose a day or cadence"
//
// Weekly-with-days already existed, under the label "Certain days", which is
// why it was reported missing. The other two are new.
//
// The shapes:
//
//   { type: "daily" }
//   { type: "weekly",  days: [1, 4] }            0 = Sunday
//   { type: "monthly", dayOfMonth: 15 }
//   { type: "interval", everyN: 2, start: "YYYY-MM-DD" }
//   { type: "perPerson", people: { p1: {days:[1]}, p2: {days:[4]} } }
//
// PER-PERSON IS NOT A ROTATION WITH EXTRA STEPS
//
// An ordinary rotation works out whose turn it is from who went last. A
// per-person schedule works the other way round: the day decides the person.
// Steven has Mondays, Ryan has Thursdays, and neither missing their turn makes
// it the other's problem. That also avoids a circularity -- with a rotation,
// "when is it due" and "whose is it" would each need the other's answer.

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYMD = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
/* Weeks are counted from a Sunday, matching WEEKDAYS and the rest of the app.
   Only used for "every other week", where all that matters is that two dates in
   the same week land on the same number. */
const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; };
const weeksBetween = (a, b) => Math.round((weekStart(b) - weekStart(a)) / (7 * 86400000));

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const cadenceOf = (chore) => chore?.cadence || { type: "daily" };
export const isPerPerson = (chore) => cadenceOf(chore).type === "perPerson";

/** One person's schedule inside a per-person cadence. */
export const scheduleFor = (chore, personId) => {
  const people = cadenceOf(chore).people;
  const s = people && people[personId];
  return { days: Array.isArray(s?.days) ? s.days.filter((d) => d >= 0 && d <= 6) : [] };
};

/** Is this chore due on this day at all? */
/* ------------------------------------------------------------- pausing --- */
//
// Ryan: "instill a pause feature for chores in the case of which it's a
// seasonal one."
//
// Mowing the lawn is not a chore anybody skips from November to March; it is a
// chore that does not exist from November to March. The difference matters,
// because the alternative -- letting it come due and skipping it every week --
// buries five months of skips in the history and makes the "who is not pulling
// their weight" report lie.
//
// So a paused chore is NOT DUE, which also means it accrues nothing while it
// sleeps. That second part is the one that would have bitten: `oldestOwed`
// walks back looking for scheduled days nobody completed, so without this a
// lawn paused for the winter would resume in April with twenty overdue
// occurrences and a red badge.
//
// `annual` is what makes it seasonal rather than a one-off. Compared on
// month-and-day, and it handles a window that crosses the new year, because
// every genuinely seasonal pause does.

export const pauseOf = (chore) => (chore && chore.pause) || null;

const mmdd = (key) => String(key || "").slice(5); // "2026-11-01" -> "11-01"

/** Is this chore asleep on this day? */
export function isPausedOn(chore, dateKey) {
  const p = pauseOf(chore);
  if (!p || !dateKey) return false;

  if (p.annual) {
    const from = mmdd(p.from), until = mmdd(p.until), day = mmdd(dateKey);
    if (!from || !until) return false;
    // A window that does not cross the new year: November to March does, June
    // to August does not, and both have to work.
    return from <= until
      ? (day >= from && day <= until)
      : (day >= from || day <= until);
  }

  if (p.from && dateKey < p.from) return false;
  if (p.until && dateKey > p.until) return false;
  return Boolean(p.from || p.until || p.paused);
}

/** Pause from a day, optionally until another. No `until` means indefinitely. */
export function pauseChore(chore, { from, until = null, annual = false } = {}) {
  return { ...chore, pause: { from: from || null, until: until || null, annual: Boolean(annual), paused: true } };
}

/** Wake it up. Drops the pause entirely rather than leaving a spent one behind. */
export function resumeChore(chore) {
  const next = { ...chore };
  delete next.pause;
  return next;
}

/** "Paused until 1 April" / "Paused each year, 1 Nov – 31 Mar" / "" */
export function pauseLabel(chore, { todayKey } = {}) {
  const p = pauseOf(chore);
  if (!p) return "";
  const nice = (key) => {
    if (!key) return "";
    const [, m, d] = String(key).split("-");
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${Number(d)} ${MONTHS[Number(m) - 1] || ""}`.trim();
  };
  if (p.annual) return `Paused each year, ${nice(p.from)} – ${nice(p.until)}`;
  if (p.until) return `Paused until ${nice(p.until)}`;
  if (todayKey && p.from && p.from > todayKey) return `Pauses on ${nice(p.from)}`;
  return "Paused";
}

/* ------------------------------------------- moving one occurrence --- */
//
// Ryan: "there should be a 'reschedule this occurrence' of a chore if we want
// or need to push it to another day that week."
//
// One occurrence, not the schedule. Bins are Tuesdays; this week the lorry
// comes Wednesday. Changing the cadence would be wrong twice: it moves every
// future week, and it quietly rewrites what was expected of everybody.
//
// Stored as a map from the day it was scheduled to the day it moved to, which
// is what lets the move be undone and lets the history still say the occurrence
// belonged to Tuesday.

export const movedTo = (chore, dateKey) => (chore?.moved || {})[dateKey] || null;

export function movedFrom(chore, dateKey) {
  const moved = chore?.moved || {};
  for (const from of Object.keys(moved)) if (moved[from] === dateKey) return from;
  return null;
}

/** Push a scheduled occurrence to another day. Same day clears the move. */
export function moveOccurrence(chore, fromKey, toKey) {
  const moved = { ...(chore?.moved || {}) };
  if (!toKey || toKey === fromKey) delete moved[fromKey];
  else moved[fromKey] = toKey;
  const next = { ...chore, moved };
  if (!Object.keys(moved).length) delete next.moved;
  return next;
}

/** Forget moves for days already gone, so the map cannot grow forever. */
export function pruneMoves(chore, beforeKey) {
  const moved = chore?.moved || {};
  const kept = {};
  for (const [from, to] of Object.entries(moved)) {
    if (from >= beforeKey || to >= beforeKey) kept[from] = to;
  }
  const next = { ...chore, moved: kept };
  if (!Object.keys(kept).length) delete next.moved;
  return next;
}

export function dueOn(chore, dateKey) {
  /* A moved occurrence is checked before anything else, including the pause:
     somebody moved this deliberately and on purpose, and the day they moved it
     to is when they expect it. */
  if (movedFrom(chore, dateKey)) return true;
  if (movedTo(chore, dateKey)) return false;

  // Asleep. Not due, and -- because oldestOwed asks this same question -- not
  // accruing anything to be overdue about when it wakes.
  if (isPausedOn(chore, dateKey)) return false;

  const c = cadenceOf(chore);
  if (!c || c.type === "daily") return true;
  const d = parseYMD(dateKey);

  if (c.type === "weekly") {
    if (!(c.days || []).includes(d.getDay())) return false;
    /* "Every other Tuesday", and every third, and so on.
       
       Counted in whole weeks from an anchor rather than in days, because the
       alternative -- every 14 days from a start date -- drifts off the weekday
       the household chose the moment anybody completes it late. The week is the
       unit people actually mean. */
    const every = Math.max(1, Number(c.everyNWeeks) || 1);
    if (every === 1) return true;
    const anchor = parseYMD(c.anchor || dateKey);
    return weeksBetween(anchor, d) % every === 0;
  }

  /* A weekday of the month: "the first Monday", "the last Friday". Distinct
     from `monthly`, which is a date -- the 15th falls on a different weekday
     every month, and a chore like putting the bins out is a weekday, not a
     number. */
  if (c.type === "monthlyDay") {
    const dow = Number(c.dow ?? 1);
    if (d.getDay() !== dow) return false;
    const nth = Number(c.nth ?? 1);
    if (nth === -1) {
      // The last one of the month: no same weekday remains after this.
      return d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
    }
    return Math.floor((d.getDate() - 1) / 7) + 1 === nth;
  }

  if (c.type === "monthly") {
    const want = Math.min(c.dayOfMonth || 1, daysInMonth(d.getFullYear(), d.getMonth()));
    return d.getDate() === want;
  }

  if (c.type === "interval") {
    const n = Math.max(1, c.everyN || 2);
    const start = parseYMD(c.start || dateKey);
    const diff = Math.round((d - start) / 86400000);
    return diff >= 0 && diff % n === 0;
  }

  if (c.type === "perPerson") {
    // Due if it is anybody's day.
    return Object.values(c.people || {}).some((s) =>
      Array.isArray(s?.days) && s.days.includes(d.getDay()));
  }

  return true;
}

/**
 * Whose day this is, under a per-person schedule. Null for every other type,
 * so the ordinary rotation keeps deciding.
 *
 * If two people have claimed the same weekday -- which the editor allows,
 * because a chore two people do together is a real thing -- the order of the
 * rotation breaks the tie, so the answer is stable rather than depending on
 * object key order.
 */
export function scheduledPerson(chore, dateKey) {
  if (!isPerPerson(chore)) return null;
  const dow = parseYMD(dateKey).getDay();
  const people = cadenceOf(chore).people || {};
  const order = Array.isArray(chore?.rotation) && chore.rotation.length
    ? chore.rotation
    : Object.keys(people);

  for (const id of order) {
    const s = people[id];
    if (Array.isArray(s?.days) && s.days.includes(dow)) return id;
  }
  return null;
}

/* --------------------------------------------------------- resetting it --- */

/**
 * Re-anchor the schedule to a day it was actually done.
 *
 * Ryan's example: bins are every two days and today is an off day, but he took
 * them out anyway. Without this the app keeps insisting tomorrow, and the
 * schedule drifts further from reality every time somebody does it early.
 *
 * Only `interval` has an anchor to move. A weekly or monthly chore is pinned to
 * named days -- doing the bins on Wednesday does not make bin day Wednesday --
 * so those are returned untouched, and `canResetAnchor` says so in advance
 * rather than offering a control that does nothing.
 */
export const canResetAnchor = (chore) => cadenceOf(chore).type === "interval";

export function resetAnchor(chore, dateKey) {
  if (!canResetAnchor(chore)) return chore;
  return { ...chore, cadence: { ...cadenceOf(chore), start: dateKey } };
}

/** The next day this chore comes round after re-anchoring to `dateKey`. */
export function nextAfterReset(chore, dateKey) {
  const c = cadenceOf(chore);
  if (c.type !== "interval") return null;
  const n = Math.max(1, c.everyN || 2);
  const d = parseYMD(dateKey);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/* ----------------------------------------------------------- describing --- */

/** A plain-English cadence, for the row and the editor. */
export function describeCadence(chore, personName) {
  const c = cadenceOf(chore);
  switch (c.type) {
    case "daily": return "Every day";
    case "weekly": {
      const days = (c.days || []).slice().sort();
      if (!days.length) return "Weekly";
      const every = Math.max(1, Number(c.everyNWeeks) || 1);
      if (days.length === 7 && every === 1) return "Every day";
      const named = days.map((d) => WEEKDAYS[d]).join(", ");
      if (every === 1) return `Every ${named}`;
      if (every === 2) return `Every other ${named}`;
      return `Every ${ordinal(every)} week, on ${named}`;
    }
    case "monthly": return `Monthly, on the ${ordinal(c.dayOfMonth || 1)}`;
    case "monthlyDay": {
      const day = WEEKDAYS[Number(c.dow ?? 1)] || "Monday";
      const nth = Number(c.nth ?? 1);
      return nth === -1 ? `Monthly, the last ${day}` : `Monthly, the ${ordinal(nth)} ${day}`;
    }
    case "interval": {
      const n = Math.max(1, c.everyN || 2);
      return n === 1 ? "Every day" : `Every ${n} days`;
    }
    case "perPerson": {
      const entries = Object.entries(c.people || {})
        .filter(([, s]) => Array.isArray(s?.days) && s.days.length);
      if (!entries.length) return "Nobody has a day yet";
      if (personName) {
        return entries
          .map(([id, s]) => `${personName(id) || "?"}: ${s.days.slice().sort().map((d) => WEEKDAYS[d]).join(", ")}`)
          .join(" · ");
      }
      return `${entries.length} people, own days`;
    }
    default: return "Every day";
  }
}

export function ordinal(n) {
  const v = Number(n) || 1;
  const s = ["th", "st", "nd", "rd"][(v % 100 - 20) % 10] || ["th", "st", "nd", "rd"][v % 100] || "th";
  return `${v}${s}`;
}

/** Toggle one weekday in a list, keeping it sorted. */
export const toggleDay = (days, dow) =>
  (Array.isArray(days) && days.includes(dow)
    ? days.filter((d) => d !== dow)
    : [...(days || []), dow]).sort((a, b) => a - b);

/** Set one person's days inside a per-person cadence. */
export function setPersonDays(chore, personId, days) {
  const c = cadenceOf(chore);
  const people = { ...(c.people || {}) };
  const clean = (days || []).filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (clean.length) people[personId] = { days: clean };
  else delete people[personId];
  return { ...chore, cadence: { ...c, type: "perPerson", people } };
}
