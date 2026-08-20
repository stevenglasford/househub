-- 013_caldav_sync.sql
--
-- Two-way calendar sync. Inbound already worked: a subscription URL is fetched
-- and the .ics expanded into days. This adds the outbound half -- writing the
-- household's own events back to a real calendar -- which needs two things the
-- subscription model never did.
--
-- FIRST, A CREDENTIAL.
--
-- A subscription URL is a bearer secret but a narrow one: it grants read access
-- to one calendar. Writing needs an account login, and that is a different kind
-- of thing to be holding.
--
-- It is stored sealed under the server key, like the subscription URLs and the
-- TOTP secrets, and it must be an APP-SPECIFIC PASSWORD -- Apple issues these
-- per application, they cannot be used to sign in to an Apple ID, and they are
-- revocable one at a time from the account page without disturbing anything
-- else. The UI says so and refuses to be helpful about anything else.
--
-- This is a real widening of what a server compromise costs, and it is worth
-- being blunt about it: someone who takes both the database and SECRET_KEY can
-- read and write that calendar. They still cannot read the household document,
-- which is encrypted under keys the server has never held. The trade is opt-in,
-- per household, and unwinds completely by deleting the row.
--
-- SECOND, SOMEWHERE TO PUT THE SYNC STATE.
--
-- Each event written out is remembered by UID and ETag. The ETag is what makes
-- the writes conditional, so a change made on somebody's phone is detected as a
-- lost race rather than silently overwritten -- and the UID list is how the
-- sync knows which remote events are its own, which is the only reason it can
-- ever safely delete one.

CREATE TABLE IF NOT EXISTS caldav_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Display only; the real secrets are the sealed columns.
  server_url    text NOT NULL,
  username_enc  bytea NOT NULL,
  password_enc  bytea NOT NULL,
  last_ok_at    timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- One account per server per household. Two would race each other.
  UNIQUE (household_id, server_url)
);

CREATE INDEX IF NOT EXISTS caldav_accounts_household
  ON caldav_accounts (household_id);

-- A calendar that can be written to, discovered under an account.
CREATE TABLE IF NOT EXISTS caldav_calendars (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  href          text NOT NULL,
  -- The calendar's own name, as the provider reports it. Not household content:
  -- it came from outside and is what the picker has to show before anyone has
  -- had a chance to rename it.
  name          text NOT NULL DEFAULT 'Calendar',
  color         text,
  writable      boolean NOT NULL DEFAULT false,
  -- Turned on per calendar. Discovering a calendar must not mean writing to it.
  push_enabled  boolean NOT NULL DEFAULT false,
  ctag          text,
  last_push_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, href)
);

CREATE INDEX IF NOT EXISTS caldav_calendars_household
  ON caldav_calendars (household_id);

-- One row per event this server has written out, and nothing else. The sync
-- will only ever modify or delete a remote event whose UID appears here.
CREATE TABLE IF NOT EXISTS caldav_pushed (
  calendar_id   uuid NOT NULL REFERENCES caldav_calendars(id) ON DELETE CASCADE,
  uid           text NOT NULL,
  etag          text,
  -- What we last wrote, so an unchanged event is not rewritten on every pass.
  signature     text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (calendar_id, uid)
);
