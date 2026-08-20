-- 012_session_persistence.sql
--
-- Per-account control over staying signed in.
--
-- Three states, held in one nullable integer:
--
--   NULL   persistence is OFF for this account. "Remember me" is refused and
--          the person is told why.
--   0      no expiry. The session lasts until it is signed out or revoked.
--   N      the session lasts N hours.
--
-- Defaulted to 168 (one week), because that is the requested default -- but a
-- default alone changes nothing. A session only outlives the tab if somebody
-- ticks "remember me", so existing accounts behave exactly as they did until
-- they ask for something different.
--
-- WHY THIS SETTING IS PER USER AND NOT PER SERVER
--
-- Staying signed in means this browser keeps something that can open the
-- household. Whether that is acceptable depends entirely on the device: a
-- laptop that only you ever touch is a different proposition from a shared
-- machine, and neither the operator nor the other members of a household are
-- in a position to make that call for somebody else. So each account decides
-- for itself, and can turn it off for every device at once.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_persistence_hours INTEGER DEFAULT 168;

COMMENT ON COLUMN users.session_persistence_hours IS
  'Staying-signed-in policy: NULL = disabled, 0 = never expires, N = hours. Only takes effect when the person ticks "remember me" at sign-in.';

-- Marks the sessions that were created by an explicit "remember me", so they
-- can be listed and revoked separately from ordinary ones. Somebody turning
-- persistence off should be able to cut every remembered device loose without
-- signing themselves out of the tab they are sitting in.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS persistent BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN sessions.persistent IS
  'True when this session came from "remember me" rather than an ordinary sign-in.';
