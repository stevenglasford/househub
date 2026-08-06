-- 003_audit_log_detach_fks.sql — let accounts and households be deleted.
--
-- THE BUG. `audit_log` declared:
--
--   actor_user_id UUID REFERENCES users(id)      ON DELETE SET NULL
--   household_id  UUID REFERENCES households(id) ON DELETE SET NULL
--
-- and a trigger that rejects every UPDATE and DELETE, to make history
-- tamper-evident. Those two are in direct contradiction. Deleting a user makes
-- Postgres issue `UPDATE audit_log SET actor_user_id = NULL`, the trigger raises
-- "audit_log is append-only", and the delete fails.
--
-- So no account could ever be removed: not by the person who owns it, not to
-- satisfy a deletion request, not to clean up a test. Found by trying to delete
-- a smoke-test account against a live install.
--
-- THE FIX, and why this one rather than an exemption in the trigger. Dropping
-- the foreign keys is not a workaround, it is what an audit log should have said
-- in the first place. An audit entry records what happened at a point in time.
-- If deleting a user silently rewrites thousands of historical rows to say the
-- actor was "nobody", the log is no longer a record of events -- and a design
-- where ordinary account deletion mutates the audit trail is one where the
-- trail cannot be trusted.
--
-- After this, the columns hold the id that acted, permanently, whether or not
-- that row still exists elsewhere. Nothing is nulled and nothing is rewritten,
-- so the hash chain over the entries continues to verify.
--
-- The ids remain opaque UUIDs that reveal nothing on their own; deleting a user
-- still destroys their key material, sessions and vault access.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_user_id_fkey;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_household_id_fkey;

COMMENT ON COLUMN audit_log.actor_user_id IS
  'The user who acted. Deliberately NOT a foreign key: audit rows are immutable, '
  'so a cascading SET NULL would both fail against the append-only trigger and '
  'falsify history. May reference a user that no longer exists.';

COMMENT ON COLUMN audit_log.household_id IS
  'The household acted upon. Not a foreign key, for the same reason as '
  'actor_user_id. May reference a household that no longer exists.';
