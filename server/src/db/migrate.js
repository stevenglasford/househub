// migrate.js — forward-only migration runner.
//
// Files in ./migrations are applied in filename order inside a transaction each,
// and their checksums are recorded. A file that changes after being applied is a
// hard error rather than a silent no-op: on a system where an AI opens pull
// requests against the schema, "someone edited an applied migration" is exactly
// the failure that must not pass quietly.

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const sha = (s) => createHash("sha256").update(s).digest("hex");

// The migrations table lives in 001, which cannot record itself before it runs.
async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

export function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return { version: file.replace(/\.sql$/, ""), file, sql, checksum: sha(sql) };
    });
}

export async function migrate({ quiet = false } = {}) {
  const client = await pool.connect();
  const log = (...a) => { if (!quiet) console.log(...a); };
  try {
    await ensureLedger(client);

    // Serialise concurrent boots. Two servers starting at once must not both
    // try to create the same table.
    await client.query("SELECT pg_advisory_lock(hashtext('househub_migrate'))");

    const { rows } = await client.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    let ran = 0;
    for (const m of listMigrations()) {
      const previous = applied.get(m.version);
      if (previous) {
        if (previous !== m.checksum) {
          throw new Error(
            `Migration ${m.file} changed after it was applied.\n` +
            `  recorded ${previous}\n  on disk  ${m.checksum}\n` +
            "Applied migrations are immutable. Add a new migration instead."
          );
        }
        continue;
      }
      log(`[migrate] applying ${m.file}`);
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [m.version, m.checksum]
        );
        await client.query("COMMIT");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${m.file} failed: ${err.message}`);
      }
    }
    log(ran ? `[migrate] ${ran} migration(s) applied` : "[migrate] up to date");
    return ran;
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('househub_migrate'))"); } catch {}
    client.release();
  }
}

// `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); process.exit(1); });
}
