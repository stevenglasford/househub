// auth.js — registration, sign-in, sessions, password changes, 2FA.
//
// The server never receives a password. The browser stretches it with PBKDF2
// and sends only the second half of that output (`authProof`); the server keeps
// an Argon2id verifier of *that*. So a fully compromised server, logging every
// request body it sees, still cannot derive the key-encryption key and still
// cannot open a single household. See web/src/lib/crypto.js.
//
// The other theme running through this file is account non-enumeration. For an
// app whose users may be a queer couple in a hostile jurisdiction, "does
// steven@example.com have an account on this server" is itself sensitive. Every
// path below returns the same shape and takes the same time whether or not the
// account exists.

import express from "express";
import { z } from "zod";
import { createHmac, randomBytes } from "node:crypto";

import { q, tx } from "../db/pool.js";
import { wrap, badRequest, unauthorized, conflict, notFound } from "../middleware/errors.js";
import { limit, consume, accountBucket, clientKey } from "../middleware/ratelimit.js";
import { requireAuth, resolveSession, SESSION_COOKIE } from "../middleware/auth.js";
import { seal, openText, blindIndex, subkey } from "../crypto/seal.js";
import { hashPassword, verifyPassword, dummyVerify, needsRehash } from "../crypto/password.js";
import { newToken, hashToken } from "../crypto/tokens.js";
import * as totp from "../crypto/totp.js";
import { audit } from "../services/audit.js";
import {
  IS_PROD, PUBLIC_URL, COOKIE_PATH, SESSION_TTL_HOURS, ALLOW_SIGNUP,
  MAX_FAILED_LOGINS, LOCKOUT_MINUTES, CLIENT_KDF_ITERATIONS,
} from "../config.js";

export const router = express.Router();

/* ------------------------------------------------------------ validation --- */

const b64 = (max) => z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "expected base64").max(max);

const emailSchema = z.string().trim().toLowerCase()
  .min(3).max(254)
  .regex(/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/, "That does not look like an email address");

const identitySchema = z.object({
  kdfAlgo: z.literal("PBKDF2-SHA256"),
  kdfIterations: z.number().int().min(100000).max(10_000_000),
  kdfSalt: b64(64),
  wrappedMasterKey: b64(512),
  publicKey: b64(64),
  encPrivateKey: b64(512),
  authProof: b64(128),
});

const registerSchema = identitySchema.extend({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
  inviteToken: z.string().max(256).optional(),
  // Required, and required to be true. The consequence of a forgotten password
  // here is total and permanent, so "I was never told" should not be a thing
  // anybody can honestly say. Recorded with a timestamp.
  acknowledgedNoRecovery: z.literal(true, {
    errorMap: () => ({ message: "You must confirm you understand that a forgotten password cannot be recovered." }),
  }),
});

const loginSchema = z.object({
  email: emailSchema,
  authProof: b64(128),
  totp: z.string().max(16).optional(),
  // A request to stay signed in, which the account's own policy may refuse.
  remember: z.boolean().optional(),
});

/* ----------------------------------------------------------------- utils --- */

const parse = (schema, body) => {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first.message, { field: first.path.join(".") });
  }
  return r.data;
};

const bin = (b64str) => Buffer.from(b64str, "base64");

/* A "never expires" policy still needs a number for the cookie, because
   browsers have no such value. Ten years is indistinguishable from forever for
   a household app and keeps the session row and the cookie in agreement. */
const FOREVER_HOURS = 24 * 365 * 10;

function setSessionCookie(res, token, hours = SESSION_TTL_HOURS) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,                                  // unreachable from injected JS
    secure: IS_PROD || PUBLIC_URL.startsWith("https://"),
    sameSite: "strict",                              // primary CSRF defence
    maxAge: hours * 3600_000,
    // Scoped to the mount point, so a hub at /beta does not hand its session
    // cookie to everything else on the same hostname.
    path: COOKIE_PATH,
  });
}

/**
 * How long a session should last, given what the person asked for and what
 * their account allows.
 *
 * Returns { hours, persistent, refused }. `refused` is the case the UI has to
 * explain: they ticked "remember me" and their own settings forbid it, so they
 * get an ordinary session and a message rather than silence.
 */
export function resolveSessionLifetime(policyHours, remember) {
  if (!remember) return { hours: SESSION_TTL_HOURS, persistent: false, refused: false };
  if (policyHours === null || policyHours === undefined) {
    return { hours: SESSION_TTL_HOURS, persistent: false, refused: true };
  }
  const hours = policyHours === 0 ? FOREVER_HOURS : policyHours;
  return { hours, persistent: true, refused: false };
}

async function createSession(userId, req, lifetime = null) {
  const { hours, persistent } = lifetime || { hours: SESSION_TTL_HOURS, persistent: false };
  const token = newToken();
  const ipHash = createHmac("sha256", subkey("session/ip")).update(req.ip || "").digest();
  const uaHash = createHmac("sha256", subkey("session/ua")).update(req.get("user-agent") || "").digest();
  await q(
    `INSERT INTO sessions (user_id, token_hash, ip_hash, ua_hash, expires_at, persistent)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, $6)`,
    [userId, hashToken(token), ipHash, uaHash, String(hours), persistent]
  );
  return token;
}

/** The blobs a client needs to reconstruct its keys. Safe to hand out post-auth. */
const identityPayload = (u) => ({
  kdfAlgo: u.kdf_algo,
  kdfIterations: u.kdf_iterations,
  kdfSalt: Buffer.from(u.kdf_salt).toString("base64"),
  wrappedMasterKey: Buffer.from(u.wrapped_master_key).toString("base64"),
  publicKey: Buffer.from(u.public_key).toString("base64"),
  encPrivateKey: Buffer.from(u.enc_private_key).toString("base64"),
});

/* --------------------------------------------------------- KDF parameters ---
 *
 * The client needs the salt and iteration count before it can compute an auth
 * proof, which means this endpoint answers for addresses that may not exist.
 *
 * For an unknown address we return a *deterministic decoy*: a salt derived by
 * HMAC from the address under a server key. It is stable across requests (so
 * probing twice cannot distinguish it from a real one by watching for changes),
 * indistinguishable from random, and unrelated to any real salt. The subsequent
 * login attempt then fails on the proof, exactly as a wrong password would.
 */
router.post("/kdf-params",
  limit("kdf-params", { capacity: 30, perSecond: 0.5 }),
  wrap(async (req, res) => {
    const { email } = parse(z.object({ email: emailSchema }), req.body);
    const bidx = blindIndex("email", email);

    const { rows } = await q(
      "SELECT kdf_algo, kdf_iterations, kdf_salt FROM users WHERE email_bidx = $1", [bidx]
    );

    if (rows[0]) {
      return res.json({
        kdfAlgo: rows[0].kdf_algo,
        kdfIterations: rows[0].kdf_iterations,
        kdfSalt: Buffer.from(rows[0].kdf_salt).toString("base64"),
      });
    }

    const decoy = createHmac("sha256", subkey("kdf/decoy")).update(email).digest().subarray(0, 16);
    res.json({
      kdfAlgo: "PBKDF2-SHA256",
      kdfIterations: CLIENT_KDF_ITERATIONS,
      kdfSalt: decoy.toString("base64"),
    });
  })
);

/* -------------------------------------------------------------- register --- */

router.post("/register",
  limit("register", { capacity: 5, perSecond: 0.05 }),
  wrap(async (req, res) => {
    const body = parse(registerSchema, req.body);

    // A closed instance still accepts registrations that carry a valid invite,
    // so a family can be added to a private server without opening it up.
    //
    // The token is verified here rather than merely being present: otherwise
    // "closed registration" would be defeated by sending any string at all.
    if (!ALLOW_SIGNUP) {
      const valid = body.inviteToken && (await q(
        `SELECT 1 FROM invites
          WHERE token_hash = $1 AND revoked_at IS NULL
            AND claimed_by IS NULL AND expires_at > now()`,
        [hashToken(body.inviteToken)]
      )).rowCount > 0;

      if (!valid) {
        throw badRequest(
          "This server is not accepting new accounts. If you were invited, open the " +
          "invitation link you were sent rather than signing up directly."
        );
      }
    }

    // X25519 public keys are exactly 32 bytes. Anything else is a client bug or
    // an attempt to store something that is not a key.
    if (bin(body.publicKey).length !== 32) throw badRequest("publicKey must be 32 bytes");

    const bidx = blindIndex("email", body.email);

    const userId = await tx(async ({ q: query }) => {
      const existing = await query("SELECT id, status FROM users WHERE email_bidx = $1", [bidx]);
      if (existing.rows[0]) {
        // Deliberately the same 409 an unauthenticated caller would get for any
        // duplicate. We cannot avoid revealing existence here -- registration
        // must fail -- but we say nothing about status, name, or households.
        throw conflict("An account with that address already exists");
      }

      const { rows } = await query(
        `INSERT INTO users (
           email_bidx, email_enc, password_hash,
           kdf_algo, kdf_iterations, kdf_salt,
           wrapped_master_key, public_key, enc_private_key, display_name_enc,
           no_recovery_ack_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         RETURNING id`,
        [
          bidx, seal("email", body.email), hashPassword(body.authProof),
          body.kdfAlgo, body.kdfIterations, bin(body.kdfSalt),
          bin(body.wrappedMasterKey), bin(body.publicKey), bin(body.encPrivateKey),
          body.displayName ? seal("displayName", body.displayName) : null,
        ]
      );
      return rows[0].id;
    });

    const token = await createSession(userId, req);
    setSessionCookie(res, token);
    await audit("user_registered", { actorUserId: userId });

    res.status(201).json({ userId, token, user: { id: userId, isSuperAdmin: false } });
  })
);

/* ----------------------------------------------------------------- login --- */

router.post("/login", wrap(async (req, res) => {
  const body = parse(loginSchema, req.body);
  const bidx = blindIndex("email", body.email);

  // Two independent budgets. The per-IP one stops a single host hammering the
  // endpoint; the per-account one stops a distributed attempt against one
  // person, which rotating proxies would otherwise walk straight through.
  await consume(`login-ip:${clientKey(req)}`, { capacity: 20, perSecond: 0.2 });
  await consume(accountBucket(bidx), { capacity: 10, perSecond: 0.05 });

  const { rows } = await q(
    `SELECT id, password_hash, kdf_algo, kdf_iterations, kdf_salt,
            session_persistence_hours,
            wrapped_master_key, public_key, enc_private_key,
            totp_enabled, totp_secret_enc, status, failed_logins, locked_until, is_super_admin
       FROM users WHERE email_bidx = $1`,
    [bidx]
  );
  const user = rows[0];

  // Same message, same status, same approximate timing for every failure below.
  const reject = () => unauthorized("Incorrect email or password");

  if (!user) {
    dummyVerify();                 // spend the same ~100ms an Argon2id check costs
    throw reject();
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    dummyVerify();
    throw unauthorized("Too many failed attempts. Try again shortly.");
  }
  if (user.status === "disabled") { dummyVerify(); throw reject(); }

  if (!verifyPassword(body.authProof, user.password_hash)) {
    const failed = user.failed_logins + 1;
    // Every placeholder is cast explicitly. Without the casts Postgres cannot
    // settle on a type for $2 -- it is assigned to an integer column and also
    // compared against an untyped parameter -- and raises 42P08. That threw on
    // every failed login, which meant lockout never engaged and the resulting
    // 500 told an attacker which addresses have accounts. Found by
    // security/pentest/run.js.
    await q(
      `UPDATE users SET failed_logins = $2::int,
              locked_until = CASE WHEN $2::int >= $3::int
                                  THEN now() + ($4::text || ' minutes')::interval
                                  ELSE locked_until END
         WHERE id = $1`,
      [user.id, failed, MAX_FAILED_LOGINS, String(LOCKOUT_MINUTES)]
    );
    await audit("login_failed", { actorUserId: user.id, meta: { attempt: failed } });
    throw reject();
  }

  if (user.totp_enabled) {
    if (!body.totp) {
      // Only reachable once the proof has already been verified, so this
      // reveals nothing to someone who does not hold the password.
      return res.status(401).json({ error: "Two-factor code required", code: "totp_required" });
    }
    const secret = openText("totp", user.totp_secret_enc, user.id);
    if (totp.verify(secret, body.totp) === null) {
      await audit("login_totp_failed", { actorUserId: user.id });
      throw reject();
    }
  }

  // Raise the stored cost if the server's parameters were increased since this
  // account was created. Free upgrade, invisible to the user.
  const patch = needsRehash(user.password_hash) ? hashPassword(body.authProof) : user.password_hash;
  await q(
    "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now(), password_hash = $2 WHERE id = $1",
    [user.id, patch]
  );

  /* "Remember me" is a request; the account's own policy decides. A refusal
     still signs them in -- the password was right -- and says so, because a
     tick that silently does nothing is how somebody ends up mystified about
     being signed out a fortnight later. */
  const lifetime = resolveSessionLifetime(user.session_persistence_hours, body.remember === true);
  const token = await createSession(user.id, req, lifetime);
  setSessionCookie(res, token, lifetime.hours);
  await audit("login", { actorUserId: user.id, meta: { persistent: lifetime.persistent } });

  res.json({
    token,
    persistence: {
      requested: body.remember === true,
      granted: lifetime.persistent,
      refused: lifetime.refused,
      hours: lifetime.persistent ? lifetime.hours : null,
    },
    user: { id: user.id, isSuperAdmin: user.is_super_admin },
    identity: identityPayload(user),
  });
}));

/* ---------------------------------------------------------------- logout --- */

router.post("/logout", resolveSession, wrap(async (req, res) => {
  if (req.session) {
    await q("UPDATE sessions SET revoked_at = now() WHERE id = $1", [req.session.id]);
    await audit("logout", { actorUserId: req.user.id });
  }
  res.clearCookie(SESSION_COOKIE, { path: COOKIE_PATH });
  res.json({ ok: true });
}));

/* -------------------------------------------------------------------- me --- */

router.get("/me", requireAuth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.email_enc, u.display_name_enc, u.is_super_admin, u.totp_enabled,
            u.kdf_algo, u.kdf_iterations, u.kdf_salt,
            u.wrapped_master_key, u.public_key, u.enc_private_key, u.created_at
       FROM users u WHERE u.id = $1`, [req.user.id]
  );
  const u = rows[0];
  if (!u) throw notFound();

  const memberships = await q(
    `SELECT m.household_id, m.role, h.key_epoch, h.status, h.name_enc IS NOT NULL AS has_name
       FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY m.joined_at`, [req.user.id]
  );

  res.json({
    id: u.id,
    email: openText("email", u.email_enc),
    displayName: u.display_name_enc ? openText("displayName", u.display_name_enc) : null,
    isSuperAdmin: u.is_super_admin,
    totpEnabled: u.totp_enabled,
    createdAt: u.created_at,
    identity: identityPayload(u),
    households: memberships.rows.map((m) => ({
      id: m.household_id, role: m.role, keyEpoch: m.key_epoch, status: m.status,
    })),
  });
}));

/* ------------------------------------------------------- change password ---
 *
 * The client re-derives everything and sends the new blobs. The household key
 * is untouched, so this costs one row update no matter how much history the
 * family has -- and, importantly, other members need do nothing.
 */
router.post("/password",
  requireAuth,
  limit("password-change", { capacity: 5, perSecond: 0.02, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      currentAuthProof: b64(128),
      kdfAlgo: z.literal("PBKDF2-SHA256"),
      kdfIterations: z.number().int().min(100000).max(10_000_000),
      kdfSalt: b64(64),
      wrappedMasterKey: b64(512),
      authProof: b64(128),
      revokeOtherSessions: z.boolean().default(true),
    }), req.body);

    const { rows } = await q("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    if (!verifyPassword(body.currentAuthProof, rows[0].password_hash)) {
      throw unauthorized("Current password is incorrect");
    }

    await q(
      `UPDATE users SET password_hash = $2, kdf_algo = $3, kdf_iterations = $4,
              kdf_salt = $5, wrapped_master_key = $6, updated_at = now()
         WHERE id = $1`,
      [req.user.id, hashPassword(body.authProof), body.kdfAlgo, body.kdfIterations,
       bin(body.kdfSalt), bin(body.wrappedMasterKey)]
    );

    if (body.revokeOtherSessions) {
      await q(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
        [req.user.id, req.session.id]
      );
    }
    await audit("password_changed", { actorUserId: req.user.id });
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- sessions --- */

router.get("/sessions", requireAuth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, created_at, last_seen_at, expires_at
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC`, [req.user.id]
  );
  // IP and user-agent are stored hashed and stay hashed: enough for the owner to
  // count their sessions and revoke a stranger, without this becoming a
  // location history that a subpoena could usefully demand.
  res.json(rows.map((s) => ({ ...s, current: s.id === req.session.id })));
}));

router.delete("/sessions/:id", requireAuth, wrap(async (req, res) => {
  const { rowCount } = await q(
    "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [req.params.id, req.user.id]
  );
  if (!rowCount) throw notFound();
  await audit("session_revoked", { actorUserId: req.user.id, target: req.params.id });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ TOTP --- */

router.post("/totp/start", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT email_enc, totp_enabled FROM users WHERE id = $1", [req.user.id]);
  if (rows[0].totp_enabled) throw conflict("Two-factor is already on");

  const secret = totp.newSecret();
  // Held pending until a code proves the authenticator actually has it --
  // enabling first would lock out anyone who mis-scanned the QR code.
  await q("UPDATE users SET totp_secret_enc = $2 WHERE id = $1",
    [req.user.id, seal("totp", secret, req.user.id)]);

  res.json({
    secret,
    otpauthUrl: totp.otpauthUrl(secret, { account: openText("email", rows[0].email_enc) }),
  });
}));

router.post("/totp/enable",
  requireAuth,
  limit("totp-enable", { capacity: 10, perSecond: 0.1, by: "user" }),
  wrap(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    const { rows } = await q("SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1", [req.user.id]);
    if (rows[0].totp_enabled) throw conflict("Two-factor is already on");
    if (!rows[0].totp_secret_enc) throw badRequest("Start two-factor setup first");

    const secret = openText("totp", rows[0].totp_secret_enc, req.user.id);
    if (totp.verify(secret, code) === null) throw badRequest("That code is not right. Check your phone's clock.");

    await q("UPDATE users SET totp_enabled = TRUE WHERE id = $1", [req.user.id]);
    await audit("totp_enabled", { actorUserId: req.user.id });
    res.json({ ok: true });
  })
);

router.post("/totp/disable",
  requireAuth,
  limit("totp-disable", { capacity: 10, perSecond: 0.1, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({ authProof: b64(128), code: z.string().max(10).optional() }), req.body);
    const { rows } = await q(
      "SELECT password_hash, totp_secret_enc, totp_enabled FROM users WHERE id = $1", [req.user.id]
    );
    // Both factors required to remove a factor: a stolen session alone must not
    // be enough to strip 2FA off an account.
    if (!verifyPassword(body.authProof, rows[0].password_hash)) throw unauthorized("Password is incorrect");
    if (rows[0].totp_enabled) {
      const secret = openText("totp", rows[0].totp_secret_enc, req.user.id);
      if (totp.verify(secret, body.code) === null) throw badRequest("That code is not right");
    }

    await q("UPDATE users SET totp_enabled = FALSE, totp_secret_enc = NULL WHERE id = $1", [req.user.id]);
    await audit("totp_disabled", { actorUserId: req.user.id });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------ staying signed in ------- */

/**
 * The account's own policy for staying signed in.
 *
 * Per account rather than per server: whether it is acceptable for a browser to
 * keep something that can open the household depends entirely on the device,
 * and nobody else in the household is placed to judge that.
 */
router.get("/session-policy", requireAuth, wrap(async (req, res) => {
  const { rows } = await q(
    "SELECT session_persistence_hours FROM users WHERE id = $1", [req.user.id]);
  const hours = rows[0]?.session_persistence_hours ?? null;
  const { rows: devices } = await q(
    `SELECT count(*)::int AS n FROM sessions
      WHERE user_id = $1 AND persistent AND revoked_at IS NULL AND expires_at > now()`,
    [req.user.id]
  );
  res.json({
    enabled: hours !== null,
    hours,                                   // 0 means never expires
    rememberedDevices: devices[0].n,
  });
}));

router.put("/session-policy",
  requireAuth,
  limit("session-policy", { capacity: 20, perSecond: 0.05, by: "user" }),
  wrap(async (req, res) => {
    const body = parse(z.object({
      // null disables it; 0 means never expires; otherwise hours, capped at a
      // decade so the column cannot be used to store nonsense.
      hours: z.number().int().min(0).max(24 * 365 * 10).nullable(),
    }), req.body);

    await q("UPDATE users SET session_persistence_hours = $2 WHERE id = $1",
      [req.user.id, body.hours]);

    /* Turning it off must actually cut the remembered devices loose, not just
       stop new ones being made. Somebody switching this off has usually just
       realised a device is somewhere it should not be, and "no new ones" would
       be a useless answer to that.

       Ordinary sessions are left alone, so this does not sign them out of the
       tab they are sitting in. */
    let revoked = 0;
    if (body.hours === null) {
      const { rowCount } = await q(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND persistent AND revoked_at IS NULL`,
        [req.user.id]
      );
      revoked = rowCount;
    }

    await audit("session_policy_changed", {
      actorUserId: req.user.id,
      meta: { hours: body.hours, revokedDevices: revoked },
    });
    res.json({ ok: true, enabled: body.hours !== null, hours: body.hours, revokedDevices: revoked });
  })
);

export default router;
