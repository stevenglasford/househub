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
export function dueOn(chore, dateKey) {
  const c = cadenceOf(chore);
  if (!c || c.type === "daily") return true;
  const d = parseYMD(dateKey);

  if (c.type === "weekly") return (c.days || []).includes(d.getDay());

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
      if (days.length === 7) return "Every day";
      return `Every ${days.map((d) => WEEKDAYS[d]).join(", ")}`;
    }
    case "monthly": return `Monthly, on the ${ordinal(c.dayOfMonth || 1)}`;
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
