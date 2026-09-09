// timers.js — named kitchen timers, shared across every screen in the house.
//
// Ryan: "add a timer ... activated by voice and the ability to set multiple
// times that are named and also have an audio alarm go off with each."
//
// Three requirements, and the third is what shapes the data.
//
// MULTIPLE AND NAMED is why a timer is a row in a list rather than a single
// field: "12 minutes" on a wall display tells you nothing at the moment two
// things are cooking, which is the only moment anybody needs a second timer.
//
// SHARED is the harder one. A timer set in the kitchen has to be visible from a
// phone, and silencing the alarm anywhere has to quiet the tablet too -- the
// same property reminder snoozes already have, and for the same reason: nobody
// wants to dismiss one alarm once per screen in the house.
//
// So nothing here stores "running" or "ringing" as a flag. A flag has to be
// written by somebody, and the somebody would be whichever browser happened to
// notice first -- on a wall tablet that has been asleep, that is nobody. Every
// state below is *derived* from two absolute timestamps, so a screen that was
// off for an hour computes the same answer as one that watched the whole
// countdown, without either having to tell the other anything.
//
// The cost of absolute timestamps is clock skew between devices. A phone two
// minutes off will show a countdown two minutes out. That is the right trade
// for a kitchen timer -- the alternative is a sync protocol for something whose
// whole job is to be correct within a second or two of an egg -- but it is a
// real limitation and worth knowing before somebody debugs it as a bug.

/** Sensible default when a duration cannot be worked out. */
export const DEFAULT_MS = 5 * 60 * 1000;

/** Nothing longer than a day: past that it is an event, not a timer. */
export const MAX_MS = 24 * 60 * 60 * 1000;

/* ----------------------------------------------------------------- shape --- */

/**
 * A new timer, already running.
 *
 * `endsAt` is absolute rather than a duration plus a start, because that is
 * what makes the countdown survive a screen being asleep: there is nothing to
 * decrement and so nothing to miss.
 */
export function newTimer({ label = "", durationMs = DEFAULT_MS, personId = "", now = Date.now(), id } = {}) {
  const ms = clampDuration(durationMs);
  return {
    id: id || `tm${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    label: String(label || "").slice(0, 60),
    durationMs: ms,      // kept so the timer can be run again without retyping
    startedAt: now,
    endsAt: now + ms,
    pausedAt: 0,         // epoch ms while paused, 0 while running
    remainingMs: 0,      // frozen countdown, meaningful only while paused
    silencedAt: 0,       // set when somebody stops the alarm -- shared, so one tap quiets every screen
    personId,
  };
}

export const clampDuration = (ms) => {
  const n = Math.round(Number(ms) || 0);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MS;
  return Math.min(n, MAX_MS);
};

/* ----------------------------------------------------------------- state --- */

/** Milliseconds left, floored at zero. Frozen while paused. */
export function remainingMs(t, now = Date.now()) {
  if (!t) return 0;
  if (t.pausedAt) return Math.max(0, Math.round(Number(t.remainingMs) || 0));
  return Math.max(0, Math.round((Number(t.endsAt) || 0) - now));
}

/**
 * One of: "paused" | "running" | "ringing" | "done".
 *
 * "done" is a timer that reached zero and was silenced. It stays in the list
 * rather than deleting itself -- you have just been interrupted by an alarm,
 * and the thing you most often want next is to run the same timer again.
 */
export function timerState(t, now = Date.now()) {
  if (!t) return "done";
  if (t.pausedAt) return "paused";
  if (remainingMs(t, now) > 0) return "running";
  return t.silencedAt ? "done" : "ringing";
}

export const isRinging = (t, now = Date.now()) => timerState(t, now) === "ringing";

/** Every timer sounding right now, longest-overdue first. */
export function ringingTimers(data, now = Date.now()) {
  return (data?.timers || [])
    .filter((t) => isRinging(t, now))
    .sort((a, b) => (Number(a.endsAt) || 0) - (Number(b.endsAt) || 0));
}

/**
 * The timers worth showing: everything except the finished ones.
 *
 * Ringing first (they want an answer), then running by soonest, then paused.
 */
export function activeTimers(data, now = Date.now()) {
  const rank = { ringing: 0, running: 1, paused: 2 };
  return (data?.timers || [])
    .filter((t) => timerState(t, now) !== "done")
    .sort((a, b) => {
      const ra = rank[timerState(a, now)] ?? 9, rb = rank[timerState(b, now)] ?? 9;
      if (ra !== rb) return ra - rb;
      return remainingMs(a, now) - remainingMs(b, now);
    });
}

/* --------------------------------------------------------------- actions --- */
// Each returns a new timer rather than mutating, so they compose with the
// document merge, which compares rows by id.

export function pauseTimer(t, now = Date.now()) {
  if (!t || t.pausedAt || remainingMs(t, now) <= 0) return t;
  return { ...t, pausedAt: now, remainingMs: remainingMs(t, now) };
}

export function resumeTimer(t, now = Date.now()) {
  if (!t || !t.pausedAt) return t;
  return { ...t, pausedAt: 0, remainingMs: 0, endsAt: now + Math.max(0, Number(t.remainingMs) || 0) };
}

/** Stop the alarm. Written to the document, so every other screen stops too. */
export function silenceTimer(t, now = Date.now()) {
  if (!t) return t;
  return { ...t, silencedAt: now, pausedAt: 0, remainingMs: 0 };
}

/** Run it again from the top, at its original duration. */
export function restartTimer(t, now = Date.now()) {
  if (!t) return t;
  const ms = clampDuration(t.durationMs);
  return { ...t, startedAt: now, endsAt: now + ms, pausedAt: 0, remainingMs: 0, silencedAt: 0 };
}

/**
 * "+1 minute" on a timer that is already sounding.
 *
 * Extending a ringing timer has to clear `silencedAt` as well as move the end,
 * or the timer would be running with the alarm already marked dealt with and
 * would then finish in silence -- the one failure a timer must not have.
 */
export function addTime(t, ms, now = Date.now()) {
  if (!t) return t;
  const base = remainingMs(t, now) > 0 ? remainingMs(t, now) : 0;
  const next = clampDuration(base + (Number(ms) || 0));
  if (t.pausedAt) return { ...t, remainingMs: next, silencedAt: 0 };
  return { ...t, endsAt: now + next, pausedAt: 0, remainingMs: 0, silencedAt: 0 };
}

/* -------------------------------------------------------------- printing --- */

/** "9:05", "1:02:03", "0:07". Hours only when there are hours. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "10 minutes", "1 hour 30 minutes" -- for confirming back what was heard. */
export function spokenDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const parts = [];
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (h) parts.push(unit(h, "hour"));
  if (m) parts.push(unit(m, "minute"));
  if (s && !h) parts.push(unit(s, "second"));
  return parts.join(" ") || "0 seconds";
}

/** A name to show when nobody gave one. */
export const timerName = (t) => (t?.label || "").trim() || "Timer";
