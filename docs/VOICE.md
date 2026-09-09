# Voice commands from satellite microphones

Speaking to a screen only works if you are standing at it. Satellite
microphones around the house fix that, and they move the problem: the audio
arrives at Home Assistant, and the display that has to act on it is a browser in
another room that heard nothing.

**How it fits together**

```
  satellite mic ──> Home Assistant ──> the display's browser ──> your document
   (any room)        wake word +        WebSocket, on your          encrypted
                     speech-to-text,    own network                 as always
                     both local
```

**The HouseHub server is deliberately not in that path.** It holds ciphertext
and no key; a transcript relayed through it would be your household's own words,
in the clear, on the one machine the entire design exists to keep them off. So
the display subscribes to Home Assistant directly and encrypts the timer itself.

---

## What this costs, said plainly

The display needs a Home Assistant token, and **Home Assistant has no scoped
tokens** — any token can control anything that instance can control. That is a
house-controlling credential sitting in a browser on a screen anybody can walk
up to.

Two mitigations, both worth doing:

1. **A second Home Assistant user, just for this.** `docs/HOME-ASSISTANT.md`
   already has you make a `HouseHub` user; make a `HouseHub Voice` one the same
   way, with **Local access only** on, and let displays have only that token. It
   is not a permission boundary — Home Assistant does not offer one — but it is
   a name in the logbook and one switch to cut off.
2. **Per display, off by default.** A screen that does not need to hear anything
   should not hold a token at all.

If that trade is not one you want to make, the push-to-talk microphone built
into the timer bar needs none of this and works today. It just requires you to
be standing at the screen.

---

# Part 1 — what Ryan sets up in Home Assistant

None of this exists on your instance yet. It is all Home Assistant's own
plumbing; HouseHub needs none of it installed and only listens at the end.

## 1. The Assist pipeline

**Settings → Voice assistants → Add assistant.** A pipeline is three pieces, and
for this to stay local all three must be local:

| Piece | Add-on | Why |
|---|---|---|
| Speech-to-text | **Whisper** (`faster-whisper`) | turns the audio into text on your hardware |
| Text-to-speech | **Piper** | only needed if you want it to answer aloud |
| Wake word | **openWakeWord** | so "hey jarvis" is detected locally and only what follows is processed |

All three install from **Settings → Add-ons → Add-on Store** and then appear as
Wyoming integrations. Pick them in the pipeline you just created.

> If you use the cloud speech-to-text option instead, your kitchen audio goes to
> a third party. That is a normal Home Assistant choice and an odd one to make
> in this particular app.

## 2. The satellites

Any of these work; they all speak Wyoming to Home Assistant:

- **Home Assistant Voice Preview Edition** — the official puck. On-device wake
  word (microWakeWord), and by far the least work.
- **ESP32-S3-BOX / M5Stack Atom Echo** — cheap, flashed with ESPHome's voice
  assistant component.
- **A Raspberry Pi with a decent mic**, running `wyoming-satellite`.

Put one wherever you would want to say "set a timer" — the kitchen at minimum.

## 3. Fire the event HouseHub listens for

HouseHub listens for one Home Assistant event, `househub_voice`, and reads the
spoken text out of it. Everything else is Home Assistant's business.

Add a wildcard sentence so the whole phrase reaches HouseHub intact rather than
being parsed into slots — HouseHub already has a parser for kitchen phrasing and
two of them would only drift apart.

`config/custom_sentences/en/househub.yaml`:

Each block sets a static `action` slot, and that is load-bearing rather than
decoration: `intent_script` renders its templates with **only the slots** in
scope, so there is no variable anywhere holding the sentence that was actually
said. The verb has to be carried as a slot or it is simply lost.

```yaml
language: en
intents:
  HouseHubVoice:
    data:
      - sentences:
          - "(set|start) a timer {phrase}"
        slots:
          action: "set a timer"
      - sentences:
          - "timer {phrase}"
        slots:
          action: "timer"
      - sentences:
          - "(stop|cancel|silence) {phrase}"
        slots:
          action: "stop"
lists:
  phrase:
    wildcard: true
```

`configuration.yaml`:

```yaml
intent_script:
  HouseHubVoice:
    action:
      - event: househub_voice
        event_data:
          # the whole sentence, for HouseHub's own parser
          text: "{{ action }} {{ phrase }}"
          # optional: name the screen that should act. Leave it out and every
          # listening screen acts, which is what you want with one wall tablet.
          display: "Kitchen wall"
    speech:
      text: "Right."
```

Restart Home Assistant, then check it with **Developer tools → Events → Listen
to events → `househub_voice`** and say the phrase at a satellite. If the event
shows up with your words in `text`, Home Assistant's half is done.

> **Tested against Home Assistant 2026.8.1.** The config above validates with
> `check_config`, loads without error, and `custom_sentences/en/` is the
> directory that release actually reads (it commits to one language variant, and
> resolves `en` to `en`). What is *not* yet tested is a real satellite: the
> sentence matching was exercised with hassil directly rather than by speaking.
>
> An earlier draft of this page used
> `text: "{{ trigger_sentence | default('set a timer ' ~ phrase) }}"`. There is
> no `trigger_sentence` variable in Home Assistant — `intent_script` renders with
> only the slots — so the default fired every time and every stop phrase arrived
> with its verb replaced: "cancel the pasta timer" reached HouseHub as
> "set a timer the pasta timer", which `parseStopCommand` rejects. The timer
> never stopped and nothing was logged. Hence the `action` slot.
>
> If a phrase does not come through as expected, check what
> `Developer tools → Events` shows in `event_data`; the HouseHub side reads
> `text`, `command` or `transcript`, whichever is present.

## 4. Turn it on for a screen

Once Steven has shipped Part 2: **Settings → Home Assistant → Voice**, paste the
`HouseHub Voice` token, and enable it for the displays that should listen.

The display shows a small microphone in the timer bar **only when it is actually
connected**. A screen that claims to be listening when Home Assistant is
unreachable is worse than one that says nothing, because you stop checking.

---

# Part 2 — what Steven needs to build on the server

The client half is done and is on `feat/timers`:

- `web/src/lib/ha-voice.js` — the WebSocket subscription, with the auth
  handshake, per-display targeting and reconnect backoff
- `web/src/api.js` — `loadVoiceLink()`, which fetches the link below and
  **resolves to null on 404**, so a server without this simply has no
  wake-word voice rather than an error
- `web/test/ha-voice.test.js` — 9 tests, no network

It needs one endpoint, in two mountings (members and displays), matching how
`server/src/routes/home.js` already splits `memberRouter` and `displayRouter`:

```
GET /api/households/:householdId/home/voice
GET /api/display/home/voice

200 { "url": "http://192.168.1.50:8123", "token": "...", "enabled": true }
404 when the household has not connected Home Assistant or has voice off
```

**Storage.** `household_home_assistant` already holds `url_enc` and `token_enc`
sealed with `crypto/seal.js`. This wants two more columns rather than reusing
the existing token:

- `voice_token_enc` — the `HouseHub Voice` user's token, sealed the same way
- `voice_enabled` — boolean, default false

Keeping it separate is the point. The existing token is the one that operates
the house from the server; handing that to every wall display would widen its
blast radius considerably for no gain.

**Authorisation.** Follow the shape already set out at the top of `home.js`:
decide authorisation before configuration is consulted, so "you may not" never
degrades into "Home Assistant is not set up".

- A member of the household: allowed when `voice_enabled`.
- A display: allowed when `voice_enabled` **and** that display has been granted
  voice — worth a per-display capability alongside the existing control domains,
  since the whole mitigation above rests on it being off by default.
- Rate-limit it, and `audit()` each issuance. A token leaving the server should
  be a line in the log, the same as unlocking something would be.

**What it must not do.** It must not accept a transcript, and it must not proxy
one. The moment the server has an endpoint that takes spoken text, it has an
endpoint that takes household content in the clear — and the reason this design
routes around the server is that it should never have one.

**Settings UI.** A `Voice` block under Settings → Home Assistant: the token
field, the enable switch, and the per-display list. `HomeAssistantPanel.jsx` is
where the rest of this lives.
