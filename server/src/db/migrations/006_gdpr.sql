-- 006_gdpr.sql — data-protection housekeeping.
--
-- Two small columns, both there so the server can answer questions it may
-- legitimately be asked: "was this person told?" and "when did they ask to be
-- erased?".

-- Evidence that the person creating an account was shown, and actively
-- confirmed, that a forgotten password is unrecoverable.
--
-- Not "consent" in the Article 6 sense -- the lawful basis for processing here
-- is performance of a contract, not consent -- but a fact worth being able to
-- demonstrate. It is the single most consequential thing about this product and
-- the one a user is most likely to later say nobody told them.
ALTER TABLE users
  ADD COLUMN no_recovery_ack_at TIMESTAMPTZ;

COMMENT ON COLUMN users.no_recovery_ack_at IS
  'When the user confirmed at signup that a forgotten password cannot be '
  'recovered by anyone. Recorded because the consequence is total and permanent.';

-- Erasure requests, kept only while one is in flight.
--
-- Deletion is immediate for anyone who is not the last admin of a shared
-- household; where it is not immediate, this records that the person asked, so
-- the one-month deadline in Article 12(3) runs from a recorded date rather than
-- from somebody's memory.
CREATE TABLE erasure_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What is stopping it from completing right now, in plain words for the user.
  blocked_on   TEXT,
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id)
);

COMMENT ON TABLE erasure_requests IS
  'In-flight right-to-erasure requests. Rows are removed with the account, so '
  'this table never becomes a list of people who once left.';
