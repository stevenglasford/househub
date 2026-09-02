# Contributing

Pull requests welcome. The codebase has a small number of rules that are not
style preferences — they are the reasons the privacy claims are true — and a PR
that breaks one will be sent back however good it otherwise is.

## The rules

**1. Nothing may give the server the ability to read household content.**

If a feature seems to need it, it belongs in the client. The server stores
ciphertext, wrapped keys it cannot open, and the minimum scaffolding to decide
who may fetch which blob. That is the whole design.

The honest exceptions already exist and are documented: calendar feed URLs
(browsers cannot fetch them, CORS), Home Assistant and CamWatch credentials (the
server makes those calls), and AI context for the duration of one request. Each
is sealed under the server key and named in `docs/THREAT-MODEL.md`. Adding a
fourth needs a very good argument.

**2. Applied migrations are immutable.**

Schema changes go in a new numbered file. The runner refuses to start if an
applied migration's checksum changes — a loud failure rather than a silent
divergence.

**3. Locks are member-only.**

A wall display can switch lights, blinds, fans and switches. It can never
operate a lock, and the check is against the caller rather than a stored
capability list, so no configuration can grant it. A screen mounted by the front
door that can unlock the front door is a keypad with no code.

**4. Erasure and export must work for every role.**

A right only some people can exercise is not a right.

## Before opening a PR

```bash
cd server && npm test          # 216 tests
cd ../web && npm test          # 374 tests
node security/pentest/run.js   # 91 probes, non-zero exit on HIGH+
```

**Run the server suite on its own.** Those tests share state, so two of them
running at once fail in bulk and for no reason either run can tell you about —
a concurrent pair here reported 65 failures that a single run reported as zero.
If you see a wall of server failures, check nothing else is running before
believing any of it.

The end-to-end suite asserts the architecture directly rather than testing
handlers: that the database holds no plaintext, that a wrapped key cannot be
moved between members, that one admin cannot activate a display alone, that a
display is refused a lock even when granted every other domain.

If you change behaviour those tests describe, change the test in the same commit
and say why in the message.

## Style

Match what is around you. Some specifics that come up:

- **Comments explain why, not what.** The interesting ones in this codebase are
  the trade-offs: why a display's completion is editable and a member's is not,
  why archiving is per-member, why consent is cleared when a provider changes.
- **Errors are for the person reading them.** "Only the person who ticked this
  off can un-tick it" beats "403 Forbidden".
- **No new dependencies on the auth or crypto path** without a reason that
  survives being said out loud. Every package there is a supply-chain foothold
  on the code that decides who gets in.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

MIT. By contributing you agree your work is licensed the same way.
