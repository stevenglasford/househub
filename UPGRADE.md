# Upgrading

## Read this first

The version you are replacing stores everything in **SQLite** (`server/hub.db`).
The build this release is based on had been switched back to a flat JSON file
(`server/data.json`). This release puts SQLite back and carries the newer
version's features across, so your existing database is read in place.

**Consequence if you had deployed the JSON build directly:** the app would have
found no `data.json`, seeded an empty household, and shown a blank hub — with
`hub.db` still on disk, untouched but ignored. Nothing deleted, but it would
have looked like total data loss. This release avoids that.

### What changes in your data

This version reworked the **meals** model. Previously each day had one dish per
slot (`breakfast`/`lunch`/`dinner`) as plain text, with separate maps for who
cooked and what time. Now each slot is a **list of entries**, so two people can
have different meals — or share one — and each entry carries its own cook,
time, and a to-go flag.

That migration runs automatically the first time this release loads your
database. Your existing meals are converted in place: a dish like `"Tacos"`
becomes a single entry, and its old cook/time are folded into that entry. The
conversion is idempotent — loading again won't double-convert — and your old
data is preserved in the new shape, not discarded.

Everything else this version adds (house projects, the evening agenda, nightly
check-ins, date-night jars, grocery history, the Siri Shortcuts token, and the
read-only Home Assistant tab) starts empty on your existing database and fills
in as you use it. No action needed.

## Before you start

Back up the database. One file, one command:

```bash
cd /path/to/household-hub/server
npm run backup            # -> server/hub-backup-YYYY-MM-DD.db
```

`npm run backup` uses SQLite's online backup API, so it's safe while the server
is live. A plain `cp hub.db` during a write is **not** guaranteed consistent
under WAL — use the script.

Note where your database actually lives. If your systemd unit or
`ecosystem.config.cjs` sets `DB_FILE`, that path wins. Otherwise it defaults to
`server/hub.db`.

## Upgrade

```bash
# 1. stop the app
sudo systemctl stop household-hub     # or: pm2 stop hub

# 2. back up (above), and keep a copy of the old directory
cp -a household-hub household-hub.bak

# 3. unpack this release over the old directory
#    hub.db is NOT in the archive, so your data is not overwritten
unzip -o household-hub-new.zip -d /path/to/

# 4. install and build
cd household-hub
npm run setup
npm run build

# 5. start
sudo systemctl start household-hub    # or: pm2 restart hub
```

On first boot you should see the server come up, and — if you have calendar
feeds — one refresh line per feed. The meals migration is silent; it just
works.

## What to verify

Open the hub and confirm the essentials carried over: household name, people,
notes, grocery list (and stores), tasks, countdowns, chores with their
completion history, and calendar feeds. Then open the meal planner and check a
day that previously had a dinner set — it should still be there, now as an
entry you can assign to a person or mark to-go.

New tabs (Projects, Agenda, Home) will be present but empty until you use them.
The **Home** tab does nothing until you set `HA_URL` and `HA_TOKEN` — see below.

## Home Assistant (optional)

The Home tab is a read-only view of your HA entities plus camera snapshots. The
long-lived token stays on the server and is never sent to the browser, so this
is safe to expose on a wall tablet. To enable it, set two environment variables
(in your systemd unit, pm2 config, or `.env`):

```
HA_URL=http://192.168.1.50:8123
HA_TOKEN=<long-lived access token from your HA profile page>
```

Restart, then pick which entities to show in **Settings**. Leave them unset and
the tab simply has nothing to configure.

## Rolling back

```bash
sudo systemctl stop household-hub
rm -rf household-hub && mv household-hub.bak household-hub
sudo systemctl start household-hub
```

One caveat specific to this upgrade: once this release has run, your database's
meals are stored in the new per-person shape. The previous SQLite release reads
meals from a different table and won't see them, so after a rollback the older
version may show meals as empty (the rest of your data is unaffected). If you
might roll back, keep the `hub-backup-*.db` you made in step 1 — restoring it
returns meals to the exact state the old version expects. This is why the backup
is not optional.

## Keep your data out of the deploy directory

The reason this upgrade needed care is that `hub.db` lives inside the directory
being replaced. Move it somewhere stable and this stops being a concern:

```bash
sudo mkdir -p /var/lib/household-hub
sudo mv server/hub.db /var/lib/household-hub/hub.db
sudo chown -R steven:steven /var/lib/household-hub
```

Then set `DB_FILE=/var/lib/household-hub/hub.db` in your systemd unit or pm2
config (both shipped examples already show this). After that, deploying a new
version is just: unzip, `npm run setup && npm run build`, restart.

## Automating the backup

```
0 3 * * * cd /path/to/household-hub && npm run backup >> /var/log/hub-backup.log 2>&1
```
