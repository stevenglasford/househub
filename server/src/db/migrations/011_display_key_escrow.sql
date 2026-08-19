-- 011_display_key_escrow.sql
--
-- Let any admin finish setting up a display, and let any member get its link
-- again afterwards.
--
-- A display has its own keypair. The public half is what the household key gets
-- wrapped to; the private half goes into the link's fragment so the screen can
-- unwrap it. Until now that private half lived in one place only: the React
-- state of the browser tab that proposed the display.
--
-- Two things followed, and both were reported as the feature simply not working:
--
--   * A display that every admin had approved could not be activated by any of
--     them except the person who proposed it, on that device, in that tab. A
--     refresh stranded it permanently -- "2 of 2 admins approved" and no way
--     forward.
--   * The link was shown exactly once. The other people in the household had no
--     way to obtain it, which defeats the point of a shared screen.
--
-- So the private key is escrowed here, sealed under the *household* key. The
-- server stores ciphertext and holds no key that opens it.
--
-- WHY THIS IS NOT AN ESCALATION
--
-- Opening this requires the household key. Anyone who has that can already read
-- everything in the household -- strictly more than any display link will ever
-- show. It does mean a former member who kept a copy of the household key could
-- reconstruct display links, which is one more reason the UI presses for a key
-- rotation when somebody is removed. Rotating makes this ciphertext unopenable,
-- and the display has to be recreated.

ALTER TABLE displays
  ADD COLUMN IF NOT EXISTS private_key_enc TEXT,
  ADD COLUMN IF NOT EXISTS link_enc        TEXT;

COMMENT ON COLUMN displays.private_key_enc IS
  'The display private key, sealed under the household key by a member browser. Opaque to the server. Lets any admin activate the display rather than only the tab that proposed it.';

COMMENT ON COLUMN displays.link_enc IS
  'The finished setup link, sealed under the household key. Lets any member show the link again without minting a new token -- which would knock a screen that is already running off the air.';

-- The token itself is still stored only as a hash (display_tokens). This column
-- holds a copy the *household* can open and the server cannot, which is what
-- makes "show me that link again" possible without re-issuing it.
