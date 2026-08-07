-- 007_household_home_assistant.sql — Home Assistant, per household.
--
-- THE BUG THIS FIXES. Home Assistant was configured with two server-wide
-- environment variables, HA_URL and HA_TOKEN. On a single-family install that is
-- fine. On a server hosting more than one household it is badly wrong: every
-- household on the box would see the *same* house. One family's cameras, lights
-- and door sensors, shown to all of them.
--
-- Nobody had hit it because nobody had connected Home Assistant on a shared
-- server yet, which is exactly the kind of bug that waits.
--
-- Configuration therefore moves here, one row per household.
--
-- WHY THIS IS NOT END-TO-END ENCRYPTED, unlike everything else. The server has
-- to make the calls: browsers cannot reach a private-network Home Assistant, and
-- HA's camera endpoints reject long-lived tokens as query parameters, so images
-- must be proxied. The token is therefore sealed under the server key -- the
-- same treatment as calendar subscription URLs -- rather than under the
-- household key. A stolen database yields nothing; a fully compromised *host*
-- yields the token, and docs/THREAT-MODEL.md says so.
--
-- That token is a full-access credential for someone's home. It is the most
-- dangerous thing this server is ever asked to hold, which is why the setup
-- documentation pushes people towards a scoped HA user rather than an owner
-- account.

CREATE TABLE household_home_assistant (
  household_id   UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,

  -- Base URL, e.g. http://192.168.1.50:8123. Sealed: knowing which households
  -- run Home Assistant, and on what address, is itself worth not leaking.
  url_enc        BYTEA NOT NULL,
  -- Long-lived access token. Sealed under the server key, AAD-bound to the
  -- household id so a row copied between households fails to open.
  token_enc      BYTEA NOT NULL,

  -- Optional deep link to Home Assistant's own dashboard, for the "full
  -- controls" button. Not a secret, but no reason to store it in the clear
  -- either when the URL beside it is sealed.
  dashboard_enc  BYTEA,

  -- Entities chosen for the household's Home tab, in display order.
  entities       JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Whether members may switch things, and which kinds. Locks are always
  -- member-only and are enforced in routes/home.js against the caller, never
  -- from a stored list.
  control_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  last_ok_at     TIMESTAMPTZ,
  last_error     TEXT,
  configured_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE household_home_assistant IS
  'Per-household Home Assistant connection. Replaces the server-wide HA_URL and '
  'HA_TOKEN environment variables, which showed every household on a shared '
  'server the same house.';
