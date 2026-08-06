// pool.js — the Postgres connection pool and the two helpers everything uses.
//
// Every query in this codebase goes through `q` or `tx` with parameter
// placeholders. There is no string interpolation of user input into SQL
// anywhere, and the pentest suite asserts that by fuzzing every endpoint.

import pg from "pg";
import { DATABASE_URL, DB_POOL_MAX, DB_SSL, IS_PROD } from "../config.js";

// Return NUMERIC as a string rather than a float. Payment amounts are held in
// atomic units (satoshi, wei, piconero) and wei does not survive a double.
pg.types.setTypeParser(1700, (v) => v);
// Same for BIGINT: vault versions are counters, not floats.
pg.types.setTypeParser(20, (v) => v);

/**
 * Connection settings.
 *
 * Discrete PG* variables are preferred over DATABASE_URL when they are present,
 * because a password is not URL-safe. Characters that are perfectly good in a
 * password -- $ @ / # ? : -- either break URL parsing outright or silently
 * truncate the credential. Passing them as separate values sidesteps the whole
 * class of bug; DATABASE_URL still works for anyone already using it.
 */
function connectionConfig() {
  if (process.env.PGHOST || process.env.PGUSER) {
    return {
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    };
  }
  return { connectionString: DATABASE_URL };
}

export const pool = new pg.Pool({
  ...connectionConfig(),
  max: DB_POOL_MAX,
  ssl: DB_SSL ? { rejectUnauthorized: true } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // A runaway query must not pin a connection forever.
  statement_timeout: 20_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export async function q(text, params = []) {
  const started = process.hrtime.bigint();
  try {
    return await pool.query(text, params);
  } finally {
    if (!IS_PROD) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 200) console.warn(`[db] slow query ${ms.toFixed(0)}ms: ${text.slice(0, 90)}`);
    }
  }
}

// Transaction helper. Rolls back on any throw, and always releases -- a leaked
// client under load is indistinguishable from an outage.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      q: (text, params = []) => client.query(text, params),
      client,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
