# Moving from the old HouseHub

Everything comes across: people, chores and their whole completion history,
tasks, meals, notes, projects, important dates, the agenda archive, date ideas,
check-in history and calendar subscriptions.

Nothing is deleted from the old system. The import reads a **copy** of its
database; the old hub keeps running until you decide otherwise.

## What you need

The old app's database, from the machine it runs on:

| Version | File |
|---|---|
| Any recent one | `server/househub.db` (or wherever `DB_FILE` pointed) |
| Very early ones | `server/data.json` |

**If you take `househub.db`, take `househub.db-wal` too.** This matters more
than it sounds. The old app ran SQLite in WAL mode, which means recent writes
live in a separate `-wal` file until they get folded in. A database copied from
a running server without it opens perfectly happily and shows you an *older*
household — no error, no warning, just last week missing. The importer detects
this and says so, but it is easier to copy both.

The cleanest approach:

```bash
# on the old machine
sudo systemctl stop household-hub          # or however you run it
cp server/househub.db  ~/househub-backup.db
cp server/househub.db-wal ~/ 2>/dev/null   # only exists if it wasn't stopped cleanly
```

If you cannot stop it, copy both files and select both — they are put back
together in the browser.

## Doing it

1. Sign in to the new HouseHub as an **admin** of the household you want to
   import into. Ideally a brand-new, empty one.
2. **Settings → Import from the old HouseHub**
3. Drop the file (or files) on. Nothing is written yet.
4. Read what it found — a count of every collection, and any warnings.
5. Press **Import**.

If the household you are importing into already has anything in it, the button
says **Replace this household** and lists exactly what will be lost. An import
replaces; it does not merge. Two households' worth of people with different
internal ids cannot be sensibly interleaved, and pretending otherwise would
produce a mess nobody could untangle.

## The file never leaves your browser

This is the part worth understanding, because it is why the screen works the way
it does.

The server cannot read your household. It holds ciphertext and no key. So it
*cannot* accept your old database and convert it for you — there would be
nothing it could do with the result except hand it back.

Instead the whole conversion happens in the browser tab: the file is read from
your disk with the File API, converted in memory, encrypted with your household
key, and only then sent. The server receives ciphertext and nothing else.

That also rules out the usual way of reading SQLite in a browser, `sql.js`,
which is a WebAssembly build and needs `wasm-unsafe-eval` in the
Content-Security-Policy. That policy is what protects the encryption keys from
injected script, so instead there is a small read-only SQLite reader in plain
JavaScript (`web/src/lib/sqlite.js`).

## What changes, and what does not

**Chore completions come across exactly as they were recorded.** The old app
stored either `true`, a person's id, or `"skipped"`. The new one records who
ticked it, from which device, and whether that claim can be edited afterwards.
Old marks keep whoever was credited and are shown as unverified — the old app
never stored which device did it, and inventing an actor for a tick from two
years ago would be forging a record rather than migrating one.

**Calendar subscriptions are re-added rather than copied.** Feeds live
server-side in the new system, sealed under the server key, because a browser
cannot fetch a Google or iCloud feed itself. Feeds with a URL start refreshing
again on their own; ones that were imported from a file come across as a fixed
snapshot, exactly as they were.

**Person ids are preserved**, so every chore, task, meal and note stays attached
to the right person.

**List order is preserved.** If you dragged your grocery list into the order of
the aisles at your shop, it arrives in that order.

**The old voice token is not imported.** It was a bearer credential sitting in
the clear in the old document; those routes now use your normal sign-in, so
carrying it over would only import a stray secret from the system you are
leaving.

**Nothing is switched on for you.** The chore archive stays off, and phone
reminders stay off. Both are decisions for the household, not side effects of
an import.

## If something looks wrong

Nothing has been destroyed. Your old database is untouched, and you still have
the copy. Fix whatever it was and import again — a second import replaces the
first.

If a record could not be read, the importer says so by name before you commit
rather than skipping it silently.

## For the maintainers

The importer is tested against real SQLite files written by SQLite itself, not
by our own code — a fixture produced by the thing under test would prove
nothing. `web/test/fixtures/make-legacy-db.py` builds them, and `npm test` in
`web/` runs it first.

The fixtures are deliberately awkward in the ways a real household database is:

- 400 chores, so the table spans interior B-tree pages
- a 44 KB iCalendar body, so that row needs an overflow chain
- a grocery list whose `pos` order disagrees with its rowid order
- a live-copied WAL pair whose main file and log genuinely disagree
