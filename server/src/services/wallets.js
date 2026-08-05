// wallets.js — deriving a fresh receiving address per invoice.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: no spending key ever touches this
// server. It holds extended *public* keys (BTC, ETH) and a Monero *view* key.
// Those are sufficient to generate addresses and to notice money arriving, and
// insufficient to move any of it. A server on the public internet running a
// billing endpoint is going to be attacked; when it is, the worst outcome
// should be a leaked list of addresses, not a drained wallet.
//
// A fresh address per invoice matters for the same reason the rest of this
// system is encrypted. Reusing one address publishes a public ledger of every
// payment the operator ever received, and lets anyone correlate households by
// amount and timing. Chain analysis on a static address is trivial; on
// per-invoice addresses it is at least work.

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/abstract/utils";

const concat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));

/* =========================================================== base58check === */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

function base58CheckDecode(str) {
  const full = base58Decode(str);
  if (full.length < 5) throw new Error("Too short to be base58check");
  const payload = full.subarray(0, full.length - 4);
  const checksum = full.subarray(full.length - 4);
  const expected = Buffer.from(sha256(sha256(payload))).subarray(0, 4);
  if (!expected.equals(checksum)) throw new Error("Bad checksum -- is that key copied correctly?");
  return payload;
}

function base58CheckEncode(payload) {
  const checksum = Buffer.from(sha256(sha256(payload))).subarray(0, 4);
  return base58Encode(concat(payload, checksum));
}

/* ================================================================ bech32 === */

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** Encode a native segwit address. `witver` 0 gives bc1q..., 1 gives bc1p... */
export function bech32Encode(hrp, witver, program) {
  const data = [witver, ...convertBits([...program], 8, 5, true)];
  // BIP350: v0 uses the original constant, v1+ uses bech32m.
  const constant = witver === 0 ? 1 : 0x2bc830a3;
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => BECH32[d]).join("")}`;
}

/* =================================================================== BIP32 = */

// Version bytes for the extended-key flavours in circulation. They differ only
// in the address type they imply, so accepting all three and remembering which
// one we saw is what lets an operator paste whatever their wallet gave them.
const XPUB_VERSIONS = {
  // Public halves -- the only ones this server should ever be given.
  0x0488b21e: { network: "mainnet", kind: "p2pkh" },        // xpub
  0x049d7cb2: { network: "mainnet", kind: "p2sh-p2wpkh" },  // ypub
  0x04b24746: { network: "mainnet", kind: "p2wpkh" },       // zpub
  0x043587cf: { network: "testnet", kind: "p2pkh" },        // tpub
  0x044a5262: { network: "testnet", kind: "p2sh-p2wpkh" },  // upub
  0x045f1cf6: { network: "testnet", kind: "p2wpkh" },       // vpub

  // Private halves, listed so that pasting one produces a clear refusal rather
  // than "unrecognised version". Somebody will paste an xprv; they should be
  // told exactly what they just nearly did.
  0x0488ade4: { network: "mainnet", kind: "p2pkh-priv" },       // xprv
  0x049d7878: { network: "mainnet", kind: "p2sh-p2wpkh-priv" }, // yprv
  0x04b2430c: { network: "mainnet", kind: "p2wpkh-priv" },      // zprv
  0x04358394: { network: "testnet", kind: "p2pkh-priv" },       // tprv
  0x045f18bc: { network: "testnet", kind: "p2wpkh-priv" },      // vprv
};

export function parseExtendedPublicKey(xpub) {
  const data = base58CheckDecode(xpub.trim());
  if (data.length !== 78) throw new Error("Extended key is the wrong length");

  const version = data.readUInt32BE(0);
  const meta = XPUB_VERSIONS[version];
  if (!meta) throw new Error("Unrecognised extended key version");
  if (meta.kind.endsWith("-priv")) {
    throw new Error("That is a PRIVATE extended key. Never give a server one -- paste the xpub/zpub instead.");
  }

  const key = data.subarray(45, 78);
  // A public extended key starts 0x02 or 0x03. A leading 0x00 means somebody
  // pasted an xprv that happened to survive the version check.
  if (key[0] !== 0x02 && key[0] !== 0x03) {
    throw new Error("That looks like a private key, not a public one. Refusing to store it.");
  }

  return {
    version, network: meta.network, kind: meta.kind,
    depth: data[4],
    chainCode: data.subarray(13, 45),
    publicKey: key,
  };
}

/** CKDpub: non-hardened public child derivation. */
function deriveChild({ chainCode, publicKey }, index) {
  if (index >= 0x80000000) throw new Error("Cannot derive a hardened child from a public key");
  const data = concat(publicKey, Buffer.from([index >> 24, (index >> 16) & 0xff, (index >> 8) & 0xff, index & 0xff]));
  const I = hmac(sha512, chainCode, data);
  const IL = I.subarray(0, 32);
  const IR = I.subarray(32);

  const tweak = bytesToNumberLE(Buffer.from(IL).reverse());
  if (tweak >= secp256k1.CURVE.n || tweak === 0n) {
    // Astronomically unlikely; BIP32 says skip to the next index.
    return deriveChild({ chainCode, publicKey }, index + 1);
  }
  const parent = secp256k1.ProjectivePoint.fromHex(publicKey);
  const child = parent.add(secp256k1.ProjectivePoint.BASE.multiply(tweak));
  child.assertValidity();

  return { chainCode: Buffer.from(IR), publicKey: Buffer.from(child.toRawBytes(true)) };
}

/** Walk a relative path such as "0/5" from a parsed extended key. */
export function derivePath(parsed, path) {
  let node = { chainCode: parsed.chainCode, publicKey: parsed.publicKey };
  for (const part of String(path).split("/").filter((p) => p && p !== "m")) {
    if (/['h]$/.test(part)) throw new Error("Hardened derivation is impossible from a public key");
    node = deriveChild(node, Number(part));
  }
  return node;
}

const hash160 = (b) => Buffer.from(ripemd160(sha256(b)));

/**
 * A Bitcoin receiving address for invoice number `index`.
 *
 * The address flavour follows the extended key that was pasted: a zpub yields
 * native segwit (cheapest to spend), an xpub yields legacy. Guessing wrong
 * would generate addresses the operator's wallet never watches, so the key type
 * decides rather than a config option somebody has to get right.
 */
export function btcAddress(xpub, index, { chain = 0 } = {}) {
  const parsed = parseExtendedPublicKey(xpub);
  const node = derivePath(parsed, `${chain}/${index}`);
  const h160 = hash160(node.publicKey);

  if (parsed.kind === "p2wpkh") {
    return bech32Encode(parsed.network === "mainnet" ? "bc" : "tb", 0, h160);
  }
  if (parsed.kind === "p2sh-p2wpkh") {
    // P2SH-wrapped segwit: the redeem script is OP_0 <20-byte-hash>.
    const redeem = concat(Buffer.from([0x00, 0x14]), h160);
    const prefix = parsed.network === "mainnet" ? 0x05 : 0xc4;
    return base58CheckEncode(concat(Buffer.from([prefix]), hash160(redeem)));
  }
  const prefix = parsed.network === "mainnet" ? 0x00 : 0x6f;
  return base58CheckEncode(concat(Buffer.from([prefix]), h160));
}

/* ==================================================================== ETH == */

/** EIP-55 mixed-case checksum. Wallets reject an all-lowercase address. */
export function toChecksumAddress(hexAddress) {
  const addr = hexAddress.toLowerCase().replace(/^0x/, "");
  const hash = Buffer.from(keccak_256(Buffer.from(addr, "utf8"))).toString("hex");
  let out = "0x";
  for (let i = 0; i < addr.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}

/**
 * secp256k1 public key -> Ethereum address.
 *
 * Split out from `ethAddress` so it can be checked against a known
 * (public key, address) pair directly -- the BIP32 half is already proven by the
 * BIP84 vectors, and this is the only Ethereum-specific step.
 */
export function ethAddressFromPublicKey(publicKey) {
  // Ethereum hashes the *uncompressed* point with its 0x04 prefix removed.
  const uncompressed = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  return toChecksumAddress(Buffer.from(hash).subarray(12).toString("hex"));
}

export function ethAddress(xpub, index, { chain = 0 } = {}) {
  const parsed = parseExtendedPublicKey(xpub);
  return ethAddressFromPublicKey(derivePath(parsed, `${chain}/${index}`).publicKey);
}

/* ==================================================================== XMR == */

// Monero uses its own base58: fixed 8-byte blocks encoding to 11 characters,
// with a shorter final block. Not interchangeable with Bitcoin's.
const XMR_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function xmrBase58EncodeBlock(block) {
  let n = 0n;
  for (const b of block) n = n * 256n + BigInt(b);
  const size = XMR_BLOCK_SIZES[block.length];
  let out = "";
  for (let i = 0; i < size; i++) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

export function xmrBase58Encode(bytes) {
  let out = "";
  let i = 0;
  for (; i + 8 <= bytes.length; i += 8) out += xmrBase58EncodeBlock(bytes.subarray(i, i + 8));
  if (i < bytes.length) out += xmrBase58EncodeBlock(bytes.subarray(i));
  return out;
}

/** Hs(): keccak-256 of the input, reduced into the ed25519 scalar field. */
function hashToScalar(bytes) {
  return bytesToNumberLE(keccak_256(bytes)) % ed25519.CURVE.n;
}

/**
 * Derive subaddress (major, minor) from a view key and public spend key.
 *
 * This is the piece that makes per-invoice Monero addresses possible without a
 * spending key: subaddresses are generated from the *private view* key, and the
 * corresponding funds can be detected with it -- but only the spend key can move
 * them. (major, 0) with major 0 is the primary address, which is why minor
 * starts at 1 for invoices.
 */
export function xmrSubaddress({ privateViewKey, publicSpendKey, publicViewKey, network = "mainnet" }, major, minor) {
  const a = bytesToNumberLE(Buffer.from(privateViewKey, "hex")) % ed25519.CURVE.n;
  const B = ed25519.ExtendedPoint.fromHex(publicSpendKey);

  if (major === 0 && minor === 0) {
    // The primary address is not a subaddress and uses a different tag.
    const tag = network === "mainnet" ? [0x12] : [0x35];
    const data = concat(Buffer.from(tag), B.toRawBytes(), Buffer.from(publicViewKey, "hex"));
    return xmrBase58Encode(concat(data, Buffer.from(keccak_256(data)).subarray(0, 4)));
  }

  // m = Hs("SubAddr\0" || a || major_le32 || minor_le32)
  const prefix = Buffer.concat([Buffer.from("SubAddr", "utf8"), Buffer.from([0])]);
  const idx = Buffer.alloc(8);
  idx.writeUInt32LE(major, 0);
  idx.writeUInt32LE(minor, 4);
  const m = hashToScalar(concat(prefix, numberToBytesLE(a, 32), idx));

  const D = B.add(ed25519.ExtendedPoint.BASE.multiply(m));   // D = B + m*G
  const C = D.multiply(a);                                    // C = a*D

  const tag = network === "mainnet" ? [0x2a] : [0x3f];        // subaddress tag
  const data = concat(Buffer.from(tag), D.toRawBytes(), C.toRawBytes());
  return xmrBase58Encode(concat(data, Buffer.from(keccak_256(data)).subarray(0, 4)));
}

/* ============================================================== dispatch === */

export const ASSETS = {
  BTC: { name: "Bitcoin", decimals: 8, atomic: "satoshi" },
  ETH: { name: "Ethereum", decimals: 18, atomic: "wei" },
  XMR: { name: "Monero", decimals: 12, atomic: "piconero" },
};

/** Next receiving address for an asset. `index` is the invoice counter. */
export function deriveAddress(asset, config, index) {
  switch (asset) {
    case "BTC": return btcAddress(config.xpub, index);
    case "ETH": return ethAddress(config.xpub, index);
    case "XMR": return xmrSubaddress(config, 0, index + 1);   // minor 0 is the primary
    default: throw new Error(`Unsupported asset: ${asset}`);
  }
}

/** Fiat minor units -> atomic units of the asset, at the supplied rate. */
export function toAtomic(asset, priceCents, ratePerUnitCents) {
  const { decimals } = ASSETS[asset];
  if (!ratePerUnitCents || ratePerUnitCents <= 0) throw new Error("A positive exchange rate is required");
  // BigInt throughout: 18-decimal wei does not survive a double, and an invoice
  // that is silently off by a rounding error is a support ticket forever.
  const scale = 10n ** BigInt(decimals);
  const cents = BigInt(Math.round(priceCents));
  const rate = BigInt(Math.round(ratePerUnitCents));
  return ((cents * scale) + rate - 1n) / rate;   // round up, never undercharge
}

export function fromAtomic(asset, atomic) {
  const { decimals } = ASSETS[asset];
  const s = BigInt(atomic).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
