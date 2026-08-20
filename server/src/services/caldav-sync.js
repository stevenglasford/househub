// caldav-sync.js — storing CalDAV accounts, and pushing events out to them.
//
// caldav.js is the protocol and knows nothing about this app. This is the part
// that knows about households: where the credential lives, which calendars are
// allowed to be written to, and what has already been sent.
//
// The safety rules are worth restating where the deleting actually happens:
//
//   * a remote event is only ever touched if its UID is in `caldav_pushed` for
//     that calendar, which means this server put it there
//   * a calendar is only written to if somebody turned `push_enabled` on for it
//     specifically -- discovering a calendar is not consent to write to it
//   * every write is conditional on the ETag last seen, so an edit made on a
//     phone is detected rather than flattened

import { q } from "../db/pool.js";
import { seal, openText } from "../crypto/seal.js";
import {
  discoverCalendars, putEvent, deleteEvent, planSync, signatureOf,
  uidFor, AuthError, ICLOUD_CALDAV,
} from "./caldav.js";
import { timezoneFor } from "./calendars.js";

export { ICLOUD_CALDAV, AuthError };

/* ------------------------------------------------------------- accounts --- */

/**
 * Store an account after proving the credentials work.
 *
 * Verified before it is saved, deliberately: a stored credential that has never
 * worked is indistinguishable from one that has stopped working, and the second
 * is the one somebody needs to be told about.
 */
export async function connectAccount(householdId, { serverUrl, username, password }) {
  const url = String(serverUrl || ICLOUD_CALDAV).trim();
  const user = String(username || "").trim();
  if (!user || !password) throw new Error("A username and an app-specific password are both needed.");

  const calendars = await discoverCalendars(url, { username: user, password });

  const { rows } = await q(
    `INSERT INTO caldav_accounts (household_id, server_url, username_enc, password_enc, last_ok_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (household_id, server_url)
     DO UPDATE SET username_enc = EXCLUDED.username_enc,
                   password_enc = EXCLUDED.password_enc,
                   last_ok_at = now(), last_error = NULL
     RETURNING id`,
    [householdId, url,
     seal("caldavUser", user, householdId),
     seal("caldavPass", String(password), householdId)]
  );
  const accountId = rows[0].id;

  for (const cal of calendars) {
    await q(
      `INSERT INTO caldav_calendars (account_id, household_id, href, name, color, writable, ctag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id, href)
       DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color,
                     writable = EXCLUDED.writable, ctag = EXCLUDED.ctag`,
      [accountId, householdId, cal.href, cal.name, cal.color || null, cal.writable, cal.ctag || null]
    );
  }
  return { accountId, calendars: calendars.length };
}

/** The credential for an account, unsealed. Never leaves the server. */
async function credentialsFor(accountId, householdId) {
  const { rows } = await q(
    "SELECT server_url, username_enc, password_enc FROM caldav_accounts WHERE id = $1 AND household_id = $2",
    [accountId, householdId]
  );
  if (!rows[0]) throw new Error("No such CalDAV account.");
  return {
    serverUrl: rows[0].server_url,
    username: openText("caldavUser", rows[0].username_enc, householdId),
    password: openText("caldavPass", rows[0].password_enc, householdId),
  };
}

/** Accounts and their calendars, with nothing secret in the result. */
export async function listAccounts(householdId) {
  const { rows: accounts } = await q(
    `SELECT id, server_url, last_ok_at, last_error FROM caldav_accounts
      WHERE household_id = $1 ORDER BY created_at`, [householdId]);
  const { rows: cals } = await q(
    `SELECT id, account_id, href, name, color, writable, push_enabled, last_push_at, last_error
       FROM caldav_calendars WHERE household_id = $1 ORDER BY name`, [householdId]);

  return accounts.map((a) => ({
    id: a.id,
    serverUrl: a.server_url,
    lastOkAt: a.last_ok_at,
    lastError: a.last_error,
    calendars: cals.filter((c) => c.account_id === a.id).map((c) => ({
      id: c.id, name: c.name, color: c.color, writable: c.writable,
      pushEnabled: c.push_enabled, lastPushAt: c.last_push_at, lastError: c.last_error,
    })),
  }));
}

export async function removeAccount(householdId, accountId) {
  await q("DELETE FROM caldav_accounts WHERE id = $1 AND household_id = $2", [accountId, householdId]);
}

/**
 * Turn pushing on or off for one calendar.
 *
 * Refused for a calendar the provider said is read-only, rather than accepted
 * and then failing on every push with a 403 nobody reads.
 */
export async function setPushEnabled(householdId, calendarId, enabled) {
  const { rows } = await q(
    "SELECT writable FROM caldav_calendars WHERE id = $1 AND household_id = $2",
    [calendarId, householdId]);
  if (!rows[0]) throw new Error("No such calendar.");
  if (enabled && !rows[0].writable) throw new Error("That calendar is read-only.");

  await q("UPDATE caldav_calendars SET push_enabled = $1, last_error = NULL WHERE id = $2 AND household_id = $3",
    [Boolean(enabled), calendarId, householdId]);
}

/* ----------------------------------------------------------------- push --- */

/**
 * Push a set of events to one calendar, and remove the ones that went away.
 *
 * `events` is the complete set that should be on that calendar -- not a delta.
 * Anything this server previously wrote there and that is no longer in the set
 * is deleted; anything it did not write is never considered.
 *
 * The client supplies the events, because they live in the encrypted document
 * and the server cannot read it. That is also why this cannot run on a timer:
 * a push happens when somebody with the keys is looking at the app.
 */
export async function pushToCalendar(householdId, calendarId, events, { now = Date.now() } = {}) {
  const { rows } = await q(
    `SELECT c.id, c.href, c.account_id, c.push_enabled, c.writable
       FROM caldav_calendars c WHERE c.id = $1 AND c.household_id = $2`,
    [calendarId, householdId]);
  const cal = rows[0];
  if (!cal) throw new Error("No such calendar.");
  if (!cal.push_enabled) throw new Error("Pushing is not enabled for that calendar.");
  if (!cal.writable) throw new Error("That calendar is read-only.");

  const creds = await credentialsFor(cal.account_id, householdId);
  const tz = await timezoneFor(householdId);

  const { rows: known } = await q(
    "SELECT uid, etag, signature FROM caldav_pushed WHERE calendar_id = $1", [calendarId]);

  const local = (events || [])
    .filter((e) => e && e.id && e.date)
    .map((e) => ({ ...e, uid: uidFor("event", e.id) }));

  const plan = planSync(local, known);
  const result = { created: 0, updated: 0, removed: 0, conflicts: 0, failed: 0 };
  const opts = { username: creds.username, password: creds.password, tz, now };

  for (const { uid, event } of plan.create) {
    const res = await putEvent(cal.href, event, opts);
    if (res.ok) {
      await rememberPush(calendarId, uid, res.etag, signatureOf(event));
      result.created++;
    } else if (res.conflict) {
      /* Already there under our own UID: something we wrote before a previous
         run lost track of. Adopt it rather than fight -- the next pass will
         update it conditionally. */
      await rememberPush(calendarId, uid, "", "");
      result.conflicts++;
    } else {
      result.failed++;
    }
  }

  for (const { uid, event, etag } of plan.update) {
    const res = await putEvent(cal.href, event, { ...opts, etag });
    if (res.ok) {
      await rememberPush(calendarId, uid, res.etag, signatureOf(event));
      result.updated++;
    } else if (res.conflict) {
      // Edited on a phone. Their version stands; forget our etag so the next
      // pass re-reads rather than repeatedly failing on a stale one.
      await q("UPDATE caldav_pushed SET etag = '' WHERE calendar_id = $1 AND uid = $2", [calendarId, uid]);
      result.conflicts++;
    } else {
      result.failed++;
    }
  }

  for (const { uid, etag } of plan.remove) {
    const res = await deleteEvent(cal.href, uid, { ...opts, etag });
    if (res.ok) {
      await q("DELETE FROM caldav_pushed WHERE calendar_id = $1 AND uid = $2", [calendarId, uid]);
      result.removed++;
    } else if (res.conflict) {
      result.conflicts++;
    } else {
      result.failed++;
    }
  }

  await q(
    "UPDATE caldav_calendars SET last_push_at = now(), last_error = $2 WHERE id = $1",
    [calendarId, result.failed ? `${result.failed} event(s) could not be written` : null]);

  return result;
}

function rememberPush(calendarId, uid, etag, signature) {
  return q(
    `INSERT INTO caldav_pushed (calendar_id, uid, etag, signature, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (calendar_id, uid)
     DO UPDATE SET etag = EXCLUDED.etag, signature = EXCLUDED.signature, updated_at = now()`,
    [calendarId, uid, etag || "", signature || ""]);
}
