# Household Hub

A self-hosted family wall display — the kind of thing a Skylight Calendar does, but
running on any tablet you already own and on your own server.

Built for a two-person household but works for any number of people.

## What it does

- **Today** — a glanceable dashboard: schedule, meals, and to-dos in three columns,
  with weather, countdowns, and sticky notes. Sized to fit the screen exactly — the page
  never scrolls; long lists scroll inside their own column. Step to any other day with
  the arrows.
- **Calendar** — colour-coded week view, with read-only Google / Apple calendar feeds
  merged alongside events you add yourself
- **Meals** — plan breakfast / lunch / dinner for the week. Each slot holds as many
  entries as you need, so two people can eat different things; mark each one **eat-in or
  to-go**, with an optional time and who's cooking
- **To-Dos** — recurring *chores* (daily, certain weekdays, monthly, or every N days)
  and one-off dated *tasks*. Missed items carry over and are flagged as overdue. On the
  Today view, anything you tick off drops to a "done" group at the bottom so the
  remaining work stays at the top.
- **Grocery** — a shared shopping list, taggable by store and category with either as the
  sort, quantities, voice adding via Siri, and a running purchase history ("bought before")
- **House projects** — a backlog of projects with no date, or scheduled onto one or more
  days with percent-complete tracking; unfinished work carries forward with a
  reschedule prompt instead of vanishing or duplicating
- **Home** — optional read-only Home Assistant view: camera stills, lights, locks, sensors
- **Agenda** — an evening discussion list: things either of you wants to talk about,
  tagged by category, checked off as you cover them, then filed into a dated archive.
  Includes a rotating nightly conversation prompt, a "how we're doing" status check-in,
  and date-night jars
- **Nightly check-in** — the wall tablet chimes and opens a short walkthrough of only
  what needs attention that night, timed off when a synced work calendar ends (with a
  manual fallback), and keeps a history of past check-ins
- **Board** — sticky notes and countdowns to important dates
- **Home** — read-only view of Home Assistant: camera stills, which lights are on,
  what's unlocked or open, and sensor readings (optional; appears only when configured)
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

### Reclaiming vertical space on the wall

The Today screen is deliberately fixed-height, so anything above the three columns eats
into them. Two settings trade context for column room:

- **Settings → Per-person summary on Today** — hide the Ryan/Steven chips
- **Settings → Sticky notes on Today** — set to *Hidden*, or *Stuck on* (the overlay
  costs no vertical space at all, unlike the compact row)

The countdown strip is capped at a single line by design and scrolls sideways rather
than wrapping onto a second row.

### Choosing what "Up next" shows

By default the top-row *Up next* card looks at every calendar. **Settings → "Up next"
draws from** lets you tick any combination of your synced calendars (plus events added
in the hub itself) — useful if an imported work calendar drowns out household plans.
Unticking everything returns to using them all.

The per-calendar options only appear once you've connected a calendar under
**Calendar sync**.

## Requirements

- **Node.js 18 or newer** (uses the built-in `fetch`)
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
(a SQLite database) with a starter household.

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
│   ├── store.js         SQLite datastore (better-sqlite3, WAL mode)
│   ├── store-json.js    optional JSON-file datastore (alternative to SQLite)
│   ├── document.js      the document shape + migrations, shared by both stores
│   ├── config.js        resolves every setting from the environment
│   ├── homeassistant.js read-only Home Assistant bridge (token stays server-side)
│   ├── backup.mjs       consistent online DB snapshot (npm run backup)
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

## How meals work

Each meal slot holds a **list** of entries rather than a single dish, because breakfast
and lunch usually aren't shared. Every entry has:

- **Who it's for** — one person, or **Shared** for something you eat together
- **Eat in or to-go** — to-go entries are flagged with a bag icon
- An optional **time**, and **who's cooking** (hidden for to-go, where it doesn't apply)

The person filter in the tab bar applies to meals: filter to one person and you see their
meals plus anything shared, hiding the other person's. That makes a typical day read as
two separate breakfasts and lunches with one shared dinner.

Plans made before this change are migrated automatically — an old single dish becomes one
**Shared** entry, keeping its time and cook.

## Evening agenda

Carried over from the standalone Evening Agenda app. This is **not** the to-do list — it's
for things you want to *talk about* rather than tasks to complete. Either of you adds items
through the day ("should we restain the deck?", "budget for the tablet"), tagged **House /
Money / Plans / Just talk / Other** and attributed to whoever raised it. In the evening you
work down the list, checking things off as you cover them.

Hitting **File** moves everything covered into a dated archive, so the list resets for
tomorrow but you keep a record of past conversations — expandable at the bottom of the tab.
The archive keeps the last 60 evenings.

The tab badge shows how many things are waiting, which is the useful signal on a wall
display: you can see at a glance that there are three things to bring up tonight.

## Nightly check-in

A wall-tablet-native reminder and a short walkthrough — no push notifications or
permissions needed, since the tablet already has the app open.

**The reminder.** At the scheduled time the tablet chimes (two soft tones) and opens
the check-in. It only fires within a 30-minute window of the target time and only once
per night, so leaving the app open late doesn't retrigger it.

**Timing.** Set **Settings → Check-in** to follow one person's workday. If that person
has a synced calendar event recognizable as work (by title keyword, or by picking a
whole calendar), the check-in is timed some number of minutes after it ends. If nothing
matches that day, it falls back to a plain time you set. Either way, if the computed
moment would land inside another event, it slides to just after that event instead.

**The walkthrough** only shows what needs attention: tonight's conversation prompt,
anything overdue, projects that slipped, open discussion topics, tomorrow's schedule,
whether tomorrow's meals are planned, and each person's status check-in. It ends by
setting tomorrow's time — which doubles as the explicit override and the day's fallback.

**History.** Every completed check-in is logged (when, what was covered, what was
skipped), viewable from the check-in's start screen.

Browsers block audio until the page has been tapped at least once, so the very first
chime after a tablet reboot may be silent.

## Date-night jars

Three jars by default — **Cheap**, **Long**, **Fancy** — under **Agenda → Date jar**.
Add ideas whenever one occurs to either of you, then draw from whichever jar matches the
mood. Jars are renameable and you can add your own.

**Drawing isn't pure random**, because pure random keeps handing back the same idea from a
small jar. Ideas you've never drawn come first; after that it rotates by whatever was drawn
longest ago, and it never offers the same idea twice in a row (unless the jar has only one
thing in it). Drawing again is always one tap.

When you pick something, **We're doing it** records the date and leaves it in the jar —
a good date is worth repeating, and each idea shows how many times you've done it and how
long ago. **Did it, retire** takes genuinely one-off things out of rotation; retired ideas
are listed separately and can be put back.

Removing a jar keeps its ideas — they move to the first remaining jar rather than being
deleted.

Ideas can also be added by voice (see below), which is the point: you're most likely to
think of one when you're nowhere near the tablet.

## Voice control with Siri

You can add to the grocery list by voice: **"Hey Siri, add to grocery list."** Siri asks
what to add, you dictate it, and it appears in the app with the aisle guessed
automatically. One phrase can hold several items — *"milk, eggs and bread"* becomes three
entries.

This works through **Apple Shortcuts** posting to the hub's API. No App Store app and no
Apple developer account needed.

### Setup

Open **Settings → Voice** in the app. It shows the endpoint URL, your token, and the exact
steps, with copy buttons. In short: build a Shortcut with *Ask for Input* → *Get Contents
of URL* (POST, `Authorization: Bearer <token>`, JSON body `{"text": <Provided Input>}`),
and name the Shortcut whatever you want to say to Siri.

Add *Show Result* with the response's `spoken` field and Siri will read back what it added.

### Voice endpoints

These are the only routes that require a token, since they're the ones you'd expose
beyond the local network. Pass it as `?token=…` or `Authorization: Bearer …`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/voice/grocery` | Add items from dictated text |
| GET | `/api/voice/grocery` | Read the list back (for Siri to speak) |
| POST | `/api/voice/task` | Add a one-off task |
| POST | `/api/voice/note` | Add a sticky note |
| POST | `/api/voice/date-idea` | Add a date-night idea to a jar |
| POST | `/api/voice/agenda` | Add something to tonight's agenda |

They accept `{"text": "..."}` as JSON, or a plain-text body. Each responds with a `spoken`
field written to be read aloud.

```bash
curl -X POST "https://hub.example.com/api/voice/grocery?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"paper towels, olive oil and bananas"}'
```

Quantities are picked out of what you said: *"two gallons of milk"* becomes **2 gallons**
of **Milk**, and *"2 lbs coffee"* becomes **2 lbs** of **Coffee**. Quantity is stored as
free text so "a dozen" and "1 gallon" both survive. Product names that merely start with a
number are left alone — *"2% milk"* stays a single item rather than being read as a
quantity of two.

If an item is already on the list, saying it again with a quantity fills that in rather
than adding a duplicate row.

Aisle guessing uses a small keyword list and falls back to *Other*, which you can re-file
with the dropdown in the app. It matches on word boundaries, so "toilet paper" correctly
lands in Household rather than being caught by the "oil" inside "toilet".

### Using it away from home

The token protects the voice endpoints only — **the rest of the app still has no login.**
To add items while you're at the store, reach the server over a private network
(Tailscale or a VPN) rather than opening it to the internet. Treat the token like a
password; anyone holding it can write to your lists. Regenerate it from **Settings**, or by clearing the stored token and restarting.

## Weather

Uses [Open-Meteo](https://open-meteo.com) — free, no account, no API key. Set your
location in **Settings → Weather** by searching for a city or entering coordinates.
Refreshes every 30 minutes. Requires outbound internet from the browser; if it shows
"No connection", that's the fetch failing rather than a configuration problem.

## Home Assistant (optional)

The hub can show a read-only view of your smart home: camera stills, which lights are
on, what's unlocked or open, and sensor readings. A **Home** tab appears once it's
configured, and stays hidden otherwise.

**It is deliberately display-only.** The server exposes no way to call Home Assistant
services, so nothing in this app can change the state of your house. A stray tap on a
wall-mounted screen can't unlock a door. For actual control, set a dashboard link
(below) and the Home tab gets a **Full controls** button that opens Home Assistant's own
interface.

### Setup

1. In Home Assistant, go to your profile page (`/profile`) → **Long-lived access
   tokens** → create one.
2. Put it in the server environment:
   ```
   HA_URL=http://192.168.1.50:8123
   HA_TOKEN=eyJhbGci...
   ```
   In systemd, add them as `Environment=` lines; see `deploy/household-hub.service`.
3. Restart the server, then open **Settings → Home** in the app and tick what should
   appear. There's a search box, since a typical Home Assistant install exposes far more
   entities than belong on a wall display.
4. Optionally paste a Home Assistant dashboard URL for the **Full controls** button.

### Why the token stays on the server

Two reasons it's an environment variable rather than something you paste into the app:

- It's a **full-access credential** — anything holding it can control the house. It never
  appears in `/api/state` and is never sent to a browser.
- Home Assistant's camera URLs **don't accept long-lived tokens** as a `?token=` query
  parameter — only short-lived ones that expire within minutes. So a browser can't fetch
  snapshots directly even if you wanted it to. The server proxies them instead, which
  makes camera tiles a plain image URL that keeps working indefinitely.

### Cameras

Camera tiles are **polled stills**, refreshed every 2 seconds, not live video. That's a
deliberate trade: it looks essentially live at a glance, costs a fraction of the CPU,
needs no video decoder on the display, and degrades gracefully — a network hiccup shows
a slightly older frame instead of a broken player. If a camera stops responding the tile
says *No signal* rather than going blank.

This works with any camera Home Assistant can see, including an NVR like Frigate, since
those surface as normal `camera.*` entities.

### Home Assistant endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/home/status` | Whether HA is configured and reachable |
| GET | `/api/home/entities` | States of the entities chosen for the Home tab |
| GET | `/api/home/all-entities` | Everything available, for the Settings picker |
| GET | `/api/home/camera/:entityId.jpg` | Proxied camera still |

Noisy domains (automations, update entities, diagnostics) are filtered out of the picker.
States are cached for 4 seconds and snapshots for 1 second, so several displays polling
at once won't hammer your Home Assistant instance.

## Deploying on a server

### 1. Reverse proxy with HTTPS

The Node app listens on port 4000 over plain HTTP. Put a proxy in front of it.
**Caddy** is the least work — it handles Let's Encrypt automatically:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

An nginx + certbot equivalent is in `deploy/nginx.conf.example`.

### 2. Keep it running

```bash
sudo cp deploy/household-hub.service /etc/systemd/system/
sudo nano /etc/systemd/system/household-hub.service   # set User, WorkingDirectory, TZ
sudo systemctl daemon-reload
sudo systemctl enable --now household-hub
sudo systemctl status household-hub
```

### 3. Updating

```bash
git pull
npm run setup
npm run build
sudo systemctl restart household-hub
```

## Mounting the tablet

- Add the page to the home screen so it launches fullscreen without browser chrome
- Set **Auto-Lock → Never** and keep it plugged in
- iPad: **Guided Access** (Settings → Accessibility) locks it to the app
- Android: *Fully Kiosk Browser* handles kiosk mode, screen wake, and auto-launch on
  boot more gracefully than iOS does
- In the app, set **Settings → Display mode → Wall**

## Data and backups

Everything lives in one SQLite database, `server/hub.db` (or wherever `DB_FILE`
points). Back it up with the bundled script, which uses SQLite's online backup
API and is safe to run while the server is live:

```bash
npm run backup                      # -> hub-backup-YYYY-MM-DD.db next to the DB
npm run backup -- ~/backups/hub.db  # or an explicit destination
```

Don't just `cp hub.db` while the server is running — under WAL a plain copy
mid-write isn't guaranteed consistent. The script is. To start over, stop the
server, delete the database, and start again.

Prefer a single human-readable file over a database? Change the import in
`server/server.js` from `./store.js` to `./store-json.js` and the hub will use
a plain `data.json` instead. Both stores share the same document logic, so
features and migrations are identical.

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
| PUT | `/api/meals/:date` | Set a day's meals (list per slot; old single-dish shape still accepted) |
| POST/PUT/DELETE | `/api/chores[/:id]` | Recurring chores |
| POST | `/api/chores/:id/toggle?date=YYYY-MM-DD` | Check/uncheck a chore |
| POST/PUT/DELETE | `/api/tasks[/:id]` | One-off dated tasks |
| POST | `/api/tasks/:id/toggle?date=YYYY-MM-DD` | Check/uncheck a task (stamps `doneAt`) |
| POST/PUT/DELETE | `/api/projects[/:id]` | House projects (backlog, dates, stages) |
| POST | `/api/projects/:id/progress?to=&by=` | Nudge percent complete |
| POST | `/api/projects/:id/stage/:stageId/toggle` | Check/uncheck a project stage |
| POST/PUT/DELETE | `/api/grocery[/:id]` | Grocery list (qty, aisle, store) |
| POST | `/api/grocery/:id/toggle` | Mark an item picked up (logs to history) |
| POST | `/api/grocery/clear-done` | Remove everything picked up |
| GET | `/api/grocery/history` | Purchase history, most recent first |
| POST/PUT/DELETE | `/api/notes[/:id]` | Sticky notes |
| POST/PUT/DELETE | `/api/dates[/:id]` | Countdowns |
| POST/PUT/DELETE | `/api/agenda[/:id]` | Evening agenda items |
| POST | `/api/agenda/:id/toggle` | Mark an item covered |
| POST | `/api/agenda/archive` | File covered items into the archive |
| PUT/GET | `/api/status/:date` | Nightly status check-in (per person, per day) |
| POST/PUT/DELETE | `/api/date-ideas[/:id]` | Date-night ideas |
| POST | `/api/date-ideas/draw?jar=` | Draw a weighted idea from a jar |
| POST | `/api/date-ideas/:id/done?retire=` | Record doing it; optionally retire it |
| PUT | `/api/weather` | Weather location and units |
| GET | `/api/home/status` | Whether Home Assistant is configured/reachable |
| GET | `/api/home/entities` | States of entities chosen for the Home tab |
| GET | `/api/home/all-entities` | Everything available, for the Settings picker |
| GET | `/api/home/camera/:entityId.jpg` | Proxied camera still |
| POST | `/api/voice/grocery` | Add grocery items from dictated text |
| GET | `/api/voice/grocery` | Read the grocery list back, for Siri to speak |
| POST | `/api/voice/task` | Add a task from dictated text (parses date/person) |
| POST | `/api/voice/project` | Add a project; no date parsed means the backlog |
| POST | `/api/voice/note` | Add a sticky note from dictated text |
| POST | `/api/voice/agenda` | Add an agenda topic from dictated text |
| POST | `/api/voice/date-idea` | Add a date-night idea (names the jar if you say one) |
| POST/PUT/DELETE | `/api/calendars[/:id]` | Calendar feeds |
| POST | `/api/calendars/:id/refresh` | Force a feed refresh |
| GET | `/api/calendar-events?start=&end=` | Expanded read-only feed events |

The granular endpoints exist for scripting and integrations; the UI itself mostly uses
`GET`/`PUT /api/state`. The nightly check-in has no dedicated endpoint — its settings,
per-night overrides, and history all live under the `checkin` field on the main document,
the same way display preferences do.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Interface to bind (use `127.0.0.1` behind a proxy) |
| `REFRESH_MINUTES` | `15` | How often to re-fetch subscribed feeds |
| `DB_FILE` | `./hub.db` | SQLite database location — **this is your data** |
| `DATA_FILE` | `./data.json` | Legacy JSON store; imported once if `DB_FILE` is new |
| `TZ` | system | Timezone for interpreting feed times |
| `HA_URL`, `HA_TOKEN` | — | Optional read-only Home Assistant integration |
| `HOUSEHOLD_NAME`, `HOUSEHOLD_PEOPLE` | — | Seed values for a brand-new database |
| `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_LABEL`, `WEATHER_UNIT` | Minneapolis | Default weather location |

See `.env.example` for the complete list — every hardcoded value has been made
configurable, so deploying a new version never requires editing source.

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
- **Home Assistant is display-only.** No service calls are exposed, so nothing here can
  turn a light on/off or unlock a door — only show state. Use the "Full controls" link
  for that.
- **No two-way calendar sync.** Events created in the hub live in the hub; synced calendar
  events are read-only and edited in Google/Apple.
- **The nightly check-in's calendar-derived timing only works if work is actually a synced
  calendar event with an end time** (a single-day timed event). All-day entries and
  multi-day spans can't anchor it, and it falls back to a plain time on those days.

## License

MIT — see [LICENSE](LICENSE).
