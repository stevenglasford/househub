# Household Hub

A self-hosted family wall display — the kind of thing a Skylight Calendar does, but
running on any tablet you already own and on your own server.

Built for a two-person household but works for any number of people.

## What it does

- **Today** — a glanceable dashboard: today's schedule, meals, and to-dos side by side,
  with weather, countdowns, and sticky notes
- **Calendar** — colour-coded week view, with read-only Google / Apple calendar feeds
  merged alongside events you add yourself
- **Meals** — plan breakfast / lunch / dinner for the week and assign who's cooking
- **To-Dos** — recurring *chores* (daily, certain weekdays, monthly, or every N days)
  and one-off dated *tasks*. Missed items carry over and are flagged as overdue.
- **Grocery** — a shared shopping list grouped by aisle
- **Board** — sticky notes and countdowns to important dates
- **Per-person views** — filter the whole app to one person, or see everyone

Everything is shared: the wall tablet and everyone's phones see the same data,
because it all lives on your server.

## Screens & layout

The interface adapts to the device:

- **Wall** — the three-column dashboard, sized to fit without scrolling. Meant for a
  tablet mounted in a kitchen or hallway.
- **Compact** — stacked single-column layout for phones.

It picks automatically by screen width, but you can lock a device to either one in
**Settings → Display mode** (useful if the wall tablet runs in a narrow window).

## Requirements

- **Node.js 20 or newer** (built-in `fetch`; better-sqlite3 ships prebuilt binaries
  for current Node versions)
- A tablet or browser to display it
- Optional: a domain + reverse proxy if you want to reach it from outside your network

## Quick start

```bash
git clone <your-repo-url> household-hub
cd household-hub

npm run setup     # installs both server/ and web/ dependencies
npm run build     # builds the front-end into server/public/
npm start         # serves everything on http://localhost:4000
```

Open `http://localhost:4000`. On first run the server creates `server/hub.db`
(SQLite) with a starter household. If a `server/data.json` from the old JSON-file
version exists, it's imported into the database automatically and renamed to
`data.json.imported`.

> **Set the server's timezone.** Calendar feed times are interpreted in the server's
> local time, so an incorrect timezone can shift events onto the wrong day:
> ```bash
> sudo timedatectl set-timezone America/Chicago
> ```

## Development

Two terminals:

```bash
npm run dev:server    # API on :4000
npm run dev:web       # Vite dev server on :5173 with hot reload, proxying /api
```

Then work against `http://localhost:5173`.

## Project layout

```
household-hub/
├── server/              Express API + serves the built front-end
│   ├── server.js        routes, static hosting, background feed refresh
│   ├── ics.js           iCalendar parser + recurrence/multi-day expansion
│   ├── store.js         SQLite datastore (better-sqlite3, WAL, transactional writes)
│   ├── backup.mjs       WAL-safe online backup of the live database
│   └── hub.db           your household's data (created on first run, gitignored)
├── web/                 React + Vite + Tailwind front-end
│   └── src/
│       ├── App.jsx      the entire UI
│       ├── api.js       thin REST client
│       ├── main.jsx     entry point
│       └── index.css    Tailwind + base styles
├── deploy/              systemd unit, Caddyfile, nginx example
└── package.json         convenience scripts for both halves
```

## Connecting calendars

Feeds are **read-only**: they display here, and you edit them in Google or Apple.
Add them in **Settings → Calendar sync**, either by pasting a secret `.ics` address
or importing a downloaded `.ics` file.

**Google Calendar** → calendar Settings → *Integrate calendar* → copy
**"Secret address in iCal format"**. No login or API key needed.

**Apple / iCloud** → share the calendar as a *Public Calendar*, then copy the
`webcal://` link. ("Public" here means anyone with the secret link, same as Google's
secret address — fine for a household, but don't post the URL anywhere.)

Each feed gets a colour and can be assigned to a person, so imported events flow into
the per-person filter. The server re-fetches every 15 minutes
(`REFRESH_MINUTES` to change).

**Why the server fetches these instead of the browser:** browsers block cross-origin
requests to calendar providers (CORS). Doing it server-side avoids that entirely,
which is why subscribing by URL works reliably here.

### Two-way sync

Not supported, deliberately. Writing back to Google needs OAuth (a Cloud project,
consent screen, token refresh) and iCloud has no public API at all — only CalDAV with
an app-specific password. Both are ongoing maintenance for a display that mostly needs
to *show* you things. Events you create in the hub live in the hub; events from
Google/Apple stay read-only and are marked with a lock icon.

## Weather

Uses [Open-Meteo](https://open-meteo.com) — free, no account, no API key. Set your
location in **Settings → Weather** by searching for a city or entering coordinates.
Refreshes every 30 minutes. Requires outbound internet from the browser; if it shows
"No connection", that's the fetch failing rather than a configuration problem.

## Deploying on a server

### 1. Reverse proxy with HTTPS

The Node app listens on port 4000 over plain HTTP. Put a proxy in front of it.
**Caddy** is the least work — it handles Let's Encrypt automatically:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

An nginx + certbot equivalent is in `deploy/nginx.conf.example`. To serve the hub
as a **subpath** of an existing site (e.g. `https://example.com/hub`) instead of its
own hostname, use `deploy/nginx-subpath.conf.example` — the frontend and API client
use relative URLs, so no base-path configuration is needed in the app itself.

### 2. Keep it running

With **pm2** (edit `ecosystem.config.cjs` first if your port or timezone differ):

```bash
pm2 start ecosystem.config.cjs
pm2 save          # persist across reboots (assumes `pm2 startup` is configured)
pm2 logs hub
```

Prefer systemd? `deploy/household-hub.service` still works:

```bash
sudo cp deploy/household-hub.service /etc/systemd/system/
sudo nano /etc/systemd/system/household-hub.service   # set User, WorkingDirectory, TZ
sudo systemctl daemon-reload && sudo systemctl enable --now household-hub
```

### 3. Updating

```bash
git pull
npm run setup
npm run build
pm2 restart hub        # or: sudo systemctl restart household-hub
```

## Mounting the tablet

- Add the page to the home screen so it launches fullscreen without browser chrome
- Set **Auto-Lock → Never** and keep it plugged in
- iPad: **Guided Access** (Settings → Accessibility) locks it to the app
- Android: *Fully Kiosk Browser* handles kiosk mode, screen wake, and auto-launch on
  boot more gracefully than iOS does
- In the app, set **Settings → Display mode → Wall**

## Data and backups

Everything lives in `server/hub.db`, a SQLite database (better-sqlite3, WAL mode).
Every mutation is a single transaction, so a crash mid-save can't corrupt or
half-apply anything.

To back it up while the server is running, use the online-backup script — a plain
`cp` of a WAL database that's mid-write is not guaranteed consistent:

```bash
npm run backup                          # -> server/hub-backup-YYYY-MM-DD.db
npm run backup -- ~/backups/hub.db      # explicit destination
```

The output is an ordinary SQLite file — restore by stopping the server and copying
it over `hub.db`. It's also handy for ad-hoc queries (`sqlite3 server/hub.db
"SELECT data FROM chores"` — entities are JSON in the `data` column, one table per
collection). To start over, stop the server and delete `hub.db` (and its `-wal` /
`-shm` siblings).

There's no authentication. Anyone who can reach the URL can read and edit everything —
fine on a home network, but put it behind a VPN, Tailscale, or HTTP basic auth in your
reverse proxy before exposing it to the internet.

## How saving works

The browser holds the household document and saves the whole thing back with
`PUT /api/state`, debounced ~600ms after your last change. Other devices poll every
15 seconds and pick up changes, pausing while you have unsaved edits so a background
refresh can't overwrite what you're typing.

Last write wins. For a household this is the right trade — the payload is a few
kilobytes and simultaneous edits to the same field are vanishingly rare. If two people
edit at the same moment, the later save wins; nothing corrupts.

Calendar feed contents (`icsText`) never leave the server, so a save can't wipe them.

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/state` | The whole household document (feeds as metadata only) |
| PUT | `/api/state` | Save the document |
| PUT | `/api/settings` | Update household name |
| POST/PUT/DELETE | `/api/people[/:id]` | Manage people |
| POST/PUT/DELETE | `/api/events[/:id]` | Hub-local events |
| PUT | `/api/meals/:date` | Set a day's meals and cooks |
| POST/PUT/DELETE | `/api/chores[/:id]` | Recurring chores |
| POST | `/api/chores/:id/toggle?date=YYYY-MM-DD` | Check/uncheck a chore |
| POST/PUT/DELETE | `/api/tasks[/:id]` | One-off dated tasks |
| POST | `/api/tasks/:id/toggle` | Check/uncheck a task |
| POST/PUT/DELETE | `/api/grocery[/:id]` | Grocery list |
| POST | `/api/grocery/:id/toggle` | Mark an item picked up |
| POST | `/api/grocery/clear-done` | Remove everything picked up |
| POST/PUT/DELETE | `/api/notes[/:id]` | Sticky notes |
| POST/PUT/DELETE | `/api/dates[/:id]` | Countdowns |
| PUT | `/api/weather` | Weather location and units |
| POST/PUT/DELETE | `/api/calendars[/:id]` | Calendar feeds |
| POST | `/api/calendars/:id/refresh` | Force a feed refresh |
| GET | `/api/calendar-events?start=&end=` | Expanded read-only feed events |

The granular endpoints exist for scripting and integrations; the UI itself mostly uses
`GET`/`PUT /api/state`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Port the server listens on |
| `REFRESH_MINUTES` | `15` | How often to re-fetch subscribed feeds |
| `DB_FILE` | `./hub.db` | SQLite database file |
| `DATA_FILE` | `./data.json` | Legacy JSON store — read once and imported on first boot |
| `TZ` | system | Timezone for interpreting feed times |

See `.env.example`.

## Known limitations

- **No authentication** — see the note above before exposing it publicly.
- **Recurring events** support a practical subset of `RRULE` (`FREQ`, `INTERVAL`,
  `COUNT`, `UNTIL`, and `BYDAY` for weekly). Exotic rules like "third Thursday of the
  month" and per-instance exceptions (`EXDATE`) aren't handled.
- **Multi-day events** display on each day they span, but as separate entries per day
  rather than one continuous bar across the week grid.
- **Feed times** are interpreted in the server's timezone rather than per-event `TZID`,
  so set `TZ` correctly.
- **Photo slideshow** isn't implemented.

## License

MIT — see [LICENSE](LICENSE).
