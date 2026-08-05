# Self-hosting HouseHub

Two audiences here, and they need different things:

- **[Run it for your own household](#part-1--one-household)** — one family, one
  machine, half an hour.
- **[Run it for other people](#part-2--running-it-for-others)** — a server other
  families use, with billing if you want it.

Both are supported and neither is the "real" one. The licence is MIT.

---

## Part 1 — one household

### What you need

- A machine that stays on: an old laptop, a NUC, a Raspberry Pi 5, a VPS
- Docker, or Node 20+ and PostgreSQL 14+
- A domain name **with HTTPS**, or Tailscale

> **HTTPS is not optional.** HouseHub decrypts your household in the browser
> using Web Crypto, which browsers only expose in a secure context. Over plain
> `http://` to another machine, the app cannot decrypt anything at all. On
> `localhost` it works, because browsers treat that as secure.

### With Docker

```bash
git clone https://github.com/stevenglasford/househub
cd househub

cp deploy/env.example .env
./scripts/generate-secret.sh >> .env
$EDITOR .env                      # set PUBLIC_URL and POSTGRES_PASSWORD

docker compose -f deploy/docker-compose.yml up -d
```

That starts PostgreSQL, Ollama, pulls a model, and runs the app on
`127.0.0.1:4000`. Put a TLS proxy in front:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile   # set your hostname
sudo systemctl reload caddy
```

Open your domain, create an account, and make a household.

### Without Docker

```bash
sudo -u postgres createuser --pwprompt househub
sudo -u postgres createdb -O househub househub

cd server && npm ci && cd ../web && npm ci && npm run build && cd ..

export DATABASE_URL="postgres://househub:yourpassword@localhost/househub"
export PUBLIC_URL="https://hub.example.com"
export SECRET_KEY="$(openssl rand -base64 32)"    # save this
cd server && npm start
```

`deploy/household-hub.service` is a systemd unit. Set `User`,
`WorkingDirectory`, `TZ` and the environment variables in it.

> **Set the timezone.** Calendar feed times are interpreted in the server's
> local time, so a wrong `TZ` shifts events onto the wrong day.
> `sudo timedatectl set-timezone America/Chicago`

### Closing signups

Once everyone in your house has an account:

```bash
ALLOW_SIGNUP=0
```

Invitations still work, so you can add people later without reopening the door.

### Adding the rest of your household

**Settings → Household → Invite.** Each invitation is a one-time link. You can
pin it to an email address, so a forwarded link is useless to anyone else.

When they accept, **they cannot see anything yet**. An admin has to grant them
a key, which is the step where the household key is wrapped to their public key
on your device. Check the fingerprint the app shows you against the one on
their screen — in person, ideally. That is what stops a malicious server
substituting its own key.

**Making an account for someone else** — a child, or a partner who is not going
to do this themselves — is **Settings → Household → Add a managed account**. You
pick a password and hand it over; they can change it later, and at that point
you lose the ability to sign in as them.

**Several admins** is normal and supported. Any number of people can be admins
of one household: co-parents, three partners, whatever the shape of the home is.
Admins can add and remove members, and every admin must sign off before a wall
display goes live.

### The wall display

**Settings → Displays → New display.**

1. Name it, tick the panels it may show, optionally set an expiry.
2. **Every other admin has to approve it.** Any one of them can veto.
3. Once approved, you get a link. **It is shown once.** Open it on the tablet.

The tablet stores its key locally and runs indefinitely. It cannot write
anything, cannot see your member list, and stops working the moment you revoke
it.

If a display device is lost or stolen: revoke it, then **rotate the household
key** (Settings → Household → Rotate key). Revocation kills the link; rotation
is what makes the copy it already had useless.

### Check-in questions

The nightly check-in question is generated locally by Ollama rather than drawn
from a fixed list. **Settings → Check-in** controls the tone and how much
context is shared with the model:

- **Minimal** — nothing about your household
- **Signals** (default) — counts only: "2 overdue tasks, 1 thing to discuss"
- **Full** — actual titles

Inference is local, always. There is no remote-model option and the server
refuses to start if `OLLAMA_URL` points somewhere non-local.

On a CPU-only machine use `llama3.2:3b`. With a GPU, `qwen3:14b` is noticeably
better. The first generation after a reboot takes 15–30 seconds while the model
loads; `OLLAMA_KEEP_WARM=1` keeps it resident so the evening check-in is
instant.

### Backups

```bash
docker compose -f deploy/docker-compose.yml exec -T db \
  pg_dump -U househub househub | gzip > househub-$(date +%F).sql.gz
```

**Back up `SECRET_KEY` separately and somewhere else.** The dump alone is
useless without it for emails and calendar URLs — which is the point — but that
also means losing the key loses those.

Household content is not recoverable from a backup without a member's password.
Nobody can reset one. Say this out loud to everyone in the house before they
pick one.

---

## Part 2 — running it for others

Everything above, plus the following.

### Before you take anyone's money

Be straight with people about what you can and cannot see. You can see that a
household exists, how many members it has, and how many bytes it stores. You
cannot read any of it, and there is no endpoint that would let you. If someone
loses their password, you cannot help — say so at signup, not afterwards.

### Making yourself a super-admin

There is no default admin account and no bootstrap password. Sign up normally,
then:

```bash
./scripts/create-super-admin.sh you@example.com
```

### Billing in BTC, ETH or XMR

**Settings → Super admin → Wallets.**

> **Give this server receive-only keys.** An `xpub`/`zpub` for Bitcoin and
> Ethereum, and for Monero the primary address plus the **private view key**.
> Those generate addresses and detect payments. They cannot spend. Never paste
> an `xprv`, a seed phrase, or a Monero spend key — the API rejects extended
> private keys, but do not rely on that as your only safeguard.

Each invoice gets a freshly derived address. That is deliberate: a reused
address publishes a public ledger of every payment you have ever received and
lets anyone correlate your customers.

Watching for payments:

| Asset | How | Notes |
|---|---|---|
| BTC | Esplora-compatible API | Your own `electrs` ideally; `mempool.space` works |
| ETH | Any JSON-RPC endpoint | `eth_getBalance` |
| XMR | `monero-wallet-rpc`, view-only | **Required.** No explorer can see a Monero subaddress — that is the point of Monero |

Using a public explorer tells that explorer which addresses are yours. Run your
own node if the people paying you would care.

Set an exchange rate feed:

```
PRICE_FEED_URL=https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,monero&vs_currencies=usd
```

Anything returning that shape works, including your own.

**Nonpayment freezes; it never deletes.** A household past its grace period goes
read-only and can still export everything. Please keep it that way.

### The upgrade pipeline

A super-admin can drop a zip describing a change, and Claude Code implements it
against a checkout and opens a pull request.

```
UPGRADES_ENABLED=1
UPGRADE_REPO_URL=https://github.com/you/househub
GITHUB_TOKEN=ghp_...
```

Needs the `claude` CLI on the host.

What it does: unpacks the archive (refusing traversal, symlinks and zip bombs),
clones the repo onto a branch, runs Claude Code with a constrained prompt, runs
an **additive-only guard** over the diff, runs the test suites, and parks the
result for you to review. You read the diff and approve, and only then is a pull
request opened.

The guard **rejects** a change that:

- deletes or edits anything under `server/src/crypto/`, `web/src/lib/crypto.js`,
  the auth/security middleware, or `safe-fetch.js`
- modifies an already-applied migration
- deletes more than 800 lines overall

It also fails the job if tests fail.

`UPGRADE_DIRECT_PUSH=1` pushes to your main branch with nobody reading it. It
exists because the brief asked for it. Leave it off.

### Hardening a public server

```
ALLOW_SIGNUP=0          # invite-only
TRUST_PROXY=1           # you have Caddy/nginx in front
SESSION_IDLE_HOURS=48
MAX_FAILED_LOGINS=5
```

Then run the attack suite against yourself:

```bash
node security/pentest/run.js
TARGET=https://hub.example.com node security/pentest/run.js
```

It exits non-zero on any HIGH or CRITICAL finding, so it belongs in CI. It found
three real bugs in this codebase during development, including one that broke
account lockout entirely.

### Legal

A server holding other people's data creates obligations that vary by country.
Two things worth knowing:

- You genuinely cannot produce household content in response to a legal demand.
  You can produce email addresses, timestamps and sizes. Decide in advance how
  you will answer, and consider publishing a transparency policy.
- Encryption is restricted or illegal in some jurisdictions. If you are hosting
  for people in one, that is worth understanding before you start.

This is not legal advice.

---

## Troubleshooting

**"This browser has no Web Crypto API"** — you are on plain `http://` from
another machine. Web Crypto needs HTTPS. Use `localhost` or a TLS proxy.

**"Wrong password"** and you are sure it is right — check your email for
typos. There is no reset; if the password is genuinely gone, so is the
household.

**Check-in says "AI unavailable"** — `docker compose logs ollama`. Most often
the model was never pulled: `docker compose exec ollama ollama pull llama3.2:3b`.

**A member is stuck on "waiting for approval"** — an admin has to grant them a
key from Settings → Household. It cannot happen automatically; that is the
security property.

**A display shows "no longer available"** — it was revoked or expired, or the
household key was rotated after it was set up. Issue a new display link.

**Migrations refuse to run** — "Migration X changed after it was applied" means
an applied migration file was edited. Applied migrations are immutable; restore
the original and add a new one.
