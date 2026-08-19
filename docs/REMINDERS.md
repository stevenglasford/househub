# Reminders

A chore having an assignee and a due date is not the same as it getting done.
Reminders are for the ones with a consequence attached — pet medication, bins
out before the lorry comes, a dose at a fixed hour — where "it's on the list"
is not enough and something has to actually interrupt.

## Setting one

Open any chore or task and use **Remind us if it isn't done**:

| Field | Meaning |
|---|---|
| **By** | when it should have been done |
| **Repeat** | how often to chime after that — 5, 10, 15, 30 or 60 minutes |
| **Stop at** | the cutoff, after which it gives up for the day |

Two levels of insistence:

- **Banner** — a strip under the header that does not scroll away
- **Takeover** — fills the screen, over everything including open settings

Both offer the same four actions: **Done**, **Skip**, **Snooze 10m**, and
**Who?** to record that somebody else actually did it.

The cutoff matters as much as the start time. A reminder that chimes all night
gets the tablet muted, and then none of them work.

### Snoozes are shared

Snoozing on a phone also quiets the tablet in the hall. Snoozes live in the
household document, which is what syncs between devices — otherwise the same
reminder has to be dismissed once per screen in the house.

## If the chimes are silent

Browsers refuse to play audio until the page has received a real tap. After a
tablet reboot or a fresh load, open **Settings → Check-in** and press **Test the
alert sound** once — that gesture arms every later chime for the session.
Tapping anywhere in the app does the same thing.

If the test button itself is silent, it is the device rather than the app: check
the volume, and on an iPad the physical mute switch, which Safari honours even
for web audio.

## Phone reminders

A screen has to be awake with the page open to chime, and browsers throttle
background timers. For anything critical you want a real phone notification.

**This is the one feature the encryption genuinely constrains, so it is worth
understanding before you turn it on.**

### Why it is not just an API endpoint

The single-household version of this app answered the problem with a server
endpoint, `/api/alerts/due`, that a phone Shortcut polled. The server read the
chore list, worked out what was overdue, and returned the titles as JSON.

That cannot be ported here. This server cannot read the household document at
all — it holds ciphertext and no key — so it does not know your chores exist,
what they are called, or when they were due. Rebuilding that endpoint would mean
storing chore titles and schedules in the clear, which is the one thing the whole
design exists to prevent. *"Take your medication at 8pm"* is exactly the sort of
thing a household is entitled to keep to itself.

### What happens instead

Your browser already holds the key and already works out what is overdue, so it
sends the notification itself — directly to a push service **you** choose,
usually an [ntfy](https://ntfy.sh) instance you run.

Who learns what:

| Party | What they see |
|---|---|
| HouseHub's server | **nothing** — it is not part of the request |
| Your push service | the reminder title, because a notification that doesn't say what it's about isn't one |
| Whoever runs the server | that a household enabled a relay, and to which host |

That middle row is a real disclosure. Pointing it at an ntfy instance on your own
machine keeps it inside the house; pointing it at a public one does not. It is
off by default either way.

### Turning it on

**1. The operator allows the host.** `connect-src` is a property of the origin,
not of one household, so a household cannot widen it by editing anything it
controls. Set `PUSH_HOSTS` on the server:

```
PUSH_HOSTS=https://ntfy.example.com
```

Several are allowed, comma- or space-separated. Wildcards, plain `http://` (other
than localhost) and unparseable entries are refused at boot with a warning rather
than silently accepted.

> Understand what this costs. `connect-src` is part of what stops injected script
> from posting key material somewhere useful to an attacker. Every host added is
> one more place it could post to. Name exact origins, and prefer ones you run.

**2. The household turns it on.** Settings → Check-in → **Phone reminders**.
Enter the full topic URL, e.g. `https://ntfy.example.com/our-house`, and send a
test. If the test fails, the usual cause is step 1 not being done.

**3. Subscribe on the phone.** Install the ntfy app and subscribe to that topic.

### Duplicate sends

Which device sends is worked out through the document: a client records the
escalation step it sent, and others skip it. Two devices crossing the same step
inside one sync round can still both send. Occasionally seeing a reminder twice
is a much better failure than a scheme that drops it.

### The better answer, not yet built

Web Push with a service worker would keep the title away from every third party:
the client registers *"wake me at 20:00 and deliver this sealed blob"*, the server
learns only the time, and the service worker decrypts and renders the
notification locally. That needs VAPID keys, a subscription table and a scheduled
sender, so it is written down here rather than half-built.

## Timezones

Reminders are evaluated on the device, against its own clock, so they follow
whoever is holding it.

Calendar *events* are different: subscribed `.ics` feeds are expanded into days
on the server, because browsers cannot fetch a Google or iCloud feed themselves
(CORS). The server therefore has to know which zone a household measures days in.

Set it in **Settings → Household → Timezone**. If it is wrong, nothing errors —
evening events simply land on the following day, and the calendar becomes
gently untrustworthy. A 7:30pm dinner published as `00:30Z` shows up on tomorrow's
tile.

The panel shows the household's zone next to the browser's own and warns when
they differ, because nobody goes looking for a timezone setting; they just stop
believing the wall display.

`HOUSEHOLD_TZ` (or `TZ`) on the server is only the fallback for households that
have not chosen one. Per-household is the real setting — one server carries many
unrelated households and they are not all in one place.

All-day events are never shifted, whatever the zone. A birthday is on that date
everywhere. Events published in another zone are converted: a 9am New York call
shows as 8am in Chicago.
