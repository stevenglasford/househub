// proposals.js — changes that take every admin agreeing.
//
// One thing uses this today: switching a completion archive off, which wipes it.
// That is destructive, irreversible, and in a household the archive may be the
// only record of who was actually doing the work -- so it should not be
// something one person can do quietly while the others are out.
//
// The gate is: every *currently active* admin must approve, and any single deny
// kills the proposal outright. Approvals from someone since removed or demoted
// stop counting, so a proposal cannot be smuggled through on stale consent.
//
// What this is and is not, stated plainly. The archive lives inside the
// end-to-end encrypted document; the server cannot read it and therefore cannot
// enforce what a client does with it. This makes the decision deliberate,
// visible to every other admin, and permanent in the audit log. It is not a
// defence against an admin who edits their own client -- and in an end-to-end
// encrypted system nothing client-side could be. See docs/THREAT-MODEL.md.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, notFound, conflict, forbidden } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, requireWritable } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

export const router = express.Router();

const KINDS = ["disable_archive"];

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

/** Active admins, and which of them have approved. Stale consent does not count. */
async function tally(query, householdId, proposalId) {
  const { rows: admins } = await query(
    `SELECT user_id FROM household_members
      WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
    [householdId]
  );
  const { rows: decisions } = await query(
    "SELECT user_id, decision FROM proposal_approvals WHERE proposal_id = $1",
    [proposalId]
  );

  const adminIds = new Set(admins.map((a) => a.user_id));
  const approvals = decisions.filter((d) => d.decision === "approve" && adminIds.has(d.user_id));
  const denials = decisions.filter((d) => d.decision === "deny" && adminIds.has(d.user_id));

  return {
    required: adminIds.size,
    approvals: approvals.map((a) => a.user_id),
    denials: denials.map((d) => d.user_id),
    satisfied: denials.length === 0 && approvals.length >= adminIds.size,
  };
}

/* -------------------------------------------------------------- create ---- */

router.post("/:householdId/proposals",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  limit("proposal-create", { capacity: 10, perSecond: 0.02, by: "household" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      kind: z.enum(KINDS),
      payload: z.object({
        collections: z.array(z.enum(["chores", "tasks", "projects", "grocery"])).min(1).max(8),
      }),
    }), req.body);

    const result = await tx(async ({ q: query }) => {
      const dup = await query(
        `SELECT id FROM household_proposals
          WHERE household_id = $1 AND kind = $2 AND status = 'open' AND expires_at > now()`,
        [req.household.id, body.kind]
      );
      if (dup.rows[0]) throw conflict("There is already an open proposal of that kind", { id: dup.rows[0].id });

      const { rows } = await query(
        `INSERT INTO household_proposals (household_id, kind, payload, created_by)
         VALUES ($1, $2, $3::jsonb, $4) RETURNING id, expires_at`,
        [req.household.id, body.kind, JSON.stringify(body.payload), req.user.id]
      );
      const id = rows[0].id;

      // Proposing is consenting. Recorded explicitly so the count is uniform.
      await query(
        "INSERT INTO proposal_approvals (proposal_id, user_id, decision) VALUES ($1, $2, 'approve')",
        [id, req.user.id]
      );

      return { id, expiresAt: rows[0].expires_at, ...(await tally(query, req.household.id, id)) };
    });

    await audit("proposal_created", {
      householdId: req.household.id, actorUserId: req.user.id,
      target: result.id, meta: { kind: body.kind, collections: body.payload.collections },
    });
    res.status(201).json({ kind: body.kind, ...result });
  })
);

/* ---------------------------------------------------------------- list ---- */

router.get("/:householdId/proposals", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.id, p.kind, p.payload, p.status, p.created_by, p.created_at, p.expires_at,
            COALESCE(json_agg(json_build_object('userId', a.user_id, 'decision', a.decision))
                     FILTER (WHERE a.user_id IS NOT NULL), '[]') AS decisions
       FROM household_proposals p
       LEFT JOIN proposal_approvals a ON a.proposal_id = p.id
      WHERE p.household_id = $1 AND p.status IN ('open','approved')
        AND p.expires_at > now()
      GROUP BY p.id ORDER BY p.created_at DESC`,
    [req.household.id]
  );

  const { rows: admins } = await q(
    `SELECT count(*)::int AS n FROM household_members
      WHERE household_id = $1 AND role = 'admin' AND status = 'active'`,
    [req.household.id]
  );

  res.json(rows.map((p) => ({
    id: p.id, kind: p.kind, payload: p.payload, status: p.status,
    createdBy: p.created_by, createdAt: p.created_at, expiresAt: p.expires_at,
    decisions: p.decisions, required: admins[0].n,
  })));
}));

/* ------------------------------------------------------------- decide ----- */

router.post("/:householdId/proposals/:id/decide",
  requireAuth, loadHousehold(), requireRole("admin"), requireWritable,
  wrap(async (req, res) => {
    const { decision } = parse(
      z.object({ decision: z.enum(["approve", "deny"]) }), req.body
    );

    const result = await tx(async ({ q: query }) => {
      const { rows } = await query(
        "SELECT id, kind, status, expires_at FROM household_proposals WHERE id = $1 AND household_id = $2 FOR UPDATE",
        [req.params.id, req.household.id]
      );
      const p = rows[0];
      if (!p) throw notFound();
      if (p.status !== "open") throw conflict(`This proposal is already ${p.status}`);
      if (new Date(p.expires_at) < new Date()) throw conflict("This proposal has expired");

      await query(
        `INSERT INTO proposal_approvals (proposal_id, user_id, decision) VALUES ($1, $2, $3)
         ON CONFLICT (proposal_id, user_id) DO UPDATE SET decision = EXCLUDED.decision, decided_at = now()`,
        [p.id, req.user.id, decision]
      );

      const state = await tally(query, req.household.id, p.id);

      // A single deny ends it. Destroying a shared record needs everyone; one
      // person objecting is enough to stop it.
      if (decision === "deny") {
        await query(
          "UPDATE household_proposals SET status = 'denied', resolved_at = now() WHERE id = $1", [p.id]
        );
        return { status: "denied", ...state };
      }
      if (state.satisfied) {
        await query(
          "UPDATE household_proposals SET status = 'approved', resolved_at = now() WHERE id = $1", [p.id]
        );
        return { status: "approved", kind: p.kind, ...state };
      }
      return { status: "open", ...state };
    });

    await audit(`proposal_${decision === "deny" ? "denied" : "approved"}`, {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
    });
    res.json(result);
  })
);

/**
 * Mark an approved proposal as carried out.
 *
 * The client performs the actual change -- it holds the key, so only it can --
 * and calls this so the audit trail records that it happened rather than
 * stopping at "everyone agreed".
 */
router.post("/:householdId/proposals/:id/applied",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    const { rows } = await q(
      "SELECT status, kind, payload FROM household_proposals WHERE id = $1 AND household_id = $2",
      [req.params.id, req.household.id]
    );
    if (!rows[0]) throw notFound();
    if (rows[0].status !== "approved") throw forbidden("That proposal has not been approved by every admin");

    await q(
      "UPDATE household_proposals SET status = 'applied', resolved_at = now() WHERE id = $1",
      [req.params.id]
    );
    await audit("proposal_applied", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
      meta: { kind: rows[0].kind, payload: rows[0].payload },
    });
    res.json({ ok: true });
  })
);

router.delete("/:householdId/proposals/:id",
  requireAuth, loadHousehold(), requireRole("admin"),
  wrap(async (req, res) => {
    const { rowCount } = await q(
      `UPDATE household_proposals SET status = 'withdrawn', resolved_at = now()
        WHERE id = $1 AND household_id = $2 AND status = 'open'`,
      [req.params.id, req.household.id]
    );
    if (!rowCount) throw notFound();
    await audit("proposal_withdrawn", {
      householdId: req.household.id, actorUserId: req.user.id, target: req.params.id,
    });
    res.json({ ok: true });
  })
);

export default router;
