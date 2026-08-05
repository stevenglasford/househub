// seal.js — the server's own encryption, for the small set of values it must be
// able to read: email addresses, TOTP secrets, calendar subscription URLs,
// wallet configuration.
//
// This is emphatically NOT what protects household content. Household content is
// sealed by member devices with keys this process never sees (crypto/README.md
// explains the split). What follows exists so that a stolen disk, a seized
// server, or a leaked `pg_dump` yields ciphertext for the operational metadata
// too -- defence in depth, one layer below the end-to-end layer.
//
// One root secret, many purpose-separated subkeys. Deriving per-purpose keys by
// HKDF means a bug that leaks the email key cannot decrypt wallet config, and
// ciphertext from one column can never be replayed into another.

import { createHmac, createCipheriv, createDecipheriv, randomBytes, hkdfSync, timingSafeEqual } from "node:crypto";
import { SECRET_KEY } from "../config.js";

const VERSION = 1;      // leading byte, so the format can change without a flag day
const NONCE_LEN = 12;   // AES-GCM standard nonce
const TAG_LEN = 16;

const keyCache = new Map();

/** A 32-byte key bound to `label`. Same label always yields the same key. */
export function subkey(label) {
  let k = keyCache.get(label);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", SECRET_KEY, Buffer.from("househub/v1"), Buffer.from(label), 32));
    keyCache.set(label, k);
  }
  return k;
}

/**
 * Seal `plaintext` under the key for `label`.
 *
 * `aad` binds the ciphertext to its context -- pass the row id, and a blob moved
 * from one row to another fails to open rather than silently decrypting. That
 * turns a whole class of database-level tampering into a loud error.
 *
 * Layout: [version:1][nonce:12][ciphertext:n][tag:16]
 */
export function seal(label, plaintext, aad = "") {
  if (plaintext == null) return null;
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", subkey(label), nonce, { authTagLength: TAG_LEN });
  if (aad) cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
}

/** Inverse of seal(). Throws if the label, aad, or bytes do not match. */
export function open(label, sealed, aad = "") {
  if (sealed == null) return null;
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < 1 + NONCE_LEN + TAG_LEN) throw new Error("sealed value truncated");
  if (buf[0] !== VERSION) throw new Error(`unknown seal version ${buf[0]}`);

  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", subkey(label), nonce, { authTagLength: TAG_LEN });
  if (aad) decipher.setAAD(Buffer.from(String(aad), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function openText(label, sealed, aad = "") {
  const out = open(label, sealed, aad);
  return out == null ? null : out.toString("utf8");
}

/**
 * Blind index: a deterministic, keyed fingerprint used for equality lookups on
 * a column whose real value is sealed. `WHERE email_bidx = $1` still works;
 * `SELECT email` reveals nothing.
 *
 * Deterministic means equal values produce equal fingerprints, so this leaks
 * "these two rows share an email" and supports an offline guess-and-check
 * attack by anyone holding the key. That is acceptable for an address, and the
 * reason the key lives outside the database rather than in it.
 */
export function blindIndex(label, value) {
  const norm = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  return createHmac("sha256", subkey(`bidx/${label}`)).update(norm).digest();
}

/** Constant-time compare that tolerates length mismatch without leaking it. */
export function safeEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do the work, so a length mismatch is not measurably faster.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
