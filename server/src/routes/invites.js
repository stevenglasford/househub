// invites.js — claiming an invitation.
//
// Accepting an invite does NOT grant access. It records that this account wants
// in and publishes its public key; an admin must then wrap the household key to
// that key before anything becomes readable. The membership sits in 'pending'
// in between.
//
// That extra step is not bureaucracy -- it is the whole defence. If accepting an
// invite granted access on its own, then whoever controls the server could
// accept one themselves and be handed a decryptable household. Because the
// second step requires a key only an admin's device holds, they cannot.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, notFound, conflict, forbidden } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth } from "../middleware/auth.js";
import { hashToken } from "../crypto/tokens.js";
import { safeEqual } from "../crypto/seal.js";
import { audit } from "../services/audit.js";

export const router = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

/**
 * Look at an invite without accepting it, so the join page can say "you have
 * been invited to a household as an adult" before asking someone to sign up.
 *
 * Returns nothing identifying: no household name, no inviter, no member list.
 * A leaked link should not tell a stranger whose home it belongs to.
 */
router.post("/inspect",
  limit("invite-inspect", { capacity: 20, perSecond: 0.2 }),
  wrap(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(256) }), req.body);
    const { rows } = await q(
      `SELECT role, expires_at, claimed_by, revoked_at, email_bidx IS NOT NULL AS pinned
         FROM invites WHERE token_hash = $1`,
      [hashToken(token)]
    );
    const inv = rows[0];
    if (!inv || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
      throw notFound("This invitation is no longer valid");
    }
    if (inv.claimed_by) throw conflict("This invitation has already been used");

    res.json({ role: inv.role, expiresAt: inv.expires_at, pinnedToEmail: inv.pinned });
  })
);

router.post("/accept",
  requireAuth,
  limit("invite-accept", { capacity: 10, perSecond: 0.1, by: "user" }),
  wrap(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(256) }), req.body);

    const result = await tx(async ({ q: query }) => {
      const { rows } = await query(
        `SELECT id, household_id, role, email_bidx, expires_at, claimed_by, revoked_at
           FROM invites WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(token)]
      );
      const inv = rows[0];
      if (!inv || inv.revoked_at || new Date(inv.expires_at) < new Date()) {
        throw notFound("This invitation is no longer valid");
      }
      if (inv.claimed_by) throw conflict("This invitation has already been used");

      // A pinned invite is bound to one address, so a forwarded or intercepted
      // link is useless to anyone else.
      if (inv.email_bidx && !safeEqual(inv.email_bidx, req.user.emailBidx)) {
        throw forbidden("This invitation was issued to a different email address");
      }

      const already = await query(
        "SELECT status FROM household_members WHERE household_id = $1 AND user_id = $2",
        [inv.household_id, req.user.id]
      );
      if (already.rows[0]?.status === "active") {
        throw conflict("You are already a member of this household");
      }

      await query(
        `INSERT INTO household_members (household_id, user_id, role, status, invited_by)
         VALUES ($1, $2, $3, 'pending', (SELECT created_by FROM invites WHERE id = $4))
         ON CONFLICT (household_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, status = 'pending', removed_at = NULL`,
        [inv.household_id, req.user.id, inv.role, inv.id]
      );
      await query(
        "UPDATE invites SET claimed_by = $2, claimed_at = now() WHERE id = $1",
        [inv.id, req.user.id]
      );

      return { householdId: inv.household_id, role: inv.role };
    });

    await audit("invite_claimed", {
      householdId: result.householdId, actorUserId: req.user.id, meta: { role: result.role },
    });

    res.json({
      ...result,
      status: "pending",
      note: "An admin of this household needs to approve you before you can see anything. " +
            "Check the fingerprint with them in person if you can.",
    });
  })
);

/** Households waiting on an admin to finish granting this user a key. */
router.get("/pending", requireAuth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT household_id, role, joined_at FROM household_members
      WHERE user_id = $1 AND status = 'pending' ORDER BY joined_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

export default router;
