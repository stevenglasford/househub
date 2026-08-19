// relay.js — getting a reminder onto a phone.
//
// THE PROBLEM
//
// The original single-household app answered this with a server endpoint,
// /api/alerts/due, that a phone Shortcut polled every so often. The server read
// the chore list, found what was overdue, and returned the titles as JSON.
//
// That cannot be ported. This server cannot read the household document at all
// -- it holds ciphertext and no key -- so it does not know these chores exist,
// what they are called, or when they were due. Reintroducing a server-side
// evaluator would mean storing chore titles and schedules in the clear, which
// is the one thing the whole design exists to prevent. "Take your medication at
// 8pm" is exactly the sort of thing a household is entitled to keep private.
//
// WHAT THIS DOES INSTEAD
//
// The browser already holds the key and already works out what is overdue (see
// lib/alerts.js). So the client sends the notification itself, directly to a
// push service the household chooses and controls -- typically an ntfy instance
// they already run.
//
// WHAT EACH PARTY LEARNS
//
//   HouseHub's server   nothing. It is not involved in the request at all.
//   The push service    the reminder title, because a notification that does
//                       not say what it is about is not a notification.
//   The operator        that a household enabled a relay, and to which host,
//                       because the host has to be allowlisted in the CSP.
//
// That middle line is a real disclosure and the settings UI says so plainly.
// Pointing it at an ntfy instance on your own machine keeps it inside the
// house; pointing it at a public one does not. Off by default, either way.
//
// WHY NOT WEB PUSH
//
// The better long-term answer is Web Push with a service worker: the client
// registers "wake me at 20:00 and deliver this sealed blob", the server learns
// only the time, and the service worker decrypts and renders the notification
// locally. That keeps even the title away from every third party. It needs
// VAPID keys, a subscription table and a scheduled sender, so it is written up
// in docs/REMINDERS.md as the next step rather than half-built here.

/** Default shape. `endpoint` is a full topic URL, e.g. https://ntfy.example/house. */
export const DEFAULT_RELAY = { enabled: false, endpoint: "", priority: "default" };

export const relayConfigured = (doc) =>
  Boolean(doc?.reminderRelay?.enabled && doc?.reminderRelay?.endpoint);

/**
 * Has this escalation step already been sent?
 *
 * Recorded in the household document rather than per-device, so the tablet and
 * a phone that are both awake do not each send the same reminder. The document
 * is the only thing they share, and it already merges on save.
 *
 * This is best-effort: two devices crossing the same step within one sync round
 * can still both send. Occasionally seeing a reminder twice is a far better
 * failure than a scheme that drops it.
 */
export const alreadySent = (doc, key, step) =>
  Number(doc?.alertRelayed?.[key] ?? -1) >= step;

export function recordSent(doc, key, step) {
  return { ...doc, alertRelayed: { ...(doc.alertRelayed || {}), [key]: step } };
}

/** Drop bookkeeping for reminders that are no longer sounding. */
export function pruneRelayed(doc, liveKeys) {
  const cur = doc?.alertRelayed || {};
  const keep = {};
  for (const k of Object.keys(cur)) if (liveKeys.has(k)) keep[k] = cur[k];
  return Object.keys(keep).length === Object.keys(cur).length
    ? doc
    : { ...doc, alertRelayed: keep };
}

/**
 * Send one reminder.
 *
 * Resolves to true only on a 2xx. Never throws: a push service being down must
 * not break the app the household is standing in front of, and the on-screen
 * banner is the primary channel regardless -- this is the belt to its braces.
 */
export async function sendReminder(config, alert, { fetchImpl = fetch } = {}) {
  if (!config?.enabled || !config?.endpoint) return false;

  const late = alert.overdue < 1 ? "due now" : `${alert.overdue} min late`;
  const body = alert.person?.name
    ? `${alert.person.name} · ${late}`
    : late;

  try {
    const res = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        // ntfy reads these; other services ignore them harmlessly.
        Title: asciiHeader(alert.title),
        Priority: config.priority === "urgent" ? "urgent" : "default",
        Tags: "bell",
      },
      body,
      // No cookies to a third-party host, ever.
      credentials: "omit",
      mode: "cors",
    });
    return res.ok;
  } catch {
    // Blocked by CSP, offline, host down, DNS gone. All the same to us.
    return false;
  }
}

/* HTTP header values are latin-1. A chore called "Café — 8pm" would otherwise
   throw when set as a header, and the reminder would silently never send. */
function asciiHeader(s) {
  return String(s || "Reminder")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 120) || "Reminder";
}
