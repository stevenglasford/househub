// maintenance.js — the periodic housekeeping every long-lived install needs.
//
// Deliberately in-process and simple. A self-hoster running this on a NUC in a
// cupboard should not have to also run a job queue, and none of this work is
// heavy enough to justify one.

import { q } from "../db/pool.js";
import { sweepRateLimits } from "../middleware/ratelimit.js";
import { refreshDueFeeds } from "../services/calendars.js";
import { warm } from "../services/ollama.js";
import { checkPendingInvoices } from "../services/billing.js";
import { REFRESH_MINUTES, AI_ENABLED, OLLAMA_KEEP_WARM, BILLING_ENABLED, ORPHAN_GRACE_DAYS } from "../config.js";

const MINUTE = 60_000;

async function expireSessions() {
  const { rowCount } = await q(
    "DELETE FROM sessions WHERE (expires_at < now() - interval '7 days') OR (revoked_at < now() - interval '7 days')"
  );
  return rowCount;
}

async function expireInvites() {
  const { rowCount } = await q(
    "DELETE FROM invites WHERE expires_at < now() - interval '30 days'"
  );
  return rowCount;
}

/**
 * Time-limited displays go dark on schedule. A display whose expiry has passed
 * stops serving immediately -- the check also runs on every request, so this
 * job is only tidying the status column, not enforcing the deadline.
 */
async function expireDisplays() {
  const { rowCount } = await q(
    `UPDATE displays SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`
  );
  return rowCount;
}

async function expireInvoices() {
  const { rowCount } = await q(
    "UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < now()"
  );
  return rowCount;
}

/**
 * Hosted installs only: move households past their grace period to read-only.
 * Never deletes. A family behind on payment keeps their data and their export.
 */
async function freezeOverdue() {
  const { rowCount } = await q(
    `UPDATE subscriptions SET status = 'frozen', updated_at = now()
      WHERE status = 'past_due'
        AND current_period_end < now() - (grace_days || ' days')::interval`
  );
  if (rowCount) {
    await q(
      `UPDATE households SET status = 'suspended'
        WHERE id IN (SELECT household_id FROM subscriptions WHERE status = 'frozen')
          AND status = 'active'`
    );
  }
  return rowCount;
}

/**
 * Households nobody can open any more.
 *
 * When the last member's account is deleted, their wrapped key goes with it
 * (household_keys cascades on the user). The household row and its vault
 * survive, but no key to that vault exists anywhere in the world -- it is
 * ciphertext that can never be read again, by anyone, including its owners.
 *
 * Kept for a grace period first, because "the last member left" and "the last
 * member deleted their account by mistake" look identical for a while, and
 * because an admin may be mid-way through handing the household over.
 */
async function sweepOrphanedHouseholds() {
  const { rowCount } = await q(
    `DELETE FROM households h
      WHERE h.updated_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM household_members m
           WHERE m.household_id = h.id AND m.status = 'active'
        )`,
    [String(ORPHAN_GRACE_DAYS)]
  );
  return rowCount;
}

const TASKS = [
  { name: "sessions", every: 60, fn: expireSessions },
  { name: "orphans", every: 720, fn: sweepOrphanedHouseholds },
  { name: "invites", every: 360, fn: expireInvites },
  { name: "displays", every: 5, fn: expireDisplays },
  { name: "invoices", every: 5, fn: expireInvoices },
  { name: "subscriptions", every: 60, fn: freezeOverdue },
  { name: "ratelimits", every: 60, fn: sweepRateLimits },
  { name: "calendars", every: Math.max(1, REFRESH_MINUTES), fn: refreshDueFeeds },
  // Returns nothing to log: keeping a model resident is routine, not an event.
  { name: "payments", every: 2, fn: async () => (BILLING_ENABLED ? checkPendingInvoices() : 0) },
  { name: "ollama-warm", every: 4, fn: async () => { if (AI_ENABLED && OLLAMA_KEEP_WARM) await warm(); return 0; } },
];

export function startMaintenance() {
  const timers = [];
  let tick = 0;

  const timer = setInterval(async () => {
    tick++;
    for (const task of TASKS) {
      if (tick % task.every !== 0) continue;
      try {
        const n = await task.fn();
        if (n) console.log(`[maintenance] ${task.name}: ${n}`);
      } catch (err) {
        // One failing task must not stop the others, and must not crash the
        // process -- an unhandled rejection here would take the server down.
        console.error(`[maintenance] ${task.name} failed:`, err.message);
      }
    }
  }, MINUTE);

  // Do not hold the event loop open; this is background work.
  timer.unref();
  timers.push(timer);

  return () => timers.forEach(clearInterval);
}
