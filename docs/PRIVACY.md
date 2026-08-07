# Privacy and data protection

Written for two readers: a person deciding whether to trust a HouseHub server,
and an operator running one for other families who needs to know what they have
taken on.

It is specific about the awkward parts. A privacy notice that only describes the
comfortable ones is not much use to either.

---

## The short version

The server stores your household's contents as ciphertext it cannot read. It
holds your email address, encrypted. It knows how often you save and roughly how
much. That is close to the whole list.

You can download everything it has about you, and delete your account yourself,
from **Settings → Your data**.

---

## Who is responsible for what

**HouseHub is software, not a service.** Whoever runs the server you use is the
data controller. If you self-host, that is you.

For household contents there is a further wrinkle worth stating plainly: the
server operator is not in any meaningful sense a controller of them. They cannot
read, index, search, correct or selectively delete a household document, because
they do not have the key. In practice the **members of a household are joint
controllers of their own household's data**, and the operator is closer to a
processor of ciphertext.

That is not a way of dodging obligations. It is what the encryption makes true,
and it changes what can honestly be promised — see [erasure](#erasure) below.

---

## What is stored, and why

| Data | Form | Why it exists |
|---|---|---|
| Household contents | AES-256-GCM ciphertext | The whole product |
| Email address | Encrypted; looked up by keyed fingerprint | Sign-in, invitations |
| Display name | Encrypted | Showing who is who |
| Password | **Not stored.** An Argon2id hash of a value derived from it | Proving it is you |
| Encryption keys | Your private key, encrypted under your password | So only you can decrypt |
| Sessions | Hash of the token; salted hashes of IP and browser | Keeping you signed in |
| Activity log | Action names and account ids, never content | Tamper-evident record |
| Vault size, save times | Plaintext | Quotas, sync, billing |
| Calendar feed URL and contents | Encrypted under the server key | Browsers cannot fetch them (CORS) |
| Home Assistant address and token | Encrypted under the server key | The server has to make the calls |

**Lawful basis** (GDPR Article 6): performance of a contract — you asked for a
household organiser, this is what running one requires. Not consent, so there is
no consent to withdraw; the equivalent is deleting your account.

**Special category data** (Article 9): a household document may contain health
notes, religious observances, or information revealing sexual orientation — this
software was built by and for a same-sex couple and assumes that. The server
cannot read any of it. That is the protection, and it is a stronger one than a
policy commitment.

---

## Your rights, and how to use them

### Access and portability (Articles 15 and 20)

**Settings → Your data** offers two downloads, and the distinction matters:

**Your account data** — everything the server holds about *you*: account,
memberships, sessions, and the activity log entries naming you. Machine-readable
JSON, produced by the server, which is the controller of it.

**This household** — the calendar, chores, lists, notes, history. Decrypted in
your browser, because the server cannot produce it. This is your *household's*
data, written jointly by everyone living there, and it contains personal data
about other people. It is offered as portability of data you co-control, not as
a subject access response about you.

Article 15(4) says a copy must not adversely affect the rights of others. A
household document is full of others. You can already read every word of it —
you have the key — so exporting it discloses nothing new to you. Sharing it
onward is your responsibility as a joint controller, and the file says so at the
top.

### Rectification (Article 16)

Your account details are in Settings. Household contents are edited in the app
like anything else.

### Erasure (Article 17)

**Settings → Your data → Delete my account.** Available to every role — admin,
adult, dependant, viewer. A right only some people can exercise is not a right.

Deleting your account destroys:

- your email address, display name, and password verifier
- your encryption keys, and with them your access to any household
- your sessions and two-factor secret
- your membership of every household
- any household where you were the only member (nobody else holds a key, so its
  contents are already permanently unreadable)

It does **not** destroy:

- **households you shared with other people.** Those are theirs too. One person
  leaving does not delete a family's calendar.
- **your name or entries inside a shared household.** The server cannot read
  that document, so it cannot find you in it. Ask a member to edit it, or do it
  yourself before you delete your account. This is a genuine limitation of
  end-to-end encryption and we would rather say so than pretend otherwise.
- **activity log entries.** These keep an account id and an action name. Once
  the account is deleted the id resolves to nobody, which is what makes an
  append-only log compatible with erasure rather than opposed to it. Retained
  under Article 17(3)(b)/(e) — the log is what makes it possible to show whether
  a security control was actually enforced.

**One blocker.** If you are the only admin of a household other people still
live in, deletion is refused until you promote another admin. Otherwise nobody
left could add a member, approve a display, or rotate the key — their household
would be permanently stuck. The request is recorded when this happens, so the
one-month deadline in Article 12(3) runs from a date rather than a memory.

### Objection and restriction (Articles 18, 21)

There is no profiling, no advertising, no automated decision-making, and no
third-party analytics. Nothing to object to. If you disagree with how a server
is run, export your data and leave — that is the strongest form of restriction
available and it needs nobody's cooperation.

---

## Where data goes

Nowhere, by default. Specifically:

- **AI** is a local Ollama on the same machine. The code refuses a non-local
  host, and there is no remote-provider option to enable.
- **Weather** is fetched by your *browser* from Open-Meteo, so the server never
  learns where you live. Open-Meteo sees an approximate location. Set
  `WEATHER_PROXY=1` to reverse that trade.
- **Calendar feeds** are fetched by the server from Google/Apple/whoever you
  subscribed to. They see your server's address.
- **Home Assistant** is on your own network.
- **No analytics, no error reporting, no CDN.** The Content-Security-Policy
  blocks external requests, and the fonts are self-hosted for the same reason.

## Retention

| Data | Kept |
|---|---|
| Household contents | Until deleted by a member |
| Vault revisions | Last 50 |
| Account | Until deleted |
| Sessions | 14 days, or 7 days idle; purged a week after |
| Activity log | Indefinitely, pseudonymous |
| Invitations | 30 days after expiry |
| Households with no members | 30 days, then deleted |

## Breach

The honest position: a database breach exposes ciphertext. Household contents
would not be readable. A full host compromise additionally exposes the server
key, and with it email addresses, calendar URLs and Home Assistant tokens —
which would be notifiable under Article 33.

Operators: `node security/pentest/run.js` runs 90+ attack probes and exits
non-zero on anything serious. Put it in CI.

## Children

Guardians can create accounts for children (`dependent` role). The guardian
chooses the password and can therefore access that account; a child who later
sets their own password ends that. Under GDPR a guardian generally exercises
these rights on behalf of a young child. Nothing about a dependent account is
processed differently by the server — it cannot tell them apart, because it
cannot read anything.

## Complaints

Raise it with whoever runs your server first. In the EU/UK you have the right to
complain to your data protection authority regardless.

---

## For operators

If you run this for other people, you take on controller obligations for the
account-level data. Practical notes:

- **You cannot honour a subject access request for household contents.** You
  cannot read them. Point the person at Settings → Your data, where their
  browser can.
- **You cannot comply with an order to produce a family's data.** Design, not
  policy. Decide in advance how you will answer, and consider publishing a
  transparency statement.
- **`SECRET_KEY` is the sensitive thing you hold.** With it, a host compromise
  exposes emails and integration tokens. Keep it out of the database backup.
- **Suspension is read-only, never deletion.** Nonpayment must not destroy
  anyone's data; the code enforces this and please leave it that way.
- Fill in your own contact details, jurisdiction and DPA before publishing this
  document to your users. It is a starting point, not legal advice.
