-- 001_core.sql — identity, households, and the encrypted vault.
--
-- DESIGN NOTE, and it governs every table below: the server is not trusted with
-- household content. Anything a family writes lives in `vault_documents` as one
-- AES-256-GCM ciphertext that only member devices can open. Postgres holds the
-- ciphertext, the wrapped keys, and the minimum relational scaffolding needed to
-- decide *who may fetch which ciphertext* -- never the plaintext, and never a key
-- that can open it.
--
-- Where the server genuinely must look something up (an email at login), the
-- column is split in two: `*_bidx` is a keyed blind index (HMAC-SHA256 under a
-- pepper held outside the database) used for equality lookups only, and `*_enc`
-- is the AEAD-sealed real value. A stolen database dump yields neither.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity ---

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Login lookup is by blind index; the address itself is sealed.
  email_bidx         BYTEA NOT NULL UNIQUE,
  email_enc          BYTEA NOT NULL,

  -- Argon2id verifier. Proves the password to the server. Deliberately NOT the
  -- material any key is derived from -- see `kdf_*` below.
  password_hash      TEXT NOT NULL,

  -- Client-side KDF parameters. The browser stretches the same password with
  -- these to obtain a key-encryption key that never leaves the device, so the
  -- server holds a verifier for one derivation and ciphertext for the other.
  kdf_algo           TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
  kdf_iterations     INTEGER NOT NULL DEFAULT 650000,
  kdf_salt           BYTEA NOT NULL,

  -- The user's 32-byte master key, wrapped by the client-derived KEK.
  -- Changing a password re-wraps this; it never re-encrypts household data.
  wrapped_master_key BYTEA NOT NULL,

  -- X25519 identity keypair. Public half is public (other members wrap the
  -- household key to it); private half is sealed under the master key.
  public_key         BYTEA NOT NULL,
  enc_private_key    BYTEA NOT NULL,

  display_name_enc   BYTEA,
  totp_secret_enc    BYTEA,
  totp_enabled       BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'active' | 'invited' | 'disabled'. An invited dependent (a child whose
  -- parent made the account) exists here before it is ever logged into.
  status             TEXT NOT NULL DEFAULT 'active',
  is_super_admin     BOOLEAN NOT NULL DEFAULT FALSE,

  failed_logins      INTEGER NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_status_ck CHECK (status IN ('active', 'invited', 'disabled')),
  CONSTRAINT users_kdf_ck    CHECK (kdf_iterations >= 100000)
);

-- Sessions store only a hash of the bearer token, so a dump cannot be replayed.
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    BYTEA NOT NULL UNIQUE,
  -- Salted hashes, not raw values: enough to spot session theft, useless as a
  -- location history if the database leaks.
  ip_hash       BYTEA,
  ua_hash       BYTEA,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx    ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx  ON sessions(expires_at) WHERE revoked_at IS NULL;

-- -------------------------------------------------------------- households ---

-- A "party" in the product sense: one or more adults who share a life, plus
-- whoever depends on them. Nothing here describes the family -- even the name
-- is sealed -- because the server has no business knowing it.
CREATE TABLE households (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_enc     BYTEA,

  -- Monotonic key generation. Bumped whenever the household key is rotated
  -- (a member or display is removed). Ciphertext records which epoch sealed
  -- them so clients know which wrapped key to unwrap.
  key_epoch    INTEGER NOT NULL DEFAULT 1,

  -- How many admins must sign off before a kiosk display goes live.
  -- 0 means "all current admins", which is the default the product describes.
  display_approval_threshold INTEGER NOT NULL DEFAULT 0,

  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT households_status_ck CHECK (status IN ('active', 'suspended', 'closed'))
);

-- Roles:
--   admin     -- full control, can add/remove members, approve displays. Any
--                number of them; the polygamous / co-parent case is just N admins.
--   adult     -- full read/write on content, no membership or display control
--   dependent -- a child account: reads and writes their own slice, no settings
--   viewer    -- read-only human (a grandparent checking the calendar)
CREATE TABLE household_members (
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',

  -- Set when a guardian created this account on someone else's behalf. The
  -- dependent can later claim it and set their own password.
  managed_by   UUID REFERENCES users(id) ON DELETE SET NULL,

  invited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at   TIMESTAMPTZ,

  PRIMARY KEY (household_id, user_id),
  CONSTRAINT hm_role_ck   CHECK (role IN ('admin', 'adult', 'dependent', 'viewer')),
  CONSTRAINT hm_status_ck CHECK (status IN ('active', 'pending', 'removed'))
);
CREATE INDEX hm_user_idx ON household_members(user_id) WHERE status = 'active';

-- The household key, wrapped once per subject that may hold it. The server
-- stores these blobs and can open none of them: each is an X25519 ECDH-ES
-- wrap addressed to a specific public key.
CREATE TABLE household_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  -- 'user' or 'display'. Displays hold keys too, which is what lets a wall
  -- tablet render without anyone logging into it.
  subject_type  TEXT NOT NULL,
  subject_id    UUID NOT NULL,

  key_epoch     INTEGER NOT NULL,
  wrapped_key   BYTEA NOT NULL,
  -- Ephemeral X25519 public key from the ECDH-ES wrap.
  wrap_epk      BYTEA NOT NULL,
  wrapped_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (household_id, subject_type, subject_id, key_epoch),
  CONSTRAINT hk_subject_ck CHECK (subject_type IN ('user', 'display'))
);
CREATE INDEX hk_lookup_idx ON household_keys(subject_type, subject_id);

-- ------------------------------------------------------------------ vault ---

-- The household document: one sealed blob, versioned for optimistic
-- concurrency. `version` increments on every accepted write; a client that
-- submits a stale version is rejected and re-merges rather than clobbering.
CREATE TABLE vault_documents (
  household_id UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  key_epoch    INTEGER NOT NULL,
  version      BIGINT NOT NULL DEFAULT 1,
  -- The AES-GCM nonce is the first 12 bytes of `ciphertext`; the blob is
  -- self-contained so it can be moved or exported without losing its header.
  ciphertext   BYTEA NOT NULL,
  -- 'gzip' or 'none'. Part of the AAD, so it cannot be altered to make a client
  -- mis-parse a document that still authenticates.
  compression  TEXT NOT NULL DEFAULT 'none',
  -- Plaintext byte length, kept for quota accounting. Reveals size, nothing else.
  plain_bytes  INTEGER NOT NULL DEFAULT 0,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bounded history so a bad client write (or a ransomware-style wipe) is
-- recoverable without the operator ever being able to read any of it.
CREATE TABLE vault_revisions (
  id           BIGSERIAL PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key_epoch    INTEGER NOT NULL,
  version      BIGINT NOT NULL,
  ciphertext   BYTEA NOT NULL,
  compression  TEXT NOT NULL DEFAULT 'none',
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, version)
);
CREATE INDEX vault_rev_hh_idx ON vault_revisions(household_id, version DESC);

-- Calendar feeds are the one exception to "the server holds no plaintext", and
-- only because browsers cannot fetch them directly (CORS). The subscription URL
-- is a secret, so it is sealed under a server key; the fetched .ics body is
-- sealed the same way. Neither is readable from a bare database dump.
CREATE TABLE calendar_feeds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  url_enc       BYTEA NOT NULL,
  ics_enc       BYTEA,
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cal_hh_idx ON calendar_feeds(household_id);

-- ---------------------------------------------------------------- invites ---

-- Claiming: an admin invites someone, or creates an account *for* them. Either
-- way the household key can only be wrapped to the newcomer once their public
-- key exists, so acceptance is a two-step handshake the server merely relays.
CREATE TABLE invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash    BYTEA NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  -- Optional: pins the invite to one address so a leaked link is still useless.
  email_bidx    BYTEA,
  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set once the invitee registers a public key; an admin then wraps the
  -- household key to it and the membership goes active.
  claimed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invites_role_ck CHECK (role IN ('admin', 'adult', 'dependent', 'viewer'))
);
CREATE INDEX invites_hh_idx ON invites(household_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------- displays ---

-- A permanent wall display: the iPad by the door. It holds its own keypair,
-- gets the household key wrapped to it, and renders only the scopes the admins
-- granted. It cannot write, and it never sees a user password.
CREATE TABLE displays (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,

  -- Generated on the provisioning device. The private half is delivered through
  -- the URL fragment of the setup link and is never transmitted to the server.
  public_key    BYTEA,

  -- Which panels this screen may render: ['today','calendar','meals',...].
  -- Enforced server-side on every fetch as well as in the display UI.
  scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 'pending'  -- created, awaiting admin sign-off
  -- 'active'   -- approved, key wrapped, link live
  -- 'expired' | 'revoked'
  status        TEXT NOT NULL DEFAULT 'pending',

  expires_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activated_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT displays_status_ck CHECK (status IN ('pending', 'active', 'expired', 'revoked'))
);
CREATE INDEX displays_hh_idx ON displays(household_id);

-- The permanent link. Only the hash is stored, so the operator cannot mint or
-- replay a display URL from database access alone.
CREATE TABLE display_tokens (
  display_id  UUID PRIMARY KEY REFERENCES displays(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every admin's sign-off, recorded individually. A display cannot be activated
-- until the household's threshold is met -- and because activation requires an
-- admin device to perform the key wrap, this is enforced by cryptography and
-- not merely by an `if` statement in the API.
CREATE TABLE display_approvals (
  display_id  UUID NOT NULL REFERENCES displays(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL DEFAULT 'approve',
  -- Ed25519 signature over the display's identity by the approving admin,
  -- so an approval cannot be forged by the server.
  signature   BYTEA,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (display_id, user_id),
  CONSTRAINT da_decision_ck CHECK (decision IN ('approve', 'deny'))
);

-- ---------------------------------------------------------------- audit ----
--
-- Append-only and hash-chained: each row commits to the previous row's hash, so
-- deleting or editing history breaks the chain verifiably. Records *that* an
-- action happened, never its content.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  household_id  UUID REFERENCES households(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     BYTEA,
  entry_hash    BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_hh_idx    ON audit_log(household_id, id DESC);
CREATE INDEX audit_actor_idx ON audit_log(actor_user_id, id DESC);

-- Blocks UPDATE and DELETE outright. The application role has no way to rewrite
-- history even if it is fully compromised.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- (The `schema_migrations` ledger is created by the runner in db/migrate.js
-- before any migration executes -- it cannot be defined by the migration it
-- would need to record.)
