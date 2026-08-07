-- 008_ai_providers_and_cameras.sql
--
-- Two new capabilities, and one of them reverses a decision made earlier in this
-- codebase, so it is worth saying why in the schema rather than only in a commit
-- message.

-- ------------------------------------------------------- AI providers -----
--
-- Until now inference was local, always: services/ollama.js refused a non-local
-- host, and there was no provider abstraction, deliberately -- an interface with
-- an `OpenAIProvider` slot next to the Ollama one is an invitation for household
-- context to start leaving the machine.
--
-- The owner of this project has asked for the choice, which is theirs to make.
-- What is NOT acceptable is that choice being made silently, or being made *for*
-- a household by whoever runs the server. So it is split in two:
--
--   the operator decides which providers may be offered at all (this table)
--   each household decides whether to use one (household_ai_settings)
--
-- A household on a shared server therefore cannot have its check-in questions
-- routed to OpenAI by an operator ticking a box. It has to choose, and the
-- consent is recorded with a timestamp.
--
-- Local Ollama remains the default and is the only provider where the promise
-- "nothing leaves this machine" still holds.
CREATE TABLE ai_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Shown to households when they choose.
  label         TEXT NOT NULL,

  -- 'ollama'          local or LAN Ollama; context stays on your network
  -- 'openai'          OpenAI, or anything speaking its chat-completions API
  -- 'anthropic'       Claude
  kind          TEXT NOT NULL,

  base_url_enc  BYTEA,
  -- Sealed under the server key. Never returned to a browser, ever.
  api_key_enc   BYTEA,
  default_model TEXT,

  -- Derived from `kind` and the URL at save time, not supplied by the client.
  -- Everything downstream keys its warnings off this one boolean.
  is_local      BOOLEAN NOT NULL DEFAULT FALSE,

  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_kind_ck CHECK (kind IN ('ollama', 'openai', 'anthropic'))
);

COMMENT ON TABLE ai_providers IS
  'Providers the operator permits. Offering one does not route any household to '
  'it -- each household chooses, and a non-local choice needs recorded consent.';

CREATE TABLE household_ai_settings (
  household_id  UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  provider_id   UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  model         TEXT,

  -- Required before anything is sent to a provider that is not local, and
  -- cleared automatically whenever the household switches provider.
  offsite_consent_at  TIMESTAMPTZ,
  offsite_consent_by  UUID REFERENCES users(id) ON DELETE SET NULL,

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN household_ai_settings.offsite_consent_at IS
  'When this household agreed that context may leave the server. Null means no '
  'non-local provider may be used, whatever is selected.';

-- Seed the local provider so a fresh install works with no configuration and
-- keeps the original guarantee by default.
INSERT INTO ai_providers (label, kind, default_model, is_local, enabled)
VALUES ('Local Ollama (on this server)', 'ollama', NULL, TRUE, TRUE);

-- ----------------------------------------------------------- cameras -----
--
-- CamWatch is a separate system -- Python, YOLO, face recognition, its own
-- storage -- that a household already runs on its own hardware. HouseHub does
-- not absorb it; it plugs into it, the same way it plugs into Home Assistant.
--
-- Footage is never stored here. Streams and snapshots are proxied so that a
-- wall display can show a camera without holding CamWatch's password, and so
-- that access dies the moment a display is revoked.
CREATE TABLE household_cameras (
  household_id   UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,

  url_enc        BYTEA NOT NULL,
  -- CamWatch authenticates with a single shared password. Sealed, AAD-bound to
  -- the household, and never sent to a browser.
  password_enc   BYTEA NOT NULL,

  -- Which cameras this household has chosen to surface in HouseHub. Empty means
  -- all of them.
  cameras        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Face recognition and recordings are the most sensitive things CamWatch
  -- holds, so surfacing them here is opt-in separately from live view.
  show_alerts    BOOLEAN NOT NULL DEFAULT TRUE,
  show_faces     BOOLEAN NOT NULL DEFAULT FALSE,
  show_recordings BOOLEAN NOT NULL DEFAULT FALSE,

  last_ok_at     TIMESTAMPTZ,
  last_error     TEXT,
  configured_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE household_cameras IS
  'Connection to a household''s own CamWatch instance. No footage, faces or '
  'recordings are stored here -- everything is proxied on demand.';
