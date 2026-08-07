// privacy.js — subject access, portability, and erasure.
//
// THE QUESTION THAT SHAPES THIS FILE: what is "your data" when a household
// document is written by five people and encrypted under one shared key?
//
// The answer this implements splits it in two, because the two halves have
// genuinely different legal shapes:
//
//   PERSONAL DATA -- your account, your memberships, your sessions, the audit
//   entries naming you. The server is the controller. You can export it here and
//   you can have it erased. Article 15 and Article 17.
//
//   HOUSEHOLD DATA -- the calendar, chores, notes, everything in the vault.
//   Written jointly by everyone in the home about everyone in the home. The
//   server is not the controller of it in any meaningful sense: it cannot read
//   it, cannot index it, and cannot selectively remove one person's traces from
//   it. The members are joint controllers of their own household.
//
// So the household export is done by the *client*, which holds the key
// (lib/export.js), and it is offered as portability rather than subject access.
// Article 15(4) is the reason the distinction matters: the right to a copy
// "shall not adversely affect the rights and freedoms of others", and a
// household document is full of other people. A member exporting it is fine --
// they can already read every word of it -- but it is their household's data
// they are taking, not a subject access response, and the UI says so.
//
// Erasure has the mirror-image consequence and it is stated rather than glossed:
// deleting your account destroys everything the server holds about you, and
// cannot remove your name from the shared calendar, because the server cannot
// read the shared calendar. A member has to do that.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, unauthorized, conflict, forbidden } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth } from "../middleware/auth.js";
import { openText } from "../crypto/seal.js";
import { verifyPassword } from "../crypto/password.js";
import { audit } from "../services/audit.js";
import { PUBLIC_URL } from "../config.js";

export const router = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) throw badRequest(r.error.issues[0].message);
  return r.data;
};

const unseal = (label, value, aad) => {
  if (!value) return null;
  try { return openText(label, value, aad); } catch { return null; }
};

/* ------------------------------------------------------- subject access --- */

/**
 * Everything the server holds about the person asking, in machine-readable JSON.
 *
 * Deliberately exhaustive, including the fields somebody would not think to ask
 * for -- the shape of the key material, the hashed session records -- with a
 * note on each saying what it is and why it exists. An export that quietly omits
 * the awkward parts is not an export.
 */
router.get("/export",
  requireAuth,
  limit("gdpr-export", { capacity: 5, perSecond: 0.01, by: "user" }),
  wrap(async (req, res) => {
    const [user, members, sessions, auditRows, invites, displays, proposals] = await Promise.all([
      q(`SELECT id, email_enc, display_name_enc, kdf_algo, kdf_iterations, totp_enabled,
                status, is_super_admin, no_recovery_ack_at, last_login_at, created_at, updated_at
           FROM users WHERE id = $1`, [req.user.id]),
      q(`SELECT household_id, role, status, managed_by, invited_by, joined_at, removed_at, archived_at
           FROM household_members WHERE user_id = $1`, [req.user.id]),
      q(`SELECT id, created_at, last_seen_at, expires_at, revoked_at
           FROM sessions WHERE user_id = $1`, [req.user.id]),
      q(`SELECT id, household_id, action, target, meta, created_at
           FROM audit_log WHERE actor_user_id = $1 ORDER BY id`, [req.user.id]),
      q(`SELECT id, household_id, role, expires_at, claimed_at, created_at
           FROM invites WHERE created_by = $1 OR claimed_by = $1`, [req.user.id]),
      q(`SELECT id, household_id, name, scopes, status, created_at
           FROM displays WHERE created_by = $1`, [req.user.id]),
      q(`SELECT p.id, p.household_id, p.kind, p.payload, p.status, p.created_at
           FROM household_proposals p WHERE p.created_by = $1`, [req.user.id]),
    ]);

    const u = user.rows[0];

    res.set("Content-Disposition",
      `attachment; filename="househub-account-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      _about: {
        what: "Everything this server holds about your account.",
        generatedAt: new Date().toISOString(),
        server: PUBLIC_URL,
        notIncluded:
          "Your household's contents. The server stores those encrypted and cannot read " +
          "them, so it cannot export them either. Export a household from inside it, " +
          "where your browser holds the key.",
        yourRights:
          "Article 15 (access), 16 (rectification, via Settings), 17 (erasure, via " +
          "DELETE /api/privacy/me), 20 (portability -- this file is machine-readable JSON).",
      },

      account: {
        id: u.id,
        email: unseal("email", u.email_enc),
        displayName: unseal("displayName", u.display_name_enc),
        status: u.status,
        isSuperAdmin: u.is_super_admin,
        twoFactorEnabled: u.totp_enabled,
        acknowledgedNoPasswordRecoveryAt: u.no_recovery_ack_at,
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
        _note:
          "Your email is stored encrypted, and looked up by a keyed fingerprint so login " +
          "works without the server holding it in the clear.",
      },

      encryption: {
        keyDerivation: { algorithm: u.kdf_algo, iterations: u.kdf_iterations },
        _note:
          "Your password is never sent to this server. The browser stretches it and sends " +
          "a derived proof; the server stores an Argon2id hash of that. Your private key " +
          "is stored encrypted under a key only your password produces. None of that " +
          "material is included here because it would be useless without your password " +
          "and dangerous in a file.",
      },

      households: members.rows.map((m) => ({
        householdId: m.household_id,
        role: m.role,
        status: m.status,
        joinedAt: m.joined_at,
        removedAt: m.removed_at,
        archivedByYouAt: m.archived_at,
        accountWasCreatedForYouBy: m.managed_by,
        invitedBy: m.invited_by,
      })),

      sessions: sessions.rows.map((s) => ({
        id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at, revokedAt: s.revoked_at,
      })),
      _sessionsNote:
        "IP addresses and browser identifiers are stored only as salted hashes and are " +
        "not reversible, so they cannot be shown here or handed to anyone else.",

      activity: auditRows.rows.map((a) => ({
        at: a.created_at, action: a.action, householdId: a.household_id,
        target: a.target, detail: a.meta,
      })),
      _activityNote:
        "A tamper-evident record of actions, never of content. No chore, note, message or " +
        "calendar entry appears here.",

      invitations: invites.rows,
      displaysYouCreated: displays.rows,
      proposalsYouRaised: proposals.rows,
    });
  })
);

/* --------------------------------------------------------------- erasure --- */

/**
 * What deleting this account would do, before doing it.
 *
 * Shown first because two of the consequences genuinely surprise people: the
 * shared household survives, and their name may remain inside it.
 */
router.get("/erasure-preview", requireAuth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT m.household_id, m.role,
            (SELECT count(*)::int FROM household_members o
              WHERE o.household_id = m.household_id AND o.status = 'active') AS members,
            (SELECT count(*)::int FROM household_members o
              WHERE o.household_id = m.household_id AND o.status = 'active' AND o.role = 'admin') AS admins
       FROM household_members m
      WHERE m.user_id = $1 AND m.status = 'active'`,
    [req.user.id]
  );

  const soleAdminOf = rows.filter((r) => r.role === "admin" && r.admins === 1 && r.members > 1);
  const lastMemberOf = rows.filter((r) => r.members === 1);

  res.json({
    willBeDeleted: [
      "Your account: email address, display name, and password verifier",
      "Your encryption keys, which makes any household you have not left unreadable to you",
      "Your sessions and two-factor secret",
      "Your membership of every household",
    ],
    willNotBeDeleted: [
      "Households you shared with other people, and everything in them",
      "Your name or entries inside a shared household's own records — the server " +
        "cannot read them, so it cannot remove them. Ask a member to edit them, or " +
        "remove them yourself before deleting your account",
      "Activity log entries, which keep an account id but no longer identify anyone " +
        "once the account is gone",
    ],
    // Blocking, because leaving a shared household with no admin would brick it
    // for everyone still living there.
    blockers: soleAdminOf.map((r) => ({
      householdId: r.household_id,
      reason: "You are the only admin and other people are still members. " +
              "Promote another admin first, so they are not locked out.",
    })),
    householdsThatWouldBeLeftEmpty: lastMemberOf.map((r) => r.household_id),
  });
}));

/**
 * Delete this account. Any member may do this for themselves, always.
 *
 * A right of erasure that only some people can exercise is not a right, so this
 * is not restricted by role -- an admin, an adult, a dependant and a viewer can
 * all leave. Removing *somebody else* remains an admin action and lives in
 * routes/households.js, which is the distinction that actually matters.
 */
router.delete("/me",
  requireAuth,
  limit("gdpr-erase", { capacity: 5, perSecond: 0.005, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      // Proves the request came from the account holder rather than from a
      // borrowed session on an unlocked laptop.
      authProof: z.string().min(10).max(200),
      confirm: z.literal("DELETE"),
      // Only honoured for households where they are the last member; a shared
      // household is never destroyed by one person leaving.
      deleteEmptyHouseholds: z.boolean().default(true),
    }), req.body);

    const { rows: userRows } = await q("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    if (!verifyPassword(body.authProof, userRows[0].password_hash)) {
      throw unauthorized("That password is not correct");
    }

    const { rows: memberships } = await q(
      `SELECT m.household_id, m.role,
              (SELECT count(*)::int FROM household_members o
                WHERE o.household_id = m.household_id AND o.status = 'active') AS members,
              (SELECT count(*)::int FROM household_members o
                WHERE o.household_id = m.household_id AND o.status = 'active' AND o.role = 'admin') AS admins
         FROM household_members m WHERE m.user_id = $1 AND m.status = 'active'`,
      [req.user.id]
    );

    const blocked = memberships.filter((r) => r.role === "admin" && r.admins === 1 && r.members > 1);
    if (blocked.length) {
      // Recorded so the Article 12(3) clock starts from a date, not a memory.
      await q(
        `INSERT INTO erasure_requests (user_id, blocked_on) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET blocked_on = EXCLUDED.blocked_on`,
        [req.user.id, `sole admin of ${blocked.length} shared household(s)`]
      );
      throw conflict(
        "You are the only admin of a household other people still live in. Promote another " +
        "admin first — otherwise nobody left could add members, approve a display, or " +
        "rotate the key, and their household would be stuck for good.",
        { blockers: blocked.map((b) => b.household_id) }
      );
    }

    const emptied = memberships.filter((r) => r.members === 1).map((r) => r.household_id);

    await tx(async ({ q: query }) => {
      if (body.deleteEmptyHouseholds) {
        for (const id of emptied) {
          // Nobody else holds a key to these, so the vault is already
          // permanently unreadable. Leaving them would be litter.
          await query("DELETE FROM households WHERE id = $1", [id]);
        }
      }
      // Everything keyed to this user cascades: sessions, memberships, wrapped
      // keys, TOTP secret, invites they claimed.
      await query("DELETE FROM users WHERE id = $1", [req.user.id]);
    });

    // After the row is gone: the audit entry keeps an id that no longer resolves
    // to a person, which is what makes retaining the chain compatible with
    // erasure rather than in tension with it.
    await audit("account_erased", {
      meta: { householdsDeleted: body.deleteEmptyHouseholds ? emptied.length : 0 },
    });

    res.json({
      ok: true,
      householdsDeleted: body.deleteEmptyHouseholds ? emptied : [],
      note:
        "Your account and keys are gone. Anything you wrote inside a household you shared " +
        "with other people remains theirs and can only be edited from inside it.",
    });
  })
);

export default router;
