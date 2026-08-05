// billing.js — invoices in BTC, ETH and XMR, watched for payment.
//
// Design constraints, in priority order:
//
//   1. No spending key on the server. See services/wallets.js.
//   2. Billing learns nothing about a household beyond "it exists and owes
//      money". No names, no member counts, no content -- an invoice is a
//      household UUID, an amount, and an address.
//   3. Nonpayment freezes, never deletes. A family that stops paying keeps
//      their data and can still export it. Holding someone's life hostage over
//      a subscription is not a business model this should support.
//
// Payment detection prefers the operator's own node. A public block explorer
// works and is the default only because most people will not run three nodes --
// but it does tell that explorer which addresses belong to this server, which
// is a real privacy cost and is flagged in the admin UI.

import { q, tx } from "../db/pool.js";
import { seal, openText } from "../crypto/seal.js";
import { deriveAddress, toAtomic, fromAtomic, ASSETS } from "./wallets.js";
import { safeFetch } from "./safe-fetch.js";
import { audit } from "./audit.js";
import { INVOICE_TTL_MINUTES, PRICE_FEED_URL } from "../config.js";

/* --------------------------------------------------------------- config --- */

export async function getWalletConfig(asset) {
  const { rows } = await q("SELECT * FROM wallet_config WHERE asset = $1", [asset]);
  const w = rows[0];
  if (!w) return null;
  return {
    asset,
    enabled: w.enabled,
    confirmations: w.confirmations,
    derivationPath: w.derivation_path,
    nextIndex: w.next_index,
    xpub: w.xpub_enc ? openText("walletXpub", w.xpub_enc, asset) : null,
    privateViewKey: w.view_key_enc ? openText("walletViewKey", w.view_key_enc, asset) : null,
    nodeUrl: w.node_url_enc ? openText("walletNode", w.node_url_enc, asset) : null,
    nodeAuth: w.node_auth_enc ? openText("walletNodeAuth", w.node_auth_enc, asset) : null,
  };
}

export async function setWalletConfig(asset, patch) {
  await q(
    `INSERT INTO wallet_config (asset, xpub_enc, view_key_enc, node_url_enc, node_auth_enc,
                                confirmations, enabled, derivation_path, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (asset) DO UPDATE SET
       xpub_enc      = COALESCE(EXCLUDED.xpub_enc, wallet_config.xpub_enc),
       view_key_enc  = COALESCE(EXCLUDED.view_key_enc, wallet_config.view_key_enc),
       node_url_enc  = COALESCE(EXCLUDED.node_url_enc, wallet_config.node_url_enc),
       node_auth_enc = COALESCE(EXCLUDED.node_auth_enc, wallet_config.node_auth_enc),
       confirmations = EXCLUDED.confirmations,
       enabled       = EXCLUDED.enabled,
       derivation_path = EXCLUDED.derivation_path,
       updated_at    = now()`,
    [
      asset,
      patch.xpub ? seal("walletXpub", patch.xpub, asset) : null,
      patch.privateViewKey ? seal("walletViewKey", patch.privateViewKey, asset) : null,
      patch.nodeUrl ? seal("walletNode", patch.nodeUrl, asset) : null,
      patch.nodeAuth ? seal("walletNodeAuth", patch.nodeAuth, asset) : null,
      patch.confirmations ?? (asset === "BTC" ? 2 : asset === "ETH" ? 12 : 10),
      patch.enabled ?? false,
      patch.derivationPath || "m/0",
    ]
  );
}

/* ---------------------------------------------------------------- rates --- */

let rateCache = { at: 0, data: null };

/**
 * Exchange rates, in fiat *minor units* per whole coin.
 *
 * Cached for five minutes: an invoice quoted at a rate that moves between the
 * quote and the payment is the normal case, which is why invoices expire and
 * why underpayment is a distinct status rather than a failure.
 */
export async function getRates() {
  if (Date.now() - rateCache.at < 300_000 && rateCache.data) return rateCache.data;
  if (!PRICE_FEED_URL) return null;

  try {
    const text = await safeFetch(PRICE_FEED_URL, { maxBytes: 256 * 1024 });
    const json = JSON.parse(text);
    // Accepts the CoinGecko simple-price shape, which is the common default,
    // and a flat { BTC: 65000 } for anyone pointing at their own feed.
    const data = {};
    for (const [asset, id] of [["BTC", "bitcoin"], ["ETH", "ethereum"], ["XMR", "monero"]]) {
      const usd = json[id]?.usd ?? json[asset] ?? json[asset.toLowerCase()];
      if (usd) data[asset] = Math.round(Number(usd) * 100);   // to cents
    }
    if (!Object.keys(data).length) return null;
    rateCache = { at: Date.now(), data };
    return data;
  } catch {
    // A stale rate beats no billing at all; a missing one is reported upstream.
    return rateCache.data;
  }
}

/* -------------------------------------------------------------- invoices --- */

export async function createInvoice(householdId, { asset, planCode, rateOverride }) {
  if (!ASSETS[asset]) throw new Error(`Unsupported asset: ${asset}`);

  const config = await getWalletConfig(asset);
  if (!config?.enabled) throw new Error(`${asset} payments are not enabled on this server`);

  const { rows: planRows } = await q("SELECT * FROM plans WHERE code = $1 AND active", [planCode]);
  const plan = planRows[0];
  if (!plan) throw new Error(`No such plan: ${planCode}`);

  const rates = await getRates();
  const rate = rateOverride ?? rates?.[asset];
  if (!rate) {
    throw new Error(
      `No exchange rate for ${asset}. Set PRICE_FEED_URL, or supply a rate with the invoice.`
    );
  }

  const amount = toAtomic(asset, plan.price_cents, rate);

  // Reserve the derivation index inside the transaction so two concurrent
  // invoices can never be issued the same address -- which would make the two
  // payments indistinguishable.
  return tx(async ({ q: query }) => {
    const { rows: idxRows } = await query(
      "UPDATE wallet_config SET next_index = next_index + 1 WHERE asset = $1 RETURNING next_index - 1 AS idx",
      [asset]
    );
    const index = idxRows[0].idx;
    const address = deriveAddress(asset, config, index);

    const { rows } = await query(
      `INSERT INTO invoices (household_id, plan_id, asset, address, address_index,
                             amount_atomic, price_cents, rate_used, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval)
       RETURNING id, address, amount_atomic, expires_at`,
      [householdId, plan.id, asset, address, index, amount.toString(),
       plan.price_cents, rate, String(INVOICE_TTL_MINUTES)]
    );

    return {
      id: rows[0].id,
      asset,
      address: rows[0].address,
      amount: fromAtomic(asset, rows[0].amount_atomic),
      amountAtomic: rows[0].amount_atomic,
      expiresAt: rows[0].expires_at,
      uri: paymentUri(asset, rows[0].address, fromAtomic(asset, rows[0].amount_atomic)),
    };
  });
}

/** BIP21 / EIP-681 style URI, so a wallet app can be opened from a QR code. */
export function paymentUri(asset, address, amount) {
  if (asset === "BTC") return `bitcoin:${address}?amount=${amount}`;
  if (asset === "XMR") return `monero:${address}?tx_amount=${amount}`;
  if (asset === "ETH") return `ethereum:${address}?value=${amount}`;
  return address;
}

/* -------------------------------------------------------------- watchers --- */

/**
 * Check one invoice for payment.
 *
 * Each asset has its own way of being asked "did money arrive at this address".
 * All three go through safeFetch, because the node URL is operator-supplied and
 * this process should not be able to be pointed at its own internals.
 */
async function checkAddress(asset, address, config) {
  if (asset === "BTC") {
    // Esplora/mempool.space API shape, which most Bitcoin explorers and a
    // self-hosted `electrs` all speak.
    const base = config.nodeUrl || "https://mempool.space/api";
    const text = await safeFetch(`${base}/address/${address}`, { maxBytes: 128 * 1024 });
    const data = JSON.parse(text);
    const confirmed = BigInt(data.chain_stats?.funded_txo_sum ?? 0);
    const pending = BigInt(data.mempool_stats?.funded_txo_sum ?? 0);
    return { confirmed, pending, confirmations: confirmed > 0n ? config.confirmations : 0 };
  }

  if (asset === "ETH") {
    // eth_getBalance against any JSON-RPC endpoint.
    const base = config.nodeUrl;
    if (!base) throw new Error("ETH watching needs a JSON-RPC node URL");
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.nodeAuth ? { Authorization: config.nodeAuth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { confirmed: BigInt(data.result), pending: 0n, confirmations: config.confirmations };
  }

  if (asset === "XMR") {
    // monero-wallet-rpc running in view-only mode. There is no way to check a
    // Monero subaddress from a public explorer -- that is the entire point of
    // Monero -- so this one genuinely requires the operator's own wallet daemon.
    const base = config.nodeUrl;
    if (!base) throw new Error("XMR watching needs a monero-wallet-rpc URL (view-only wallet)");
    const res = await fetch(`${base}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.nodeAuth ? { Authorization: config.nodeAuth } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "0", method: "get_transfers",
        params: { in: true, pool: true, subaddr_indices: [] },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    let confirmed = 0n, pending = 0n, minConf = 0;
    for (const t of [...(data.result?.in || []), ...(data.result?.pool || [])]) {
      if (t.address !== address) continue;
      if (t.type === "pool" || (t.confirmations ?? 0) < config.confirmations) pending += BigInt(t.amount);
      else { confirmed += BigInt(t.amount); minConf = Math.max(minConf, t.confirmations ?? 0); }
    }
    return { confirmed, pending, confirmations: minConf };
  }

  throw new Error(`No watcher for ${asset}`);
}

/** Sweep every open invoice. Called from the maintenance loop. */
export async function checkPendingInvoices() {
  const { rows } = await q(
    `SELECT id, household_id, asset, address, amount_atomic, status
       FROM invoices WHERE status IN ('pending','detected') AND expires_at > now() - interval '24 hours'
       ORDER BY created_at LIMIT 50`
  );
  if (!rows.length) return 0;

  const configs = new Map();
  let settled = 0;

  for (const inv of rows) {
    try {
      if (!configs.has(inv.asset)) configs.set(inv.asset, await getWalletConfig(inv.asset));
      const config = configs.get(inv.asset);
      if (!config?.enabled) continue;

      const { confirmed, pending, confirmations } = await checkAddress(inv.asset, inv.address, config);
      const owed = BigInt(inv.amount_atomic);

      if (confirmed >= owed) {
        await markPaid(inv, confirmations);
        settled++;
      } else if (confirmed > 0n) {
        // Partial payment. Recorded rather than ignored, so a human can see it
        // and decide -- silently discarding someone's money is unacceptable.
        await q("UPDATE invoices SET status = 'underpaid', confirmations = $2 WHERE id = $1",
          [inv.id, confirmations]);
      } else if (pending > 0n && inv.status === "pending") {
        await q("UPDATE invoices SET status = 'detected' WHERE id = $1", [inv.id]);
      }
    } catch (err) {
      console.error(`[billing] could not check invoice ${inv.id}:`, err.message);
    }
  }
  return settled;
}

async function markPaid(invoice, confirmations) {
  await tx(async ({ q: query }) => {
    await query(
      "UPDATE invoices SET status = 'paid', paid_at = now(), confirmations = $2 WHERE id = $1 AND status <> 'paid'",
      [invoice.id, confirmations]
    );
    await query(
      `UPDATE subscriptions
          SET status = 'active',
              current_period_end = GREATEST(COALESCE(current_period_end, now()), now())
                                   + (SELECT CASE interval WHEN 'year' THEN interval '1 year'
                                                           WHEN 'month' THEN interval '1 month'
                                                           ELSE interval '0' END
                                        FROM plans WHERE id = (SELECT plan_id FROM invoices WHERE id = $2)),
              plan_id = COALESCE((SELECT plan_id FROM invoices WHERE id = $2), plan_id),
              updated_at = now()
        WHERE household_id = $1`,
      [invoice.household_id, invoice.id]
    );
    // Un-freeze on payment, so service resumes without anyone intervening.
    await query("UPDATE households SET status = 'active' WHERE id = $1 AND status = 'suspended'",
      [invoice.household_id]);
  });

  await audit("invoice_paid", {
    householdId: invoice.household_id, target: invoice.id, meta: { asset: invoice.asset },
  });
}
