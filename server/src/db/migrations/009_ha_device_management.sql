-- 009_ha_device_management.sql — organising a household's devices.
--
-- Home Assistant deliberately has no generic "add a device" API: pairing runs
-- through its own config flow, which is where it belongs. What HouseHub can
-- meaningfully own is everything after that -- which entities appear here, what
-- they are called *here*, which room they belong to, and what order they show
-- in.
--
-- That distinction matters in practice. Half the entities in a typical Home
-- Assistant are named `sensor.0x00158d0004a1b2c3_temperature` by whatever
-- integration created them, and a household is never going to rename them all
-- upstream. Renaming them here costs nothing and makes the wall display legible.
--
-- Stored per household, alongside the connection, rather than in the encrypted
-- document: the server already resolves entity ids to talk to Home Assistant on
-- the household's behalf, so keeping the labels beside them avoids a second
-- source of truth that could drift. They are not sensitive in the way household
-- content is -- "Kitchen" and "Hallway lamp" are not a family's private life --
-- but they are still sealed, because an operator has no need to read a map of
-- somebody's home either.
ALTER TABLE household_home_assistant
  ADD COLUMN devices_enc BYTEA;

COMMENT ON COLUMN household_home_assistant.devices_enc IS
  'Sealed JSON: per-entity overrides ({entityId: {name, room, order, hidden}}) '
  'and the household''s room list. Labels for a home, kept out of plain sight.';
