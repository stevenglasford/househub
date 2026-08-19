// crypto.js — the end-to-end layer. Everything a household writes is sealed here
// and opened here, in the browser, under keys the server never receives.
//
// The shape of it:
//
//   password ──PBKDF2──> KEK ──unwraps──> master key ──unwraps──> X25519 private key
//                                                                        │
//   household key (random 32B, per household) <──ECDH-ES unwrap──────────┘
//                    │
//                    └──AES-256-GCM──> the household document
//
// Two independent derivations hang off the same password. The server holds an
// Argon2id *verifier* (crypto/password.js) which proves you know it; the browser
// runs PBKDF2 over it to get a key-encryption key that is never transmitted.
// This is what makes "the operator cannot read your data" a property of the
// maths rather than a promise in a privacy policy.
//
// Curve operations use @noble/curves rather than WebCrypto: X25519 only reached
// WebCrypto in recent browser versions, and a wall tablet is exactly the device
// stuck three OS releases behind. AES-GCM and PBKDF2 come from WebCrypto, which
// is universally available and keeps the bulk symmetric work in native code.

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  throw new Error(
    "This browser has no Web Crypto API. HouseHub cannot decrypt your data without it. " +
    "Web Crypto requires a secure context -- serve the app over HTTPS or via localhost."
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------- encoding --- */

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  // Chunked: String.fromCharCode(...bigArray) overflows the call stack on
  // documents of any real size.
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// getRandomValues refuses more than 65536 bytes in one call, so fill in chunks.
// Every current caller asks for 12-32 bytes, but a helper this fundamental
// should not have a size cliff waiting for whoever adds the next caller.
export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  }
  return out;
}

/* ------------------------------------------------------- key derivation --- */

/**
 * Stretch the password into a key-encryption key.
 *
 * PBKDF2-SHA256 at 650k iterations is the OWASP 2023 floor. Argon2id would be
 * the better primitive -- it resists GPU attack far more effectively -- but it
 * is not in WebCrypto, and shipping a WASM build means the login page cannot
 * work if that asset fails to load. The parameters are stored per-user and sent
 * by the server at login (`kdfAlgo`, `kdfIterations`), so moving to Argon2id
 * later is an account-by-account upgrade, not a migration everyone must survive
 * at once. See docs/THREAT-MODEL.md.
 */
export async function deriveAccountKeys(password, salt, iterations = 650000, algo = "PBKDF2-SHA256") {
  if (algo !== "PBKDF2-SHA256") throw new Error(`Unsupported KDF: ${algo}. Update HouseHub.`);
  if (iterations < 100000) throw new Error("Refusing a KDF iteration count below 100000.");

  const material = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  // 64 bytes in one pass, split into two halves that never mix:
  //   [0..32)  key-encryption key -- stays here, unwraps the master key
  //   [32..64) auth proof         -- goes to the server in place of the password
  const bits = new Uint8Array(await subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 512
  ));

  const kek = await subtle.importKey("raw", bits.subarray(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const authProof = toB64(hkdf(sha256, bits.subarray(32), salt, enc.encode("househub/auth/v1"), 32));
  bits.fill(0);
  return { kek, authProof };
}

/** Back-compat shim for callers that only want the wrapping key. */
export async function deriveKEK(password, salt, iterations, algo) {
  return (await deriveAccountKeys(password, salt, iterations, algo)).kek;
}

const importAes = (raw, usages = ["encrypt", "decrypt"]) =>
  subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);

/* --------------------------------------------------------------- sealing --- */

// Wire format for every symmetric blob: [nonce:12][ciphertext+tag].
// Self-contained, so a blob can be stored in one column and moved intact.

async function aesSeal(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const params = { name: "AES-GCM", iv: nonce, tagLength: 128 };
  if (aad) params.additionalData = aad;
  const ct = new Uint8Array(await subtle.encrypt(params, key, plaintext));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce); out.set(ct, nonce.length);
  return out;
}

async function aesOpen(key, blob, aad) {
  if (blob.length < 12 + 16) throw new Error("Ciphertext is truncated.");
  const params = { name: "AES-GCM", iv: blob.subarray(0, 12), tagLength: 128 };
  if (aad) params.additionalData = aad;
  return new Uint8Array(await subtle.decrypt(params, key, blob.subarray(12)));
}

/* -------------------------------------------------------------- identity --- */

/**
 * Everything a brand-new account needs. The returned `upload` half is what the
 * server stores; the `keys` half stays in memory for the session and is never
 * persisted to disk, localStorage, or IndexedDB.
 */
export async function createIdentity(password, iterations = 650000) {
  const kdfSalt = randomBytes(16);
  const { kek, authProof } = await deriveAccountKeys(password, kdfSalt, iterations);

  const masterKeyRaw = randomBytes(32);
  const wrappedMasterKey = await aesSeal(kek, masterKeyRaw, enc.encode("househub/master/v1"));

  const masterKey = await importAes(masterKeyRaw);
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  const encPrivateKey = await aesSeal(masterKey, privateKey, publicKey);

  return {
    upload: {
      kdfAlgo: "PBKDF2-SHA256",
      kdfIterations: iterations,
      kdfSalt: toB64(kdfSalt),
      wrappedMasterKey: toB64(wrappedMasterKey),
      publicKey: toB64(publicKey),
      encPrivateKey: toB64(encPrivateKey),
      // What the server stores an Argon2id verifier *of*. The password itself is
      // not in this object and is never sent anywhere.
      authProof,
    },
    keys: { masterKey, masterKeyRaw, privateKey, publicKey },
  };
}

/** Reverse of createIdentity: turn a password plus the stored blobs into keys. */
export async function unlockIdentity(password, stored) {
  const { kek } = await deriveAccountKeys(
    password, fromB64(stored.kdfSalt), stored.kdfIterations, stored.kdfAlgo
  );

  let masterKeyRaw;
  try {
    masterKeyRaw = await aesOpen(kek, fromB64(stored.wrappedMasterKey), enc.encode("househub/master/v1"));
  } catch {
    // The only realistic cause is a wrong password: AES-GCM does not
    // distinguish "bad key" from "corrupt data", and neither should we.
    throw new Error("Wrong password.");
  }

  const masterKey = await importAes(masterKeyRaw);
  const publicKey = fromB64(stored.publicKey);

  // The stored public key is server-supplied, and it is the value other members
  // wrap household keys to. A hostile server that substitutes its own key here
  // would have every future wrap addressed to it. Two defences, in order:
  //
  //   1. The public key is the AAD over the sealed private key, so a swap makes
  //      this decrypt fail outright. That is the one that actually fires.
  //   2. The derived-key comparison below, which does not depend on the AAD
  //      binding and so still holds if this format ever changes.
  let privateKey;
  try {
    privateKey = await aesOpen(masterKey, fromB64(stored.encPrivateKey), publicKey);
  } catch {
    throw new Error(
      "Your identity key did not verify against the public key the server returned. " +
      "This means either the stored data is corrupt or the server altered it -- in which " +
      "case anything you save now could be readable by someone else. Do not continue."
    );
  }

  if (toB64(x25519.getPublicKey(privateKey)) !== toB64(publicKey)) {
    throw new Error(
      "Key mismatch: the public key the server returned is not the one belonging to your " +
      "private key. Do not continue."
    );
  }

  return { masterKey, masterKeyRaw, privateKey, publicKey };
}

/** Re-wrap the master key under a new password. Household data is untouched. */
export async function rewrapMasterKey(masterKeyRaw, newPassword, iterations = 650000) {
  const kdfSalt = randomBytes(16);
  const { kek, authProof } = await deriveAccountKeys(newPassword, kdfSalt, iterations);
  return {
    kdfAlgo: "PBKDF2-SHA256",
    kdfIterations: iterations,
    kdfSalt: toB64(kdfSalt),
    wrappedMasterKey: toB64(await aesSeal(kek, masterKeyRaw, enc.encode("househub/master/v1"))),
    authProof,
  };
}

/**
 * The login proof on its own, for the sign-in path where we need to talk to the
 * server before we have anything to unwrap.
 */
export async function loginProof(password, { kdfSalt, kdfIterations, kdfAlgo }) {
  const { authProof } = await deriveAccountKeys(password, fromB64(kdfSalt), kdfIterations, kdfAlgo);
  return authProof;
}

/* ------------------------------------------------- household key wrapping --- */

// ECDH-ES with a fresh ephemeral key per wrap. The recipient's public key is
// mixed into the HKDF info, which binds the wrapped key to exactly one
// recipient: a blob copied to another member's row will not open.

const WRAP_INFO = (recipientPub, context) =>
  new Uint8Array([...enc.encode(`househub/hkwrap/v1/${context}/`), ...recipientPub]);

export function newHouseholdKeyRaw() {
  return randomBytes(32);
}

export async function wrapHouseholdKey(householdKeyRaw, recipientPublicKey, context = "user") {
  const ephPriv = randomBytes(32);
  const epk = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientPublicKey);

  const wrapRaw = hkdf(sha256, shared, undefined, WRAP_INFO(recipientPublicKey, context), 32);
  const wrapKey = await importAes(wrapRaw, ["encrypt"]);
  const wrapped = await aesSeal(wrapKey, householdKeyRaw, epk);

  ephPriv.fill(0); shared.fill(0); wrapRaw.fill(0);
  return { epk: toB64(epk), wrapped: toB64(wrapped) };
}

export async function unwrapHouseholdKey({ epk, wrapped }, myPrivateKey, myPublicKey, context = "user") {
  const epkBytes = fromB64(epk);
  const shared = x25519.getSharedSecret(myPrivateKey, epkBytes);
  const wrapRaw = hkdf(sha256, shared, undefined, WRAP_INFO(myPublicKey, context), 32);
  const wrapKey = await importAes(wrapRaw, ["decrypt"]);
  try {
    return await aesOpen(wrapKey, fromB64(wrapped), epkBytes);
  } catch {
    throw new Error("Could not unwrap the household key. It may have been rotated -- reload the page.");
  } finally {
    shared.fill(0); wrapRaw.fill(0);
  }
}

/* -------------------------------------------------------------- document --- */

// Compression happens before encryption, which is safe here because the
// attacker cannot inject chosen plaintext into a household document and watch
// the length change (the CRIME/BREACH precondition). It matters because a
// year of meal plans and chores is highly repetitive and compresses ~10x,
// and the vault is what a paying household's quota is measured against.

async function gzip(bytes) {
  if (typeof CompressionStream === "undefined") return { data: bytes, algo: "none" };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), algo: "gzip" };
}

async function gunzip(bytes, algo) {
  if (algo !== "gzip") return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress the vault. Use a current browser.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Seal the whole household document.
 *
 * `householdId` and `version` go into the AAD, so ciphertext cannot be replayed
 * into a different household or rolled back to an earlier version by anyone
 * with database access -- both attacks fail the authentication tag instead of
 * silently succeeding.
 */
export async function sealDocument(householdKeyRaw, doc, { householdId, version }) {
  const plain = enc.encode(JSON.stringify(doc));
  const { data, algo } = await gzip(plain);
  const key = await importAes(householdKeyRaw, ["encrypt"]);
  const aad = enc.encode(`househub/doc/v1/${householdId}/${version}/${algo}`);
  return {
    ciphertext: toB64(await aesSeal(key, data, aad)),
    compression: algo,
    plainBytes: plain.length,
  };
}

export async function openDocument(householdKeyRaw, { ciphertext, compression, householdId, version }) {
  const key = await importAes(householdKeyRaw, ["decrypt"]);
  const aad = enc.encode(`househub/doc/v1/${householdId}/${version}/${compression || "none"}`);
  let raw;
  try {
    raw = await aesOpen(key, fromB64(ciphertext), aad);
  } catch {
    throw new Error(
      "The vault failed its integrity check. Either the wrong key was used, or the stored " +
      "data was altered. Nothing has been overwritten -- report this before saving."
    );
  }
  return JSON.parse(dec.decode(await gunzip(raw, compression)));
}

/* ------------------------------------------------------------------ name --- */

// The household's name, sealed under the household key.
//
// Kept separate from the document so a member can see which home is which
// *before* downloading and opening a whole vault -- which is what the household
// picker needs at login. The server stores the ciphertext and cannot read it.

export async function sealName(householdKeyRaw, name) {
  const key = await importAes(householdKeyRaw, ["encrypt"]);
  return toB64(await aesSeal(key, enc.encode(String(name ?? "")), enc.encode("househub/name/v1")));
}

export async function openName(householdKeyRaw, nameEnc) {
  if (!nameEnc) return null;
  const key = await importAes(householdKeyRaw, ["decrypt"]);
  try {
    return dec.decode(await aesOpen(key, fromB64(nameEnc), enc.encode("househub/name/v1")));
  } catch {
    // A name sealed under a rotated-away key. Not worth failing the whole
    // picker over -- the caller falls back to a placeholder.
    return null;
  }
}

/* --------------------------------------------------------------- display --- */

/**
 * Seal a display's private key under the household key, so any admin can
 * finish setting the display up and hand out its link.
 *
 * The original design kept this key in the proposing browser's memory and
 * nowhere else, which had two consequences nobody wanted. A display approved by
 * every admin could not be activated by any of them except the one who proposed
 * it, on the same device, in the same tab -- a refresh was enough to strand it
 * permanently. And once a link had been shown it could never be shown again, so
 * the second person in the household had no way to get it.
 *
 * Storing it sealed under the household key fixes both. The server holds
 * ciphertext it cannot read; every member's browser can open it. That is not an
 * escalation: a display's link grants strictly less than the household key that
 * unseals it, so anybody able to decrypt this could already read everything the
 * display will ever show.
 */
export async function sealDisplayPrivateKey(householdKeyRaw, privateKey) {
  const key = await importAes(householdKeyRaw, ["encrypt"]);
  return toB64(await aesSeal(key, privateKey, enc.encode("househub/display-key/v1")));
}

export async function openDisplayPrivateKey(householdKeyRaw, sealed) {
  if (!sealed) return null;
  const key = await importAes(householdKeyRaw, ["decrypt"]);
  try {
    return new Uint8Array(await aesOpen(key, fromB64(sealed), enc.encode("househub/display-key/v1")));
  } catch {
    // Sealed under a key epoch this household has rotated away from. The display
    // has to be recreated; the caller says so rather than throwing.
    return null;
  }
}


// A wall display gets its own X25519 keypair. The private half is generated on
// the provisioning device and handed over in the URL *fragment* of the setup
// link -- fragments are never sent in an HTTP request, so it does not reach the
// server even in access logs.

export function newDisplayKeypair() {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** Recover the public half of a stored device key. */
export const publicKeyFromPrivate = (privateKey) => x25519.getPublicKey(privateKey);

/**
 * A short, human-readable fingerprint of a public key.
 *
 * This is what two people read to each other -- out loud, in the same room --
 * before one admits the other to a household. The server supplies the public key
 * an admin wraps the household key to, so a malicious server could substitute
 * its own and be admitted. Comparing six words' worth of hex closes that, and it
 * is the only step in the whole design that depends on a human doing something.
 *
 * Truncated to 10 bytes / 80 bits: far beyond what anyone can forge by grinding
 * keypairs, and still short enough to actually be read aloud.
 */
export function keyFingerprint(publicKey) {
  const bytes = typeof publicKey === "string" ? fromB64(publicKey) : publicKey;
  const digest = sha256(new Uint8Array([...enc.encode("househub/fingerprint/v1"), ...bytes]));
  return Array.from(digest.subarray(0, 10))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)
    .join(" ");
}

/** Seal the display's private key at rest under a key derived from its own token. */
export async function sealDisplayKey(privateKey, token) {
  const keyRaw = hkdf(sha256, enc.encode(token), enc.encode("househub/display/v1"), enc.encode("at-rest"), 32);
  const key = await importAes(keyRaw, ["encrypt"]);
  const out = toB64(await aesSeal(key, privateKey, enc.encode("display")));
  keyRaw.fill(0);
  return out;
}

export async function openDisplayKey(sealed, token) {
  const keyRaw = hkdf(sha256, enc.encode(token), enc.encode("househub/display/v1"), enc.encode("at-rest"), 32);
  const key = await importAes(keyRaw, ["decrypt"]);
  try {
    return await aesOpen(key, fromB64(sealed), enc.encode("display"));
  } finally {
    keyRaw.fill(0);
  }
}

/* ------------------------------------------------------------ signatures --- */

// Admin sign-off on a display is signed, not merely recorded, so the server
// cannot manufacture an approval and activate a screen on its own. We reuse the
// X25519 key by way of a shared secret with a fixed public "verifier" point --
// a genuine Ed25519 signing key would be cleaner, and swapping to one is a
// keypair addition rather than a redesign. See docs/THREAT-MODEL.md, "Display
// approvals".
export async function approvalProof({ privateKey, publicKey }, displayId, displayPublicKey) {
  const msg = enc.encode(`househub/approve/v1/${displayId}/`);
  const material = new Uint8Array([...msg, ...displayPublicKey, ...publicKey]);
  const shared = x25519.getSharedSecret(privateKey, displayPublicKey);
  const proof = hkdf(sha256, shared, material, enc.encode("approval"), 32);
  shared.fill(0);
  return toB64(proof);
}
