// auth.js — who is calling, and what they are allowed to touch.
//
// Authorisation here is deliberately boring and centralised. Every route that
// touches household data goes through `loadHousehold` + `requireRole`, so
// "can this person see this family's data" is answered in one place rather than
// re-derived in forty handlers, which is where that check eventually gets
// forgotten.

import { q } from "../db/pool.js";
import { hashToken } from "../crypto/tokens.js";
import { unauthorized, forbidden, notFound } from "./errors.js";
import { SESSION_IDLE_HOURS } from "../config.js";

export const SESSION_COOKIE = "hh_session";

// Highest first. `atLeast('adult')` then means adult or admin.
const ROLE_RANK = { viewer: 0, dependent: 1, adult: 2, admin: 3 };

function bearerFrom(req) {
  const header = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) return m[1].trim();
  return req.cookies?.[SESSION_COOKIE] || null;
}

/**
 * Attach req.user / req.session when a valid session is presented. Never
 * rejects -- routes decide whether anonymity is acceptable.
 */
export async function resolveSession(req, res, next) {
  try {
    const token = bearerFrom(req);
    if (!token) return next();

    const { rows } = await q(
      `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at,
              u.is_super_admin, u.status, u.email_bidx
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [hashToken(token)]
    );
    const s = rows[0];
    if (!s) return next();

    // Absolute expiry, then idle expiry. A tablet left logged in for a month in
    // a shared hallway is a real exposure, so idleness ends a session too.
    const now = Date.now();
    if (new Date(s.expires_at).getTime() < now) return next();
    const idleMs = now - new Date(s.last_seen_at).getTime();
    if (idleMs > SESSION_IDLE_HOURS * 3600_000) {
      await q("UPDATE sessions SET revoked_at = now() WHERE id = $1", [s.id]);
      return next();
    }
    if (s.status !== "active") return next();

    // Throttle the write: touching every request turns a read-mostly workload
    // into a write on every poll, and the app polls every 15 seconds.
    if (idleMs > 60_000) {
      await q("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [s.id]);
    }

    req.session = { id: s.id, token };
    req.user = { id: s.user_id, isSuperAdmin: s.is_super_admin, emailBidx: s.email_bidx };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  // 404 rather than 403: the existence of the super-admin surface is not
  // something an ordinary account needs confirmed.
  if (!req.user.isSuperAdmin) return next(notFound());
  next();
}

/**
 * Resolve :householdId and the caller's membership of it.
 *
 * A non-member gets 404, not 403. 403 would confirm that a given household id
 * exists, which is a probe worth denying on a system whose users may be hiding
 * the existence of their household from someone.
 *
 * Super-admins are NOT auto-admitted. They run the server; they are not members
 * of the family, they hold no key, and there is nothing here for them to read.
 */
export function loadHousehold(param = "householdId") {
  return async (req, res, next) => {
    try {
      if (!req.user) return next(unauthorized());
      const householdId = req.params[param];
      if (!/^[0-9a-f-]{36}$/i.test(householdId || "")) return next(notFound());

      const { rows } = await q(
        `SELECT h.id, h.key_epoch, h.status, h.display_approval_threshold,
                m.role, m.status AS member_status
           FROM households h
           JOIN household_members m
             ON m.household_id = h.id AND m.user_id = $2
          WHERE h.id = $1`,
        [householdId, req.user.id]
      );
      const row = rows[0];
      if (!row || row.member_status !== "active") return next(notFound());
      if (row.status === "closed") return next(forbidden("This household has been closed"));

      req.household = {
        id: row.id,
        keyEpoch: row.key_epoch,
        status: row.status,
        approvalThreshold: row.display_approval_threshold,
      };
      req.membership = { role: row.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require one of the named roles. Use after loadHousehold. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.membership) return next(forbidden());
    if (!roles.includes(req.membership.role)) {
      return next(forbidden(`This action needs one of: ${roles.join(", ")}`));
    }
    next();
  };
}

/** Require at least the given rank, e.g. atLeast('adult') admits adult + admin. */
export function atLeast(role) {
  return (req, res, next) => {
    if (!req.membership) return next(forbidden());
    if (ROLE_RANK[req.membership.role] < ROLE_RANK[role]) {
      return next(forbidden(`This action needs ${role} access or higher`));
    }
    next();
  };
}

/**
 * A suspended household (unpaid, on a hosted server) is readable and
 * exportable but not writable. Nonpayment must never destroy or lock away a
 * family's data -- that is the operator holding it hostage, not billing.
 */
export function requireWritable(req, res, next) {
  if (req.household?.status === "suspended") {
    return next(forbidden("This household is read-only. Your data is safe and can still be exported."));
  }
  next();
}

export async function listAdmins(householdId) {
  const { rows } = await q(
    `SELECT u.id, u.public_key
       FROM household_members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = $1 AND m.role = 'admin' AND m.status = 'active'`,
    [householdId]
  );
  return rows;
}
