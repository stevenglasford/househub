// tokens.js — every bearer secret in the system: session cookies, invite links,
// permanent display URLs.
//
// Two rules, applied without exception:
//   1. Tokens are 32 bytes from the CSPRNG. Nothing is derived from a counter,
//      a timestamp, or an id, so none can be guessed from another.
//   2. Only the hash is stored. Database access must not let anyone -- operator
//      or intruder -- mint a working display link or resume a live session.
//
// The hash is plain SHA-256 rather than a password hash, deliberately: the input
// already has 256 bits of entropy, so stretching buys nothing and would put a
// slow function on the hot path of every authenticated request.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_BYTES = 32;

/** A fresh URL-safe bearer token. Returned once; never recoverable afterwards. */
export function newToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest();
}

/**
 * Short, human-transcribable code for reading an invite down the phone to a
 * relative who is not going to click a link. Crockford base32 minus the
 * characters people confuse: no I, L, O, U.
 *
 * 10 characters over a 32-symbol alphabet is ~51 bits. That is far below a
 * bearer token, so codes carry a short expiry and a strict attempt limit -- both
 * enforced in routes/invites.js.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newHumanCode(length = 10) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out.match(/.{1,5}/g).join("-");   // XXXXX-XXXXX
}

export function normalizeHumanCode(code) {
  return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    // Fold the lookalikes a human will inevitably type instead.
    .replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) { timingSafeEqual(ba, ba); return false; }
  return timingSafeEqual(ba, bb);
}
