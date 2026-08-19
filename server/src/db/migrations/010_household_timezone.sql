-- 010_household_timezone.sql
--
-- Which zone a household's calendar days are measured in.
--
-- The server expands subscribed .ics feeds into per-day events, and that
-- expansion has to decide which calendar day a timed event belongs to. Doing
-- that in the server's own zone is wrong the moment the server is not in the
-- same zone as the people reading the wall display -- and a hosted server is
-- usually UTC, which pushes every evening event onto the following day. A 7:30pm
-- dinner shows up on tomorrow's tile, nobody files a bug, they just stop
-- believing the calendar.
--
-- This is per household rather than a process-wide setting because the whole
-- point of the rewrite is that one server carries many unrelated households,
-- and they are not all in one place. A couple in Chicago and a family in Lisbon
-- share this table.
--
-- Stored in the clear, unlike almost everything else here. A zone name is
-- coarse location data, which is not nothing -- but it has to be readable by
-- the feed expander, which runs server-side precisely because browsers cannot
-- fetch a Google or iCloud feed themselves (see services/calendars.js, the
-- documented exception to "the server holds no plaintext"). A household that
-- does not want even that can leave it NULL and get the server default; the
-- cost is only that timed events may land on the wrong day.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN households.timezone IS
  'IANA zone name used to place calendar events on days. NULL means fall back to the server default (HOUSEHOLD_TZ, then TZ, then the host zone).';
