// ratelimit.js — token-bucket limits, held in Postgres.
//
// In the database rather than in memory for two reasons: limits survive a
// restart, so an attacker cannot reset their own budget by crashing a worker;
// and they hold across every process, so scaling out does not multiply the
// allowance by the worker count.
//
// The write is a single atomic upsert. Read-then-write would let concurrent
// requests each see a full bucket -- which is precisely the race an attacker
// creates by firing a hundred requests at once.

import { createHmac } from "node:crypto";
import { q } from "../db/pool.js";
import { rateLimited } from "./errors.js";
import { subkey } from "../crypto/seal.js";

/** Client identity for limiting. Hashed, so the table is not a log of who visited. */
export function clientKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return createHmac("sha256", subkey("ratelimit/ip")).update(ip).digest("base64url").slice(0, 22);
}

/**
 * Consume `cost` tokens from `bucket`, which refills at `perSecond` up to
 * `capacity`. Returns remaining tokens; throws ApiError(429) when empty.
 */
export async function consume(bucket, { capacity, perSecond, cost = 1 }) {
  const { rows } = await q(
    `INSERT INTO rate_limits (bucket, tokens, updated_at)
     VALUES ($1, $2::real - $4::real, now())
     ON CONFLICT (bucket) DO UPDATE SET
       tokens = LEAST(
                  $2::real,
                  rate_limits.tokens
                    + EXTRACT(EPOCH FROM (now() - rate_limits.updated_at))::real * $3::real
                ) - $4::real,
       updated_at = now()
     RETURNING tokens`,
    [bucket, capacity, perSecond, cost]
  );

  const remaining = Number(rows[0].tokens);
  if (remaining < 0) {
    // Put the tokens back: a rejected request must not deepen the hole, or a
    // client stuck in a retry loop can never recover.
    await q("UPDATE rate_limits SET tokens = tokens + $2 WHERE bucket = $1", [bucket, cost]);
    throw rateLimited(Math.max(1, Math.ceil(cost / perSecond)));
  }
  return remaining;
}

/**
 * Express middleware factory.
 *
 * `by` chooses the bucket: 'ip' for unauthenticated endpoints, 'user' once we
 * know who is calling, 'household' for shared resources like AI generation.
 */
export function limit(name, { capacity, perSecond, by = "ip", cost = 1 }) {
  return async (req, res, next) => {
    try {
      let scope;
      if (by === "user") scope = req.user?.id || clientKey(req);
      else if (by === "household") scope = req.household?.id || req.user?.id || clientKey(req);
      else scope = clientKey(req);

      const remaining = await consume(`${name}:${scope}`, { capacity, perSecond, cost });
      res.set("X-RateLimit-Remaining", String(Math.floor(remaining)));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Per-account limiting for the login path, keyed on the blind index rather than
 * the address. Combined with the per-IP limit this is what stops credential
 * stuffing: rotating proxies defeat the IP bucket but not this one.
 */
export function accountBucket(emailBidx) {
  return `login-account:${Buffer.from(emailBidx).toString("base64url").slice(0, 22)}`;
}

/** Drop spent buckets. Called from the periodic maintenance job. */
export async function sweepRateLimits() {
  const { rowCount } = await q(
    "DELETE FROM rate_limits WHERE updated_at < now() - interval '1 day'"
  );
  return rowCount;
}
