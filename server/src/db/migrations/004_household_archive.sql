-- 004_household_archive.sql — retiring a household without destroying it.
--
-- People's living arrangements end. A breakup, a house move, a shared flat that
-- disbands: the household stops being current, but the calendar, the photos of
-- what needed fixing, and the record of who did what may still matter -- or may
-- need to be gone entirely, immediately, for exactly the same reasons.
--
-- So there are two separate actions, and they are deliberately not the same:
--
--   archive  hidden from the everyday list, still readable, reversible
--   delete   destroyed, unrecoverable (routes/households.js)
--
-- 'archived' is added per-member rather than per-household, because the members
-- of a household that ended will not agree about it and should not have to. One
-- person archiving their view of a shared home must not hide it from anyone
-- else, and must not look to them like data loss.

ALTER TABLE household_members
  ADD COLUMN archived_at TIMESTAMPTZ;

COMMENT ON COLUMN household_members.archived_at IS
  'Set when this member has archived the household out of their own list. '
  'Per-member on purpose: after a breakup the two people involved will not '
  'agree, and neither should be able to hide the household from the other.';

-- Fetching a member''s households is the first query after every login.
CREATE INDEX hm_active_user_idx
  ON household_members(user_id, archived_at)
  WHERE status = 'active';
