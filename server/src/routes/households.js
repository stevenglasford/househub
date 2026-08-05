// households.js — the "party": who belongs to it, who runs it, and how the
// household key reaches each of them.
//
// The central constraint shaping every handler here: the server cannot wrap the
// household key, because it does not have it. Adding a member is therefore
// always a two-step handshake that the server merely relays --
//
//   1. the newcomer publishes an X25519 public key (registration does this)
//   2. an existing admin's browser wraps the household key to that key and
//      uploads the result, which activates the membership
//
// That is why there is no "add member" endpoint that does the job in one call.
// The gap is the security property: an operator who forges step 1 still cannot
// perform step 2, so they cannot insert themselves into a family.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, forbidden, notFound, conflict } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import {
  requireAuth, loadHousehold, requireRole, atLeast, requireWritable,
} from "../middleware/auth.js";
import { seal, openText, blindIndex } from "../crypto/seal.js";
import { hashPassword } from "../crypto/password.js";
import { newToken, hashToken } from "../crypto/tokens.js";
import { audit, recentForHousehold } from "../services/audit.js";
import { PUBLIC_URL } from "../config.js";

export const router = express.Router();

const b64 = (max) => z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/).max(max);
const bin = (s) => Buffer.from(s, "base64");
const ROLES = ["admin", "adult", "dependent", "viewer"];

const wrappedKeySchema = z.object({ epk: b64(64), wrapped: b64(512) });

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first.message, { field: first.path.join(".") });
  }
  return r.data;
};

/* ------------------------------------------------------------- create ------ */

/**
 * Create a household. The caller's browser has already generated a random
 * household key and wrapped it to its own public key; we store the wrap and
 * never see the key.
 *
 * `nameEnc` is ciphertext under the *household* key, not a server seal -- so
 * the family's name for their own home is unreadable here, while still being
 * displayable in a member's household list without downloading the whole vault.
 */
router.post("/",
  requireAuth,
  limit("household-create", { capacity: 5, perSecond: 0.02, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      nameEnc: b64(1024).optional(),
      wrappedKey: wrappedKeySchema,
      // The initial empty document, sealed. Supplied at creation so a household
      // is never in a half-built state with no vault to read.
      document: z.object({ ciphertext: z.string().max(20_000_000), compression: z.string().max(16), plainBytes: z.number().int().nonnegative() }),
    }), req.body);

    const result = await tx(async ({ q: query }) => {
      const { rows } = await query(
        "INSERT INTO households (name_enc) VALUES ($1) RETURNING id, key_epoch",
        [body.nameEnc ? bin(body.nameEnc) : null]
      );
      const h = rows[0];

      await query(
        `INSERT INTO household_members (household_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')`,
        [h.id, req.user.id]
      );
      await query(
        `INSERT INTO household_keys (household_id, subject_type, subject_id, key_epoch, wrapped_key, wrap_epk, wrapped_by)
         VALUES ($1, 'user', $2, $3, $4, $5, $2)`,
        [h.id, req.user.id, h.key_epoch, bin(body.wrappedKey.wrapped), bin(body.wrappedKey.epk)]
      );
      await query(
        `INSERT INTO vault_documents (household_id, key_epoch, version, ciphertext, compression, plain_bytes, updated_by)
         VALUES ($1, $2, 1, $3, $4, $5, $6)`,
        [h.id, h.key_epoch, bin(body.document.ciphertext), body.document.compression,
         body.document.plainBytes, req.user.id]
      );
      // Every household starts on the self-host plan. On a server that never
      // enables billing, nothing ever changes it.
      await query(
        `INSERT INTO subscriptions (household_id, plan_id, status)
         SELECT $1, id, 'active' FROM plans WHERE code = 'selfhost'`,
        [h.id]
      );
      return h;
    });

    await audit("household_created", { householdId: result.id, actorUserId: req.user.id });
    res.status(201).json({ id: result.id, keyEpoch: result.key_epoch, role: "admin" });
  })
);

/* -------------------------------------------------------------- read ------- */

router.get("/:householdId", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    "SELECT id, name_enc, key_epoch, status, display_approval_threshold, created_at FROM households WHERE id = $1",
    [req.household.id]
  );
  const h = rows[0];
  const { rows: keyRows } = await q(
    `SELECT wrapped_key, wrap_epk, key_epoch FROM household_keys
      WHERE household_id = $1 AND subject_type = 'user' AND subject_id = $2
      ORDER BY key_epoch DESC LIMIT 1`,
    [req.household.id, req.user.id]
  );
  if (!keyRows[0]) {
    // Membership exists but no key has been wrapped yet: an invite that has been
    // claimed but not yet approved by an admin.
    throw forbidden("Your access to this household has not been finished by an admin yet");
  }

  res.json({
    id: h.id,
    nameEnc: h.name_enc ? Buffer.from(h.name_enc).toString("base64") : null,
    keyEpoch: h.key_epoch,
    status: h.status,
    approvalThreshold: h.display_approval_threshold,
    createdAt: h.created_at,
    role: req.membership.role,
    wrappedKey: {
      epk: Buffer.from(keyRows[0].wrap_epk).toString("base64"),
      wrapped: Buffer.from(keyRows[0].wrapped_key).toString("base64"),
      keyEpoch: keyRows[0].key_epoch,
    },
  });
}));

/**
 * Members, with their public keys. Public keys are exactly that -- public --
 * and an admin's browser needs them to wrap the household key during rotation.
 */
router.get("/:householdId/members", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT m.user_id, m.role, m.status, m.managed_by, m.joined_at,
            u.public_key, u.display_name_enc, u.email_enc, u.status AS user_status,
            EXISTS (
              SELECT 1 FROM household_keys k
               WHERE k.household_id = m.household_id AND k.subject_type = 'user'
                 AND k.subject_id = m.user_id AND k.key_epoch = $2
            ) AS has_current_key
       FROM household_members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = $1 AND m.status <> 'removed'
      ORDER BY m.joined_at`,
    [req.household.id, req.household.keyEpoch]
  );

  res.json(rows.map((m) => ({
    userId: m.user_id,
    role: m.role,
    status: m.status,
    managed: Boolean(m.managed_by),
    joinedAt: m.joined_at,
    publicKey: Buffer.from(m.public_key).toString("base64"),
    hasCurrentKey: m.has_current_key,
    // Email and display name are sealed under a server key. Members of a
    // household can see each other's addresses -- they live together -- so this
    // is one of the few places the server decrypts on someone's behalf.
    email: unsealOrNull("email", m.email_enc),
    displayName: unsealOrNull("displayName", m.display_name_enc),
  })));
}));

// A row sealed under a rotated-away or corrupt server key should blank one
// field, not fail the whole member list and leave an admin unable to manage
// their household.
function unsealOrNull(label, value) {
  if (!value) return null;
  try { return openText(label, value); } catch { return null; }
}

/* ------------------------------------------------------------ invites ------ */

/**
 * Invite someone. Produces a link; the token is stored only as a hash, so an
 * operator reading the database cannot mint or replay one.
 */
router.post("/:householdId/invites",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("invite-create", { capacity: 20, perSecond: 0.1, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      role: z.enum(ROLES),
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      expiresInHours: z.number().int().min(1).max(24 * 30).default(72),
    }), req.body);

    const token = newToken();
    const { rows } = await q(
      `INSERT INTO invites (household_id, token_hash, role, email_bidx, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
       RETURNING id, expires_at`,
      [req.household.id, hashToken(token), body.role,
       body.email ? blindIndex("email", body.email) : null, req.user.id, String(body.expiresInHours)]
    );

    await audit("invite_created", {
      householdId: req.household.id, actorUserId: req.user.id,
      target: rows[0].id, meta: { role: body.role, pinned: Boolean(body.email) },
    });

    res.status(201).json({
      id: rows[0].id,
      role: body.role,
      expiresAt: rows[0].expires_at,
      // Returned exactly once. Nothing can recover it afterwards.
      url: `${PUBLIC_URL}/join#${token}`,
    });
  })
);

router.get("/:householdId/invites", requireAuth, loadHousehold(), requireRole("admin"), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, role, claimed_by, claimed_at, expires_at, created_at, email_bidx IS NOT NULL AS pinned
       FROM invites
      WHERE household_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`, [req.household.id]
  );
  res.json(rows);
}));

router.delete("/:householdId/invites/:id",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    const { rowCount } = await q(
      "UPDATE invites SET revoked_at = now() WHERE id = $1 AND household_id = $2 AND revoked_at IS NULL",
      [req.params.id, req.household.id]
    );
    if (!rowCount) throw notFound();
    await audit("invite_revoked", { householdId: req.household.id, actorUserId: req.user.id, target: req.params.id });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------- dependent accounts ------ */

/**
 * Create an account *for* someone -- the case in the brief: a parent setting up
 * a child, or a spouse who will not be doing the setup themselves.
 *
 * The admin's browser generates the whole identity from a password they choose
 * and hand over, so the server still never sees a password and still cannot
 * read anything. `managed_by` records that this account was made by someone
 * else, which matters: the dependent can later claim it outright and change the
 * password, at which point the guardian loses that ability.
 */
router.post("/:householdId/members/managed",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("managed-create", { capacity: 10, perSecond: 0.02, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      displayName: z.string().trim().min(1).max(80),
      role: z.enum(["adult", "dependent", "viewer"]),
      identity: z.object({
        kdfAlgo: z.literal("PBKDF2-SHA256"),
        kdfIterations: z.number().int().min(100000).max(10_000_000),
        kdfSalt: b64(64),
        wrappedMasterKey: b64(512),
        publicKey: b64(64),
        encPrivateKey: b64(512),
        authProof: b64(128),
      }),
      wrappedKey: wrappedKeySchema,
    }), req.body);

    if (bin(body.identity.publicKey).length !== 32) throw badRequest("publicKey must be 32 bytes");

    const bidx = blindIndex("email", body.email);
    const userId = await tx(async ({ q: query }) => {
      const dup = await query("SELECT id FROM users WHERE email_bidx = $1", [bidx]);
      if (dup.rows[0]) throw conflict("An account with that address already exists. Invite them instead.");

      const ins = await query(
        `INSERT INTO users (email_bidx, email_enc, password_hash, kdf_algo, kdf_iterations,
                            kdf_salt, wrapped_master_key, public_key, enc_private_key, display_name_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [bidx, seal("email", body.email), hashPassword(body.identity.authProof),
         body.identity.kdfAlgo, body.identity.kdfIterations, bin(body.identity.kdfSalt),
         bin(body.identity.wrappedMasterKey), bin(body.identity.publicKey),
         bin(body.identity.encPrivateKey), seal("displayName", body.displayName)]
      );
      const id = ins.rows[0].id;

      await query(
        `INSERT INTO household_members (household_id, user_id, role, status, managed_by, invited_by)
         VALUES ($1, $2, $3, 'active', $4, $4)`,
        [req.household.id, id, body.role, req.user.id]
      );
      await query(
        `INSERT INTO household_keys (household_id, subject_type, subject_id, key_epoch, wrapped_key, wrap_epk, wrapped_by)
         VALUES ($1, 'user', $2, $3, $4, $5, $6)`,
        [req.household.id, id, req.household.keyEpoch,
         bin(body.wrappedKey.wrapped), bin(body.wrappedKey.epk), req.user.id]
      );
      return id;
    });

    await audit("managed_member_created", {
      householdId: req.household.id, actorUserId: req.user.id, target: userId, meta: { role: body.role },
    });
    res.status(201).json({ userId, role: body.role });
  })
);

/* ---------------------------------------------------- finish a join -------- */

/**
 * Step 2 of the handshake: an admin wraps the household key to a member who has
 * claimed an invite, which flips their membership to active.
 *
 * The admin's client is expected to have verified the newcomer's public key
 * fingerprint out of band -- in person, which for a household is easy. Without
 * that, a server could substitute its own key here and be admitted. The UI
 * shows the fingerprint and asks for confirmation; see docs/THREAT-MODEL.md.
 */
router.post("/:householdId/members/:userId/key",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const body = parse(z.object({
      wrappedKey: wrappedKeySchema,
      // Echoed back by the admin's client to prove it wrapped to the key it was
      // shown, not one swapped in between the two requests.
      publicKey: b64(64),
    }), req.body);

    const { rows } = await q(
      `SELECT m.status, u.public_key FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = $1 AND m.user_id = $2`,
      [req.household.id, req.params.userId]
    );
    const member = rows[0];
    if (!member) throw notFound();

    if (Buffer.from(member.public_key).toString("base64") !== body.publicKey) {
      throw conflict("That member's public key changed since you loaded the page. Re-check the fingerprint.");
    }

    await tx(async ({ q: query }) => {
      await query(
        `INSERT INTO household_keys (household_id, subject_type, subject_id, key_epoch, wrapped_key, wrap_epk, wrapped_by)
         VALUES ($1, 'user', $2, $3, $4, $5, $6)
         ON CONFLICT (household_id, subject_type, subject_id, key_epoch) DO UPDATE
           SET wrapped_key = EXCLUDED.wrapped_key, wrap_epk = EXCLUDED.wrap_epk`,
        [req.household.id, req.params.userId, req.household.keyEpoch,
         bin(body.wrappedKey.wrapped), bin(body.wrappedKey.epk), req.user.id]
      );
      await query(
        "UPDATE household_members SET status = 'active' WHERE household_id = $1 AND user_id = $2",
        [req.household.id, req.params.userId]
      );
    });

    await audit("member_key_granted", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.userId,
    });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------- roles ------- */

router.put("/:householdId/members/:userId/role",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);

    await tx(async ({ q: query }) => {
      // Never let the last admin demote themselves. A household with no admin
      // can never add a member, approve a display, or rotate a key again --
      // it would be permanently and silently bricked.
      if (req.params.userId === req.user.id && role !== "admin") {
        const { rows } = await query(
          `SELECT count(*)::int AS n FROM household_members
            WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
          [req.household.id]
        );
        if (rows[0].n <= 1) throw conflict("You are the only admin. Promote someone else first.");
      }
      const { rowCount } = await query(
        `UPDATE household_members SET role = $3
          WHERE household_id = $1 AND user_id = $2 AND status <> 'removed'`,
        [req.household.id, req.params.userId, role]
      );
      if (!rowCount) throw notFound();
    });

    await audit("member_role_changed", {
      householdId: req.household.id, actorUserId: req.user.id,
      target: req.params.userId, meta: { role },
    });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------ removal ------ */

/**
 * Remove a member. This revokes access *going forward*; it cannot un-see what
 * they already read, and the response says so rather than implying otherwise.
 *
 * The old wrapped key is deleted and the household is marked as needing
 * rotation. Until an admin completes the rotation, the removed member's copy of
 * the household key still opens any ciphertext they kept a copy of -- which is
 * why the client prompts to rotate immediately.
 */
router.delete("/:householdId/members/:userId",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    if (req.params.userId === req.user.id) {
      throw badRequest("Use 'leave household' to remove yourself");
    }

    await tx(async ({ q: query }) => {
      const { rows } = await query(
        `SELECT role FROM household_members
          WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
        [req.household.id, req.params.userId]
      );
      if (!rows[0]) throw notFound();

      if (rows[0].role === "admin") {
        const { rows: admins } = await query(
          `SELECT count(*)::int AS n FROM household_members
            WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
          [req.household.id]
        );
        if (admins[0].n <= 1) throw conflict("That is the only admin of this household");
      }

      await query(
        `UPDATE household_members SET status = 'removed', removed_at = now()
          WHERE household_id = $1 AND user_id = $2`,
        [req.household.id, req.params.userId]
      );
      await query(
        `DELETE FROM household_keys
          WHERE household_id = $1 AND subject_type = 'user' AND subject_id = $2`,
        [req.household.id, req.params.userId]
      );
    });

    await audit("member_removed", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.userId,
    });
    res.json({
      ok: true,
      rotationRequired: true,
      note: "Rotate the household key now. Until you do, anyone holding the old key can still " +
            "read data they already had a copy of.",
    });
  })
);

/* ----------------------------------------------------------- rotation ------ */

/**
 * Rotate the household key.
 *
 * The admin's client generates a fresh key, re-wraps it for every remaining
 * member and active display, re-seals the document under it, and submits the
 * lot. All of it lands in one transaction: a partial rotation that left some
 * members unable to decrypt would be an outage for the family, and one that
 * left the document under the old key would be a silent non-rotation.
 */
router.post("/:householdId/rotate-key",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("rotate", { capacity: 5, perSecond: 0.01, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      keys: z.array(z.object({
        subjectType: z.enum(["user", "display"]),
        subjectId: z.string().uuid(),
        epk: b64(64),
        wrapped: b64(512),
      })).min(1).max(200),
      document: z.object({
        ciphertext: z.string().max(20_000_000),
        compression: z.string().max(16),
        plainBytes: z.number().int().nonnegative(),
      }),
      nameEnc: b64(1024).optional(),
    }), req.body);

    const result = await tx(async ({ q: query }) => {
      // Lock the household row so two admins rotating at once cannot interleave
      // and leave half the members on each epoch.
      const { rows: hh } = await query(
        "SELECT key_epoch FROM households WHERE id = $1 FOR UPDATE", [req.household.id]
      );
      const newEpoch = hh[0].key_epoch + 1;

      // Everyone who must still have access after this rotation.
      const { rows: expected } = await query(
        `SELECT 'user' AS t, user_id AS id FROM household_members
          WHERE household_id = $1 AND status = 'active'
         UNION ALL
         SELECT 'display', id FROM displays
          WHERE household_id = $1 AND status = 'active'`,
        [req.household.id]
      );
      const supplied = new Set(body.keys.map((k) => `${k.subjectType}:${k.subjectId}`));
      const missing = expected.filter((e) => !supplied.has(`${e.t}:${e.id}`));
      if (missing.length) {
        // Refuse rather than lock someone out of their own home.
        throw conflict(
          `Rotation is missing wrapped keys for ${missing.length} subject(s). ` +
          "Reload the member list and try again.",
          { missing: missing.map((m) => ({ type: m.t, id: m.id })) }
        );
      }

      for (const k of body.keys) {
        await query(
          `INSERT INTO household_keys (household_id, subject_type, subject_id, key_epoch, wrapped_key, wrap_epk, wrapped_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (household_id, subject_type, subject_id, key_epoch) DO UPDATE
             SET wrapped_key = EXCLUDED.wrapped_key, wrap_epk = EXCLUDED.wrap_epk`,
          [req.household.id, k.subjectType, k.subjectId, newEpoch, bin(k.wrapped), bin(k.epk), req.user.id]
        );
      }

      // Old epochs go, including any belonging to the member just removed.
      await query("DELETE FROM household_keys WHERE household_id = $1 AND key_epoch < $2",
        [req.household.id, newEpoch]);

      const { rows: doc } = await query(
        `UPDATE vault_documents
            SET key_epoch = $2, version = version + 1, ciphertext = $3, compression = $4,
                plain_bytes = $5, updated_by = $6, updated_at = now()
          WHERE household_id = $1 RETURNING version`,
        [req.household.id, newEpoch, bin(body.document.ciphertext), body.document.compression,
         body.document.plainBytes, req.user.id]
      );

      // Revisions were sealed under keys that no longer exist; keeping them
      // would be undecryptable noise that still counts against the quota.
      await query("DELETE FROM vault_revisions WHERE household_id = $1", [req.household.id]);

      await query(
        `UPDATE households SET key_epoch = $2, updated_at = now(),
                name_enc = COALESCE($3, name_enc) WHERE id = $1`,
        [req.household.id, newEpoch, body.nameEnc ? bin(body.nameEnc) : null]
      );

      return { keyEpoch: newEpoch, version: Number(doc[0].version) };
    });

    await audit("key_rotated", {
      householdId: req.household.id, actorUserId: req.user.id,
      meta: { epoch: result.keyEpoch, subjects: body.keys.length },
    });
    res.json(result);
  })
);

/* ---------------------------------------------------------- settings ------- */

router.put("/:householdId/settings",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const body = parse(z.object({
      nameEnc: b64(1024).optional(),
      // 0 means "every current admin must approve a display".
      displayApprovalThreshold: z.number().int().min(0).max(20).optional(),
    }), req.body);

    await q(
      `UPDATE households
          SET name_enc = COALESCE($2, name_enc),
              display_approval_threshold = COALESCE($3, display_approval_threshold),
              updated_at = now()
        WHERE id = $1`,
      [req.household.id, body.nameEnc ? bin(body.nameEnc) : null,
       body.displayApprovalThreshold ?? null]
    );
    await audit("household_settings_changed", { householdId: req.household.id, actorUserId: req.user.id });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------- leave ------- */

router.post("/:householdId/leave", requireAuth, loadHousehold(), wrap(async (req, res) => {
  await tx(async ({ q: query }) => {
    if (req.membership.role === "admin") {
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM household_members
          WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
        [req.household.id]
      );
      if (rows[0].n <= 1) throw conflict("You are the only admin. Promote someone else, or close the household.");
    }
    await query(
      `UPDATE household_members SET status = 'removed', removed_at = now()
        WHERE household_id = $1 AND user_id = $2`, [req.household.id, req.user.id]
    );
    await query(
      "DELETE FROM household_keys WHERE household_id = $1 AND subject_type = 'user' AND subject_id = $2",
      [req.household.id, req.user.id]
    );
  });
  await audit("member_left", { householdId: req.household.id, actorUserId: req.user.id });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ activity ----- */

router.get("/:householdId/activity", requireAuth, loadHousehold(), atLeast("adult"),
  wrap(async (req, res) => {
    res.json(await recentForHousehold(req.household.id, Number(req.query.limit) || 100));
  })
);

export default router;
