// admin.js — the super-admin surface: operating the server, charging for it,
// and upgrading it.
//
// WHAT A SUPER-ADMIN CANNOT DO, which is the more important list: read any
// household's content, add themselves to a household, approve a display,
// recover a forgotten password, or hand a family's data to anyone who asks for
// it. None of those are missing features. They are absent because the operator
// holds no household key, so there is no code that could implement them.
//
// What they can do is run the machine: see how much space is used, suspend an
// abusive account, configure receiving wallets, and queue an upgrade.

import express from "express";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { q } from "../db/pool.js";
import { wrap, badRequest, notFound, conflict, ApiError } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireSuperAdmin } from "../middleware/auth.js";
import { audit, verifyChain } from "../services/audit.js";
import { getWalletConfig, setWalletConfig, getRates, createInvoice, checkPendingInvoices } from "../services/billing.js";
import { parseExtendedPublicKey, deriveAddress } from "../services/wallets.js";
import { runUpgradeJob, publishUpgrade, bundleHash } from "../services/upgrades.js";
import { isAvailable, listModels } from "../services/ollama.js";
import {
  UPGRADES_ENABLED, UPGRADE_WORK_DIR, UPGRADE_MAX_ZIP_MB, UPGRADE_REPO_URL,
  UPGRADE_DIRECT_PUSH, GITHUB_TOKEN, BILLING_ENABLED,
} from "../config.js";

export const router = express.Router();
router.use(requireSuperAdmin);

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first.message, { field: first.path.join(".") });
  }
  return r.data;
};

/* ------------------------------------------------------------ overview ----- */

router.get("/overview", wrap(async (req, res) => {
  const [users, households, displays, vault, subs] = await Promise.all([
    q("SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'active')::int AS active FROM users"),
    q("SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'suspended')::int AS suspended FROM households"),
    q("SELECT count(*)::int AS n FROM displays WHERE status = 'active'"),
    q("SELECT COALESCE(sum(octet_length(ciphertext)), 0)::bigint AS bytes FROM vault_documents"),
    q("SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status"),
  ]);

  res.json({
    users: { total: users.rows[0].n, active: users.rows[0].active },
    households: { total: households.rows[0].n, suspended: households.rows[0].suspended },
    displays: { active: displays.rows[0].n },
    // Ciphertext bytes. The operator can see how much space a household uses
    // and nothing whatsoever about what is in it.
    storageBytes: Number(vault.rows[0].bytes),
    subscriptions: Object.fromEntries(subs.rows.map((r) => [r.status, r.n])),
    ai: { available: await isAvailable(), models: (await listModels()).map((m) => m.name) },
    billingEnabled: BILLING_ENABLED,
    upgradesEnabled: UPGRADES_ENABLED,
  });
}));

/**
 * Households, as the operator sees them: an id, a size, a bill, and nothing else.
 * There is deliberately no endpoint that returns a household name or a member's
 * address -- those are sealed, and an operator with a legitimate need has to ask
 * the family, the same as anyone else.
 */
router.get("/households", wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT h.id, h.status, h.key_epoch, h.created_at,
            (SELECT count(*)::int FROM household_members m
              WHERE m.household_id = h.id AND m.status = 'active') AS members,
            (SELECT count(*)::int FROM displays d
              WHERE d.household_id = h.id AND d.status = 'active') AS displays,
            COALESCE(octet_length(v.ciphertext), 0) AS vault_bytes,
            s.status AS subscription, s.current_period_end, p.code AS plan
       FROM households h
       LEFT JOIN vault_documents v ON v.household_id = h.id
       LEFT JOIN subscriptions s ON s.household_id = h.id
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY h.created_at DESC LIMIT 500`
  );
  res.json(rows);
}));

router.post("/households/:id/status", wrap(async (req, res) => {
  const { status, reason } = parse(z.object({
    status: z.enum(["active", "suspended"]),
    reason: z.string().max(500).optional(),
  }), req.body);

  const { rowCount } = await q(
    "UPDATE households SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'closed'",
    [req.params.id, status]
  );
  if (!rowCount) throw notFound();

  await audit("household_status_changed", {
    householdId: req.params.id, actorUserId: req.user.id, meta: { status, reason },
  });
  // Suspension is read-only, never destructive. Stated in the response so an
  // operator cannot mistake it for a delete.
  res.json({ ok: true, effect: status === "suspended"
    ? "Read-only. Members can still read and export everything."
    : "Full access restored." });
}));

/* --------------------------------------------------------------- audit ----- */

router.get("/audit/verify", wrap(async (req, res) => {
  res.json(await verifyChain({ limit: Number(req.query.limit) || 100000 }));
}));

router.get("/audit", wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, household_id, actor_user_id, action, target, meta, created_at
       FROM audit_log ORDER BY id DESC LIMIT $1`,
    [Math.min(1000, Number(req.query.limit) || 200)]
  );
  res.json(rows);
}));

/* -------------------------------------------------------------- wallets ---- */

const ASSET = z.enum(["BTC", "ETH", "XMR"]);

router.get("/wallets", wrap(async (req, res) => {
  const out = [];
  for (const asset of ["BTC", "ETH", "XMR"]) {
    const c = await getWalletConfig(asset);
    out.push({
      asset,
      configured: Boolean(c?.xpub || c?.privateViewKey),
      enabled: Boolean(c?.enabled),
      confirmations: c?.confirmations ?? null,
      nextIndex: c?.nextIndex ?? 0,
      hasNode: Boolean(c?.nodeUrl),
      // Never returns the xpub or view key. Once set, they are write-only from
      // the API's point of view; there is no reason to read one back out and
      // every reason not to.
    });
  }
  res.json({ wallets: out, rates: await getRates() });
}));

router.put("/wallets/:asset", wrap(async (req, res) => {
  const asset = ASSET.parse(req.params.asset.toUpperCase());
  const body = parse(z.object({
    xpub: z.string().trim().max(200).optional(),
    privateViewKey: z.string().trim().regex(/^[0-9a-f]{64}$/i, "A Monero view key is 64 hex characters").optional(),
    publicSpendKey: z.string().trim().regex(/^[0-9a-f]{64}$/i).optional(),
    publicViewKey: z.string().trim().regex(/^[0-9a-f]{64}$/i).optional(),
    nodeUrl: z.string().url().max(500).optional(),
    nodeAuth: z.string().max(500).optional(),
    confirmations: z.number().int().min(0).max(100).optional(),
    enabled: z.boolean().optional(),
  }), req.body);

  // Validate before storing: a typo'd xpub silently generates addresses the
  // operator's wallet is not watching, and the money lands nowhere recoverable.
  if (body.xpub) {
    try {
      const parsed = parseExtendedPublicKey(body.xpub);
      if (parsed.kind.endsWith("-priv")) throw new Error("That is a private key");
    } catch (err) {
      throw badRequest(`That extended key was rejected: ${err.message}`);
    }
  }
  if (asset === "XMR" && body.privateViewKey && !body.publicSpendKey) {
    throw badRequest("Monero also needs the public spend key to derive subaddresses");
  }

  await setWalletConfig(asset, body);

  // Prove it works by deriving the next address and handing it back, so the
  // operator can check it against their own wallet before enabling anything.
  let sample = null;
  try {
    const c = await getWalletConfig(asset);
    sample = deriveAddress(asset, { ...c, publicSpendKey: body.publicSpendKey, publicViewKey: body.publicViewKey }, c.nextIndex);
  } catch (err) {
    throw badRequest(`Saved, but no address could be derived: ${err.message}`);
  }

  await audit("wallet_configured", { actorUserId: req.user.id, meta: { asset, enabled: body.enabled } });
  res.json({
    ok: true,
    sampleAddress: sample,
    note: "Check this address appears in your own wallet before enabling payments.",
  });
}));

router.post("/billing/check-now", limit("billing-check", { capacity: 10, perSecond: 0.05, by: "user" }),
  wrap(async (req, res) => {
    res.json({ settled: await checkPendingInvoices() });
  })
);

/* ---------------------------------------------------------------- plans ---- */

router.get("/plans", wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM plans ORDER BY price_cents");
  res.json(rows);
}));

router.post("/plans", wrap(async (req, res) => {
  const body = parse(z.object({
    code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
    name: z.string().trim().min(1).max(80),
    priceCents: z.number().int().min(0).max(10_000_000),
    interval: z.enum(["month", "year", "once"]),
    maxMembers: z.number().int().min(1).max(200).default(8),
    maxDisplays: z.number().int().min(0).max(100).default(3),
    maxVaultMb: z.number().int().min(1).max(10_000).default(50),
  }), req.body);

  const { rows } = await q(
    `INSERT INTO plans (code, name, price_cents, interval, max_members, max_displays, max_vault_mb)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [body.code, body.name, body.priceCents, body.interval, body.maxMembers, body.maxDisplays, body.maxVaultMb]
  );
  await audit("plan_created", { actorUserId: req.user.id, target: rows[0].id, meta: { code: body.code } });
  res.status(201).json({ id: rows[0].id });
}));

router.post("/households/:id/invoice", wrap(async (req, res) => {
  const body = parse(z.object({
    asset: ASSET,
    planCode: z.string().max(40),
    rateOverride: z.number().positive().optional(),
  }), req.body);

  try {
    res.status(201).json(await createInvoice(req.params.id, body));
  } catch (err) {
    throw badRequest(err.message);
  }
}));

/* ------------------------------------------------------------- upgrades ---- */

router.get("/upgrades", wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, title, status, phase_detail, branch_name, pr_url, diff_stat, guard_report,
            test_report, bundle_sha256, bundle_bytes, created_by, created_at, updated_at
       FROM upgrade_jobs ORDER BY created_at DESC LIMIT 100`
  );
  res.json({
    enabled: UPGRADES_ENABLED,
    repo: UPGRADE_REPO_URL,
    canPush: Boolean(GITHUB_TOKEN),
    directPush: UPGRADE_DIRECT_PUSH,
    jobs: rows,
  });
}));

router.get("/upgrades/:id", wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM upgrade_jobs WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw notFound();
  const { bundle_path, ...safe } = rows[0];   // path is a server detail
  res.json(safe);
}));

/**
 * Queue an upgrade.
 *
 * The zip arrives base64-encoded in a JSON body rather than as multipart. It is
 * a less elegant wire format and it avoids adding a file-upload dependency to
 * the one endpoint whose contents get handed to an agent with commit access --
 * a trade worth making for the smaller attack surface.
 */
router.post("/upgrades",
  limit("upgrade-create", { capacity: 5, perSecond: 0.01, by: "user" }),
  wrap(async (req, res) => {
    if (!UPGRADES_ENABLED) {
      throw new ApiError(503, "upgrades_disabled",
        "The upgrade pipeline is off. Set UPGRADES_ENABLED=1 and make sure the `claude` CLI is installed.");
    }

    const body = parse(z.object({
      title: z.string().trim().min(3).max(120),
      instructions: z.string().max(20000).optional(),
      bundleBase64: z.string().max(Math.ceil(UPGRADE_MAX_ZIP_MB * 1024 * 1024 * 1.4)),
    }), req.body);

    const buffer = Buffer.from(body.bundleBase64, "base64");
    if (!buffer.length) throw badRequest("The uploaded file was empty");
    if (buffer.length > UPGRADE_MAX_ZIP_MB * 1024 * 1024) {
      throw badRequest(`The archive is larger than the ${UPGRADE_MAX_ZIP_MB} MB limit`);
    }
    // "PK\x03\x04". Checked here so an obviously wrong file fails immediately
    // rather than three minutes into a clone.
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw badRequest("That is not a zip file");

    const sha = bundleHash(buffer);
    const { rows } = await q(
      `INSERT INTO upgrade_jobs (created_by, title, instructions, bundle_sha256, bundle_bytes, status)
       VALUES ($1,$2,$3,$4,$5,'queued') RETURNING id`,
      [req.user.id, body.title, body.instructions || null, sha, buffer.length]
    );
    const jobId = rows[0].id;

    const dir = join(UPGRADE_WORK_DIR, jobId);
    await mkdir(dir, { recursive: true });
    const bundlePath = join(dir, "bundle.zip");
    await writeFile(bundlePath, buffer, { mode: 0o600 });
    await q("UPDATE upgrade_jobs SET bundle_path = $2 WHERE id = $1", [jobId, bundlePath]);

    await audit("upgrade_queued", { actorUserId: req.user.id, target: jobId, meta: { sha256: sha } });

    // Detached: this takes minutes. The client polls the job row.
    runUpgradeJob(jobId).catch((err) => console.error(`[upgrade ${jobId}]`, err.message));

    res.status(202).json({ id: jobId, status: "queued", sha256: sha });
  })
);

/** The diff, for the human review step. */
router.get("/upgrades/:id/diff", wrap(async (req, res) => {
  const { rows } = await q("SELECT status, base_commit, head_commit FROM upgrade_jobs WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw notFound();

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const repoDir = join(UPGRADE_WORK_DIR, req.params.id, "repo");

  try {
    const { stdout } = await exec("git", ["diff", "--stat", "-p", "HEAD~1..HEAD"], {
      cwd: repoDir, maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
    });
    res.type("text/plain").send(stdout.slice(0, 4 * 1024 * 1024));
  } catch (err) {
    throw notFound("No diff is available for this job yet");
  }
}));

router.post("/upgrades/:id/approve", wrap(async (req, res) => {
  const { rows } = await q("SELECT status FROM upgrade_jobs WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw notFound();
  if (rows[0].status !== "awaiting_review") {
    throw conflict(`This job is ${rows[0].status}, so it cannot be approved`);
  }

  await q(
    "UPDATE upgrade_jobs SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1",
    [req.params.id, req.user.id]
  );
  await audit("upgrade_approved", { actorUserId: req.user.id, target: req.params.id });

  try {
    res.json(await publishUpgrade(req.params.id, req.user.id));
  } catch (err) {
    await q("UPDATE upgrade_jobs SET status = 'failed', phase_detail = $2 WHERE id = $1",
      [req.params.id, err.message.slice(0, 400)]);
    throw badRequest(err.message);
  }
}));

router.post("/upgrades/:id/reject", wrap(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body);
  const { rowCount } = await q(
    `UPDATE upgrade_jobs SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
            phase_detail = $3 WHERE id = $1 AND status IN ('awaiting_review','failed')`,
    [req.params.id, req.user.id, reason || "Rejected by a super-admin"]
  );
  if (!rowCount) throw notFound();
  await audit("upgrade_rejected", { actorUserId: req.user.id, target: req.params.id });
  res.json({ ok: true });
}));

export default router;
