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
  for (const key of ["meals", "status", "groceryHistory"]) {
    out[key] = { ...(theirs[key] || {}), ...(mine[key] || {}) };
  }

  // Scalar settings: mine win, since I am the one who just changed something.
  for (const key of ["householdName", "grocerySort", "layoutMode", "noteDisplay",
                     "showBreakdown", "weather", "checkin", "upNextSources",
                     "homeEntities", "homeDashboardUrl", "groceryStores"]) {
    if (mine[key] !== undefined) out[key] = mine[key];
  }

  return out;
}

/* ------------------------------------------------------------- calendars --- */

export const loadCalendarEvents = () =>
  session.isDisplay()
    ? session.request("GET", "api/display/calendar-events")
    : session.request("GET", `api/households/${session.householdId()}/calendar-events`);

export const addCalendar = (body) =>
  session.request("POST", `api/households/${session.householdId()}/calendars`, body);

export const refreshCalendar = (id) =>
  session.request("POST", `api/households/${session.householdId()}/calendars/${id}/refresh`);

export const deleteCalendar = (id) =>
  session.request("DELETE", `api/households/${session.householdId()}/calendars/${id}`);

export const listCalendars = () =>
  session.request("GET", `api/households/${session.householdId()}/calendars`);

/* -------------------------------------------------------------- runtime --- */

export const loadConfig = () => session.request("GET", "api/config");

export { session };
