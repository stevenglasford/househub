// totp.js — RFC 6238 time-based one-time passwords.
//
// Written out rather than pulled in: it is forty lines of HMAC, and every
// dependency added to the authentication path is a supply-chain foothold on the
// exact code that decides who gets in.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newSecret(bytes = 20) {
  const buf = randomBytes(bytes);
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function generate(secret, counter) {
  const key = fromBase32(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Verify, allowing `window` steps either side for clock drift.
 *
 * A wall tablet that has been unplugged for a month can be minutes out, so some
 * tolerance is necessary; ±1 step (30s) is the standard compromise between that
 * and handing an attacker extra valid codes.
 *
 * Returns the matched step so the caller can reject replays -- without that,
 * a code shoulder-surfed off a screen stays usable for its whole window.
 */
export function verify(secret, token, { window = 1, at = Date.now() } = {}) {
  const clean = String(token || "").replace(/\D/g, "");
  if (clean.length !== 6) return null;
  const step = Math.floor(at / 30000);
  for (let i = -window; i <= window; i++) {
    const expected = generate(secret, step + i);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return step + i;
  }
  return null;
}

export function otpauthUrl(secret, { issuer = "HouseHub", account = "user" } = {}) {
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${q}`;
}

/** Single-use recovery codes, for the phone that ends up at the bottom of a lake. */
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g).join("-")
  );
}
