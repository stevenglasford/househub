// wallets.test.js — address derivation, checked against published test vectors.
//
// A derivation bug here does not throw. It silently generates a valid-looking
// address that belongs to nobody, and the money sent to it is gone. So the
// vectors are the real specification, not the code.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  btcAddress, ethAddress, ethAddressFromPublicKey, toChecksumAddress, xmrSubaddress,
  parseExtendedPublicKey, toAtomic, fromAtomic,
} from "../src/services/wallets.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";

// BIP84 test vector: mnemonic "abandon abandon ... about", account 0 zpub.
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

test("BIP84: native segwit receiving addresses match the spec", () => {
  assert.equal(btcAddress(ZPUB, 0), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  assert.equal(btcAddress(ZPUB, 1), "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
});

test("BIP84: the change chain matches the spec", () => {
  assert.equal(btcAddress(ZPUB, 0, { chain: 1 }), "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
});

test("secp256k1 public key -> Ethereum address matches the canonical vector", () => {
  // Private key 1, whose public key is the generator point G. Its address is
  // one of the most widely published values in Ethereum.
  //
  // Checking the key->address step directly rather than through an account
  // xpub: the BIP32 half is already proven by the BIP84 vectors above, and this
  // isolates the Ethereum-specific part (keccak-256, low 20 bytes, EIP-55).
  const G = secp256k1.ProjectivePoint.BASE.toRawBytes(true);
  assert.equal(ethAddressFromPublicKey(G), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
});

test("Ethereum addresses derive distinctly per invoice index", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(ethAddress(ZPUB, i));
  assert.equal(seen.size, 20);
});

test("EIP-55 checksum casing matches the spec vectors", () => {
  for (const addr of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(toChecksumAddress(addr.toLowerCase()), addr);
  }
});

test("each invoice index yields a distinct address", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(btcAddress(ZPUB, i));
  assert.equal(seen.size, 50, "address reuse would publish a ledger of who paid what");
});

test("derivation is deterministic across calls", () => {
  // The address must be reproducible from the invoice row alone -- a restart
  // that changed derivation would orphan every outstanding invoice.
  assert.equal(btcAddress(ZPUB, 7), btcAddress(ZPUB, 7));
});

test("a private extended key is refused, not stored", () => {
  const ZPRV = "zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5";
  assert.throws(() => parseExtendedPublicKey(ZPRV), /PRIVATE|private/);
});

test("a corrupted key is caught by its checksum", () => {
  const broken = ZPUB.slice(0, -1) + (ZPUB.endsWith("s") ? "t" : "s");
  assert.throws(() => parseExtendedPublicKey(broken), /checksum|base58/i);
});

test("hardened derivation from a public key is refused", () => {
  const parsed = parseExtendedPublicKey(ZPUB);
  assert.throws(() => btcAddress(ZPUB, 0x80000000), /hardened|Hardened/);
  assert.ok(parsed.kind === "p2wpkh");
});

test("Monero subaddresses have the right tag and shape", () => {
  // Structural, not a vector: mainnet subaddresses begin with 8 and are 95
  // characters, primary addresses begin with 4.
  // Real curve points, so the encoding is exercised rather than the error path.
  const spend = ed25519.getPublicKey(new Uint8Array(32).fill(7));
  const view = ed25519.getPublicKey(new Uint8Array(32).fill(9));
  const cfg = {
    privateViewKey: "8aa2ecfa1a2a5f0e0f0b0a0908070605040302010f0e0d0c0b0a090807060504",
    publicSpendKey: Buffer.from(spend).toString("hex"),
    publicViewKey: Buffer.from(view).toString("hex"),
  };
  const sub = xmrSubaddress(cfg, 0, 1);
  assert.match(sub, /^8/, "mainnet subaddresses start with 8");
  assert.equal(sub.length, 95);

  const primary = xmrSubaddress(cfg, 0, 0);
  assert.match(primary, /^4/, "mainnet primary addresses start with 4");
  assert.equal(primary.length, 95);

  assert.notEqual(xmrSubaddress(cfg, 0, 1), xmrSubaddress(cfg, 0, 2));
});

test("atomic conversion rounds up and never undercharges", () => {
  // $10.00 at $50,000/BTC = 0.0002 BTC = 20000 sat
  assert.equal(toAtomic("BTC", 1000, 5_000_000).toString(), "20000");
  // 18 decimals must survive exactly; a float would lose the tail.
  assert.equal(toAtomic("ETH", 1000, 300_000).toString(), "3333333333333334");
  // Rounding is always up, so the operator is never short by a satoshi.
  assert.equal(toAtomic("BTC", 1, 3).toString(), "33333334");
});

test("atomic formatting round-trips for display", () => {
  assert.equal(fromAtomic("BTC", "20000"), "0.0002");
  assert.equal(fromAtomic("XMR", "1000000000000"), "1");
  assert.equal(fromAtomic("ETH", "1500000000000000000"), "1.5");
});

test("a zero or negative exchange rate is refused", () => {
  // Otherwise an invoice for 0 atomic units marks itself paid on arrival of
  // nothing at all.
  assert.throws(() => toAtomic("BTC", 1000, 0), /positive/);
  assert.throws(() => toAtomic("BTC", 1000, -5), /positive/);
});
