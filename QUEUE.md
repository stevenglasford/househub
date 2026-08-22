# Work queue

Ryan's list of 21 Aug 2026, audited against the working tree rather than taken
at face value. **Five of the eight were already built** in the uncommitted work
— the reports were made against an older running build. Each status below says
how it was established, because "looks wired" and "seen working" are not the
same claim.

Verified in the sandbox at `http://192.168.0.182:5174/dev.html`
(`cd web && npm run dev:sandbox -- --host`).

---

## Done — verified in the browser

### 6. Overdue rows on Today are whole-row buttons ✅
Rebuilt as a row with three targets, matching the lists below it: circle
completes, words open, chore can be skipped (`App.jsx:1990`).

**Verified:** clicking "Take the bins out" opened its day sheet and left the row
overdue rather than ticking it off.

### 4. Skip on overdue rows ✅
Added, chores only. A one-off task has no next occurrence to defer to and
`skipped` is a shape only chores store, so offering it there would have been a
control that quietly did nothing.

**Verified:** Skip appears on both overdue chores and correctly not on the
overdue task ("Post Alex's form").

### 8. Reset the anchor on an interval chore ✅ — *was broken, now fixed*
Shipped, but verification failed: `cadence.resetAnchor` only moved the anchor
and never recorded the completion. An interval restarted from today is due today
by definition (`0 % n === 0`), so the chore stayed on the list **unticked**,
directly under a button promising it was not wanted for two days.

Fixed at `App.jsx:6380` — re-anchor, then record the completion, guarded so it
cannot untick a chore already done. Completing also credits somebody and
advances a rotation, which re-anchoring silently would not.

**Verified:** anchor moved to `2026-08-21` every 2 days (next due Aug 23) *and*
a locked completion credited to Ryan. Overdue 3 → 2, "7 left" → "6 left".

### 1. Calendar events show the wrong person ✅
> "The calendar, on today and the tab, are not corresponding to the correct
> person from the settings."

Fixed by `web/src/lib/feed-events.js` (`decorateFeedEvents`), wired at
`App.jsx:918`. The server tags each expanded event with `feedId`
(`server/src/services/calendars.js:128`) and the client rejoins it to the
calendar's person and colour, which live in the encrypted document.

**Verified:** Standup and Sprint review render as "Ryan" in his colour, not grey
"Calendar".

*Note for whoever writes fixtures next: the join key is `feedId`, not
`calendarId`. Getting it wrong makes every event arrive unowned and grey —
indistinguishable from this bug. The sandbox fixture did exactly that and
reproduced the symptom for the wrong reason.*

### 2. Calendar item detail ✅
> "there should be the start and end time, location, and any other details
> available, along with saying what calendar it belongs to."

Built at `App.jsx:5777-5815`. `whenLabel()` renders the range, plus location,
`From {calName}`, details, and a read-only notice for synced events.

**Verified:** "9:00am – 9:15am / Zoom / From Ryan — work / Ryan / Details".

---

## Done in code — not yet verified running

### 5. Subtasks and per-occurrence notes on recurring chores
> "Add option to add subtask or notes section to recurring chores. Make it so
> that you can add a note to the specific time you did that chore."

`web/src/lib/subtasks.js` has `choreChecklist`, `setChoreChecklist`,
`choreNoteOn`, `setChoreNote`, `noteHistory`. `ChoreDayModal`
(`App.jsx:6255`) shows the standing checklist read-only and a note bound to the
date, with earlier notes underneath.

**✅ Verified.** Fixture enriched with a standing checklist and two dated notes;
the chore-day sheet renders every section — "What it involves" (1 Black bin to
the kerb, 2 Recycling box on top, 3 Bring the caddy back in), "Note for Aug 21",
and "Earlier notes" with Mon Aug 17 and Thu Aug 13.

---

## Blocked

### 3. Agenda AI: "Unsupported field: prompt"
The allowlist in `server/src/routes/ai.js:73` already gained `prompt`, with a
comment naming this exact error. But the schema is `.strict()` and there is no
`agenda` kind — the registered kinds are `checkin_question`, `checkin_batch`,
`date_idea`, `date_ideas` — so it is worth confirming which call actually
failed and whether it sends a *different* unlisted field.

**Blocked on:** the API server, which will not start (Postgres password). The
sandbox stubs `generate()`, so it cannot exercise the real route.

---

## Done — later additions

### 7. Say who actually did it ✅
> "you need to be able to choose who did it on that day... ensure that it does
> not skip the person who was assigned."

Why there was no control: ticking the circle yourself writes `byType: "user",
locked: true` — a first-person claim, deliberately not reattributable
(`completion.js:154`). So the only route in was to tick it and then try to
correct a record that refuses corrections.

`completeOnBehalf` takes the other route, and was already written and proven —
but reachable only from the full-screen reminder. Now surfaced on **both**
surfaces Ryan named: the assignee chip on each Today row and each To-Dos tab row
is the control, and a chore with nobody assigned gets a "Who?" chip so the
capability is never unreachable. Rotating chores show "X keeps their turn — this
does not use it up."

**Verified** on a rotating chore: Alex covered Ryan's Dishes →
`by: Alex, onBehalfOf: Ryan, byType: onBehalf, locked: false`, and **tomorrow is
still Ryan's turn**. Also on a non-rotating one (Alex covered Sam's Hoover).

### 9. Cover shown in history ✅  *(added 21 Aug)*
> "on the history of the todos, make it so that it shows if someone else did it
> other than the person originally assigned."

`HistoryModal` built its rows from `rec.by` and never read `rec.onBehalfOf`, so a
fortnight where one person quietly covered three of another's chores read
exactly like a fortnight where everyone did their own. Rows now carry
"covered for {name}".

### 10. Who is doing whose chores — report ✅  *(added 21 Aug)*
> "make it reportable later... to see who's doing other people's chores and more
> importantly, who's not doing theirs."

A **Report** toggle in History, off by default — a running tally of who is not
pulling their weight is something to go and look at deliberately, not something
a shared kitchen screen puts in front of the household unprompted. Per person
over the chosen window: Did · Covered for · Covered by · Skipped · Missed.

Recurring chores only: a one-off task is nobody's turn, so folding tasks in
would inflate "missed" with things nobody was scheduled to do.

**One bug found and fixed in the writing:** the first version only counted days
the chore was *due*, which silently dropped every cover made on an overdue
chore — you tick those under today, and today is usually not one of its due
days. That is precisely the case the report exists to show. Completions are now
counted wherever they were recorded; only *missed* is gated on the due day.

**Verified** by reconciliation: covered-for totals equal covered-by totals
(5 = 5), and Alex's 12 missed derives exactly from "Feed the cat" being daily
and his, 13 past days in the window less the one he did.

## Remaining

1. **5** — enrich the fixture with a checklist and past notes, then confirm
2. **3** — once the database is sorted and the server runs

Plus the sticky-note leak below, which is still open.

All 260 web tests pass.

---

## Batch two — 21 Aug, not yet triaged

Claims below came from a side analysis. **The verification pass has now run**
for 11, 14, 16 and 17 — and for 5 from batch one. The prediction held: four of
the five were already built, and the fifth (14) needed a three-line wiring fix
rather than a feature.

Two corrections to the notes as received: the sandbox server had **not** stopped
(it was serving throughout), and item 16's relabel had **already landed**.

### 11. "Extra row on Today" selects but never displays
> Select one and nothing appears. For lights/devices, choose which devices show.

Likely already fixed. `api.js:mergeDocuments` carries a comment naming this exact
symptom — `secondBlock` was missing from the scalar-settings list, so the choice
was written locally and thrown away by the next merge, "silent, and
indistinguishable from the setting not working at all."

**✅ Verified.** `second-block.js` documents *two* causes of the one symptom,
both fixed: the merge dropping `secondBlock` (`api.js:117`), and the Everyone
setting not being inherited when Today was filtered to a person — "the row was
set up under Everyone, then disappeared the moment anybody filtered Today."

Set Everyone → Grocery list, reloaded: the choice survives
(`secondBlock.all.kind === "grocery"`), Ryan inherits it, and the row renders on
Today — "GROCERY LIST · Milk · 2 Dairy · Sourdough Bakery · Coffee beans".

The device-picker half exists in code (`PICKABLE = ["camera", "devices"]`, with a
`PickList`) but needs a connected Home Assistant or CamWatch to exercise, which
the sandbox stubs out.

### 12. Two-way calendar sync, iCloud at minimum
Largely built: `loadCaldav` / `connectCaldav` / `disconnectCaldav` /
`setCaldavPush` / `pushCaldav`, a `CaldavPanel.jsx`, and a CalDAV section in
`server/src/routes/calendars.js` whose `AccountBody` (serverUrl + username +
password) is exactly the iCloud app-specific-password shape.

**Blocked** alongside item 3: needs the server and a real iCloud account.

### 13. Pushed calendar items don't update or delete; no choice of target ✅ *(client half)*
**Root cause found, and it explains both halves at once.**

`eventsForSync` includes an event only when `e.calendarId` matches the calendar
being pushed (`project-events.js:109`). `ProjectModal` has a calendar picker and
writes `calendarId`; **`EventModal` had neither** — it saved
`{id, title, date, time, endTime, personId}` and nothing more.

So no hub-created event could ever enter a push set. It never appeared on the
real calendar, and then editing or deleting it changed nothing at the far end
because there was nothing there to change. "No choice of target calendar" and
"pushed items don't update or delete" were the same missing field.

EventModal now offers "Also write this to", worded and behaving as ProjectModal's
does, including the empty-state pointing at Settings → Two-way calendar sync.

**Verified** against the real `eventsForSync`: with no target the push set is
empty; with one chosen the event enters it; deleting the event removes it from
the set, which is exactly what the server diffs against to issue a delete.

**Still unconfirmed:** whether the server's diff then performs the update and
delete correctly against a real calendar. That needs a live CalDAV account —
blocked alongside 3 and 12.

### 14. Sticky note end date + display-span history
> "Set end date on a sticky note. Keep a history of the dates they were
> displayed for."

`lib/notes.js` has `from`/`until`, `isUp`, `partitionNotes`, `displayedSpan`,
`spanLabel`, `suggestedUntil` — built.

**✅ Fixed.** The library was built; the wiring was the gap. `partitionNotes` is wired into `BoardView`
(`App.jsx:4547`) only; `NoteOverlay` (`App.jsx:2213`), `NoteRow`
(`App.jsx:1866`) and the `noteCount` badge (`App.jsx:1088`) still read
`data.notes` raw, so an expired note stayed on the wall display — the exact
thing the feature exists to prevent.

All three now read `NOTES.partitionNotes(...).up`, computed once per render and
keyed to *today* rather than the day being browsed: these are ambient, and
having them wink in and out while somebody pages through next week reads as a
glitch rather than as information.

**Verified:** "Parcel with next door" (ended two days ago) is off Today, the two
live notes remain, and the Board badge went 3 → 2. Nothing was deleted — all
three notes are still stored, and the expired one now sits in its history with
the span "5 days", which is the second half of what this item asked for.

### 15. Display mode: always show who did it, and make it correctable ✅
The sandbox gained a display mode to do this honestly — `__hub.display()` runs it
as the "Kitchen wall" screen, with display scopes and control domains and no
signed-in person. (The third `toggleChore` is `CheckInOverlay`, not a wall view;
display mode reuses the same views under `isDisplay()`.)

**Correctable** already worked: a display's completions are unlocked, so
`canReattribute` returns true and the picker appears.

**Always show who did it** did not. A completion the display cannot correct — a
member's own locked tick — rendered as a bare colour dot. A dot is a legend
nobody has, on the one screen read from across a kitchen by people who did not
choose the palette. It now shows the name, without buttons: shown, not up for
editing. Item 9's "covered for X" marker is carried onto the display too.

**Verified as the Kitchen wall:** "Feed the cat — Alex" (member's locked tick,
name now visible) and "Kitchen deep clean — covered for Sam — Alex", the latter
stored as `byType: onBehalf, source: "Kitchen wall", locked: false,
correctable: true`.

### 16. Weekly option with day selection
Already built, and the relabel has landed too. `cadence.js` supports
`{type: "weekly", days: [...]}`, and its header says the feature "already
existed, under the label 'Certain days', which is why it was reported missing."

**✅ Verified.** The editor offers "Weekly", not "Certain days", and selecting
it renders the S M T W T F S day picker. Nothing to do.

### 17. Rotating chores: per-person day or cadence
**✅ Verified, editor included.** The chore editor offers "Each person's own
day" with a day picker per person, and the copy "The day decides whose it is, so
nobody's turn carries over."

One coupling worth knowing: the option only appears when the chore already has a
rotation of two or more (`App.jsx:6612`), and the day pickers iterate that
rotation. So a per-person chore *without* a rotation renders correctly but
cannot be edited — its schedule is invisible in the editor. The app cannot
currently produce that state, so it is a latent edge rather than a live bug; the
sandbox fixture had to be corrected because it had reached it.

### 18. New items default to the signed-in person ✅
A `defaultPersonId(people)` helper, applied in all five modals — event, chore,
task, note, project.

Applied **only when there is no id yet**. An existing item assigned to nobody
also has an empty `personId`, so defaulting on edit would quietly reassign other
people's things to whoever opened them. A display, and a member who has not
linked their account to anybody, both get "" — which the pickers already render
as Everyone, exactly as before.

**Verified both ways:** a new task opens with Ryan selected and every other
option one tap away; editing "Lock up", an existing chore assigned to nobody,
still opens on Everyone.

---

## Where batch two stands

**The queue is finished except for what needs a database.**

- **Done and verified:** 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13 (client half), 14,
  15, 16, 17, 18
- **Blocked on Postgres:** 3 (agenda AI), 12 (iCloud sync), and confirming 13's
  server-side diff against a real calendar

All 260 web tests pass. The three blocked items need the database password —
`sudo -u postgres psql -c "ALTER ROLE househub PASSWORD '"'"'househub'"'"'"` — and
then `cd server && npm run dev`.
