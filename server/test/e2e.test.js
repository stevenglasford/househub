// e2e.test.js — the whole system, exercised the way it is actually used.
//
// This test drives the real HTTP API with the real browser crypto library, so
// what it proves is not "the handlers return 200" but the architectural claims
// themselves: that a second member can be admitted without the server ever
// holding a key, that a display cannot be activated by one admin acting alone,
// that rotation actually cuts off a removed member, and that one household's
// ciphertext is useless to another.
//
// Run with: DATABASE_URL=... node --test test/e2e.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import * as C from "../../web/src/lib/crypto.js";

process.env.NODE_ENV = "test";
process.env.PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:4000";

const { createApp } = await import("../src/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { q, closePool } = await import("../src/db/pool.js");

const ITER = 100000;   // policy value; keep the suite fast
let server, base;

before(async () => {
  await migrate({ quiet: true });
  // A clean slate. CASCADE reaches memberships, keys, vaults and displays.
  await q("TRUNCATE users, households, audit_log, rate_limits RESTART IDENTITY CASCADE");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await closePool();
});

/* ------------------------------------------------------------- helpers ---- */

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Browsers attach Origin to every fetch POST, including same-origin ones,
      // and the CSRF guard requires it. Sending the configured public origin
      // rather than the ephemeral test port mirrors a real deployment, where the
      // app is reached through a proxy on PUBLIC_URL while the server listens
      // on localhost.
      Origin: process.env.PUBLIC_URL,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

/** Register a user the way the browser does: keys first, password never sent. */
async function register(email, password) {
  // The signup limiter allows 5 registrations then refills slowly, which is the
  // right setting for a real server and far below what this suite needs. Clear
  // the buckets rather than weakening the limit -- the limiter itself is
  // exercised properly by security/pentest/run.js.
  await q("DELETE FROM rate_limits");
  const { upload, keys } = await C.createIdentity(password, ITER);
  const res = await api("POST", "/api/auth/register", {
    body: { email, displayName: email.split("@")[0], ...upload },
  });
  assert.equal(res.status, 201, `register ${email}: ${JSON.stringify(res.body)}`);
  return { email, password, token: res.body.token, userId: res.body.userId, keys, upload };
}

const ctx = (householdId, version) => ({ householdId, version });

/** Create a household: fresh key, wrapped to self, initial document sealed. */
async function createHousehold(user, doc) {
  const hk = C.newHouseholdKeyRaw();
  const wrappedKey = await C.wrapHouseholdKey(hk, user.keys.publicKey);
  // Version 1 is what the server assigns to a new vault.
  const sealed = await C.sealDocument(hk, doc, ctx("pending", 1));

  const res = await api("POST", "/api/households", {
    token: user.token,
    body: { wrappedKey, document: sealed },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id, hk };
}

/* =============================================================== tests ==== */

let alice, bob, carol, home;

test("a member registers and their identity round-trips", async () => {
  alice = await register("alice@example.com", "alice-correct-horse");
  const me = await api("GET", "/api/auth/me", { token: alice.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "alice@example.com");

  // The server returns the sealed blobs; only the password opens them.
  const unlocked = await C.unlockIdentity(alice.password, me.body.identity);
  assert.deepEqual(unlocked.publicKey, alice.keys.publicKey);
});

test("the server never stores anything that reveals the password", async () => {
  const { rows } = await q("SELECT password_hash, email_enc FROM users WHERE id = $1", [alice.userId]);
  const stored = rows[0].password_hash;
  assert.match(stored, /^\$argon2id\$/);
  // The verifier is over the derived auth proof, not the password, so the
  // password does not appear even in a form that could be compared against.
  assert.ok(!stored.includes(alice.password));
  // And the address is ciphertext, not text.
  assert.ok(!Buffer.from(rows[0].email_enc).toString("utf8").includes("alice@example.com"));
});

test("login works without transmitting the password", async () => {
  const params = await api("POST", "/api/auth/kdf-params", { body: { email: alice.email } });
  assert.equal(params.status, 200);
  const proof = await C.loginProof(alice.password, params.body);

  const res = await api("POST", "/api/auth/login", {
    body: { email: alice.email, authProof: proof },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  alice.token = res.body.token;
});

test("an unknown address returns plausible KDF parameters, not an error", async () => {
  // Account non-enumeration: for people who may be hiding a household's
  // existence, "is this address registered here" must not be answerable.
  const real = await api("POST", "/api/auth/kdf-params", { body: { email: alice.email } });
  const fake = await api("POST", "/api/auth/kdf-params", { body: { email: "nobody@example.com" } });

  assert.equal(fake.status, real.status);
  assert.deepEqual(Object.keys(fake.body).sort(), Object.keys(real.body).sort());
  assert.equal(typeof fake.body.kdfSalt, "string");

  // Stable across calls, so repeated probing cannot distinguish a decoy by
  // watching the value change.
  const again = await api("POST", "/api/auth/kdf-params", { body: { email: "nobody@example.com" } });
  assert.equal(again.body.kdfSalt, fake.body.kdfSalt);
});

test("a household is created and its document round-trips", async () => {
  home = await createHousehold(alice, { householdName: "The Flat", chores: [], notes: [] });

  const got = await api("GET", `/api/households/${home.id}/vault`, { token: alice.token });
  assert.equal(got.status, 200);

  const doc = await C.openDocument(home.hk, {
    ...got.body, householdId: "pending", version: 1,
  });
  assert.equal(doc.householdName, "The Flat");
});

test("what the server stores is ciphertext, not the household document", async () => {
  const { rows } = await q("SELECT ciphertext FROM vault_documents WHERE household_id = $1", [home.id]);
  const raw = Buffer.from(rows[0].ciphertext).toString("utf8");
  assert.ok(!raw.includes("The Flat"), "the household name must not be readable in the database");
  assert.ok(!raw.includes("householdName"));
});

test("the household key in the database cannot be unwrapped by the server", async () => {
  const { rows } = await q(
    "SELECT wrapped_key, wrap_epk FROM household_keys WHERE household_id = $1", [home.id]
  );
  assert.ok(rows.length === 1);
  // Everything the server has: an ephemeral public key and a sealed blob.
  // Without Alice's private key -- which is itself sealed under her password --
  // these are inert.
  const wrapped = {
    epk: Buffer.from(rows[0].wrap_epk).toString("base64"),
    wrapped: Buffer.from(rows[0].wrapped_key).toString("base64"),
  };
  const attacker = await C.createIdentity("attacker", ITER);
  await assert.rejects(
    () => C.unwrapHouseholdKey(wrapped, attacker.keys.privateKey, attacker.keys.publicKey)
  );
  // Alice, of course, can.
  assert.deepEqual(
    await C.unwrapHouseholdKey(wrapped, alice.keys.privateKey, alice.keys.publicKey),
    home.hk
  );
});

test("a stale write is rejected and hands back the current document", async () => {
  const sealed = await C.sealDocument(home.hk, { householdName: "Renamed" }, ctx(home.id, 2));
  const stale = await api("PUT", `/api/households/${home.id}/vault`, {
    token: alice.token,
    body: { ...sealed, baseVersion: 99 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "version_conflict");
  // The rejection carries the winning document, so the client merges without a
  // second round trip.
  assert.ok(stale.body.current?.ciphertext);
});

test("a good write advances the version", async () => {
  const sealed = await C.sealDocument(home.hk, { householdName: "The Flat", note: "hi" }, ctx(home.id, 2));
  const res = await api("PUT", `/api/households/${home.id}/vault`, {
    token: alice.token, body: { ...sealed, baseVersion: 1 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.version, 2);
});

/* ------------------------------------------------------ claiming a seat --- */

test("an invited member cannot read anything until an admin grants a key", async () => {
  bob = await register("bob@example.com", "bob-battery-staple");

  const invite = await api("POST", `/api/households/${home.id}/invites`, {
    token: alice.token, body: { role: "admin" },
  });
  assert.equal(invite.status, 201);
  const token = invite.body.url.split("#")[1];

  const accept = await api("POST", "/api/invites/accept", { token: bob.token, body: { token } });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.status, "pending");

  // Membership exists, but no key has been wrapped to Bob yet.
  const attempt = await api("GET", `/api/households/${home.id}/vault`, { token: bob.token });
  assert.equal(attempt.status, 404, "a pending member must not reach the vault");
});

test("an admin admits the new member by wrapping the key to them", async () => {
  const members = await api("GET", `/api/households/${home.id}/members`, { token: alice.token });
  assert.equal(members.status, 200);
  const bobRow = members.body.find((m) => m.userId === bob.userId);
  assert.ok(bobRow, "Bob should appear as a pending member");

  // Alice's browser wraps the household key to the public key it was shown.
  const wrappedKey = await C.wrapHouseholdKey(home.hk, C.fromB64(bobRow.publicKey));
  const grant = await api("POST", `/api/households/${home.id}/members/${bob.userId}/key`, {
    token: alice.token, body: { wrappedKey, publicKey: bobRow.publicKey },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
});

test("the new member can now read the household", async () => {
  const hh = await api("GET", `/api/households/${home.id}`, { token: bob.token });
  assert.equal(hh.status, 200);

  const hk = await C.unwrapHouseholdKey(hh.body.wrappedKey, bob.keys.privateKey, bob.keys.publicKey);
  assert.deepEqual(hk, home.hk, "Bob derives the same household key Alice created");

  const vault = await api("GET", `/api/households/${home.id}/vault`, { token: bob.token });
  const doc = await C.openDocument(hk, { ...vault.body, householdId: home.id, version: vault.body.version });
  assert.equal(doc.note, "hi");
});

test("a stranger cannot reach another household at all", async () => {
  carol = await register("carol@example.com", "carol-passphrase");
  for (const path of ["", "/vault", "/members", "/displays"]) {
    const res = await api("GET", `/api/households/${home.id}${path}`, { token: carol.token });
    // 404, not 403: confirming the household exists is itself a disclosure.
    assert.equal(res.status, 404, `${path} leaked existence`);
  }
});

/* ------------------------------------------------------------- displays --- */

let display, displayKeys;

test("a display cannot be activated by one admin when two must sign off", async () => {
  // Bob was invited as an admin, so the household now has two.
  displayKeys = C.newDisplayKeypair();
  const proposed = await api("POST", `/api/households/${home.id}/displays`, {
    token: alice.token,
    body: {
      name: "Hallway iPad",
      scopes: ["today", "calendar", "meals"],
      publicKey: C.toB64(displayKeys.publicKey),
    },
  });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  display = proposed.body;
  assert.equal(display.required, 2, "both admins must approve");

  // Alice tries to bring it up on her own approval alone.
  const wrappedKey = await C.wrapHouseholdKey(home.hk, displayKeys.publicKey, "display");
  const early = await api("POST", `/api/households/${home.id}/displays/${display.id}/activate`, {
    token: alice.token,
    body: { wrappedKey, publicKey: C.toB64(displayKeys.publicKey) },
  });
  assert.equal(early.status, 403, "one admin must not be able to light up a display alone");
  assert.match(early.body.error, /approval/i);
});

test("once every admin approves, the display activates and can decrypt", async () => {
  const proof = await C.approvalProof(bob.keys, display.id, displayKeys.publicKey);
  const approve = await api("POST", `/api/households/${home.id}/displays/${display.id}/approve`, {
    token: bob.token, body: { decision: "approve", proof },
  });
  assert.equal(approve.status, 200);

  const wrappedKey = await C.wrapHouseholdKey(home.hk, displayKeys.publicKey, "display");
  const activated = await api("POST", `/api/households/${home.id}/displays/${display.id}/activate`, {
    token: alice.token,
    body: { wrappedKey, publicKey: C.toB64(displayKeys.publicKey) },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  // The wall tablet now bootstraps with its permanent link and nothing else.
  const displayToken = activated.body.url.split("#")[1];
  const boot = await api("GET", "/api/display/bootstrap", { token: displayToken });
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.body.scopes, ["today", "calendar", "meals"]);

  const hk = await C.unwrapHouseholdKey(
    boot.body.wrappedKey, displayKeys.privateKey, displayKeys.publicKey, "display"
  );
  assert.deepEqual(hk, home.hk);

  const vault = await api("GET", "/api/display/vault", { token: displayToken });
  const doc = await C.openDocument(hk, { ...vault.body, householdId: home.id, version: vault.body.version });
  assert.equal(doc.householdName, "The Flat");

  display.url = activated.body.url;
  display.token = displayToken;
});

test("a display is read-only and cannot reach member endpoints", async () => {
  const write = await api("PUT", `/api/households/${home.id}/vault`, {
    token: display.token,
    body: { ciphertext: "AAAA", compression: "none", plainBytes: 1, baseVersion: 2 },
  });
  // The display token is not a session, so it does not authenticate here at all.
  assert.ok([401, 404].includes(write.status), `display could write: ${write.status}`);

  const members = await api("GET", `/api/households/${home.id}/members`, { token: display.token });
  assert.ok([401, 404].includes(members.status));
});

test("revoking a display kills its link immediately", async () => {
  const revoke = await api("DELETE", `/api/households/${home.id}/displays/${display.id}`, {
    token: alice.token,
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.rotationRecommended, true);

  const after = await api("GET", "/api/display/vault", { token: display.token });
  assert.equal(after.status, 404, "a revoked display must stop resolving");
});

/* ------------------------------------------------------------- rotation --- */

test("removing a member and rotating cuts off their old key", async () => {
  const removed = await api("DELETE", `/api/households/${home.id}/members/${bob.userId}`, {
    token: alice.token,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.rotationRequired, true);

  // Bob is out immediately, even before rotation.
  const bobRead = await api("GET", `/api/households/${home.id}/vault`, { token: bob.token });
  assert.equal(bobRead.status, 404);

  // Alice rotates: new key, re-wrapped for everyone left, document re-sealed.
  const newHk = C.newHouseholdKeyRaw();
  const vault = await api("GET", `/api/households/${home.id}/vault`, { token: alice.token });
  const doc = await C.openDocument(home.hk, {
    ...vault.body, householdId: home.id, version: vault.body.version,
  });

  const resealed = await C.sealDocument(newHk, doc, ctx(home.id, vault.body.version + 1));
  const rotate = await api("POST", `/api/households/${home.id}/rotate-key`, {
    token: alice.token,
    body: {
      keys: [{
        subjectType: "user", subjectId: alice.userId,
        ...(await C.wrapHouseholdKey(newHk, alice.keys.publicKey)),
      }],
      document: resealed,
    },
  });
  assert.equal(rotate.status, 200, JSON.stringify(rotate.body));
  assert.equal(rotate.body.keyEpoch, 2);

  // Every wrap under the old epoch is gone, so Bob's stored copy is not merely
  // unreachable -- it no longer exists.
  const { rows } = await q(
    "SELECT count(*)::int AS n FROM household_keys WHERE household_id = $1 AND key_epoch < 2", [home.id]
  );
  assert.equal(rows[0].n, 0);

  home.hk = newHk;
});

test("rotation refuses to lock a current member out", async () => {
  // Alice tries to rotate while forgetting to re-wrap for herself.
  const sealed = await C.sealDocument(C.newHouseholdKeyRaw(), {}, ctx(home.id, 99));
  const res = await api("POST", `/api/households/${home.id}/rotate-key`, {
    token: alice.token,
    body: {
      keys: [{
        subjectType: "user", subjectId: carol.userId,   // not a member here
        ...(await C.wrapHouseholdKey(C.newHouseholdKeyRaw(), carol.keys.publicKey)),
      }],
      document: sealed,
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /missing wrapped keys/i);
});

test("the document still opens after rotation", async () => {
  const vault = await api("GET", `/api/households/${home.id}/vault`, { token: alice.token });
  assert.equal(vault.body.keyEpoch, 2);
  const doc = await C.openDocument(home.hk, {
    ...vault.body, householdId: home.id, version: vault.body.version,
  });
  assert.equal(doc.householdName, "The Flat");
});

/* ---------------------------------------------------------------- roles --- */

test("the last admin cannot demote themselves and brick the household", async () => {
  const res = await api("PUT", `/api/households/${home.id}/members/${alice.userId}/role`, {
    token: alice.token, body: { role: "adult" },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /only admin/i);
});

test("a dependent account can be created for someone else", async () => {
  // The guardian's browser generates the child's whole identity, so even here
  // the server never sees a password.
  const child = await C.createIdentity("child-password", ITER);
  const wrappedKey = await C.wrapHouseholdKey(home.hk, child.keys.publicKey);

  const res = await api("POST", `/api/households/${home.id}/members/managed`, {
    token: alice.token,
    body: {
      email: "kid@example.com", displayName: "Kid", role: "dependent",
      identity: child.upload, wrappedKey,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // And the child can sign in on their own and read the household.
  const params = await api("POST", "/api/auth/kdf-params", { body: { email: "kid@example.com" } });
  const login = await api("POST", "/api/auth/login", {
    body: { email: "kid@example.com", authProof: await C.loginProof("child-password", params.body) },
  });
  assert.equal(login.status, 200);

  const hh = await api("GET", `/api/households/${home.id}`, { token: login.body.token });
  const hk = await C.unwrapHouseholdKey(hh.body.wrappedKey, child.keys.privateKey, child.keys.publicKey);
  assert.deepEqual(hk, home.hk);
});

/* ---------------------------------------------------------------- audit --- */

test("the audit log is hash-chained and verifies", async () => {
  const { verifyChain } = await import("../src/services/audit.js");
  const result = await verifyChain();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.entries > 5);
});

test("the audit log records actions but never content", async () => {
  const { rows } = await q("SELECT action, meta FROM audit_log");
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes("The Flat"), "the household name must not reach the audit log");
  assert.ok(!blob.includes("alice@example.com"));
  assert.ok(rows.some((r) => r.action === "key_rotated"));
});

test("audit rows cannot be altered, even with direct database access", async () => {
  await assert.rejects(
    () => q("UPDATE audit_log SET action = 'nothing-to-see-here' WHERE id = 1"),
    /append-only/
  );
  await assert.rejects(() => q("DELETE FROM audit_log"), /append-only/);
});

/* ------------------------------------------------------------- deletion --- */

test("an account can actually be deleted", async () => {
  // Regression test for a real bug: audit_log had ON DELETE SET NULL foreign
  // keys to users and households, while a trigger rejected every UPDATE to make
  // the log tamper-evident. The two contradicted each other, so deleting any
  // account failed with "audit_log is append-only" -- meaning nobody could ever
  // remove their account. Fixed in migration 003 by detaching the FKs.
  const doomed = await register(`doomed-${Date.now()}@example.com`, "delete-me-please");
  const house = await createHousehold(doomed, { householdName: "Temporary" });

  // Generate audit entries referencing this user, which is what used to block it.
  await api("POST", `/api/households/${house.id}/invites`, {
    token: doomed.token, body: { role: "adult" },
  });

  await assert.doesNotReject(() => q("DELETE FROM users WHERE id = $1", [doomed.userId]));

  const gone = await q("SELECT 1 FROM users WHERE id = $1", [doomed.userId]);
  assert.equal(gone.rowCount, 0);
});

test("deleting an account leaves the audit chain intact and truthful", async () => {
  const { verifyChain } = await import("../src/services/audit.js");
  const result = await verifyChain();
  assert.equal(result.ok, true, "the hash chain must still verify after a deletion");

  // The historical entries still name who acted, rather than having been
  // rewritten to "nobody" -- which is the property that makes the log an audit
  // trail rather than a mutable summary.
  const { rows } = await q(
    "SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id IS NOT NULL"
  );
  assert.ok(rows[0].n > 0, "past entries must keep their actor after that actor is deleted");
});

/* ------------------------------------------------- listing and retiring --- */

test("the household list carries a decryptable name", async () => {
  // Regression: the picker showed "Household" for every entry, because the name
  // lived only inside the encrypted document and nothing decrypted it up front.
  const owner = await register(`namer-${Date.now()}@example.com`, "name-test-passphrase");
  const hk = C.newHouseholdKeyRaw();
  const res = await api("POST", "/api/households", {
    token: owner.token,
    body: {
      wrappedKey: await C.wrapHouseholdKey(hk, owner.keys.publicKey),
      document: await C.sealDocument(hk, { householdName: "The Narrowboat" }, ctx("pending", 1)),
      nameEnc: await C.sealName(hk, "The Narrowboat"),
    },
  });
  assert.equal(res.status, 201);

  const list = await api("GET", "/api/households", { token: owner.token });
  assert.equal(list.status, 200);
  const row = list.body.find((h) => h.id === res.body.id);

  assert.ok(row.wrappedKey, "the wrapped key must come back so the client can read the name");
  const key = await C.unwrapHouseholdKey(row.wrappedKey, owner.keys.privateKey, owner.keys.publicKey);
  assert.equal(await C.openName(key, row.nameEnc), "The Narrowboat");

  // And the server still cannot read it.
  const { rows } = await q("SELECT name_enc FROM households WHERE id = $1", [res.body.id]);
  assert.ok(!Buffer.from(rows[0].name_enc).toString("utf8").includes("Narrowboat"));
});

test("archiving is per-member, not shared", async () => {
  // After a breakup the two people will not agree that the household is over.
  // One archiving it must not remove it from the other's list.
  const a = await register(`arch-a-${Date.now()}@example.com`, "archive-passphrase-a");
  const b = await register(`arch-b-${Date.now()}@example.com`, "archive-passphrase-b");
  const house = await createHousehold(a, { householdName: "Shared" });

  const invite = await api("POST", `/api/households/${house.id}/invites`, {
    token: a.token, body: { role: "admin" },
  });
  await api("POST", "/api/invites/accept", { token: b.token, body: { token: invite.body.url.split("#")[1] } });
  const members = await api("GET", `/api/households/${house.id}/members`, { token: a.token });
  const bRow = members.body.find((m) => m.userId === b.userId);
  await api("POST", `/api/households/${house.id}/members/${b.userId}/key`, {
    token: a.token,
    body: {
      wrappedKey: await C.wrapHouseholdKey(house.hk, C.fromB64(bRow.publicKey)),
      publicKey: bRow.publicKey,
    },
  });

  const archived = await api("POST", `/api/households/${house.id}/archive`, {
    token: a.token, body: { archived: true },
  });
  assert.equal(archived.status, 200);

  const aList = await api("GET", "/api/households", { token: a.token });
  const bList = await api("GET", "/api/households", { token: b.token });
  assert.equal(aList.body.find((h) => h.id === house.id).archived, true);
  assert.equal(bList.body.find((h) => h.id === house.id).archived, false,
    "one member archiving must not hide the household from the other");

  // Reversible.
  await api("POST", `/api/households/${house.id}/archive`, { token: a.token, body: { archived: false } });
  const back = await api("GET", "/api/households", { token: a.token });
  assert.equal(back.body.find((h) => h.id === house.id).archived, false);
});

test("a household cannot be deleted while anyone else is still in it", async () => {
  // The scenario is a relationship ending. Either party being able to destroy
  // the shared record unilaterally would make this a weapon.
  const a = await register(`del-a-${Date.now()}@example.com`, "delete-passphrase-a");
  const b = await register(`del-b-${Date.now()}@example.com`, "delete-passphrase-b");
  const house = await createHousehold(a, { householdName: "Ours" });

  const invite = await api("POST", `/api/households/${house.id}/invites`, {
    token: a.token, body: { role: "adult" },
  });
  await api("POST", "/api/invites/accept", { token: b.token, body: { token: invite.body.url.split("#")[1] } });
  const members = await api("GET", `/api/households/${house.id}/members`, { token: a.token });
  const bRow = members.body.find((m) => m.userId === b.userId);
  await api("POST", `/api/households/${house.id}/members/${b.userId}/key`, {
    token: a.token,
    body: {
      wrappedKey: await C.wrapHouseholdKey(house.hk, C.fromB64(bRow.publicKey)),
      publicKey: bRow.publicKey,
    },
  });

  const blocked = await api("DELETE", `/api/households/${house.id}`, { token: a.token });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /other member/i);

  // Once alone, it goes.
  await api("DELETE", `/api/households/${house.id}/members/${b.userId}`, { token: a.token });
  const gone = await api("DELETE", `/api/households/${house.id}`, { token: a.token });
  assert.equal(gone.status, 200);

  const { rows } = await q("SELECT 1 FROM households WHERE id = $1", [house.id]);
  assert.equal(rows.length, 0);
  const vault = await q("SELECT 1 FROM vault_documents WHERE household_id = $1", [house.id]);
  assert.equal(vault.rows.length, 0, "the vault must go with the household");
});

test("a non-admin cannot delete a household", async () => {
  const owner = await register(`solo-${Date.now()}@example.com`, "solo-passphrase");
  const outsider = await register(`out-${Date.now()}@example.com`, "outsider-passphrase");
  const house = await createHousehold(owner, { householdName: "Mine" });

  const res = await api("DELETE", `/api/households/${house.id}`, { token: outsider.token });
  assert.equal(res.status, 404);
  const { rows } = await q("SELECT 1 FROM households WHERE id = $1", [house.id]);
  assert.equal(rows.length, 1);
});

/* --------------------------------------------- archives, displays, locks --- */

/** Two admins in one household, for the unanimity tests. */
async function twoAdminHousehold(tag) {
  const a = await register(`${tag}-a-${Date.now()}@example.com`, `${tag}-passphrase-a`);
  const b = await register(`${tag}-b-${Date.now()}@example.com`, `${tag}-passphrase-b`);
  const house = await createHousehold(a, { householdName: tag });

  const invite = await api("POST", `/api/households/${house.id}/invites`, {
    token: a.token, body: { role: "admin" },
  });
  await api("POST", "/api/invites/accept", { token: b.token, body: { token: invite.body.url.split("#")[1] } });
  const members = await api("GET", `/api/households/${house.id}/members`, { token: a.token });
  const bRow = members.body.find((m) => m.userId === b.userId);
  await api("POST", `/api/households/${house.id}/members/${b.userId}/key`, {
    token: a.token,
    body: {
      wrappedKey: await C.wrapHouseholdKey(house.hk, C.fromB64(bRow.publicKey)),
      publicKey: bRow.publicKey,
    },
  });
  return { a, b, house };
}

test("turning an archive off needs every admin, and one refusal ends it", async () => {
  const { a, b, house } = await twoAdminHousehold("arch");

  const proposed = await api("POST", `/api/households/${house.id}/proposals`, {
    token: a.token, body: { kind: "disable_archive", payload: { collections: ["chores"] } },
  });
  assert.equal(proposed.status, 201);
  assert.equal(proposed.body.required, 2);
  // Proposing counts as consenting, but one of two is not enough.
  assert.equal(proposed.body.satisfied, false);

  // Applying before everyone agrees is refused.
  const early = await api("POST", `/api/households/${house.id}/proposals/${proposed.body.id}/applied`, {
    token: a.token,
  });
  assert.equal(early.status, 403);

  // The second admin refuses: that ends it outright.
  const denied = await api("POST", `/api/households/${house.id}/proposals/${proposed.body.id}/decide`, {
    token: b.token, body: { decision: "deny" },
  });
  assert.equal(denied.body.status, "denied");

  const stillBlocked = await api("POST", `/api/households/${house.id}/proposals/${proposed.body.id}/applied`, {
    token: a.token,
  });
  assert.equal(stillBlocked.status, 403);
});

test("with every admin agreeing, the wipe is authorised and recorded", async () => {
  const { a, b, house } = await twoAdminHousehold("arch2");

  const proposed = await api("POST", `/api/households/${house.id}/proposals`, {
    token: a.token, body: { kind: "disable_archive", payload: { collections: ["chores"] } },
  });
  const agreed = await api("POST", `/api/households/${house.id}/proposals/${proposed.body.id}/decide`, {
    token: b.token, body: { decision: "approve" },
  });
  assert.equal(agreed.body.status, "approved");
  assert.equal(agreed.body.satisfied, true);

  const applied = await api("POST", `/api/households/${house.id}/proposals/${proposed.body.id}/applied`, {
    token: a.token,
  });
  assert.equal(applied.status, 200);

  const { rows } = await q(
    "SELECT action FROM audit_log WHERE household_id = $1 AND action = 'proposal_applied'", [house.id]
  );
  assert.equal(rows.length, 1, "the wipe must be permanently recorded");
});

test("a non-admin cannot propose or decide", async () => {
  const { a, house } = await twoAdminHousehold("arch3");
  const outsider = await register(`out-${Date.now()}@example.com`, "outsider-passphrase-x");

  const proposed = await api("POST", `/api/households/${house.id}/proposals`, {
    token: outsider.token, body: { kind: "disable_archive", payload: { collections: ["chores"] } },
  });
  assert.equal(proposed.status, 404);
  assert.ok(a);
});

/** An active display, optionally allowed to write and control things. */
async function activeDisplay(owner, house, opts = {}) {
  const keys = C.newDisplayKeypair();
  const created = await api("POST", `/api/households/${house.id}/displays`, {
    token: owner.token,
    body: {
      name: opts.name || "Kitchen iPad",
      scopes: ["today", "home"],
      publicKey: C.toB64(keys.publicKey),
      canWrite: opts.canWrite ?? false,
      controlDomains: opts.controlDomains ?? [],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const activated = await api("POST", `/api/households/${house.id}/displays/${created.body.id}/activate`, {
    token: owner.token,
    body: {
      wrappedKey: await C.wrapHouseholdKey(house.hk, keys.publicKey, "display"),
      publicKey: C.toB64(keys.publicKey),
    },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return { keys, token: activated.body.url.split("#")[1], id: created.body.id };
}

test("a display cannot write unless it has been granted it", async () => {
  const owner = await register(`disp-${Date.now()}@example.com`, "display-passphrase-x");
  const house = await createHousehold(owner, { householdName: "Screened" });
  const display = await activeDisplay(owner, house, { canWrite: false });

  const sealed = await C.sealDocument(house.hk, { householdName: "Screened", n: 1 }, ctx(house.id, 2));
  const refused = await api("PUT", "/api/display/vault", {
    token: display.token, body: { ...sealed, baseVersion: 1 },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /not allowed to change/i);
});

test("a display granted write can tick things off, and it is recorded as the display", async () => {
  const owner = await register(`dispw-${Date.now()}@example.com`, "display-passphrase-w");
  const house = await createHousehold(owner, { householdName: "Screened" });
  const display = await activeDisplay(owner, house, { canWrite: true, name: "Hall iPad" });

  const sealed = await C.sealDocument(house.hk, { householdName: "Screened", ticked: true }, ctx(house.id, 2));
  const wrote = await api("PUT", "/api/display/vault", {
    token: display.token, body: { ...sealed, baseVersion: 1 },
  });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.equal(wrote.body.version, 2);

  // The member sees the display's write, and can still decrypt it.
  const read = await api("GET", `/api/households/${house.id}/vault`, { token: owner.token });
  const doc = await C.openDocument(house.hk, { ...read.body, householdId: house.id, version: 2 });
  assert.equal(doc.ticked, true);

  // And the write is attributed to the screen, not to a person.
  const { rows } = await q(
    "SELECT meta FROM audit_log WHERE household_id = $1 AND action = 'display_wrote_vault'", [house.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.display, "Hall iPad");
  const { rows: vrows } = await q("SELECT updated_by FROM vault_documents WHERE household_id = $1", [house.id]);
  assert.equal(vrows[0].updated_by, null, "a display write must not be credited to a member");
});

test("a display is refused a lock even if every other gate would allow it", async () => {
  // The central safety rule: a screen mounted by the front door must never be
  // able to open the front door. Checked against the caller, so no capability
  // list can grant it.
  const owner = await register(`lock-${Date.now()}@example.com`, "lock-passphrase-x");
  const house = await createHousehold(owner, { householdName: "Locked" });
  const display = await activeDisplay(owner, house, {
    canWrite: true, controlDomains: ["light", "switch", "fan", "cover"],
  });

  const res = await api("POST", "/api/display/home/control", {
    token: display.token, body: { entityId: "lock.front_door", action: "on" },
  });
  assert.equal(res.status, 403, `a display must never operate a lock (got ${res.status})`);
  assert.match(res.body.error, /signed in/i);
});

test("control domains a display was not granted are refused", async () => {
  const owner = await register(`dom-${Date.now()}@example.com`, "domain-passphrase-x");
  const house = await createHousehold(owner, { householdName: "Domains" });
  const display = await activeDisplay(owner, house, { controlDomains: ["light"] });

  const covers = await api("POST", "/api/display/home/control", {
    token: display.token, body: { entityId: "cover.garage", action: "off" },
  });
  assert.equal(covers.status, 403);
  assert.match(covers.body.error, /has not been given control/i);
});
