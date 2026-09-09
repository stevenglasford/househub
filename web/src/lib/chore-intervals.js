// chore-intervals.js — how long it actually goes between doings.
//
// Ryan: "we want to see the amount of time between when different chores have
// been completed. something like the filling the cat feeder and are trying to
// figure out on average how many days in between when it needs to get refilled."
//
// This is a different question from the schedule, and the interesting one. The
// schedule says what the household intended; this says what the house actually
// needs. A feeder set to "every 4 days" and refilled every 2.5 is a feeder on
// the wrong schedule, and nothing in the app could previously say so.
//
// Two numbers, because they answer differently when a run is uneven:
//
//   MEDIAN is the honest "typically". One fortnight away from home puts a
//   14-day gap in a 3-day chore and drags the mean up by enough to make it
//   useless, which is exactly the shape household data has.
//
//   MEAN is still worth showing next to it. Where the two disagree, that gap
//   is itself the information -- it means the run is lumpy rather than regular.
//
// Skips are not completions and are excluded. A skipped bin day is not evidence
// about how often the bins fill up.

const isCompletionMark = (v) => Boolean(v) && v !== "skipped"
  && !(v && typeof v === "object" && v.skipped);

const DAY = 86400000;

/** Days between two YYYY-MM-DD keys. */
export function daysBetweenKeys(a, b) {
  const [ay, am, ad] = String(a).split("-").map(Number);
  const [by, bm, bd] = String(b).split("-").map(Number);
  if (!ay || !by) return 0;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY);
}

/** Every day this chore was actually completed, oldest first. */
export function completionDates(chore) {
  return Object.entries(chore?.done || {})
    .filter(([, v]) => isCompletionMark(v))
    .map(([k]) => k)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
}

/** The gap in days between each completion and the one before it. */
export function gaps(chore) {
  const dates = completionDates(chore);
  const out = [];
  for (let i = 1; i < dates.length; i++) out.push(daysBetweenKeys(dates[i - 1], dates[i]));
  return out.filter((n) => n > 0);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * What the record says about how often this chore actually comes round.
 *
 * `null` for `typicalDays` until there are at least two completions to measure
 * between -- one completion is a date, not an interval, and reporting "every 0
 * days" from it would be worse than saying nothing.
 */
export function intervalStats(chore, todayKey = null) {
  const dates = completionDates(chore);
  const g = gaps(chore);
  const last = dates.length ? dates[dates.length - 1] : null;

  return {
    count: dates.length,
    first: dates.length ? dates[0] : null,
    last,
    daysSince: last && todayKey ? daysBetweenKeys(last, todayKey) : null,
    typicalDays: median(g),
    averageDays: g.length ? g.reduce((a, b) => a + b, 0) / g.length : null,
    shortestDays: g.length ? Math.min(...g) : null,
    longestDays: g.length ? Math.max(...g) : null,
    samples: g.length,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Round to one decimal, but print whole numbers whole. */
export const tidy = (n) => (n === null || n === undefined ? "" : String(Math.round(n * 10) / 10));

/**
 * A sentence for the chore sheet.
 *
 * Deliberately says "usually" rather than giving a false precision: this is a
 * handful of samples from a household, not a measurement.
 */
export function describeInterval(stats) {
  if (!stats || !stats.count) return "Not done yet, so there is nothing to measure.";
  if (stats.samples < 1) {
    return `Done once, on ${stats.last}. One more and this can say how often.`;
  }
  const typical = `usually every ${plural(Number(tidy(stats.typicalDays)), "day")}`;
  const spread = stats.shortestDays === stats.longestDays
    ? ""
    : ` — between ${stats.shortestDays} and ${stats.longestDays}`;
  return `${typical}${spread}, over ${plural(stats.samples + 1, "time")}.`;
}

/**
 * Whether the schedule and the reality disagree enough to be worth saying.
 *
 * Only for interval chores, where "every N days" is a claim this can be checked
 * against. Quiet unless the gap is real: a chore set to 4 days and done every
 * 3.6 is not news, and an app that says so every time is one nobody reads.
 */
export function scheduleDrift(chore, stats) {
  const c = chore?.cadence;
  if (!c || c.type !== "interval" || !stats || stats.typicalDays === null) return null;
  if (stats.samples < 3) return null;                 // too few to claim anything
  const planned = Math.max(1, c.everyN || 2);
  const actual = stats.typicalDays;
  const ratio = actual / planned;
  if (ratio > 0.75 && ratio < 1.33) return null;      // close enough
  return {
    planned,
    actual,
    faster: actual < planned,
  };
}
