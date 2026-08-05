// calendars.js — subscribed .ics feeds.
//
// This is the documented exception to "the server holds no plaintext", and it
// exists for a boring reason: browsers cannot fetch a Google or iCloud feed
// directly (CORS), so something server-side has to. Both halves are therefore
// sealed under the server key -- the subscription URL, which is a bearer secret
// that grants read access to someone's whole calendar, and the fetched body.
//
// A member's *own* events, the ones they create in HouseHub, are not here. Those
// live in the end-to-end encrypted document like everything else. Only imported
// read-only feeds pass through this file.

import { q } from "../db/pool.js";
import { seal, openText } from "../crypto/seal.js";
import { safeFetch, BlockedRequestError } from "./safe-fetch.js";
import { parseICS, expandEvents } from "./ics.js";
import { REFRESH_MINUTES } from "../config.js";

/** Add a feed. Returns the row id; the URL is never echoed back. */
export async function addFeed(householdId, url) {
  // Fetch once before storing, so a typo or an unreachable host is an immediate
  // error in the UI rather than a feed that silently never syncs.
  const text = await safeFetch(url);
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error("That URL did not return a calendar feed");
  }

  const { rows } = await q(
    `INSERT INTO calendar_feeds (household_id, url_enc, ics_enc, last_sync_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [householdId, seal("calendarUrl", url, householdId), seal("calendarIcs", text, householdId)]
  );
  return rows[0].id;
}

export async function removeFeed(householdId, id) {
  const { rowCount } = await q(
    "DELETE FROM calendar_feeds WHERE id = $1 AND household_id = $2", [id, householdId]
  );
  return rowCount > 0;
}

export async function listFeeds(householdId) {
  const { rows } = await q(
    `SELECT id, last_sync_at, last_error, octet_length(ics_enc) AS bytes
       FROM calendar_feeds WHERE household_id = $1 ORDER BY created_at`,
    [householdId]
  );
  // Deliberately no URL. It is a secret that grants access to the calendar, and
  // nothing in the UI needs it back after it has been entered.
  return rows;
}

export async function refreshFeed(id) {
  const { rows } = await q("SELECT id, household_id, url_enc FROM calendar_feeds WHERE id = $1", [id]);
  if (!rows[0]) return { ok: false, error: "not found" };

  const url = openText("calendarUrl", rows[0].url_enc, rows[0].household_id);
  try {
    const text = await safeFetch(url);
    await q(
      "UPDATE calendar_feeds SET ics_enc = $2, last_sync_at = now(), last_error = NULL WHERE id = $1",
      [id, seal("calendarIcs", text, rows[0].household_id)]
    );
    return { ok: true };
  } catch (err) {
    // The error is shown back to the household, so it must not quote a response
    // body -- that would turn a failed fetch into an SSRF read primitive after
    // all. Only the class of failure is recorded.
    const message = err instanceof BlockedRequestError
      ? err.message
      : `Could not refresh this feed (${err.message.slice(0, 80)})`;
    await q("UPDATE calendar_feeds SET last_error = $2, last_sync_at = now() WHERE id = $1", [id, message]);
    return { ok: false, error: message };
  }
}

/** Expanded events for a window. Parsed per request; feeds are small. */
export async function eventsFor(householdId, start, end) {
  const { rows } = await q(
    "SELECT id, ics_enc FROM calendar_feeds WHERE household_id = $1 AND ics_enc IS NOT NULL",
    [householdId]
  );

  const out = [];
  for (const row of rows) {
    try {
      const text = openText("calendarIcs", row.ics_enc, householdId);
      out.push(...expandEvents(parseICS(text), start, end).map((e) => ({ ...e, feedId: row.id })));
    } catch {
      // One malformed feed must not blank the whole calendar.
    }
  }
  return out;
}

/** Called by the maintenance loop. Feeds are refreshed oldest-first. */
export async function refreshDueFeeds() {
  const { rows } = await q(
    `SELECT id FROM calendar_feeds
      WHERE last_sync_at IS NULL OR last_sync_at < now() - ($1 || ' minutes')::interval
      ORDER BY last_sync_at NULLS FIRST LIMIT 25`,
    [String(REFRESH_MINUTES)]
  );

  let refreshed = 0;
  for (const row of rows) {
    // Sequential on purpose: a burst of parallel outbound requests from a home
    // server is both rude to the providers and a good way to get rate-limited.
    const r = await refreshFeed(row.id);
    if (r.ok) refreshed++;
  }
  return refreshed;
}
