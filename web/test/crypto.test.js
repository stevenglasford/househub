// crypto.test.js — the end-to-end layer is the one part of this system where a
// bug is silent and catastrophic, so it gets tested as adversarially as it gets
// written. These run under Node's WebCrypto, which is the same implementation
// surface the browser gives us.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createIdentity, unlockIdentity, rewrapMasterKey,
  newHouseholdKeyRaw, wrapHouseholdKey, unwrapHouseholdKey,
  sealDocument, openDocument,
  newDisplayKeypair, sealDisplayKey, openDisplayKey,
  loginProof, deriveAccountKeys,
  toB64, fromB64, randomBytes,
} from "../src/lib/crypto.js";

// Keep the tests quick: iteration count is a policy value, not a correctness
// one, and 650k of PBKDF2 per identity would dominate the run.
const ITER = 100000;

test("base64 round-trips binary of every byte value", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(fromB64(toB64(all)), all);
});

test("base64 handles payloads larger than the call-stack chunk size", () => {
  const big = randomBytes(200_000);          // exceeds the 0x8000 chunking window
  assert.deepEqual(fromB64(toB64(big)), big);
});

test("an identity unlocks with its password", async () => {
  const { upload, keys } = await createIdentity("correct horse battery staple", ITER);
  const reopened = await unlockIdentity("correct horse battery staple", upload);
  assert.deepEqual(reopened.privateKey, keys.privateKey);
  assert.deepEqual(reopened.publicKey, keys.publicKey);
});

test("a wrong password is rejected, and says so without leaking why", async () => {
  const { upload } = await createIdentity("hunter2", ITER);
  await assert.rejects(() => unlockIdentity("hunter3", upload), /Wrong password/);
});

test("the server cannot swap in a public key that is not yours", async () => {
  // The attack: a malicious server returns an attacker-controlled public key, so
  // that everything this client later wraps is readable by the attacker.
  const { upload } = await createIdentity("pw", ITER);
  const attacker = await createIdentity("attacker", ITER);
  const tampered = { ...upload, publicKey: attacker.upload.publicKey };
  await assert.rejects(() => unlockIdentity("pw", tampered), /Do not continue/);
});

test("changing a password leaves household data readable", async () => {
  const { upload, keys } = await createIdentity("old-password", ITER);
  const hk = newHouseholdKeyRaw();
  const wrapped = await wrapHouseholdKey(hk, keys.publicKey);

  const rewrapped = await rewrapMasterKey(keys.masterKeyRaw, "new-password", ITER);
  const after = await unlockIdentity("new-password", { ...upload, ...rewrapped });

  // Same identity key, so the household key still unwraps -- a password change
  // must never require re-encrypting a household's entire history.
  const opened = await unwrapHouseholdKey(wrapped, after.privateKey, after.publicKey);
  assert.deepEqual(opened, hk);
  await assert.rejects(() => unlockIdentity("old-password", { ...upload, ...rewrapped }));
});

test("a household key wraps to a member and unwraps only for them", async () => {
  const alice = await createIdentity("a", ITER);
  const bob = await createIdentity("b", ITER);
  const hk = newHouseholdKeyRaw();

  const forBob = await wrapHouseholdKey(hk, bob.keys.publicKey);
  assert.deepEqual(await unwrapHouseholdKey(forBob, bob.keys.privateKey, bob.keys.publicKey), hk);

  // Alice holding Bob's blob learns nothing from it.
  await assert.rejects(
    () => unwrapHouseholdKey(forBob, alice.keys.privateKey, alice.keys.publicKey),
    /Could not unwrap/
  );
});

test("a wrapped key cannot be moved between recipients", async () => {
  // The recipient's public key is bound into the KDF info, so copying Bob's row
  // into Carol's fails even though Carol is a legitimate member.
  const bob = await createIdentity("b", ITER);
  const carol = await createIdentity("c", ITER);
  const hk = newHouseholdKeyRaw();
  const forBob = await wrapHouseholdKey(hk, bob.keys.publicKey);
  await assert.rejects(() => unwrapHouseholdKey(forBob, carol.keys.privateKey, carol.keys.publicKey));
});

test("a wrap for a display does not open with the user context", async () => {
  // Context separation: a display's key blob must not be replayable as a user's.
  const d = newDisplayKeypair();
  const hk = newHouseholdKeyRaw();
  const forDisplay = await wrapHouseholdKey(hk, d.publicKey, "display");
  assert.deepEqual(await unwrapHouseholdKey(forDisplay, d.privateKey, d.publicKey, "display"), hk);
  await assert.rejects(() => unwrapHouseholdKey(forDisplay, d.privateKey, d.publicKey, "user"));
});

test("a document round-trips and actually compresses", async () => {
  const hk = newHouseholdKeyRaw();
  const doc = {
    householdName: "Home",
    chores: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: "Take out the trash", done: {} })),
  };
  const ctx = { householdId: "11111111-1111-1111-1111-111111111111", version: 7 };
  const sealed = await sealDocument(hk, doc, ctx);
  assert.deepEqual(await openDocument(hk, { ...sealed, ...ctx }), doc);
  assert.equal(sealed.compression, "gzip");
  assert.ok(fromB64(sealed.ciphertext).length < sealed.plainBytes / 4, "repetitive data should compress hard");
});

test("a document cannot be replayed into another household", async () => {
  // What this defends: an operator with database access moving one family's
  // ciphertext into another family's row to see if it renders.
  const hk = newHouseholdKeyRaw();
  const ctx = { householdId: "aaaaaaaa-0000-0000-0000-000000000000", version: 3 };
  const sealed = await sealDocument(hk, { secret: "ours" }, ctx);
  await assert.rejects(
    () => openDocument(hk, { ...sealed, householdId: "bbbbbbbb-0000-0000-0000-000000000000", version: 3 }),
    /integrity check/
  );
});

test("a document cannot be rolled back to an earlier version", async () => {
  const hk = newHouseholdKeyRaw();
  const ctx = { householdId: "aaaaaaaa-0000-0000-0000-000000000000", version: 9 };
  const sealed = await sealDocument(hk, { v: 9 }, ctx);
  await assert.rejects(() => openDocument(hk, { ...sealed, ...ctx, version: 8 }), /integrity check/);
});

test("a single flipped bit is caught, not silently decrypted", async () => {
  const hk = newHouseholdKeyRaw();
  const ctx = { householdId: "aaaaaaaa-0000-0000-0000-000000000000", version: 1 };
  const sealed = await sealDocument(hk, { a: 1 }, ctx);
  const bytes = fromB64(sealed.ciphertext);
  bytes[bytes.length - 20] ^= 0x01;
  await assert.rejects(
    () => openDocument(hk, { ...sealed, ...ctx, ciphertext: toB64(bytes) }),
    /integrity check/
  );
});

test("a display key is sealed under its own token", async () => {
  const { privateKey } = newDisplayKeypair();
  const token = toB64(randomBytes(32));
  const sealed = await sealDisplayKey(privateKey, token);
  assert.deepEqual(await openDisplayKey(sealed, token), privateKey);
  await assert.rejects(() => openDisplayKey(sealed, toB64(randomBytes(32))));
});

test("wrapping twice produces different ciphertext for the same key", async () => {
  // Ephemeral-static ECDH: a repeated wrap must not be byte-identical, or an
  // observer learns that two members hold the same household key.
  const bob = await createIdentity("b", ITER);
  const hk = newHouseholdKeyRaw();
  const a = await wrapHouseholdKey(hk, bob.keys.publicKey);
  const b = await wrapHouseholdKey(hk, bob.keys.publicKey);
  assert.notEqual(a.wrapped, b.wrapped);
  assert.notEqual(a.epk, b.epk);
});

test("KDF parameters below the floor are refused", async () => {
  const { upload } = await createIdentity("pw", ITER);
  // A hostile server lowering the iteration count would make offline cracking
  // of the vault cheap. The client rejects it rather than trusting the value.
  await assert.rejects(
    () => unlockIdentity("pw", { ...upload, kdfIterations: 1 }),
    /iteration count/
  );
});

test("an unknown KDF is refused rather than guessed at", async () => {
  const { upload } = await createIdentity("pw", ITER);
  await assert.rejects(
    () => unlockIdentity("pw", { ...upload, kdfAlgo: "MD5" }),
    /Unsupported KDF/
  );
});

test("the login proof is derived, stable, and reveals nothing about the password", async () => {
  // The server stores a verifier of this value, never the password. Two things
  // must hold: the same password always reproduces it, and a different password
  // never does.
  const { upload } = await createIdentity("s3cret-pass", ITER);
  const params = { kdfSalt: upload.kdfSalt, kdfIterations: ITER, kdfAlgo: "PBKDF2-SHA256" };

  assert.equal(await loginProof("s3cret-pass", params), upload.authProof);
  assert.notEqual(await loginProof("s3cret-Pass", params), upload.authProof);

  // And it must not be the key-encryption key: leaking the proof (which the
  // server necessarily sees) must not hand anyone the vault.
  const { kek } = await deriveAccountKeys("s3cret-pass", fromB64(upload.kdfSalt), ITER);
  assert.equal(kek.extractable, false);
  assert.notEqual(upload.authProof, upload.wrappedMasterKey);
});

test("changing the password produces a new login proof", async () => {
  const { upload, keys } = await createIdentity("old", ITER);
  const next = await rewrapMasterKey(keys.masterKeyRaw, "new", ITER);
  assert.notEqual(next.authProof, upload.authProof);
  assert.equal(await loginProof("new", next), next.authProof);
});
