// password.js — the server-side password verifier.
//
// Note what this file does *not* do: it never touches the key that decrypts a
// household. The browser stretches the same password a second time, with
// different parameters, to produce a key-encryption key that stays on the
// device (web/src/lib/crypto.js). The server only ever learns "this person
// knows the password", which is why a compromised server still cannot read a
// single family's data.
//
// Argon2id via @noble/hashes: pure JavaScript, no native build step. That
// matters more than raw speed here -- a self-hoster on a Raspberry Pi should not
// have to debug node-gyp, and hashing happens once per login, not per request.

import { argon2id } from "@noble/hashes/argon2";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ARGON_MEMORY_KIB, ARGON_TIME, ARGON_PARALLELISM } from "../config.js";

const SALT_LEN = 16;
const HASH_LEN = 32;

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");
const unb64 = (s) => Buffer.from(s, "base64");

/**
 * Returns a PHC-format string: $argon2id$v=19$m=,t=,p=$salt$hash
 * Storing the parameters alongside the hash is what lets the cost be raised
 * later without locking out everyone who registered under the old settings.
 */
export function hashPassword(password, opts = {}) {
  const m = opts.memory ?? ARGON_MEMORY_KIB;
  const t = opts.time ?? ARGON_TIME;
  const p = opts.parallelism ?? ARGON_PARALLELISM;
  const salt = randomBytes(SALT_LEN);
  const hash = argon2id(Buffer.from(password, "utf8"), salt, { m, t, p, dkLen: HASH_LEN });
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
}

/**
 * Verify, in constant time with respect to the hash contents.
 *
 * Never throws on a malformed stored hash -- it returns false. A parse error
 * that propagated as a 500 while a wrong password returned 401 would be a
 * perfectly good oracle for probing which accounts exist.
 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[1] !== "argon2id") return false;
    const params = Object.fromEntries(parts[3].split(",").map((kv) => kv.split("=")));
    const m = Number(params.m), t = Number(params.t), p = Number(params.p);
    if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p)) return false;
    // Refuse absurd parameters from a tampered row rather than allocating 64 GiB.
    if (m > 1_048_576 || t > 16 || p > 16) return false;

    const salt = unb64(parts[4]);
    const expected = unb64(parts[5]);
    const actual = Buffer.from(argon2id(Buffer.from(password, "utf8"), salt, { m, t, p, dkLen: expected.length }));
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker settings than we now use. */
export function needsRehash(stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6) return true;
    const params = Object.fromEntries(parts[3].split(",").map((kv) => kv.split("=")));
    return Number(params.m) < ARGON_MEMORY_KIB || Number(params.t) < ARGON_TIME;
  } catch { return true; }
}

/**
 * A dummy verification, run on the login path when no account matches, so that
 * "unknown address" and "wrong password" take the same wall-clock time. Without
 * it, response latency alone enumerates who has an account here -- which for
 * this product could mean confirming to a hostile party that two specific
 * people share a household.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString("hex"));
export function dummyVerify() {
  verifyPassword("not-the-password", DUMMY_HASH);
}
