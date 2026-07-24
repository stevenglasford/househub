// backup.mjs — snapshot the live DB safely while the server is running.
// Uses SQLite's online backup API, so it's consistent even mid-write under WAL.
// (A plain `cp hub.db` while the app is writing is NOT guaranteed consistent.)
//
//   npm run backup                      -> server/hub-backup-YYYY-MM-DD.db
//   npm run backup -- /path/to/dest.db  -> explicit destination

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const src = process.env.DB_FILE || join(DIR, "hub.db");
const dest = process.argv[2] || join(DIR, `hub-backup-${new Date().toISOString().slice(0, 10)}.db`);

const db = new Database(src, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();
console.log(`Backed up ${src} -> ${dest}`);
