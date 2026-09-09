// alert-sounds.js — telling one reminder apart from another, from another room.
//
// Ryan asked for custom noises per reminder. The obvious reading is "let me
// record a sound and attach it", and that turns out to be the expensive answer
// for the least benefit:
//
//   STORAGE. The whole household document is re-encrypted and re-uploaded on
//   every change. A handful of recordings would be re-sent every time somebody
//   ticked a chore, making the app slower for everyone in the house forever.
//   Doing it properly needs a separate attachment store, which is a feature and
//   not a setting.
//
//   AND IT DOES NOT ACTUALLY ANSWER THE QUESTION. A distinct beep only helps
//   once somebody has learnt which beep is which. From the next room, "that is
//   the three-note one" is a puzzle; "Bins out" is an answer.
//
// So two routes, and both cost nothing to store:
//
//   SPEAK   the browser says the reminder's own name. Nothing to record,
//           nothing to sync, and it names the thing rather than encoding it.
//
//   TONES   a set of named tones, each a handful of numbers rather than a file.
//           For the household that wants the kitchen timer and the medication
//           reminder to be plainly different sounds, and for anybody who does
//           not want the wall display announcing things aloud.
//
// What is stored on an alert is one short string. That is the whole feature's
// footprint in the document.

/**
 * The tones, as specs the renderer in chime-wav.js turns into audio.
 *
 * Each is a shape rather than a tune: rising for something starting, falling
 * for something ending, repeated and dissonant for something that is being
 * ignored. The names describe the sound, not the occasion, because which
 * occasion is the household's business.
 */
export const TONES = {
  chime: {
    label: "Chime", hint: "Two soft notes",
    spec: { wave: "sine", peak: 0.18, decay: 0.55, notes: [{ t: 0, f: 587.33 }, { t: 0.28, f: 880 }] },
  },
  alert: {
    label: "Alert", hint: "Three notes, repeated — the default",
    spec: {
      wave: "triangle", peak: 0.3, decay: 0.34,
      notes: [0, 0.8, 1.6].flatMap((b) => [
        { t: b, f: 880 }, { t: b + 0.16, f: 1108.73 }, { t: b + 0.32, f: 1318.51 },
      ]),
    },
  },
  bell: {
    label: "Bell", hint: "One clear note, left to ring",
    spec: { wave: "sine", peak: 0.26, decay: 1.6, notes: [{ t: 0, f: 1046.5 }, { t: 0.004, f: 2093 }] },
  },
  ping: {
    label: "Ping", hint: "Short and high — easy to ignore, deliberately",
    spec: { wave: "sine", peak: 0.2, decay: 0.18, notes: [{ t: 0, f: 1567.98 }] },
  },
  marimba: {
    label: "Marimba", hint: "Warm, four notes rising",
    spec: {
      wave: "sine", peak: 0.24, decay: 0.42,
      notes: [{ t: 0, f: 523.25 }, { t: 0.11, f: 659.25 }, { t: 0.22, f: 783.99 }, { t: 0.33, f: 1046.5 }],
    },
  },
  klaxon: {
    label: "Klaxon", hint: "Harsh and repeating — for the ones that matter",
    spec: {
      wave: "square", peak: 0.22, decay: 0.26,
      notes: [0, 0.34, 0.68, 1.02].flatMap((b) => [{ t: b, f: 466.16 }, { t: b + 0.17, f: 392 }]),
    },
  },
};

export const TONE_IDS = Object.keys(TONES);

/** What an alert with no sound chosen gets. Unchanged from before this existed. */
export const DEFAULT_SOUND = "alert";

/** The spoken option, stored as this rather than as a tone id. */
export const SPEAK = "speak";

/** Every choice a picker should offer, in order. */
export const SOUND_CHOICES = [
  { id: SPEAK, label: "Say the name", hint: "The screen reads the reminder aloud" },
  ...TONE_IDS.map((id) => ({ id, label: TONES[id].label, hint: TONES[id].hint })),
];

/**
 * What an item's alert should sound like.
 *
 * Anything unrecognised falls back to the default rather than to silence. A
 * reminder that makes no sound because of a typo in a stored value is the one
 * outcome this must not produce.
 */
export function soundOf(alert) {
  const raw = alert && typeof alert.sound === "string" ? alert.sound : "";
  if (raw === SPEAK) return SPEAK;
  return TONES[raw] ? raw : DEFAULT_SOUND;
}

/** The audio spec for a tone id. */
export const specFor = (id) => (TONES[id] || TONES[DEFAULT_SOUND]).spec;

/**
 * What the screen should say for a reminder.
 *
 * The person's name is included when there is one, because "Feed the cat" from
 * the hall is a fact and "Alex — feed the cat" is a request. Kept short: a
 * spoken sentence that runs on is one nobody waits through.
 */
export function spokenFor(alert, { title = "", personName = "" } = {}) {
  // Trim before falling back, not after: a title of "   " is truthy, so
  // trimming second produces an empty utterance -- a reminder that fires and
  // says nothing, which looks exactly like one that did not fire.
  const what = (String(title || "").trim() || "Reminder").slice(0, 80);
  const who = String(personName || "").trim();
  return who ? `${who} — ${what}` : what;
}
