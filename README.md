# HouseHub

A self-hosted wall display and shared organiser for people who live together —
calendar, meals, chores, groceries, projects, and a nightly check-in — where the
server that stores it all **cannot read any of it**.

Built originally for one household of two. Rebuilt so it works for any household
of any shape, and so that running it for other people does not require them to
trust you.

```
        password ──PBKDF2──> key ──unwraps──> your identity key
                                                     │
              household key <──── ECDH-ES ───────────┘
                     │
                     └── AES-256-GCM ──> everything your household writes
```

The server holds ciphertext, wrapped keys it cannot open, and the minimum needed
to decide who may fetch which blob. That is the whole design, and everything
else follows from it.

---

## What it does

- **Today** — a glanceable dashboard: schedule, meals and to-dos in three
  columns, sized to fit a wall tablet without scrolling
- **Calendar** — colour-coded week view, merging read-only Google/Apple feeds
  with events added here
- **Meals** — breakfast/lunch/dinner per person, eat-in or to-go, with who's
  cooking
- **To-dos** — recurring chores and one-off tasks; missed items carry over
- **Grocery** — a shared list, sorted by aisle or store, with purchase history
- **Projects** — house projects with percent-complete tracking
- **Agenda** — things to talk about tonight, filed into a dated archive
- **Nightly check-in** — a short walkthrough of only what needs attention, with
  a conversation question **generated locally by Ollama** rather than drawn from
  a fixed list that goes stale in a fortnight
- **Displays** — permanent links for always-on screens, each showing only what
  the admins chose
- **Home Assistant** — per household: cameras, lights, sensors, and optional
  control. Lights and blinds work from a shared display; locks never do

## What makes it different

**End-to-end encrypted.** Household content is sealed in your browser under a
key derived from your password. The operator — including whoever sells you
hosting — sees ciphertext. So does anyone who steals the disk or serves a
warrant.

**Your password never reaches the server.** The browser stretches it and sends a
derived proof; the server stores an Argon2id hash of *that*. A server logging
every request still cannot open your household.

**Households of any shape.** Any number of admins — co-parents, three partners,
whatever your home is. Plus adults, dependants with their own accounts, and
read-only viewers.

**Adding a member is a two-step handshake the server only relays.** They publish
a public key; an existing admin's device wraps the household key to it. An
operator who forges the first step still cannot perform the second, so they
cannot insert themselves into your family.

**Displays need every admin to agree.** One admin proposes a wall screen; the
others sign off. This is enforced by the fact that activation requires a key
wrap only a member device can perform — not by an `if` statement someone could
patch out.

**All AI is local.** Inference goes to Ollama on the same machine. There is no
remote provider in the codebase and the server refuses to start if `OLLAMA_URL`
is not local — the constraint is structural, not a setting.

**Open source, MIT.** Host it for your family, or for a hundred.

## Quick start

```bash
git clone https://github.com/stevenglasford/househub
cd househub

cp deploy/env.example .env
./scripts/generate-secret.sh >> .env
$EDITOR .env                       # set PUBLIC_URL and POSTGRES_PASSWORD

docker compose -f deploy/docker-compose.yml up -d
```

Then put HTTPS in front (`deploy/Caddyfile`) and open your domain.

> HouseHub decrypts in the browser with Web Crypto, which browsers only expose
> over HTTPS or on `localhost`. Over plain `http://` from another machine it
> cannot decrypt anything.

Full instructions, including running it for other families:
**[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**

## Privacy and your data

**[docs/PRIVACY.md](docs/PRIVACY.md)** covers what is stored, for how long, and
how to get it out or delete it. In short: export your account data or your whole
household from **Settings → Your data**, and delete your own account from the
same place — every role can, because a right only some people can exercise is
not a right.

The awkward part, stated there rather than buried: deleting your account cannot
remove your name from a shared household's calendar, because the server cannot
read that calendar. A member has to.

## Security

**[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)** is the honest version: what is
protected, what is not, and the known weaknesses. Short form —

| An attacker with | Can read |
|---|---|
| Network traffic | Nothing but timing and volume |
| A database dump | Nothing |
| Database + `SECRET_KEY` | Emails, calendar URLs, wallet config. **No household content** |
| A member's password | That member's households |

The limits, stated rather than buried: the E2E code is delivered by the server,
so an operator who modifies it can defeat it — self-host if that is your threat
model. A display device holds the household key even when it renders three
panels. Removing a member requires a key rotation to be complete.

Verify the claims:

```bash
cd server && npm test           # 58 tests: crypto, SSRF, archives, end-to-end
node security/pentest/run.js    # 90+ attack probes; exits non-zero on HIGH+
```

The end-to-end suite asserts the architecture directly — that the database holds
no plaintext, that a wrapped key cannot be moved between members, that one admin
cannot activate a display alone.

## Layout

```
server/
  src/
    crypto/        server-side sealing, Argon2id, TOTP, tokens
    db/            pool, forward-only migration runner, schema
    middleware/    auth, CSP and CSRF, DB-backed rate limits, errors
    routes/        auth, households, vault, invites, displays, ai, admin
    services/      ollama, check-in prompts, calendars, SSRF-safe fetch,
                   wallets, billing, upgrades, safe unzip, audit
web/
  src/
    lib/crypto.js  the end-to-end layer  <-- read this one first
    lib/session.js keys in memory, sealed load/save
    api.js         the seam: same six functions the UI always used
    App.jsx        the household UI, unchanged by encryption
docs/              self-hosting, threat model
security/pentest/  the attack suite
deploy/            Dockerfile, compose, Caddy, nginx, systemd
```

The reason `App.jsx` needed no changes is `api.js`: it still exports
`loadState()` and `saveState()` with the same signatures, and does the sealing
underneath. Nothing above that file knows encryption exists.

## Development

```bash
cd server && npm ci && npm run migrate
cd ../web && npm ci

# two terminals
cd server && npm run dev        # API on :4000
cd web    && npm run dev        # Vite on :5173, proxying /api
```

Schema changes go in a **new** file under `server/src/db/migrations/`. Applied
migrations are immutable and the runner will refuse to start if one is edited.

## Contributing

Pull requests welcome. Two rules:

1. **Nothing may give the server the ability to read household content.** If a
   feature seems to need it, it belongs in the client.
2. **AI inference stays local.** No remote providers, no API keys.

Run `npm test` and `node security/pentest/run.js` before opening a PR.

## Licence

MIT — see [LICENSE](LICENSE).
