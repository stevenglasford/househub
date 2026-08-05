# Security policy

## Reporting a vulnerability

Email **steven@glasford.io** with `HouseHub security` in the subject. Please do
not open a public issue for anything that lets someone read a household's data.

Include what you did, what happened, and what you expected. A proof of concept
against your own test instance is ideal.

Expect an acknowledgement within a few days. This is a small project, not a
company with a response team; that is the honest expectation to set.

## What this project most wants to hear about

In rough order of severity:

1. **Reading household content without a member's password.** This is the
   central claim. Anything that breaks it is critical.
2. **Getting a household key wrapped to a key you control** — impersonating a
   member during the join handshake, or bypassing display sign-off.
3. **Cross-household access** — reaching another family's ciphertext or metadata.
4. **Authentication bypass** — forging a session or a display token.
5. **Server-side request forgery** via calendar feeds, or escaping the archive
   extraction in the upgrade pipeline.
6. **Account enumeration** — anything that reveals whether an address has an
   account here. For this project's users that can matter a great deal.

## Already known

These are documented in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) rather than
being findings:

- The E2E code is delivered by the server, so a malicious operator can subvert
  it. Self-hosting is the answer; this is inherent to browser-delivered E2E.
- A wall display holds the household key even when it renders only some panels.
- Removing a member requires a key rotation to be complete.
- Blind indexes on email are deterministic and permit offline guess-and-check by
  someone holding the pepper.
- `safe-fetch.js` checks addresses at resolution time, leaving a narrow DNS
  rebinding window.

## Before you report

Run the suites first — they cover a lot of ground and will tell you quickly
whether something is already handled:

```bash
cd server && npm test
node security/pentest/run.js
```

## Scope

Test against your own instance. Do not attack a server you do not run.
