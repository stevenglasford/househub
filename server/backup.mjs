// backup.mjs — snapshot the live DB safely while the server is running.
// Uses SQLite's online backup API, so it's consistent even mid-write under WAL.
// (A plain `cp hub.db` while the app is writing is NOT guaranteed consistent.)
//
//   npm run backup                      -> hub-backup-YYYY-MM-DD.db (next to the DB)
//   npm run backup -- /path/to/dest.db  -> explicit destination

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { DB_FILE } from "./config.js";

const src = DB_FILE;
const dest = process.argv[2]
  || join(dirname(DB_FILE), `hub-backup-${new Date().toISOString().slice(0, 10)}.db`);

const db = new Database(src, { readonly: true, fileMustExist: true });
await db.backup(dest);
db.close();
console.log(`Backed up ${src} -> ${dest}`);
