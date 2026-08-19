// alerts.js — which reminders should be sounding right now.
//
// Split out of App.jsx so it can be tested directly. This is the logic that
// decides whether a medication reminder fires, so "it looked right on screen"
// is not a good enough standard for it.
//
// Everything here runs in the browser. The server cannot read the household
// document, so it does not know these chores exist or what they are called --
// which is exactly the property that makes this app safe to host for other
// people, and exactly why the evaluation cannot live server-side the way the
// single-household original did it.

export const DEFAULT_ALERT = { at: "17:00", everyMins: 10, until: "22:00", style: "banner" };

export const hasAlert = (x) => Boolean(x && x.alert && x.alert.at);

/** "HH:MM" -> minutes since midnight, or null if it is not a time. */
export const minutesOf = (hhmm) => {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};

/**
 * How overdue a reminder is right now, in minutes.
 *
 * Null when it should not sound at all: not yet time, past the cutoff, or
 * already dealt with. The cutoff is as much the point as the start time is --
 * a reminder that chimes all night gets the tablet muted, and then none of them
 * work any more.
 */
export function alertOverdueMins(item, nowMin, doneOrSkipped) {
  if (!hasAlert(item) || doneOrSkipped) return null;
  const at = minutesOf(item.alert.at);
  if (at === null || nowMin < at) return null;
  const until = minutesOf(item.alert.until || DEFAULT_ALERT.until);
  if (until !== null && nowMin > until) return null;
  return nowMin - at;
}

/**
 * Every reminder that should be sounding, worst first.
 *
 * The two chore helpers are injected rather than imported because they live in
 * the view layer, and this module has to stay importable by tests that do not
 * pull in React.
 *
 * @param data     the household document
 * @param todayKey YYYY-MM-DD in the household's own zone, not the device's
 * @param nowMin   minutes since midnight, likewise
 * @param opts     { dueOn, assigneeOf, nowMs }
 */
export function dueAlerts(data, todayKey, nowMin, opts = {}) {
  const {
    dueOn = () => true,
    assigneeOf = (c) => c.personId || "",
    nowMs = Date.now(),
  } = opts;
  if (!data) return [];
  const who = (id) => (data.people || []).find((x) => x.id === id) || null;
  // Snoozes live in the synced document rather than per-device storage, so
  // silencing one on a phone also quiets the tablet in the hall. Otherwise the
  // same reminder has to be dismissed once per screen in the house.
  const snoozed = (key) => Number((data.alertSnooze || {})[key] || 0) > nowMs;
  const out = [];

  for (const c of data.chores || []) {
    // A reminder must not fire on a day the chore is not even scheduled.
    if (!hasAlert(c) || !dueOn(c, todayKey)) continue;
    const od = alertOverdueMins(c, nowMin, Boolean(c.done?.[todayKey]));
    if (od === null || snoozed("c" + c.id)) continue;
    out.push({
      key: "c" + c.id, kind: "chore", id: c.id, title: c.title, alert: c.alert,
      overdue: od, person: who(assigneeOf(c, todayKey)),
    });
  }

  for (const t of data.tasks || []) {
    // An undated task is a someday item; only a task dated today can be late.
    if (!hasAlert(t) || t.done || (t.date && t.date !== todayKey)) continue;
    const od = alertOverdueMins(t, nowMin, false);
    if (od === null || snoozed("t" + t.id)) continue;
    out.push({
      key: "t" + t.id, kind: "task", id: t.id, title: t.title, alert: t.alert,
      overdue: od, person: who(t.personId),
    });
  }

  return out.sort((a, b) => b.overdue - a.overdue);
}

/**
 * Which escalation step a reminder is on: 0 at the due minute, then one per
 * repeat interval. The UI chimes when this number changes rather than on every
 * render, which is what stops a one-minute tick from becoming a one-minute
 * alarm.
 */
export function escalationStep(alert, overdue) {
  return Math.floor(overdue / Math.max(1, alert?.everyMins || 10));
}
