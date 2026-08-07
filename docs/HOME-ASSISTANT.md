# Plugging Home Assistant into a household

HouseHub and Home Assistant are **two separate systems**. You run Home Assistant
yourself, on your own hardware, exactly as you would anyway. HouseHub does not
bundle it, does not host it, and does not have one of its own to share out.

Connecting them is per household. On a server running several families, each one
plugs in their own instance and sees only that. There is no server-wide setting,
deliberately — there used to be, and it would have shown every household on a
shared server the same house.

**Settings → Home Assistant.** Five minutes.

---

## What you need

- A working Home Assistant your phone can reach on the same network
- Its address, e.g. `http://192.168.1.50:8123`
- A long-lived access token

Nothing installed into Home Assistant. No custom component, no HACS repository,
no YAML. HouseHub talks to the REST API that is already there.

---

## Step 1 — make a user for HouseHub

Do this rather than using your own account. HouseHub will hold a token that can
control your house, and a token scoped to a user you can see and revoke is worth
the extra minute.

1. **Settings → People → Add person**
2. Name it `HouseHub`, turn on **Allow person to login**
3. Give it a password you will not need again
4. Leave **Local access only** on if HouseHub is on your own network

> Home Assistant does not offer fine-grained permissions for normal users, so
> this account can still do a lot. What it buys you is a name in the logbook and
> one switch to cut off — which is the difference between "revoke HouseHub" and
> "change my own password and re-authorise everything I own".

## Step 2 — create the token

1. Sign in to Home Assistant **as that user**
2. Click the user's name (bottom left) → **Security** tab
3. **Long-lived access tokens → Create token**, name it `HouseHub`
4. Copy it — Home Assistant shows it once

## Step 3 — connect it

In HouseHub: **Settings → Home Assistant**

1. Paste the address and the token
2. **Test connection** — it reports what it found, e.g.
   *"Connected — 214 entities found (38 Sensors, 22 Lights, 9 Switches, 4 Cameras)"*
3. **Connect**

A connection that fails the test is not saved. A half-saved integration is worse
than none, because it looks connected.

## Step 4 — choose what appears

**Choose entities.** A typical Home Assistant exposes hundreds; a wall display
wants a dozen. Search, tick, save. The Home tab appears once something is chosen.

Good picks for a screen by the door:

- the front and back cameras
- the lights people actually ask about
- door and window sensors
- outdoor temperature
- the front door lock — to *see*, not to open

## Step 5 — control, if you want it

**Let members switch things** turns on lights, switches, fans and blinds.

**Locks are treated differently and cannot be configured otherwise.** They can be
operated only by a signed-in member with adult access, never from a shared
display, whatever else is enabled. That is checked against the caller rather than
a stored permission, so there is no configuration that puts your front door on a
screen mounted next to it.

To give a shared display control: **Settings → Displays**, and tick the domains
it may switch. Lights and blinds are on that list. Locks are not, and cannot be
added.

---

## Why it is set up this way

**Why a token instead of signing in?** Home Assistant's API has no OAuth flow for
third-party servers. A long-lived token is the mechanism it offers.

**Why does the server hold the token rather than my browser?** Two reasons, and
both are stubborn:

1. Home Assistant usually sits on a private address your phone cannot reach from
   outside the house. The server can.
2. Its camera endpoints reject long-lived tokens passed in a URL. A browser
   cannot fetch a snapshot directly even if you wanted it to, so the server
   proxies them — which is also what makes a camera tile a plain image that
   keeps working.

**So is it end-to-end encrypted?** No, and it is the one part that is not. The
token and address are sealed under the server's own key, the same treatment as
calendar subscription URLs. A stolen database yields nothing. A fully compromised
host yields the token. That is written down in
[THREAT-MODEL.md](THREAT-MODEL.md) rather than glossed over.

Everything your household actually writes — the calendar, chores, notes — stays
encrypted with a key the server does not have. The integration is plumbing to a
separate system and never touches the vault.

---

## Running both on one machine

They coexist fine. Home Assistant on `:8123`, HouseHub on `:4000` behind your
proxy. Use the machine's LAN address rather than `127.0.0.1` — HouseHub refuses a
loopback address, because from inside its container that points at HouseHub
itself, not at Home Assistant.

If HouseHub is in Docker and Home Assistant is on the host:

```
http://host.docker.internal:8123      # with the hostnet overlay: http://<LAN IP>:8123
```

---

## Troubleshooting

**"Nothing is listening at that address."** Wrong port, or `https` where it
should be `http`. Try the URL in a browser first.

**"Home Assistant rejected the access token."** Usually a newline or a space
picked up when copying. Create a fresh one and paste carefully.

**"That address points at the HouseHub server itself."** You used `localhost` or
`127.0.0.1`. Use the address other devices on your network use.

**Connected, but the Home tab is missing.** Nothing is selected yet — Settings →
Home Assistant → Choose entities.

**Cameras show "No signal".** The entity is not a `camera.*`, or Home Assistant
cannot reach it either. Check it renders in Home Assistant first.

**Tiles are stale.** State is cached for four seconds and camera stills for one,
so several screens polling at once do not hammer your instance.

## Disconnecting

**Settings → Home Assistant → Disconnect** deletes the token from this server.

**Then revoke it in Home Assistant too.** Deleting our copy does not stop the
token working — only Home Assistant can do that. Profile → Security →
Long-lived access tokens → delete.
