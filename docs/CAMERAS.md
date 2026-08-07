# Plugging CamWatch into a household

[CamWatch](https://github.com/stevenglasford/security) is a separate security
camera system — Python, YOLOv8 object detection, face recognition, its own
recordings on its own disk. You run it on your own hardware, and it works
perfectly well on its own.

HouseHub does not absorb it. It plugs into a running instance so your cameras
appear on the screens you already have here — the tablet by the door, your phone
— without that tablet ever holding CamWatch's password.

**Settings → Cameras.**

---

## What HouseHub adds

CamWatch has one shared password: anyone who has it can do everything. Plugging
it in here gets you three things it cannot do alone.

**Its own access control.** A viewer sees cameras; an admin configures them. A
wall display shows the back garden without holding the password.

**Revocation that means something.** Revoke a display and its camera access goes
with it, because the display never had the credential.

**Scope.** Pick which cameras appear, and whether alerts, recordings and faces
are surfaced at all.

## What is not stored here

Nothing. No footage, no snapshots, no alert images, no faces, no recordings.
Streams and images are piped straight through and forgotten; they never touch
this server's disk, even briefly.

The only thing HouseHub keeps is the address and the password, both encrypted.

**Face data stays on your CamWatch machine.** It is biometric information —
special category data under GDPR Article 9 — and the right place for it is the
machine that already holds it. Surfacing it in HouseHub is off by default and
switched on separately from everything else.

---

## Setup

1. **Settings → Cameras**
2. Paste the address, e.g. `http://192.168.1.60:8000`
3. Paste your CamWatch password
4. **Test connection**, then **Connect**

A connection that fails the test is not saved.

Then choose:

- **Which cameras** appear — leave it empty for all of them
- **Alert history** — detections alongside the rest of your evening
- **Recordings** — browse and download clips, which stay on your machine
- **Enrolled faces** — off by default; see above

## On a wall display

A display granted the **Home** scope shows **live cameras only**. Never alerts,
never faces, never recordings.

That distinction is deliberate. A screen in a hallway showing the garden right
now is useful. The same screen showing a scrollable history of everyone who came
to the door, or a list of enrolled faces, is a different thing — visible to
every guest, every delivery driver, anyone who walks past.

Grant it in **Settings → Displays**, tick **Home**.

## Putting cameras on Today

**Settings → Extra row on Today → Cameras** puts live stills under the dashboard
columns, chosen separately per person filter — so the shared screen can show the
garden while your phone shows the shopping list.

## Troubleshooting

**"Nothing is listening at that address."** Wrong port, or `https` where it
should be `http`. Try it in a browser first.

**"CamWatch rejected that password."** Usually a space picked up when copying.

**"That address points at the HouseHub server itself."** You used `localhost` or
`127.0.0.1`. Use the address other devices on your network use.

**Streams stutter on the wall tablet.** MJPEG is bandwidth-hungry. Use snapshots
on Today (they refresh every four seconds) and keep full streams for phones.

## Disconnecting

**Settings → Cameras → Disconnect** deletes the password from this server. Your
footage, faces and recordings are untouched — they were never here.

Change the CamWatch password afterwards if you are disconnecting because
something went wrong.
