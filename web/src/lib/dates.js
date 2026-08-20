// dates.js — important dates: how close they are, and where they go afterwards.
//
// Two things Ryan asked for that are really one idea. A date matters more as it
// approaches and stops mattering once it is behind you, and the board treated
// every date the same until the moment it silently disappeared.
//
//   * a week or less  -- red, and hard to miss
//   * two weeks       -- amber, visible but not alarming
//   * further out     -- the ordinary style
//   * already past    -- out of the countdown, into a history you can still read
//
// Annual dates never enter the history: a birthday that has passed is not over,
// it is eleven months away, and `nextOccurrence` already rolls it forward. Only
// one-off dates -- a trip, a closing date, an appointment -- can actually end.

/** Urgency bands, nearest first. `key` is what the UI styles on. */
export const URGENCY = {
  today:     { key: "today",     within: 0,   label: "Today" },
  week:      { key: "week",      within: 7,   label: "This week" },
  fortnight: { key: "fortnight", within: 14,  label: "Two weeks" },
  soon:      { key: "soon",      within: 60,  label: "Coming up" },
  later:     { key: "later",     within: Infinity, label: "Later" },
  past:      { key: "past",      within: -1,  label: "Passed" },
};

/**
 * Which band a number of days away falls into.
 *
 * `days` is whole days from today: 0 is today, 1 tomorrow, negative is behind
 * us. Null (a date that could not be read) is treated as "later" rather than as
 * urgent -- guessing loud about a date we do not understand is the worse error.
 */
export function urgencyOf(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return URGENCY.later;
  if (days < 0) return URGENCY.past;
  if (days === 0) return URGENCY.today;
  if (days <= 7) return URGENCY.week;
  if (days <= 14) return URGENCY.fortnight;
  if (days <= 60) return URGENCY.soon;
  return URGENCY.later;
}

/**
 * Is this band one the UI should shout about?
 *
 * Kept separate from the colours so that "which dates are urgent" is one
 * decision made in one place, rather than a `days <= 7` repeated at each call
 * site and drifting apart.
 */
export const isUrgent = (band) => band.key === "today" || band.key === "week";

/**
 * Split dates into what is ahead and what is behind.
 *
 * `resolve(date)` returns the next occurrence for a date (annual ones roll
 * forward), and `diff(a, b)` returns whole days between two YYYY-MM-DD keys --
 * both injected so this module carries no date arithmetic of its own and can be
 * tested without it.
 */
export function partitionDates(dates, todayKey, { resolve, diff }) {
  const upcoming = [];
  const past = [];

  for (const d of dates || []) {
    if (!d) continue;
    const when = resolve(d.date, d.annual, todayKey);

    /* An annual date always has a next occurrence, so it is never history. A
       one-off whose date has gone by resolves to nothing, and that is what
       moves it across. */
    if (!when) {
      if (d.date) past.push({ ...d, when: d.date, days: diff(todayKey, d.date) });
      continue;
    }
    const days = diff(todayKey, when);
    if (days < 0) past.push({ ...d, when, days });
    else upcoming.push({ ...d, when, days, urgency: urgencyOf(days) });
  }

  upcoming.sort((a, b) => a.days - b.days);
  past.sort((a, b) => b.when.localeCompare(a.when));   // most recent first
  return { upcoming, past };
}

/** "3 days ago", "last year" — for the history list. */
export function agoLabel(days) {
  const n = Math.abs(days);
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 7) return `${n} days ago`;
  if (n < 14) return "last week";
  if (n < 31) return `${Math.round(n / 7)} weeks ago`;
  if (n < 365) return `${Math.round(n / 30)} months ago`;
  const years = Math.round(n / 365);
  return years <= 1 ? "last year" : `${years} years ago`;
}
