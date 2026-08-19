// status.js — turning nightly check-ins into something you can look at.
//
// The check-in has always shown one evening at a time, which answers "how was
// tonight" and nothing else. What a household actually wants to know is whether
// things are drifting, and that only shows up across weeks.
//
// Split out of the component so the arithmetic can be tested. The judgements
// here are small but they are judgements, and getting them wrong would put words
// like "declining" in front of two people about their own relationship.

export const STATUS_DIMENSIONS = ["happiness", "connection", "intimacy"];

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Break a line rather than draw through a silence this long. */
export const gapDaysFor = (windowDays) => Math.max(3, Math.round(windowDays / 10));

/**
 * One series of { x, y, date } per person, oldest first.
 *
 * `dimension` is one of STATUS_DIMENSIONS, or "average" for the mean of all
 * three. Days nobody recorded are simply absent -- not zero, and not carried
 * forward from the day before. A missing evening is missing, and drawing it as
 * anything else invents a mood nobody reported.
 */
export function buildSeries(status, people, { todayKey, days, dimension = "average" }) {
  const [y, m, d] = String(todayKey).split("-").map(Number);
  const end = new Date(y, m - 1, d);
  const series = new Map(people.map((p) => [p.id, []]));
  let count = 0;

  for (let i = days - 1; i >= 0; i--) {
    const key = ymd(addDays(end, -i));
    const day = status?.[key];
    if (!day) continue;
    for (const person of people) {
      const entry = day[person.id];
      if (!entry) continue;
      const value = scoreOf(entry, dimension);
      if (value === null) continue;
      series.get(person.id).push({ x: days - 1 - i, y: value, date: key });
      count++;
    }
  }
  return { series, count };
}

/** One person's score for a dimension, or null if they did not record it. */
export function scoreOf(entry, dimension) {
  if (!entry) return null;
  if (dimension !== "average") {
    const n = Number(entry[dimension]);
    return n >= 1 && n <= 5 ? n : null;
  }
  const values = STATUS_DIMENSIONS
    .map((k) => Number(entry[k]))
    .filter((n) => n >= 1 && n <= 5);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Split a series into runs, so a stretch with no check-ins becomes a gap in the
 * line rather than a confident straight segment drawn across it.
 */
export function splitRuns(points, gapDays) {
  if (!points.length) return [];
  const runs = [];
  let run = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].x - points[i - 1].x > gapDays) { runs.push(run); run = []; }
    run.push(points[i]);
  }
  runs.push(run);
  return runs;
}

/**
 * Which way a series is heading: the first third against the last third.
 *
 * Not a fitted slope. With a handful of sparse points a regression line reads as
 * far more certain than the data supports, and this is a household's own account
 * of how they have been -- overstating it is worse than saying nothing.
 *
 * Anything inside half a point is "steady", so one tired evening does not get
 * reported back to somebody as a decline.
 */
export function trend(points) {
  if (points.length < 4) return { direction: "unknown", delta: 0, label: "" };
  const third = Math.max(1, Math.floor(points.length / 3));

  /* Median rather than mean, and this is the whole reason the function has a
     test. With a mean, nineteen good evenings and one bad one gives a delta of
     exactly -0.5 and gets reported back to a household as a decline. One rough
     night is not a trend, and being told otherwise by software about your own
     relationship is worse than being told nothing. The median ignores the
     single outlier and still moves for a real drift. */
  const median = (arr) => {
    const ys = arr.map((p) => p.y).sort((a, b) => a - b);
    const mid = Math.floor(ys.length / 2);
    return ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
  };
  const delta = median(points.slice(-third)) - median(points.slice(0, third));

  if (Math.abs(delta) < 0.5) return { direction: "steady", delta, label: "· steady" };
  return delta > 0
    ? { direction: "up", delta, label: `· up ${delta.toFixed(1)}` }
    : { direction: "down", delta, label: `· down ${Math.abs(delta).toFixed(1)}` };
}
