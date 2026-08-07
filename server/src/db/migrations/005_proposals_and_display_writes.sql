-- 005_proposals_and_display_writes.sql
--
-- Two additions, both driven by the same requirement: a shared screen in the
-- kitchen should be able to tick a chore off, and switching a completion archive
-- back off should take every admin agreeing.

-- ------------------------------------------------------------- proposals ---
--
-- A guarded change that needs more than one admin to say yes.
--
-- The first use is turning an archive off, which destroys it. That is exactly
-- the kind of action one person should not be able to take quietly on behalf of
-- a household -- particularly this one, where the archive may be the record of
-- who was actually pulling their weight.
--
-- HONEST LIMIT, and it is worth stating plainly: the archive lives inside the
-- end-to-end encrypted document, so the server cannot verify what a client
-- actually does with it. This table gates and records the *decision*; it cannot
-- stop an admin who edits their own client from clearing their local copy and
-- saving. What it does give is that the action is deliberate, visible to every
-- other admin, and permanently in the audit log. Against housemates and family
-- -- which is who this is for -- that is the useful property. It is not a
-- defence against a determined member with developer tools, and nothing
-- client-side in an end-to-end encrypted system could be.
CREATE TABLE household_proposals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,

  -- 'disable_archive' today. Kept open so other guarded changes can reuse this.
  kind          TEXT NOT NULL,
  -- What exactly is being proposed, e.g. {"collections":["chores"]}.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'open' | 'approved' | 'denied' | 'expired' | 'applied' | 'withdrawn'
  status        TEXT NOT NULL DEFAULT 'open',
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT proposals_status_ck CHECK (
    status IN ('open','approved','denied','expired','applied','withdrawn'))
);
CREATE INDEX proposals_hh_idx ON household_proposals(household_id, status, created_at DESC);

CREATE TABLE proposal_approvals (
  proposal_id UUID NOT NULL REFERENCES household_proposals(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL DEFAULT 'approve',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id),
  CONSTRAINT proposal_decision_ck CHECK (decision IN ('approve','deny'))
);

-- -------------------------------------------------------- display writes ---
--
-- Displays were strictly read-only. That is the safer default and it is wrong
-- for the actual product: the whole point of a screen in the kitchen is that
-- somebody walking past can tick the bins off without unlocking a phone.
--
-- So writing becomes an opt-in capability per display, off unless an admin turns
-- it on. What makes it acceptable rather than a hole is that a display's writes
-- are never anonymous -- every completion it records carries the display's name
-- as its source, and the archive shows it as "ticked on the kitchen iPad" rather
-- than attributing it to a person who may not have been there.
ALTER TABLE displays
  ADD COLUMN can_write BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN displays.can_write IS
  'Whether this screen may modify the household document. Off by default. '
  'Writes are attributed to the display by name, never to a person.';

-- Which Home Assistant domains this screen may operate.
--
-- Deliberately NOT a single on/off. A visitor turning the hall light on, or
-- checking whether the dogs are in the garden, is harmless and useful. A lock is
-- not: a screen mounted by the front door that can unlock the front door is a
-- keypad without a code. Locks are therefore never in this list -- the API
-- refuses them for display tokens regardless of what is stored here -- and can
-- only be operated by a signed-in member.
ALTER TABLE displays
  ADD COLUMN control_domains JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN displays.control_domains IS
  'Home Assistant domains this display may switch: light, switch, fan, cover. '
  'Locks are excluded by the API and cannot be granted here.';
