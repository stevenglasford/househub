// vault.js — get and put the sealed household document.
//
// This is the busiest route in the system and the one that handles the most
// sensitive bytes, and it is almost trivially short, which is the point: the
// server's entire job here is "hand the right opaque blob to the right member,
// and don't lose writes". It cannot read what it stores, so it cannot validate
// the contents, merge them, or index them -- and every feature that would have
// needed the server to understand the data has been pushed into the client
// instead.
//
// Concurrency is optimistic. The original app was last-write-wins over the whole
// document, which was defensible for two people on one wall tablet. With
// households of five on their own phones it is not, so a write carries the
// version it was based on and a stale write is rejected with the current
// document attached, letting the client merge and retry without a round trip.

import express from "express";
import { z } from "zod";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, notFound, conflict, forbidden } from "../middleware/errors.js";
import { limit } from "../middleware/ratelimit.js";
import { requireAuth, loadHousehold, requireRole, atLeast, requireWritable } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { VAULT_REVISIONS_KEPT } from "../config.js";

export const router = express.Router();

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first.message, { field: first.path.join(".") });
  }
  return r.data;
};

const bin = (s) => Buffer.from(s, "base64");
const out = (b) => Buffer.from(b).toString("base64");

const documentSchema = z.object({
  // Validated as base64 rather than taken on trust. The server cannot check
  // that the bytes decrypt -- that is the whole design -- but it can refuse to
  // store something that is not even a ciphertext, which catches a broken
  // client before it overwrites a household's only copy with garbage.
  ciphertext: z.string().min(38).max(24_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "ciphertext must be base64"),
  compression: z.enum(["gzip", "none"]),
  plainBytes: z.number().int().nonnegative().max(200_000_000),
  baseVersion: z.number().int().nonnegative(),
});

/* ------------------------------------------------------------------ read --- */

router.get("/:householdId/vault", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT key_epoch, version, ciphertext, compression, plain_bytes, updated_at, updated_by
       FROM vault_documents WHERE household_id = $1`,
    [req.household.id]
  );
  const d = rows[0];
  if (!d) throw notFound("This household has no vault yet");

  // A client holding a key from an older epoch cannot open this document. Say so
  // explicitly rather than letting it fail an integrity check and look like
  // corruption -- the fix is simply to reload and pick up the new wrapped key.
  if (d.key_epoch !== req.household.keyEpoch) {
    throw conflict("The household key was rotated. Reload to pick up your new key.", {
      code: "epoch_changed", keyEpoch: req.household.keyEpoch,
    });
  }

  res.json({
    householdId: req.household.id,
    keyEpoch: d.key_epoch,
    version: Number(d.version),
    ciphertext: out(d.ciphertext),
    compression: d.compression,
    plainBytes: d.plain_bytes,
    updatedAt: d.updated_at,
    updatedBy: d.updated_by,
  });
}));

/**
 * Cheap poll target. The app checks for other devices' changes every 15 seconds;
 * asking for the version alone keeps that from shipping a megabyte each time.
 */
router.get("/:householdId/vault/version", requireAuth, loadHousehold(), wrap(async (req, res) => {
  const { rows } = await q(
    "SELECT version, key_epoch, updated_at, updated_by FROM vault_documents WHERE household_id = $1",
    [req.household.id]
  );
  if (!rows[0]) throw notFound();
  res.json({
    version: Number(rows[0].version),
    keyEpoch: rows[0].key_epoch,
    updatedAt: rows[0].updated_at,
    updatedBy: rows[0].updated_by,
  });
}));

/* ----------------------------------------------------------------- write --- */

router.put("/:householdId/vault",
  requireAuth, loadHousehold(), atLeast("dependent"), requireWritable,
  limit("vault-write", { capacity: 120, perSecond: 1, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(documentSchema, req.body);
    const ciphertext = bin(body.ciphertext);

    const result = await tx(async ({ q: query }) => {
      const { rows } = await query(
        `SELECT version, key_epoch, ciphertext, compression
           FROM vault_documents WHERE household_id = $1 FOR UPDATE`,
        [req.household.id]
      );
      const current = rows[0];
      if (!current) throw notFound("This household has no vault yet");

      // Writing under a superseded key would make the document unreadable to
      // everyone who already rotated.
      if (current.key_epoch !== req.household.keyEpoch) {
        throw conflict("The household key was rotated. Reload before saving.", { code: "epoch_changed" });
      }

      // The interesting case. Return the current document with the rejection so
      // the client can merge and retry in one round trip instead of two.
      if (Number(current.version) !== body.baseVersion) {
        throw conflict("Someone else saved first", {
          code: "version_conflict",
          current: {
            version: Number(current.version),
            ciphertext: out(current.ciphertext),
            compression: current.compression,
            keyEpoch: current.key_epoch,
          },
        });
      }

      // Quota. Measured on plaintext size, which the client reports and which
      // the server cannot verify -- so it is a courtesy limit against runaway
      // growth, not a security boundary. The real bound is the body parser.
      const { rows: planRows } = await query(
        `SELECT p.max_vault_mb FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.household_id = $1`, [req.household.id]
      );
      const maxBytes = (planRows[0]?.max_vault_mb ?? 500) * 1024 * 1024;
      if (ciphertext.length > maxBytes) {
        throw forbidden(`This household's vault limit is ${planRows[0].max_vault_mb} MB.`);
      }

      await query(
        `INSERT INTO vault_revisions (household_id, key_epoch, version, ciphertext, compression, updated_by)
         SELECT household_id, key_epoch, version, ciphertext, compression, updated_by
           FROM vault_documents WHERE household_id = $1
         ON CONFLICT (household_id, version) DO NOTHING`,
        [req.household.id]
      );

      const { rows: updated } = await query(
        `UPDATE vault_documents
            SET version = version + 1, ciphertext = $2, compression = $3,
                plain_bytes = $4, updated_by = $5, updated_at = now()
          WHERE household_id = $1
          RETURNING version`,
        [req.household.id, ciphertext, body.compression, body.plainBytes, req.user.id]
      );

      // Trim history. Keeps the "someone wiped everything" recovery path without
      // letting a chatty client grow the table without bound.
      await query(
        `DELETE FROM vault_revisions
          WHERE household_id = $1 AND version <= (
            SELECT COALESCE(MAX(version), 0) - $2 FROM vault_revisions WHERE household_id = $1
          )`,
        [req.household.id, VAULT_REVISIONS_KEPT]
      );

      return { version: Number(updated[0].version) };
    });

    res.json({ version: result.version, keyEpoch: req.household.keyEpoch });
  })
);

/* ------------------------------------------------------------- revisions --- */

router.get("/:householdId/vault/revisions",
  requireAuth, loadHousehold(), atLeast("adult"),
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT version, key_epoch, updated_by, created_at, octet_length(ciphertext) AS bytes
         FROM vault_revisions WHERE household_id = $1 ORDER BY version DESC LIMIT 100`,
      [req.household.id]
    );
    res.json(rows.map((r) => ({ ...r, version: Number(r.version) })));
  })
);

router.get("/:householdId/vault/revisions/:version",
  requireAuth, loadHousehold(), atLeast("adult"),
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT version, key_epoch, ciphertext, compression, created_at
         FROM vault_revisions WHERE household_id = $1 AND version = $2`,
      [req.household.id, req.params.version]
    );
    if (!rows[0]) throw notFound();
    if (rows[0].key_epoch !== req.household.keyEpoch) {
      throw conflict("That revision predates the current household key and can no longer be opened.");
    }
    res.json({
      version: Number(rows[0].version),
      keyEpoch: rows[0].key_epoch,
      ciphertext: out(rows[0].ciphertext),
      compression: rows[0].compression,
      createdAt: rows[0].created_at,
    });
  })
);

/**
 * Restoring an old revision is a CLIENT operation, deliberately.
 *
 * There used to be a server-side endpoint here that copied an old revision's
 * ciphertext to a new version number. It produced a document nobody could open.
 *
 * The reason is the rollback protection: `sealDocument` binds the version into
 * the AEAD's associated data, so ciphertext sealed at version 8 fails its
 * integrity check the moment it is stored as version 11. That binding is what
 * stops somebody with database access silently reverting a household to an
 * earlier state, and it is worth keeping -- so the fix is not to loosen it.
 *
 * Instead the client does what only it can:
 *
 *   1. GET /vault/revisions/:version   -- the old ciphertext
 *   2. open it, using that version in the AAD
 *   3. re-seal it at the current version + 1
 *   4. PUT it as an ordinary write
 *
 * The result is a normal forward write: nothing is destroyed, the restore is
 * itself undoable, and the version binding holds throughout. lib/session.js
 * exposes this as `restoreRevision`.
 *
 * Found by test/journeys.test.js, which restored a revision and then tried to
 * read it back -- which is the only way this surfaces, since the write itself
 * succeeds perfectly happily.
 */

export default router;
