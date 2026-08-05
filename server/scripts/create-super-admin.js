// create-super-admin.js — promote an existing account.
//
// Looked up by blind index, because the address column is sealed and cannot be
// searched with a LIKE. Run via scripts/create-super-admin.sh.

import { q, closePool } from "../src/db/pool.js";
import { blindIndex } from "../src/crypto/seal.js";

const email = process.argv[2];
if (!email) {
  console.error("usage: create-super-admin.js <email>");
  process.exit(1);
}

const { rowCount } = await q(
  "UPDATE users SET is_super_admin = TRUE WHERE email_bidx = $1",
  [blindIndex("email", email)]
);

if (!rowCount) {
  console.error(
    `No account for ${email}.\n` +
    "Sign up through the web interface first -- accounts are created in the browser " +
    "so that the password never reaches the server, which is not something a CLI can do."
  );
  await closePool();
  process.exit(1);
}

console.log(`${email} is now a super-admin.`);
console.log("They can operate the server. They still cannot read any household's data.");
await closePool();
