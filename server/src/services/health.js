// health.js — is this server actually able to do its job?
//
// `/api/health` used to answer `{ ok: true }` without touching anything. The
// Docker healthcheck calls it, so a database that had died, filled its disk, or
// gone read-only left the container reported healthy while every vault write
// failed. Nothing surfaced it: clients hold the decrypted document in memory,
// so the app keeps working from the household's point of view right up until
// somebody reloads and finds their evening missing.
//
// Two different failures, and one check does not cover both:
//
//   unreachable  the database is gone. A cheap SELECT finds it.
//   read-only    the database answers SELECT and refuses writes -- a full disk,
//                a failover replica, a revoked grant. Only a real write finds
//                this, and health checks must not write, so instead the write
//                paths report their own failures here.
//
// Deliberately says little in the response. A health endpoint is unauthenticated
// and a raw driver error names the host, the database and sometimes the schema.

import { q } from "../db/pool.js";

const PROBE_TTL_MS = 5000;      // a 30s healthcheck must not become a query storm

/* Injectable so the decision logic can be tested without a database. The
   default is the real thing; the tests supply their own so that "is the
   database reachable" and "is it accepting writes" can be exercised
   separately -- they are different faults with different symptoms. */
const defaultProbe = () => q("SELECT 1");

let probe = { at: 0, reachable: true };
let lastWriteError = null;      // { at, code } -- never the raw message

/**
 * Record that a write failed.
 *
 * Called from the paths that persist household data. The point is that a
 * database can answer reads perfectly while refusing every write, and that is
 * exactly the state in which everything looks fine.
 */
export function noteWriteFailure(err) {
  lastWriteError = { at: Date.now(), code: err?.code || "unknown" };
}

/** Called after a write succeeds, so a transient failure clears itself. */
export function noteWriteSuccess() {
  lastWriteError = null;
}

/** For tests. */
export function resetHealth() {
  probe = { at: 0, reachable: true };
  lastWriteError = null;
}

/**
 * Current health.
 *
 * `ok` is false when the database cannot be reached or has recently refused a
 * write, so the container is marked unhealthy and somebody finds out.
 */
export async function checkHealth(now = Date.now(), { probeFn = defaultProbe } = {}) {
  if (now - probe.at > PROBE_TTL_MS) {
    try {
      await probeFn();
      probe = { at: now, reachable: true };
    } catch {
      probe = { at: now, reachable: false };
    }
  }

  // A write failure more than five minutes old is history, not a live fault.
  const staleAfter = 5 * 60 * 1000;
  const writeFailing = Boolean(lastWriteError) && (now - lastWriteError.at) < staleAfter;

  const database = !probe.reachable ? "unreachable" : writeFailing ? "not-accepting-writes" : "ok";
  return {
    ok: database === "ok",
    at: now,
    database,
    // The class of failure, never the driver's message: this endpoint is
    // unauthenticated and the raw text names hosts and schemas.
    ...(writeFailing ? { lastWriteErrorCode: lastWriteError.code } : {}),
  };
}

/**
 * Run a write and report whether the database accepted it.
 *
 * Wrapping rather than try/catching at each call site, so a new write path
 * cannot quietly forget to report. The error is always rethrown -- this
 * observes, it never swallows.
 */
export async function recordWriteOutcome(fn) {
  try {
    const out = await fn();
    noteWriteSuccess();
    return out;
  } catch (err) {
    // Only storage faults mean the database is unwell. A rejected request --
    // a quota, a conflict -- is the server working correctly.
    if (isStorageFault(err)) noteWriteFailure(err);
    throw err;
  }
}

/**
 * Is this the database failing, or the application refusing?
 *
 * Postgres class 53 is insufficient resources (disk full, too many
 * connections), 57 is operator intervention (shutdown), 58 is a system error.
 * `25006` is a read-only transaction, which is what a failover replica gives
 * you. Anything else -- a constraint, a conflict -- is the app doing its job.
 */
export function isStorageFault(err) {
  const code = String(err?.code || "");
  if (!code) return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE/.test(String(err?.message || ""));
  return code === "25006" || /^(53|57|58|08)/.test(code);
}
