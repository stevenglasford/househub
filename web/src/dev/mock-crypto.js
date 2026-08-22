// mock-crypto.js — stands in for lib/crypto.js in the dev sandbox.
//
// The real module throws at import time when globalThis.crypto.subtle is
// missing, which is correct: without Web Crypto the app genuinely cannot open a
// household, and failing loudly at load beats failing mysteriously later.
//
// But `subtle` is only exposed in a secure context -- HTTPS or localhost -- so
// on a LAN address over plain http that throw takes the whole page down before
// React mounts. The sandbox has no real ciphertext to open, so nothing here
// needs to actually work; it only needs to not explode on import.
//
// Two settings panels still reach for this module directly (HouseholdPanel for
// keyFingerprint, DisplaysPanel for the display key ceremony), which is why
// replacing session.js alone was not enough.
//
// sha256 comes from @noble/hashes, which is pure JS and needs no secure
// context, so fingerprints stay real -- they are what the panel actually shows.

import { sha256 } from "@noble/hashes/sha256";

const enc = new TextEncoder();

export const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * The real implementation, verbatim -- no Web Crypto involved -- with one
 * addition: a missing key returns a placeholder instead of throwing. The real
 * module is right to assume a key is always there, but in the sandbox a fixture
 * that forgets one should show a gap, not blank the settings modal.
 */
export function keyFingerprint(publicKey) {
  if (!publicKey) return "—— no key ——";
  const bytes = typeof publicKey === "string" ? fromB64(publicKey) : publicKey;
  const digest = sha256(new Uint8Array([...enc.encode("househub/fingerprint/v1"), ...bytes]));
  return Array.from(digest.subarray(0, 10))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{1,4}/g)
    .join(" ");
}

// Everything else is a key ceremony with no counterpart in the sandbox. These
// reject rather than return junk: a panel that silently "succeeded" at wrapping
// a key would be lying about the one thing this app is for.
const unavailable = (name) => () =>
  Promise.reject(new Error(`${name}() needs real Web Crypto — not available in the sandbox.`));

export const deriveAccountKeys = unavailable("deriveAccountKeys");
export const deriveKEK = unavailable("deriveKEK");
export const createIdentity = unavailable("createIdentity");
export const unlockIdentity = unavailable("unlockIdentity");
export const rewrapMasterKey = unavailable("rewrapMasterKey");
export const loginProof = unavailable("loginProof");
export const newHouseholdKeyRaw = unavailable("newHouseholdKeyRaw");
export const wrapHouseholdKey = unavailable("wrapHouseholdKey");
export const unwrapHouseholdKey = unavailable("unwrapHouseholdKey");
export const sealDocument = unavailable("sealDocument");
export const openDocument = unavailable("openDocument");
export const sealName = unavailable("sealName");
export const openName = unavailable("openName");
export const sealDisplayPrivateKey = unavailable("sealDisplayPrivateKey");
export const openDisplayPrivateKey = unavailable("openDisplayPrivateKey");
export const newDisplayKeypair = unavailable("newDisplayKeypair");
export const publicKeyFromPrivate = unavailable("publicKeyFromPrivate");
export const sealDisplayKey = unavailable("sealDisplayKey");
export const openDisplayKey = unavailable("openDisplayKey");
export const approvalProof = unavailable("approvalProof");
