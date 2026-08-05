// audit.js — the tamper-evident activity log.
//
// Two properties, both deliberate:
//
// 1. It records *that* something happened, never what. "member_added",
//    "vault_written", "display_approved" -- never a chore title, never a note.
//    An audit trail that quoted content would be a plaintext copy of everything
//    the encryption exists to hide.
//
// 2. Each entry commits to the previous one's hash. Removing or editing a row
//    breaks the chain at that point and every point after it, so a subsequent
//    verification pass says exactly where the history was rewritten. Combined
//    with the append-only trigger in 001_core.sql, an operator who wants to
//    hide their own actions has to break the chain visibly.

import { createHash } from "node:crypto";
import { q, tx } from "../db/pool.js";

const canonical = (obj) => JSON.stringify(obj, Object.keys(obj).sort());

function entryHash(prevHash, entry) {
  return createHash("sha256")
    .update(prevHash || Buffer.alloc(32))
    .update(canonical(entry))
    .digest();
}

/**
 * Append one entry.
 *
 * Auditing must never take down the operation it is recording, so failures are
 * logged and swallowed. The inverse -- refusing a member's save because the log
 * was briefly unavailable -- would be worse for both safety and trust.
 */
export async function audit(action, { householdId = null, actorUserId = null, target = null, meta = {} } = {}) {
  try {
    await tx(async ({ q: query }) => {
      // Serialise appends so two concurrent writers cannot chain off the same
      // predecessor and produce a fork.
      await query("SELECT pg_advisory_xact_lock(hashtext('househub_audit'))");
      const { rows } = await query("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1");
      const prev = rows[0]?.entry_hash || null;

      const entry = { action, householdId, actorUserId, target, meta };
      await query(
        `INSERT INTO audit_log (household_id, actor_user_id, action, target, meta, prev_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [householdId, actorUserId, action, target, JSON.stringify(meta), prev, entryHash(prev, entry)]
      );
    });
  } catch (err) {
    console.error("[audit] failed to record", action, err.message);
  }
}

/**
 * Walk the chain and report the first break.
 *
 * Exposed to super-admins and runnable from the CLI, because an integrity
 * guarantee nobody ever checks is only a claim.
 */
export async function verifyChain({ limit = 100000 } = {}) {
  const { rows } = await q(
    `SELECT id, household_id, actor_user_id, action, target, meta, prev_hash, entry_hash
     FROM audit_log ORDER BY id ASC LIMIT $1`, [limit]
  );

  let prev = null;
  for (const r of rows) {
    const stored = r.prev_hash ? Buffer.from(r.prev_hash) : null;
    if (prev !== null && (stored === null || !stored.equals(prev))) {
      return { ok: false, brokenAt: r.id, reason: "prev_hash does not match the preceding entry" };
    }
    const expected = entryHash(stored, {
      action: r.action,
      householdId: r.household_id,
      actorUserId: r.actor_user_id,
      target: r.target,
      meta: r.meta,
    });
    if (!expected.equals(Buffer.from(r.entry_hash))) {
      return { ok: false, brokenAt: r.id, reason: "entry contents do not match their hash" };
    }
    prev = Buffer.from(r.entry_hash);
  }
  return { ok: true, entries: rows.length };
}

/** Recent activity for one household. Members can see what happened in their own home. */
export async function recentForHousehold(householdId, limit = 100) {
  const { rows } = await q(
    `SELECT id, actor_user_id, action, target, meta, created_at
     FROM audit_log WHERE household_id = $1 ORDER BY id DESC LIMIT $2`,
    [householdId, Math.min(500, limit)]
  );
  return rows;
}
