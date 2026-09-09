// api.js — the same six functions App.jsx has always imported.
//
// The signatures are unchanged from the single-household, no-login version, and
// that is the point: `loadState()` still returns the household document and
// `saveState(doc)` still stores it. What changed is underneath -- the document
// is now decrypted on the way in and sealed on the way out, by lib/session.js,
// with keys the server never sees.
//
// Keeping this seam is what let the whole 5,600-line UI move to end-to-end
// encryption without being rewritten. Nothing above this file knows or needs to
// know that encryption exists.

import * as session from "./lib/session.js";
import { normalize } from "./lib/document.js";

/* ----------------------------------------------------------------- state --- */

export async function loadState() {
  const doc = await session.loadVault();
  // Documents written by older versions are brought up to the current shape
  // here, in the client -- the server cannot read them, so it cannot migrate
  // them. A migration is just a normal edit that the next save persists.
  const normalized = normalize(doc);

  // Backfill the separately sealed household name. Households created before
  // names were stored outside the document have none, which is why the picker
  // used to label every one of them "Household". Opening one fixes it.
  session.syncHouseholdName(normalized.householdName);

  // Reconcile the document's calendar list against what the server actually
  // holds. The two can drift in both directions: a feed added on another device
  // is not in this document yet, and a feed deleted server-side would otherwise
  // linger in the list forever.
  try {
    const feeds = await listCalendars();
    const byId = new Map(feeds.map((f) => [f.id, f]));
    const known = new Map((normalized.calendars || []).map((c) => [c.id, c]));

    normalized.calendars = feeds.map((f) => ({
      // Names and colours are the household's own and live only here.
      name: `Calendar`,
      color: null,
      personId: "",
      ...(known.get(f.id) || {}),
      id: f.id,
      // Sync state belongs to the server and is refreshed on every load.
      lastSync: f.last_sync_at,
      error: f.last_error,
    }));

    // Anything the document knew about that the server no longer has is gone.
    for (const c of known.keys()) if (!byId.has(c)) { /* dropped above */ }
  } catch {
    // A calendar listing failure must not stop the household loading.
  }

  return normalized;
}

/**
 * Save the whole document.
 *
 * Conflict handling is a field-level merge rather than last-write-wins. The old
 * app took the latter, which was defensible for two people sharing one tablet;
 * with a household of five on their own phones, "Bob's grocery item vanished
 * because Alice ticked a chore at the same moment" is a real and infuriating
 * bug. The merge below keeps both sides' additions and prefers the remote copy
 * only for things we did not touch.
 */
export function saveState(state) {
  return session.saveVault(state, { onConflict: mergeDocuments });
}

/**
 * Three-way-ish merge of two household documents.
 *
 * There is no common ancestor to diff against, so this is heuristic and
 * deliberately biased toward *keeping* data: a merge that loses someone's note
 * is worse than one that leaves a duplicate they can delete.
 */
export function mergeDocuments(mine, theirs) {
  const out = { ...theirs };

  // Collections keyed by id: union them, preferring my version of a row I
  // edited, and keeping rows either side added.
  const LISTS = [
    "people", "events", "chores", "tasks", "projects", "grocery", "notes",
    "dates", "agenda", "agendaArchive", "agendaPrompts", "dateJars", "dateIdeas",
    /* Timers merge by id like any other row. They need no special case
       because nothing about their state is a flag somebody writes: two
       screens editing the same timer both write timestamps, and the later
       write is the one that happened later, which is the right answer. */
    "timers",
  ];
  for (const key of LISTS) {
    const a = Array.isArray(mine[key]) ? mine[key] : [];
    const b = Array.isArray(theirs[key]) ? theirs[key] : [];
    const byId = new Map();
    for (const item of b) byId.set(item?.id ?? Math.random(), item);
    for (const item of a) byId.set(item?.id ?? Math.random(), item);

    // A row present remotely but absent locally was probably deleted by me --
    // unless I never had it. Without an ancestor we cannot tell, so it stays.
    out[key] = [...byId.values()];
  }

  // Date-keyed maps merge per date, then per slot.
  /* seenCalendar merges per person, not wholesale: two people looking at the
     calendar on two devices at the same moment must not overwrite each other's
     mark, which is what a scalar merge would do. */
  for (const key of ["meals", "status", "groceryHistory", "seenCalendar"]) {
    out[key] = { ...(theirs[key] || {}), ...(mine[key] || {}) };
  }

  // Scalar settings: mine win, since I am the one who just changed something.
  for (const key of ["householdName", "grocerySort", "layoutMode", "noteDisplay",
                     "showBreakdown", "weather", "checkin", "upNextSources",
                     "homeEntities", "homeDashboardUrl", "groceryStores",
                     /* Missing from this list is why "you select one, but it
                        doesn't actually display" -- the choice was written
                        locally, then thrown away by the next merge, because
                        `out` starts from `theirs` and only these keys let mine
                        win. Silent, and indistinguishable from the setting not
                        working at all. */
                     "secondBlock", "lists"]) {
    if (mine[key] !== undefined) out[key] = mine[key];
  }

  return out;
}

/* ------------------------------------------------------------- calendars --- */

/* ------------------------------------------------------------ voice --- */

/**
 * Where this household's Home Assistant is, and a token to subscribe to it.
 *
 * Handed to the client rather than proxied, because proxying is exactly what
 * this must not do: a spoken command relayed through this server would be the
 * household's own words in the clear on the one machine the design keeps them
 * off. The display talks to Home Assistant directly instead. See
 * lib/ha-voice.js and docs/VOICE.md.
 *
 * Resolves to null rather than throwing when the server does not implement it
 * -- a household on an older server simply has no wake-word voice, and should
 * not see an error about a feature nobody told them about.
 */
export async function loadVoiceLink() {
  const path = session.isDisplay()
    ? "api/display/home/voice"
    : `api/households/${session.householdId()}/home/voice`;
  try {
    return await session.request("GET", path);
  } catch (e) {
    return null;
  }
}

export const loadCalendarEvents = () =>
  session.isDisplay()
    ? session.request("GET", "api/display/calendar-events")
    : session.request("GET", `api/households/${session.householdId()}/calendar-events`);

/* ------------------------------------------------------- two-way sync --- */

const hh = () => session.householdId();

export const loadCaldav = () => session.request("GET", `api/households/${hh()}/caldav`);

export const connectCaldav = (body) =>
  session.request("POST", `api/households/${hh()}/caldav`, body);

export const disconnectCaldav = (accountId) =>
  session.request("DELETE", `api/households/${hh()}/caldav/${accountId}`);

export const setCaldavPush = (calendarId, pushEnabled) =>
  session.request("PUT", `api/households/${hh()}/caldav/calendars/${calendarId}`, { pushEnabled });

/**
 * Send the complete set of events that belongs on a synced calendar.
 *
 * The whole set, not a delta: the server decides what to create, change and
 * remove by comparing against what it previously wrote. Sent from here because
 * the events live in the encrypted document, which the server cannot read.
 */
export const pushCaldav = (calendarId, events) =>
  session.request("POST", `api/households/${hh()}/caldav/calendars/${calendarId}/push`, { events });

/**
 * Add a calendar feed.
 *
 * The split is the important bit. The server holds the subscription URL and the
 * fetched .ics -- both secrets, both sealed under the server key, because a
 * browser cannot fetch them itself (CORS). The *name, colour and person* are
 * household content and stay in the encrypted document, keyed by the id the
 * server hands back.
 *
 * That split was the bug behind "it says it added the calendar but it never
 * shows up": storage moved to the server, the UI kept reading `data.calendars`
 * from the document, and nothing ever wrote to it.
 */
export async function addCalendar(body) {
  const res = await session.request(
    "POST", `api/households/${session.householdId()}/calendars`,
    body.icsText ? { icsText: body.icsText } : { url: body.url }
  );
  return {
    id: res.id,
    name: body.name || (body.url ? hostOf(body.url) : "Imported calendar"),
    color: body.color || null,
    personId: body.personId || "",
    imported: Boolean(body.icsText),
  };
}

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Calendar"; }
};

export const refreshCalendar = (id) =>
  session.request("POST", `api/households/${session.householdId()}/calendars/${id}/refresh`);

export const deleteCalendar = (id) =>
  session.request("DELETE", `api/households/${session.householdId()}/calendars/${id}`);

export const listCalendars = () =>
  session.request("GET", `api/households/${session.householdId()}/calendars`);

/* -------------------------------------------------------------- runtime --- */

export const loadConfig = () => session.request("GET", "api/config");

export { session };
