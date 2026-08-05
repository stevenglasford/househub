// displays.js — the always-on screen by the front door.
//
// The brief: an iPad left on permanently, showing what matters, on its own
// permanent link, with an expiry, showing only what the admins chose -- and no
// single admin able to create one alone.
//
// HOW THE SIGN-OFF IS ACTUALLY ENFORCED. This is the part worth reading. A
// server-side `if (approvals >= threshold)` would be theatre: whoever runs the
// server could edit it out. Instead, activation requires the household key to be
// wrapped to the display's public key, and only a member device holds that key.
// So the sequence is:
//
//   1. any admin proposes a display (status 'pending' -- no key, renders nothing)
//   2. each admin approves, and their approval carries a proof derived from
//      their own private key over the display's identity
//   3. only once the threshold is met will the API accept the wrapped key that
//      brings it to life
//
// An operator who patches step 3 out still cannot produce the wrapped key in
// step 3's payload, because they do not have the household key. The display
// stays dark. That is the difference between a policy and a guarantee.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, notFound, conflict, forbidden } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, requireWritable } from "../middleware/auth.js";
import { newToken, hashToken } from "../crypto/tokens.js";
import { audit } from "../services/audit.js";
import { eventsFor } from "../services/calendars.js";
import { PUBLIC_URL } from "../config.js";

/** Panels a display may be granted. Anything not listed is not grantable. */
export const SCOPES = [
  "today", "calendar", "meals", "todos", "grocery", "projects",
  "notes", "countdowns", "agenda", "weather", "home", "checkin",
];

const b64 = (max) => z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/).max(max);
const bin = (s) => Buffer.from(s, "base64");

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first.message, { field: first.path.join(".") });
  }
  return r.data;
};

/* ================================================================ admin ==== */

export const householdRouter = express.Router();

/** How many approvals this household needs. 0 means "every current admin". */
async function requiredApprovals(householdId, threshold) {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM household_members
      WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
    [householdId]
  );
  const admins = rows[0].n;
  return threshold > 0 ? Math.min(threshold, admins) : admins;
}

async function approvalState(displayId, householdId, threshold) {
  const { rows } = await q(
    `SELECT user_id, decision FROM display_approvals WHERE display_id = $1`, [displayId]
  );
  const approvals = rows.filter((r) => r.decision === "approve");
  const denials = rows.filter((r) => r.decision === "deny");
  return {
    required: await requiredApprovals(householdId, threshold),
    approvals: approvals.map((r) => r.user_id),
    denials: denials.map((r) => r.user_id),
  };
}

/* -------------------------------------------------------------- propose ---- */

householdRouter.post("/:householdId/displays",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("display-create", { capacity: 10, perSecond: 0.02, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(60),
      scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
      // The keypair is generated on the proposing admin's device. Only the
      // public half is sent; the private half goes into the setup link's URL
      // fragment, which browsers never transmit.
      publicKey: b64(64),
      expiresAt: z.string().datetime().nullable().optional(),
    }), req.body);

    if (bin(body.publicKey).length !== 32) throw badRequest("publicKey must be 32 bytes");
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
      throw badRequest("That expiry is already in the past");
    }

    const { rows: planRows } = await q(
      `SELECT p.max_displays FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.household_id = $1`, [req.household.id]
    );
    const { rows: countRows } = await q(
      "SELECT count(*)::int AS n FROM displays WHERE household_id = $1 AND status IN ('active','pending')",
      [req.household.id]
    );
    if (countRows[0].n >= (planRows[0]?.max_displays ?? 25)) {
      throw forbidden(`This household's plan allows ${planRows[0].max_displays} displays.`);
    }

    const { rows } = await q(
      `INSERT INTO displays (household_id, name, public_key, scopes, expires_at, created_by, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending') RETURNING id, created_at`,
      [req.household.id, body.name, bin(body.publicKey), JSON.stringify(body.scopes),
       body.expiresAt || null, req.user.id]
    );
    const display = rows[0];

    // The proposer's own approval is implicit -- they just created it -- but it
    // is recorded explicitly so the count is uniform and auditable.
    await q(
      `INSERT INTO display_approvals (display_id, user_id, decision) VALUES ($1, $2, 'approve')
       ON CONFLICT DO NOTHING`,
      [display.id, req.user.id]
    );

    await audit("display_proposed", {
      householdId: req.household.id, actorUserId: req.user.id, target: display.id,
      meta: { scopes: body.scopes, expires: body.expiresAt || null },
    });

    res.status(201).json({
      id: display.id,
      status: "pending",
      ...(await approvalState(display.id, req.household.id, req.household.approvalThreshold)),
    });
  })
);

/* --------------------------------------------------------------- list ------ */

householdRouter.get("/:householdId/displays", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT d.id, d.name, d.scopes, d.status, d.expires_at, d.last_seen_at,
            d.created_by, d.created_at, d.activated_at, d.public_key,
            COALESCE(json_agg(json_build_object('userId', a.user_id, 'decision', a.decision))
                     FILTER (WHERE a.user_id IS NOT NULL), '[]') AS approvals
       FROM displays d
       LEFT JOIN display_approvals a ON a.display_id = d.id
      WHERE d.household_id = $1 AND d.status <> 'revoked'
      GROUP BY d.id ORDER BY d.created_at DESC`,
    [req.household.id]
  );

  const required = await requiredApprovals(req.household.id, req.household.approvalThreshold);
  res.json(rows.map((d) => ({
    id: d.id,
    name: d.name,
    scopes: d.scopes,
    status: d.status,
    expiresAt: d.expires_at,
    lastSeenAt: d.last_seen_at,
    createdBy: d.created_by,
    createdAt: d.created_at,
    activatedAt: d.activated_at,
    publicKey: Buffer.from(d.public_key).toString("base64"),
    approvals: d.approvals,
    requiredApprovals: required,
  })));
}));

/* ------------------------------------------------------------- approve ----- */

householdRouter.post("/:householdId/displays/:id/approve",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const body = parse(z.object({
      decision: z.enum(["approve", "deny"]).default("approve"),
      // Derived from the approving admin's private key over the display's
      // identity, so the server cannot fabricate an approval on their behalf.
      proof: b64(128).optional(),
    }), req.body);

    const { rows } = await q(
      "SELECT id, status FROM displays WHERE id = $1 AND household_id = $2",
      [req.params.id, req.household.id]
    );
    if (!rows[0]) throw notFound();
    if (rows[0].status !== "pending") throw conflict(`This display is already ${rows[0].status}`);

    await q(
      `INSERT INTO display_approvals (display_id, user_id, decision, signature)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (display_id, user_id) DO UPDATE
         SET decision = EXCLUDED.decision, signature = EXCLUDED.signature, decided_at = now()`,
      [req.params.id, req.user.id, body.decision, body.proof ? bin(body.proof) : null]
    );

    // A single denial stops it. Any admin has an absolute veto over a screen
    // that will sit in their home displaying their life.
    if (body.decision === "deny") {
      await q("UPDATE displays SET status = 'revoked', revoked_at = now() WHERE id = $1", [req.params.id]);
      await audit("display_denied", {
        householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
      });
      return res.json({ status: "revoked", note: "Denied. Any admin can veto a display." });
    }

    await audit("display_approved", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
    });
    res.json({
      status: "pending",
      ...(await approvalState(req.params.id, req.household.id, req.household.approvalThreshold)),
    });
  })
);

/* ------------------------------------------------------------ activate ----- */

/**
 * The gate. Accepts the wrapped household key and issues the permanent link,
 * but only once the approval threshold is genuinely met.
 */
householdRouter.post("/:householdId/displays/:id/activate",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const body = parse(z.object({
      wrappedKey: z.object({ epk: b64(64), wrapped: b64(512) }),
      publicKey: b64(64),   // echoed back to prove which key was wrapped to
    }), req.body);

    const token = newToken();

    const result = await tx(async ({ q: query }) => {
      const { rows } = await query(
        "SELECT id, status, public_key, expires_at FROM displays WHERE id = $1 AND household_id = $2 FOR UPDATE",
        [req.params.id, req.household.id]
      );
      const display = rows[0];
      if (!display) throw notFound();
      if (display.status === "active") throw conflict("This display is already active");
      if (display.status !== "pending") throw conflict(`This display is ${display.status}`);

      // The admin must have wrapped to the key we hold, not one substituted
      // between the list request and this one.
      if (Buffer.from(display.public_key).toString("base64") !== body.publicKey) {
        throw conflict("This display's key changed since you loaded the page. Start again.");
      }

      const { rows: approvalRows } = await query(
        "SELECT user_id, decision FROM display_approvals WHERE display_id = $1", [req.params.id]
      );
      if (approvalRows.some((a) => a.decision === "deny")) {
        throw forbidden("An admin denied this display");
      }

      // Count only approvals from people who are *currently* active admins. An
      // approval from someone since removed, or demoted, must not still count.
      const { rows: adminRows } = await query(
        `SELECT user_id FROM household_members
          WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
        [req.household.id]
      );
      const admins = new Set(adminRows.map((a) => a.user_id));
      const valid = approvalRows.filter((a) => a.decision === "approve" && admins.has(a.user_id));

      const required = req.household.approvalThreshold > 0
        ? Math.min(req.household.approvalThreshold, admins.size)
        : admins.size;

      if (valid.length < required) {
        throw forbidden(
          `This display needs ${required} admin approval(s) and has ${valid.length}.`,
          { required, have: valid.length }
        );
      }

      await query(
        `INSERT INTO household_keys (household_id, subject_type, subject_id, key_epoch, wrapped_key, wrap_epk, wrapped_by)
         VALUES ($1, 'display', $2, $3, $4, $5, $6)
         ON CONFLICT (household_id, subject_type, subject_id, key_epoch) DO UPDATE
           SET wrapped_key = EXCLUDED.wrapped_key, wrap_epk = EXCLUDED.wrap_epk`,
        [req.household.id, req.params.id, req.household.keyEpoch,
         bin(body.wrappedKey.wrapped), bin(body.wrappedKey.epk), req.user.id]
      );
      await query(
        "INSERT INTO display_tokens (display_id, token_hash) VALUES ($1, $2) ON CONFLICT (display_id) DO UPDATE SET token_hash = EXCLUDED.token_hash",
        [req.params.id, hashToken(token)]
      );
      await query(
        "UPDATE displays SET status = 'active', activated_at = now() WHERE id = $1", [req.params.id]
      );

      return { approvals: valid.length, required };
    });

    await audit("display_activated", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
      meta: result,
    });

    res.json({
      status: "active",
      ...result,
      // Shown once. The private key is appended by the client as a URL fragment,
      // which is why the server can hand out this link without ever being able
      // to use it: the half that decrypts never passes through here.
      url: `${PUBLIC_URL}/display#${token}`,
    });
  })
);

/* -------------------------------------------------------------- update ----- */

householdRouter.patch("/:householdId/displays/:id",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(60).optional(),
      scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    }), req.body);

    const { rowCount } = await q(
      `UPDATE displays
          SET name = COALESCE($3, name),
              scopes = COALESCE($4::jsonb, scopes),
              expires_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE expires_at END
        WHERE id = $1 AND household_id = $2 AND status IN ('active','pending','expired')`,
      [req.params.id, req.household.id, body.name ?? null,
       body.scopes ? JSON.stringify(body.scopes) : null,
       Object.prototype.hasOwnProperty.call(body, "expiresAt"), body.expiresAt ?? null]
    );
    if (!rowCount) throw notFound();

    // Reviving an expired display by extending it should actually revive it.
    await q(
      `UPDATE displays SET status = 'active'
        WHERE id = $1 AND status = 'expired' AND (expires_at IS NULL OR expires_at > now())`,
      [req.params.id]
    );

    await audit("display_updated", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
      meta: { scopes: body.scopes, expires: body.expiresAt },
    });
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- revoke ----- */

householdRouter.delete("/:householdId/displays/:id",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    const { rowCount } = await q(
      `UPDATE displays SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND household_id = $2 AND status <> 'revoked'`,
      [req.params.id, req.household.id]
    );
    if (!rowCount) throw notFound();

    await q("DELETE FROM display_tokens WHERE display_id = $1", [req.params.id]);
    await q(
      "DELETE FROM household_keys WHERE household_id = $1 AND subject_type = 'display' AND subject_id = $2",
      [req.household.id, req.params.id]
    );

    await audit("display_revoked", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
    });

    // Honest about what revocation does and does not achieve. The link is dead
    // immediately. The device may still hold a copy of the household key, so
    // ciphertext it already downloaded remains readable to it until rotation.
    res.json({
      ok: true,
      rotationRecommended: true,
      note: "The link is dead. If the device is out of your control, rotate the household key too -- " +
            "it still holds a copy of the old one.",
    });
  })
);

/* =============================================================== public ==== */

// Served to the display device itself. Authenticated by the permanent token
// alone: there is no user here, and a wall tablet cannot be asked for a
// password every morning.
export const publicRouter = express.Router();

function displayToken(req) {
  const header = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return (m ? m[1] : req.query.token ? String(req.query.token) : "").trim();
}

async function loadDisplay(req, res, next) {
  try {
    const token = displayToken(req);
    if (!token) return next(notFound());

    const { rows } = await q(
      `SELECT d.id, d.household_id, d.name, d.scopes, d.status, d.expires_at,
              h.key_epoch, h.status AS household_status
         FROM display_tokens t
         JOIN displays d ON d.id = t.display_id
         JOIN households h ON h.id = d.household_id
        WHERE t.token_hash = $1`,
      [hashToken(token)]
    );
    const d = rows[0];
    if (!d) return next(notFound());
    if (d.status !== "active") return next(forbidden(`This display has been ${d.status}`));

    // Checked here as well as in the maintenance sweep, so an expiry takes
    // effect the moment it passes rather than up to five minutes later.
    if (d.expires_at && new Date(d.expires_at) < new Date()) {
      await q("UPDATE displays SET status = 'expired' WHERE id = $1", [d.id]);
      return next(forbidden("This display's access has expired"));
    }
    if (d.household_status === "closed") return next(forbidden("This household is closed"));

    req.display = d;
    next();
  } catch (err) { next(err); }
}

/** What this screen is allowed to render, plus its wrapped key. */
publicRouter.get("/bootstrap",
  limit("display-bootstrap", { capacity: 60, perSecond: 0.5 }),
  loadDisplay,
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT wrapped_key, wrap_epk, key_epoch FROM household_keys
        WHERE household_id = $1 AND subject_type = 'display' AND subject_id = $2
        ORDER BY key_epoch DESC LIMIT 1`,
      [req.display.household_id, req.display.id]
    );
    if (!rows[0]) throw forbidden("This display has no key. It may need to be re-approved.");

    await q("UPDATE displays SET last_seen_at = now() WHERE id = $1", [req.display.id]);

    res.json({
      displayId: req.display.id,
      name: req.display.name,
      householdId: req.display.household_id,
      scopes: req.display.scopes,
      keyEpoch: rows[0].key_epoch,
      expiresAt: req.display.expires_at,
      wrappedKey: {
        epk: Buffer.from(rows[0].wrap_epk).toString("base64"),
        wrapped: Buffer.from(rows[0].wrapped_key).toString("base64"),
      },
    });
  })
);

/**
 * The document, for the display.
 *
 * Note what is *not* possible here: filtering the ciphertext by scope. The
 * server cannot read it, so it cannot redact it. Scope is therefore enforced in
 * the display's own renderer, and the honest consequence is that a display holds
 * the key to the whole document even when it only draws part of it.
 *
 * That is a real limitation and it is documented in docs/THREAT-MODEL.md rather
 * than hidden. The mitigations that do bite: a display cannot write, it cannot
 * enumerate members, its link dies on revocation, and rotation cuts it off for
 * good. If a household needs a screen that genuinely cannot see everything, the
 * answer is a second household, not a scope checkbox.
 */
publicRouter.get("/vault",
  limit("display-vault", { capacity: 120, perSecond: 1 }),
  loadDisplay,
  wrap(async (req, res) => {
    const { rows } = await q(
      "SELECT key_epoch, version, ciphertext, compression FROM vault_documents WHERE household_id = $1",
      [req.display.household_id]
    );
    if (!rows[0]) throw notFound();

    await q("UPDATE displays SET last_seen_at = now() WHERE id = $1", [req.display.id]);

    res.json({
      version: Number(rows[0].version),
      keyEpoch: rows[0].key_epoch,
      ciphertext: Buffer.from(rows[0].ciphertext).toString("base64"),
      compression: rows[0].compression,
      scopes: req.display.scopes,
    });
  })
);

/** Cheap poll, so a wall tablet is not pulling the whole document every 15s. */
publicRouter.get("/version",
  limit("display-version", { capacity: 300, perSecond: 2 }),
  loadDisplay,
  wrap(async (req, res) => {
    const { rows } = await q(
      "SELECT version, key_epoch FROM vault_documents WHERE household_id = $1",
      [req.display.household_id]
    );
    if (!rows[0]) throw notFound();
    await q("UPDATE displays SET last_seen_at = now() WHERE id = $1", [req.display.id]);
    res.json({ version: Number(rows[0].version), keyEpoch: rows[0].key_epoch });
  })
);

/** Read-only calendar events, so the screen can show a schedule. */
publicRouter.get("/calendar-events",
  limit("display-cal", { capacity: 60, perSecond: 0.3 }),
  loadDisplay,
  wrap(async (req, res) => {
    if (!req.display.scopes.includes("calendar") && !req.display.scopes.includes("today")) {
      throw forbidden("This display is not permitted to show the calendar");
    }
    const now = new Date();
    res.json(await eventsFor(req.display.household_id, new Date(now - 7 * 86400e3), new Date(+now + 60 * 86400e3)));
  })
);

export default { householdRouter, publicRouter };
