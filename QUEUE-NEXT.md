# Work queue — next round

Ryan's list of 1 Sep 2026, each item checked against the working tree rather
than taken at face value. Where something already half exists, that is said,
because "build it" and "finish wiring it" are very different amounts of work
and the last round was mostly the latter.

Branch: `feat/timers` off `beta` (`9553cbb`).

**All six are done.** What follows the sixth is a second round of work Ryan
asked for while testing, which is also done, plus the one thing that is not.

---

## 1. Settings is one long scroll ✅ *(done)*

**What is there.** `SettingsModal` (`web/src/App.jsx:7519`) is a flat column of
about fifteen `<Field>` rows: Household name, People, Archive, Displays, Home
Assistant, Devices, Cameras, AI, Two-way calendar sync, Extra row on Today,
Import, Staying signed in, Your data, Server (super admin), Account. Several of
those open panels that are themselves long — the weather block alone has
location, latitude, longitude and units.

**The shape of the fix.** Group into a handful of sections with the modal
holding one at a time. The grouping that falls out of the list is roughly:

- **Household** — name, people, display mode, per-person summary, sticky notes
- **Screens** — displays, the extra row on Today, "Up next" sources
- **Connections** — Home Assistant, devices, cameras, calendar sync, AI
- **Reminders** — chime, phone reminders
- **Account & data** — staying signed in, your data, import, archive, account
- **Server** — super admin only, and already conditional

**Built, and the problem was worse than a scroll.** There was *already* a tab
strip — People / Calendar sync / Weather / Voice / Home / Check-in — sitting
**underneath** the twenty flat fields. So half of Settings was tabbed, the other
half was not, and the tabs were below the scroll they were meant to be
navigating.

Now one nav at the top and one section at a time: **Household · Screens ·
Connections · Evening · Record · Account & data · Server** (the last only for a
super admin). Grouped by what somebody came in to change rather than by which
part of the code owns it — "Displays" and "Sticky notes on Today" are both about
what the screens show and were four hundred lines apart.

"Reset everything" now sits at the bottom of Account & data rather than under
every section: a button that wipes the household and follows you around is one
that eventually gets pressed.

A DOM test walks every section and asserts each pre-existing field is still
reachable, since the real risk in a restructure like this is silently dropping
one.

## 2. One history section in To-Dos ✅ *(done)*

> "merge the To-do history and the Chores history/log/archive from the settings
> into one reports or history section in the to-dos tab"

**What is there.** Two separate things, in two places:

- `HistoryModal` (`App.jsx:7024`) — reached from the To-Dos tab, covers
  completed chores and tasks over a 7-day-to-3-month window, with the per-person
  tally and the Report toggle built last round.
- `ArchivePanel` (`web/src/components/ArchivePanel.jsx:30`) — reached from
  **Settings → Archive**.

So the work is mostly moving `ArchivePanel` out of Settings and folding it in as
a third view alongside History and Report, then deleting the Settings row.

**That warning was right, so the panel was split rather than moved.**
`ArchivePanel` does two very different things: it shows the record, *and* it
holds the admin controls — turning archiving on, and the all-admins proposal
flow for turning it off, which permanently destroys the record.

- `ArchiveRecord` (the record, and reattribution) → **To-Dos → History →
  Archive**, as a third view beside History and Report.
- `ArchivePanel` (the controls) → **stays in Settings → Record**, and
  deliberately does not follow the record onto a tab a shared display can reach.
  A wall tablet in a hallway is not where "wipe the archive" should be one tap
  away.

**One bug found in the writing:** the view switch was going inside the tally
bar, which only renders when something was completed in the current window —
making Archive unreachable for exactly the household most likely to want the
older record. It is now outside it, and there is a test for that case.

## 3. Rename the Agenda tab ✅ *(done)*

> "Change the agenda tab to something more appropriate like 'relationship' or
> something like that"

**What is there.** `{ id: "agenda", label: "Agenda", Icon: MessageCircle }`
(`App.jsx:1684`). The tab holds three panes: **Topics** (things to talk about
tonight), **Status** (the happiness/connection/intimacy check-in and its graph),
and **Date jar**.

**On the name.** "Relationship" is accurate for this household and wrong for the
app: the README's whole pitch is that it was rebuilt "so it works for any
household of any shape", and three housemates sharing a flat will not open a
Relationship tab. Names worth weighing, all of which cover the same three panes:

- **Together** — works for partners and for housemates, and is the only one that
  reads naturally above "Topics / Status / Date jar"
- **Us** — shorter, warmer, same breadth
- **Check-in** — names the nightly ritual the tab is built around, and matches
  the vocabulary already used everywhere else in the code
- **Relationship** — most accurate for a couple, narrowest for everyone else

**Recommendation: "Together"**, with the label made a household setting if it
turns out people care. The tab id stays `agenda` either way — it is in display
scopes and saved layouts, and renaming the id would quietly break both.

**Built as "Together".** Three user-facing strings, not one: the tab
(`App.jsx:1684`), the display-scope list (`DisplaysPanel.jsx:36`) and the date
jar's pointer back to it (`SecondBlock.jsx:159`). Renaming only the tab would
have left the household reading two names for one place. Say the word and it
becomes "Us", "Check-in" or "Relationship" — it is a one-line change now.

## 4. Who added it, in Lists ✅ *(done)*

> "In the lists tab, mark or make the ability, to mark who made or started the
> list or added an item. If they're logged in then just log it automatically, if
> they are on a display, then it should prompt for who's entering it."

**What is there.** `lists: []` is `{ id, title, icon, color, items[], createdOn,
updatedOn }` (`web/src/lib/document.js:118`) — no `personId` on a list and none
on an item. `web/src/lib/lists.js` has the full item API (`createList`,
`addItem`, `editItem`, …), all of which take an `at` already, so there is a
natural place to add a `by`.

**The pattern to copy, not reinvent.** This is exactly the problem chore
attribution solved last round, and the answer should match it:

- A signed-in member's entry is a first-person claim — attribute it silently
  from the session, and mark it locked the way `completion.js` does.
- A display has no signed-in person, which is why it must ask. `CreditPicker`
  (`App.jsx`) is already the control for precisely this question and is already
  used from display surfaces.
- A display's entry should be **correctable** and a member's own should not,
  for the same reasons set out in `completion.js:154`.

**Built, copying chore attribution's rules exactly** rather than inventing a
second meaning for "who". `lib/lists.js` gained `attribute()`, `canReattribute()`,
`reattributed()` and `attributeItem()`; lists and items each carry a `by`.

- A signed-in member is recorded silently from the session and **locked** — a
  first-person claim nothing anonymous rewrites.
- A display **asks once**, then remembers for the visit. A picker between every
  item is a control people route around by tapping whoever is first, which
  produces worse data than asking nothing. The memory is component state, so
  leaving the tab forgets it and the next person is asked rather than inheriting
  the last one's name.
- A display's entry stays **correctable**; tapping the name opens the picker.
  A member's own does not, and refuses loudly rather than silently.
- Entries predating this have no `by` and stay that way — "we do not know",
  not a guess.

## 5. Dates under the status graph ✅ *(done)*

> "make it so that the 'agenda' has dates associated with the history on the
> bottom of the graph so we can tell what day was what"

**What is there.** `StatusGraph` (`App.jsx:3610`) plots one series per person
over a 7/30/90-day window. It reserves `PAD.b = 20` at the bottom of the SVG and
then draws nothing in it — the x-axis is entirely unlabelled, so the shape is
readable and *when* is not.

**Built.** `axisTicks(todayKey, days)` in `web/src/lib/status.js`, drawn into
the reserved band by `StatusGraph`. Density is chosen by window, because the
tick count that reads well across a week is a smear across three months:

- **a week** — every day, by weekday: "Wed", "Thu"
- **a month** — roughly every five days, by date: "12 Aug"
- **longer** — the first of each month: "Jun", "Jul", "Aug"

Today is always labelled and never doubled up with a neighbouring tick. Six
tests in `web/test/status.test.js` cover the densities, the ordering and the
no-overlap rule.

## 6. What is new on the calendar ✅ *(done)*

> "I want to be able to see what are new items that have been added to the
> calendar somehow that can be specific to the calendar and the person viewing"

**The hard half is "new to whom".** "Added recently" is a property of the event;
"new to me" is a property of the *reader*, and the app currently stores nothing
per-reader. Two candidate designs:

- **Seen markers.** Each person gets `seenCalendar: { <personId>: epochMs }` in
  the document; anything created after their marker is new to them, and opening
  the tab moves it. Cheap, and genuinely per-person.
- **Added-at only.** Show a dot on anything created in the last N days. Much
  less work, and identical for everybody looking at it — which is exactly the
  distinction Ryan asked for, so this is the weaker option.

**Built the first.** Two details it needed:

- A display has no signed-in person, so it has no marker. It should show
  household-wide recency rather than nothing, or the wall display's dots would
  never clear.
- Subscribed events already carry `feedId` and rejoin to a calendar's person and
  colour (`web/src/lib/feed-events.js`). A per-calendar filter for "new" should
  reuse that join rather than growing a second one — the last round's note about
  `feedId` vs `calendarId` applies here exactly.

**What it needed that did not exist:** neither kind of event recorded *when it
was added*. Hub events now stamp `addedAt` on creation only — stamping on edit
would make "new" mean "touched", and a fixed typo would reappear as news.
Subscribed events get it from the feed's `CREATED`, falling back to `DTSTAMP`
(`server/src/services/ics.js`, plus `icsInstant()`).

An event with no `addedAt` is **never** new. Everything written before this has
none, and treating those as new would light the whole calendar up on the day it
ships — which teaches people to ignore the marker before it has been useful
once.

`seenCalendar` merges per person in `mergeDocuments`, so two people looking on
two devices at the same moment cannot overwrite each other's mark. The mark
moves 2.5s after opening the Calendar tab, so the dots are seen rather than
cleared on the way in. 9 tests in `web/test/new-events.test.js`, 4 more in the
server's `ics.test.js`.

---

## Voice, and where the wake word should live

Open question from Ryan, kept out of the numbered list because it is a design
decision rather than a task. See the notes in `web/src/components/TimersPanel.jsx`
for what is currently built (push-to-talk, browser-local).

The short version: **Home Assistant is the right place for a wake word, and the
encryption is what makes it awkward.** HA already does local wake-word detection
and speech-to-text on the household's own hardware, HouseHub already talks to
one HA per household over its REST API, and `conversation` is already a known
domain in the bridge (`server/src/services/homeassistant.js:125`).

The catch is that the HouseHub server cannot write a timer. It holds ciphertext
and no key, by design — so a command arriving from HA has to reach a browser
that is signed in before it can become anything. That is a real design problem
with real options, and it should be settled before any of it is built.


---

# Round two — asked for while testing, 1–2 Sep

### Kitchen timers
Named, multiple, shared across every screen, with an alarm. No timer state is a
flag: everything derives from two absolute timestamps, so a wall tablet that was
asleep computes the same answer as the phone that watched the countdown.
Silencing writes to the document, so one tap quiets the house. `lib/timers.js`,
`lib/timer-voice.js`, `components/TimersPanel.jsx`.

### The iPad was silent
Reminders chimed on a laptop and not on the wall tablet. iOS routes Web Audio
through the *ringer* channel, so the mute switch killed it; a laptop has no such
switch, which is why identical code behaved differently and the test button
reported success on the machine that was not broken.

The chime is now rendered to a WAV (`lib/chime-wav.js`) and played through one
`<audio>` element whose source is swapped — not an optimisation, but how the
permission works: iOS grants playback to an *element* played inside a gesture,
and the grant survives a later `src` change. The oscillator path stays as the
fallback. **Unverified on real hardware.**

### Custom alert sounds
Not recordings. The document is re-encrypted and re-uploaded on every change, so
audio stored in it would be re-sent every time somebody ticked a chore. Instead:
**speech** (the screen says the reminder's name — "Bins out", which beats any
beep from another room) and **six tones**, each a handful of numbers.
`lib/alert-sounds.js`. An unrecognised value falls back to a real sound, never
to silence.

### Chores: pause, per-occurrence moves, and real intervals
- **Pause**, with an annual option for seasonal chores. A paused chore is not
  due *and owes nothing* — and the owed chain stops at a pause rather than
  reaching through it, so a mower paused for winter does not wake in April with
  November's backlog. Paused chores get their own section in To-Dos with a
  one-tap Resume.
- **Every other week**, and **monthly on a chosen weekday** (1st/last Monday),
  counted in whole weeks so a late completion cannot drift the weekday.
- **Per-person days for any chore** — the rotation gating is gone.
- **Move one occurrence** to another day, leaving the schedule alone.
- **How often it actually comes round**, median-led because one fortnight away
  drags a mean somewhere useless. Answers the cat-feeder question, and says when
  the schedule and reality disagree. `lib/chore-intervals.js`.

### Four attribution bugs, one root
Reported as "I can't change who did it".

1. Tasks recorded **no doer at all** — the name on the row was the assignee, and
   the picker was hard-coded off because there was nothing to edit. Tasks now
   carry the same completion record chores do, written from all three places a
   task can be ticked.
2. `markCompleted` locked **unconditionally**. Locking exists so a statement
   somebody made *about themselves* stands — but an actor with no `personId`
   has no self to make one about. Sessions not linked to a person had their
   ticks locked, credited to someone else, and correctable by nobody. Not
   sandbox-only: a real unlinked member hit the identical path.
3. `canReattribute` required `!locked` **and** an enumerated byType that
   excluded `user`, so the flag and the list could disagree — and did, once an
   unlocked `user` record could exist.
4. `choreState` set `active: dueToday` whenever a mark existed, so an overdue
   chore completed *under today* dropped off the screen entirely rather than
   moving to the done group.

### The sandbox can be reached from away
Built as a self-contained page and published as an Artifact, with a **Ryan /
Kitchen wall** switch in the SANDBOX badge — the mode toggle was `__hub.display()`,
a console call, so display mode could not be tried from a phone at all.

---

## The one thing not ready

**Wake-word voice needs a server endpoint that does not exist yet.** The client
half is written and tested (`lib/ha-voice.js`, 9 tests) and `loadVoiceLink()`
resolves to null on 404, so a server without it simply has no wake-word voice
rather than an error. Nothing else in this branch depends on it.

What Steven needs is in `docs/VOICE.md`, Part 2. The Home Assistant side —
Assist pipeline, satellites, sentence and intent YAML — is Ryan's, on his own
instance, and is **written but untested**: there is a Home Assistant on the
machine but the YAML has never been run against it.

## What has not been verified in a browser

Everything here passes tests and builds, and the sandbox has been used for the
chore and attribution work. Not confirmed on real hardware: the iPad chime fix,
speech synthesis on iPadOS, and the Home Assistant YAML.
