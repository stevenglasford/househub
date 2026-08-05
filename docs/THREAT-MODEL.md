# Threat model

This document says what HouseHub protects, what it does not, and where the
seams are. It is deliberately specific about the limits, because a security
document that only lists strengths is marketing.

HouseHub exists partly for households whose lives are nobody else's business
and who may face real consequences if that changes — a queer couple, an
undocumented family, someone with a violent ex, a household in a country where
their relationship is illegal. The design below assumes that reader.

---

## 1. What is protected

**Household content.** Everything a family writes — calendar entries, meals,
chores, grocery lists, notes, discussion topics, check-in answers, date ideas —
lives in one document sealed with AES-256-GCM under a key the server never
receives.

The key chain:

```
password
   │ PBKDF2-SHA256, 650k iterations, per-user salt, 64 bytes out
   ├──[0..32)──> key-encryption key ──unwraps──> master key ──unwraps──> X25519 private key
   │                                                                            │
   └──[32..64)─> auth proof ─────> the server stores an Argon2id verifier of this
                                                                                │
        household key (random 32 bytes) <──── ECDH-ES unwrap ───────────────────┘
                     │
                     └── AES-256-GCM ──> the household document
```

Two independent values come from the same password. The server sees only the
auth proof, and only ever stores an Argon2id hash of it. **The password itself
is never transmitted.** A fully compromised server that logs every request body
still cannot derive the key-encryption key.

**Consequence, stated plainly:** there is no password reset. Nobody can recover
a household for someone who forgets. That is not an omission.

---

## 2. Who this defends against, and how well

### The server operator — including you, if you sell this

**Defended.** The operator can see that a household exists, how many members it
has, how many bytes its vault occupies, and when it was last written. They
cannot read a single item in it.

They cannot add themselves to a household either. Membership requires the
household key to be wrapped to the newcomer's public key, and only a member
device can perform that wrap. An operator who inserts a row in
`household_members` gets an account that loads a ciphertext it cannot open.

### Someone who seizes or steals the server

**Defended for household content.** A `pg_dump`, a stolen disk, or a warrant
executed against the machine yields ciphertext. The operator cannot comply with
an order to produce a family's data because they cannot produce it.

Operational metadata (email addresses, TOTP secrets, calendar subscription URLs,
wallet configuration) is sealed under a server-side key derived from
`SECRET_KEY`, which lives outside the database. A database dump alone does not
reveal them. **A full host compromise — disk plus environment — does**, because
the server must be able to read those to function.

### A network attacker

**Defended**, assuming TLS. Run behind Caddy or nginx with a real certificate.
The app refuses to run its crypto outside a secure context, because Web Crypto
is unavailable there.

### Another household on the same server

**Defended.** Cross-household access returns 404, and the pentest suite probes
this on every household-scoped route. Even if authorisation failed, the
ciphertext is sealed under a different key, and the household id is bound into
the AEAD's associated data — so a blob moved between rows fails to open rather
than silently decrypting.

### A removed member

**Defended going forward, after rotation.** Removal is immediate: their wrapped
key row is deleted and API access stops. But if they kept a copy of ciphertext
they already downloaded, their old household key still opens it. **Rotating the
household key is what actually cuts them off**, and the API says so in the
removal response rather than implying the job is done.

Rotation cannot un-see what they already read. Nothing can.

### A thief who takes the wall tablet

**Partially defended.** The display's link dies the moment it is revoked. But
the device held the household key while it was running, and it renders from the
full document — so a display "scoped" to three panels still had the whole
document in memory.

This is a real limitation and it is not fixable without a redesign in which a
member's device publishes pre-filtered projections for each display. That is a
worthwhile future change; it is not what ships today. **If a display device is
lost, revoke it and rotate the key.** If a household needs a screen that
genuinely cannot see everything, the honest answer today is a second household.

---

## 3. Where the guarantees stop

### Malicious or modified server code

The end-to-end encryption is performed by JavaScript the server delivers. An
operator who modifies `web/src/lib/crypto.js` can make the browser exfiltrate
keys. **This is the fundamental limit of browser-delivered E2E encryption and it
applies to every web application that claims it**, including much larger ones.

What reduces it here:

- The code is open. A modified build is detectable by comparing against the
  published source.
- A strict Content-Security-Policy (`script-src 'self'`, no `unsafe-eval`, no
  CDN) means injected script cannot load from elsewhere.
- Self-hosting removes the problem entirely: you are the operator.

If your threat model includes the operator actively attacking you, self-host.
That is why the self-hosting documentation exists and why the licence is MIT.

### Key substitution when admitting a member

When an admin admits someone, their client wraps the household key to a public
key **the server supplied**. A malicious server could supply its own and be
admitted.

The mitigation is out-of-band verification: the UI shows the newcomer's key
fingerprint and asks the admin to confirm it. For a household this is easy —
they are usually in the same room. The join flow says so explicitly rather than
burying it.

### Traffic analysis

The server sees when each household writes, and roughly how much. Over time that
reveals waking hours, holidays, and when a household goes quiet. Content is
sealed; rhythm is not.

### AI generation

Generating a check-in question requires context, and context means the client
sends a small amount of decrypted signal to `/api/ai/...` for the duration of
one request. It is never stored, never logged, and never leaves the machine —
inference is local Ollama and `services/ollama.js` refuses a non-local host.

But it is plaintext in the server's memory while it runs, and an operator who
modified that route could log it. Households that would rather not: the default
privacy mode already sends counts ("2 overdue tasks") rather than content, and
AI can be switched off per server (`AI_ENABLED=0`).

### Weather

The browser fetches Open-Meteo directly so that **this server never learns where
the household lives**. The trade is that Open-Meteo and any network observer see
an approximate location. Set `WEATHER_PROXY=1` to reverse the choice.

### Metadata the server must hold

| Data | Protection | Why the server needs it |
|---|---|---|
| Email address | Sealed; looked up by blind index | Login, invitations |
| Session tokens | SHA-256 hash only | Authentication |
| Display links | SHA-256 hash only | Serving the display |
| Calendar feed URL and body | Sealed under the server key | Browsers cannot fetch them (CORS) |
| Member count, vault size | Plaintext | Quotas and billing |
| Household name | Sealed under the *household* key | Shown in the member's list |

Blind indexes are deterministic, so they leak "these two rows share an address"
to anyone holding the pepper, and permit offline guess-and-check against a known
address. That is why the pepper lives outside the database.

### Known weaknesses accepted for now

- **PBKDF2, not Argon2id, in the browser.** Argon2id resists GPU cracking far
  better, but it is not in Web Crypto, and a WASM build means the login page
  breaks if one asset fails to load. KDF parameters are stored per-user and sent
  at login, so switching is a per-account upgrade rather than a flag day.
- **DNS rebinding in `safe-fetch.js`.** Addresses are checked at resolution
  time; between that check and the socket connecting, DNS could change. Closing
  it fully needs connection pinning that undici does not currently expose. The
  payoff for an attacker is a response body readable only through a calendar
  parser.
- **Display approvals are proofs, not signatures.** `approvalProof` derives a
  value from the approving admin's X25519 key rather than producing an Ed25519
  signature. It prevents the *server* forging an approval; a proper signature
  would also be independently verifiable by third parties. A dedicated signing
  keypair is the fix.

---

## 4. What an attacker gets at each level

| They have | They can read |
|---|---|
| Network traffic (TLS) | Nothing but timing and volume |
| A database dump | Nothing. No household content, no emails, no tokens |
| Database + `SECRET_KEY` | Emails, TOTP secrets, calendar URLs, wallet config. **No household content** |
| Full host, running server | The above, plus anything in memory during a request. Still no household key for a member who is not signed in at that moment |
| A member's password | That member's households, in full |
| A running, unlocked member device | Everything that member can see |

The jump that matters is the last two. Everything above them is defended; a
compromised member is not, and cannot be.

---

## 5. Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). If you find a way to read a household's
content without a member's password, that is the finding this project most wants
to hear about.

## 6. Verifying the claims yourself

```bash
cd server && npm test          # includes crypto, SSRF, archive and end-to-end suites
node security/pentest/run.js   # 90+ attack probes against a live server
```

The end-to-end suite asserts these properties directly — that the database holds
no plaintext, that a wrapped key cannot be moved between members, that one admin
cannot activate a display alone, and that rotation removes a former member's
key. If a change breaks one of them, the suite fails.
