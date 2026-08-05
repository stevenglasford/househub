-- 002_billing_and_upgrades.sql — operator-side concerns: charging for hosting,
-- and the self-upgrade pipeline.
--
-- Neither of these may weaken the guarantee in 001. Billing therefore stores
-- addresses and amounts but nothing about *what* a household does; and the
-- upgrade pipeline touches source code only, never the vault.

-- ---------------------------------------------------------------- billing ---

-- Receive-only wallet configuration. The server holds extended PUBLIC keys and
-- Monero VIEW keys -- enough to derive fresh addresses and to notice incoming
-- payments, and categorically not enough to spend. Spending keys stay on the
-- operator's own hardware, which is the only sane arrangement for a server that
-- is on the internet.
CREATE TABLE wallet_config (
  asset          TEXT PRIMARY KEY,

  -- BTC/ETH: an xpub/zpub. XMR: the primary address.
  xpub_enc       BYTEA,
  -- XMR only: the private *view* key, sealed. Detects payments, cannot spend.
  view_key_enc   BYTEA,

  derivation_path TEXT NOT NULL DEFAULT 'm/0',
  next_index      INTEGER NOT NULL DEFAULT 0,

  -- Where to watch the chain from. An operator's own node is strongly preferred;
  -- a third-party explorer learns which addresses belong to this server.
  node_url_enc    BYTEA,
  node_auth_enc   BYTEA,

  confirmations   INTEGER NOT NULL DEFAULT 2,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_asset_ck CHECK (asset IN ('BTC', 'ETH', 'XMR'))
);

CREATE TABLE plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- Priced in fiat minor units and converted at invoice time, because crypto
  -- denominated prices go stale within the hour.
  price_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  interval      TEXT NOT NULL DEFAULT 'month',
  -- Soft caps enforced by the API. Vault size is measurable without decryption.
  max_members   INTEGER NOT NULL DEFAULT 8,
  max_displays  INTEGER NOT NULL DEFAULT 3,
  max_vault_mb  INTEGER NOT NULL DEFAULT 50,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT plans_interval_ck CHECK (interval IN ('month', 'year', 'once'))
);

CREATE TABLE subscriptions (
  household_id   UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL REFERENCES plans(id),
  status         TEXT NOT NULL DEFAULT 'trialing',
  current_period_end TIMESTAMPTZ,
  -- Days of continued service after expiry before the vault goes read-only.
  -- Data is never deleted for nonpayment; it is frozen and remains exportable.
  grace_days     INTEGER NOT NULL DEFAULT 14,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT subs_status_ck CHECK (status IN ('trialing','active','past_due','frozen','canceled'))
);

CREATE TABLE invoices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  plan_id        UUID REFERENCES plans(id),
  asset          TEXT NOT NULL,

  -- A fresh address per invoice, derived from the xpub. Reusing one address
  -- would let anybody with the link correlate every household that ever paid.
  address        TEXT NOT NULL,
  address_index  INTEGER,

  amount_atomic  NUMERIC(40,0) NOT NULL,
  price_cents    INTEGER NOT NULL,
  rate_used      NUMERIC(30,10),

  status         TEXT NOT NULL DEFAULT 'pending',
  confirmations  INTEGER NOT NULL DEFAULT 0,
  paid_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT inv_asset_ck  CHECK (asset IN ('BTC','ETH','XMR')),
  CONSTRAINT inv_status_ck CHECK (status IN ('pending','detected','paid','underpaid','expired','canceled'))
);
CREATE INDEX inv_hh_idx     ON invoices(household_id, created_at DESC);
CREATE INDEX inv_watch_idx  ON invoices(asset, address) WHERE status IN ('pending','detected');

CREATE TABLE payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  txid           TEXT NOT NULL,
  amount_atomic  NUMERIC(40,0) NOT NULL,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, txid)
);

-- --------------------------------------------------------------- upgrades ---

-- The super-admin drops in a zip; Claude Code turns it into a reviewed pull
-- request. The job row is the whole audit trail of that: what went in, what
-- came out, who approved it, where it landed.
CREATE TABLE upgrade_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title          TEXT NOT NULL,
  instructions   TEXT,

  bundle_path    TEXT,
  bundle_sha256  TEXT,
  bundle_bytes   BIGINT,

  -- queued -> scanning -> planning -> applying -> verifying
  --        -> awaiting_review -> approved -> pushed | failed | rejected
  status         TEXT NOT NULL DEFAULT 'queued',
  phase_detail   TEXT,

  branch_name    TEXT,
  base_commit    TEXT,
  head_commit    TEXT,
  pr_url         TEXT,

  diff_stat      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Result of the additive-only guard: what it allowed, what it flagged.
  guard_report   JSONB NOT NULL DEFAULT '{}'::jsonb,
  test_report    JSONB NOT NULL DEFAULT '{}'::jsonb,
  log            TEXT NOT NULL DEFAULT '',

  reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uj_status_ck CHECK (status IN (
    'queued','scanning','planning','applying','verifying',
    'awaiting_review','approved','pushed','failed','rejected','canceled'))
);
CREATE INDEX uj_status_idx ON upgrade_jobs(status, created_at DESC);

-- ------------------------------------------------------------ rate limits ---

-- Persisted so that limits survive a restart and hold across a multi-process
-- deployment. An attacker cannot reset their own budget by causing a crash.
CREATE TABLE rate_limits (
  bucket      TEXT PRIMARY KEY,
  tokens      REAL NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the plan a self-hoster runs on: everything, free, no expiry. An install
-- that is never sold to anyone should behave as if billing did not exist.
INSERT INTO plans (code, name, price_cents, interval, max_members, max_displays, max_vault_mb)
VALUES ('selfhost', 'Self-hosted', 0, 'month', 100, 25, 500);
