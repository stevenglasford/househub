# Setting up a HouseHub server

From a bare machine to a working server, in order, with the things that
actually go wrong called out where they happen.

Three sizes:

- **[One household](#one-household)** — you and the people you live with. 20 minutes.
- **[A server for several families](#a-server-for-several-families)** — you host, they trust you with ciphertext. Add an hour.
- **[Everything switched on](#everything-switched-on)** — AI, cameras, Home Assistant, crypto billing, the self-upgrade pipeline.

---

## Before you start

**You need HTTPS.** Not "should have". HouseHub decrypts your household in the
browser using the Web Crypto API, which browsers only expose in a secure
context. Over plain `http://` from another machine the app cannot decrypt
anything at all and will say so. `localhost` works, because browsers treat it as
secure.

**Nobody can reset a password.** Not you, not the operator, not a court order.
The household key is derived from it and the server never sees it. Say this out
loud to everyone before they choose one. The signup form makes them tick a box
confirming they understand; that box is not decoration.

**Minimum hardware:** any 64-bit Linux box with 2 GB RAM and Docker. A
Raspberry Pi 5 is comfortable for one household. Add AI and you want 8 GB and
ideally a GPU.

---

## One household

### 1. Get the code

```bash
git clone https://github.com/stevenglasford/househub
cd househub
```

### 2. Configure

```bash
cp deploy/env.example .env
./scripts/generate-secret.sh >> .env
$EDITOR .env
```

Three lines matter:

```bash
PUBLIC_URL=https://hub.example.com    # exactly what people will type
POSTGRES_PASSWORD=<something long>
SECRET_KEY=<the script wrote this>
```

> **A `$` in your password must be written `$$`.** Docker Compose treats a single
> `$` as a variable and silently substitutes it away. The app reads the database
> credential as discrete `PG*` values, so `@ / # ?` are all fine — only `$` needs
> escaping, and only because of Compose.

> **Back up `SECRET_KEY` somewhere other than the server.** It seals email
> addresses, TOTP secrets, calendar URLs and integration tokens. Losing it does
> not lose household content — that is encrypted under members' own keys — but
> those server-side values become unrecoverable.

### 3. Start it

```bash
docker compose -f deploy/docker-compose.yml --env-file .env up -d
docker compose -f deploy/docker-compose.yml --env-file .env logs -f app
```

You want to see `[migrate] N migration(s) applied` then `HouseHub listening`.

> **`docker compose` not found?** You have the old standalone `docker-compose`.
> Install the v2 plugin without root:
> ```bash
> mkdir -p ~/.docker/cli-plugins
> curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
>   -o ~/.docker/cli-plugins/docker-compose
> chmod +x ~/.docker/cli-plugins/docker-compose
> ```

### 4. HTTPS

**Caddy** is least work:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile      # set your hostname
sudo systemctl reload caddy
```

**Already running nginx?** `sudo certbot --nginx -d hub.example.com`, then add
the proxy block from `deploy/nginx.conf.example`.

**Behind a path prefix** (`https://home.example.com/beta`)? Use
`deploy/nginx-subpath.conf.example` and set `PUBLIC_URL` to include the prefix.
The redirect in that file is load-bearing — without it every asset 404s.

### 5. First account

Open your URL and sign up. The first account is not special; it is only the
first one made.

Then, when everyone has an account:

```bash
sed -i 's/^ALLOW_SIGNUP=1/ALLOW_SIGNUP=0/' .env
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

Invitations keep working after that.

### 6. Add your household

**Settings → People → Create invite link.** Send it. They sign up through the
link and appear as *pending*, seeing nothing.

Then **check their key fingerprint against their screen and grant access.** This
is the one step in the whole system that depends on a human. The public key you
wrap the household key to comes from the server; if it substituted its own it
would be admitted. Reading five groups of hex to someone in the same room closes
that, and nothing else does.

---

## A server for several families

Everything above, plus:

### Be straight about what you can see

You can see that a household exists, how many members it has, and how many bytes
it stores. You cannot read any of it, and there is no endpoint that would let
you. **If someone loses their password you cannot help.** Say so at signup.

### Make yourself a super admin

There is no bootstrap admin and no default password. Sign up normally, then:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env \
  exec -T app node scripts/create-super-admin.js you@example.com
```

The super admin surface appears under **Settings → Server**.

### Harden

```bash
ALLOW_SIGNUP=0          # invite only
TRUST_PROXY=1           # you have a proxy in front
SESSION_IDLE_HOURS=48
MAX_FAILED_LOGINS=5
```

Then attack yourself:

```bash
node security/pentest/run.js
TARGET=https://hub.example.com node security/pentest/run.js
```

91 probes. Exits non-zero on anything HIGH or above, so it belongs in CI. It has
found four real bugs in this codebase, including one that broke account lockout
entirely and leaked which addresses had accounts.

### Back up

```bash
docker compose -f deploy/docker-compose.yml --env-file .env exec -T db \
  pg_dump -U househub househub | gzip > househub-$(date +%F).sql.gz
```

Store `SECRET_KEY` separately, somewhere else. The dump without it is useless
for emails and integration tokens — which is the point, and also the risk.

### Legal

A server holding other people's data creates obligations that vary by country.
[docs/PRIVACY.md](PRIVACY.md) is a starting point you should edit with your own
contact details and jurisdiction before publishing it to users. It is not legal
advice.

Two things worth deciding in advance: you genuinely cannot produce household
content in response to a legal demand, and encryption is restricted in some
jurisdictions.

---

## Everything switched on

### Local AI

The compose file can run Ollama for you:

```bash
docker compose -f deploy/docker-compose.yml --profile bundled-ollama --env-file .env up -d
```

**Already running Ollama?** Keep the models you have pulled:

```bash
echo 'OLLAMA_URL=http://127.0.0.1:11434' >> .env
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.hostnet.yml \
  --env-file .env up -d
```

That overlay puts the app on the host network so it reaches Ollama on loopback.
The usual advice — rebind Ollama to `0.0.0.0` — publishes an unauthenticated LLM
to your network and, if that port is forwarded, the internet. Don't.

`llama3.2:3b` runs on CPU. `qwen3:14b` is noticeably better with a GPU.

### Other AI providers

**Settings → Server → Advanced** adds Claude, OpenAI, or a remote Ollama.

Adding one **does not route anybody to it**. Each household chooses its own
under **Settings → AI**, and a non-local provider needs that household's
recorded consent — because their context would leave the machine. You cannot
make that choice for them, deliberately.

Local remains the only setting where "nothing leaves this machine" is true.

### Home Assistant

Per household, not per server: **Settings → Home Assistant**.
See [HOME-ASSISTANT.md](HOME-ASSISTANT.md).

Then **Settings → Devices** to name things, group them into rooms and order them.
A household is never going to rename `sensor.0x00158d0004a1b2c3_temperature`
upstream; calling it "Greenhouse" here takes two seconds.

### Security cameras

Plug in your own [CamWatch](https://github.com/stevenglasford/security):
**Settings → Cameras**. See [CAMERAS.md](CAMERAS.md).

No footage, faces or recordings are stored by HouseHub — everything is proxied
and forgotten.

### Wall displays

**Settings → Displays.** Every other admin must approve before one goes live,
and any of them can veto. The setup link is shown once and carries the display's
own key in the URL fragment, so the server can neither use nor reissue it.

**Keep the tab open between proposing and activating** — the display's private
key only exists in that browser until the key is wrapped to it.

### Crypto billing

**Settings → Server → Wallets.** Receive-only keys only: an `xpub`/`zpub` for
Bitcoin and Ethereum, and for Monero the primary address plus the **private view
key**. Never paste an `xprv`, a seed phrase, or a Monero spend key.

Each invoice gets a freshly derived address. Watching for payment needs a node:
Esplora-compatible for BTC, any JSON-RPC for ETH, and `monero-wallet-rpc` in
view-only mode for XMR — no explorer can see a Monero subaddress, which is the
point of Monero.

**Nonpayment freezes; it never deletes.** Please keep it that way.

### The self-upgrade pipeline

```bash
UPGRADES_ENABLED=1
UPGRADE_REPO_URL=https://github.com/you/househub
GITHUB_TOKEN=ghp_...
```

Needs the `claude` CLI on the host. Drop a zip in **Settings → Server →
Upgrades**; it clones, runs Claude Code against a constrained prompt, applies an
additive-only guard, runs the tests, and parks the diff for you to review.
Approving opens a pull request.

`UPGRADE_DIRECT_PUSH=1` pushes to main with nobody reading it. It exists because
it was asked for. Leave it off.

---

## Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

Migrations run at boot. They are forward-only and immutable: editing an applied
migration is a hard error, not a silent no-op.

## Troubleshooting

**"This browser has no Web Crypto API"** — plain `http://` from another machine.

**"Wrong password" and you are sure it is right** — check the email for typos.
There is no reset; if the password is genuinely gone, so is the household.

**"Migration X changed after it was applied"** — someone edited an applied
migration. Restore it and add a new one.

**Members stuck on "waiting for approval"** — an admin must grant them a key
from Settings → People. It cannot happen automatically; that is the security
property.

**Check-in says AI unavailable** — `docker compose logs ollama`. Usually the
model was never pulled: `docker compose exec ollama ollama pull llama3.2:3b`.

**A display says "no longer available"** — revoked, expired, or the household key
was rotated after it was set up. Issue a new link.

## Where things live

| | |
|---|---|
| Your data | Postgres volume `househub_db-data` |
| Root secret | `.env` → `SECRET_KEY` |
| Built front-end | `server/public/` (regenerated by `npm run build`) |
| Upgrade scratch | `househub_upgrade-work` volume |
| Logs | `docker compose logs app` |
