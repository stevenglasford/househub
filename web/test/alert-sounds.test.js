// alert-sounds.test.js — telling one reminder from another, from another room.
//
// Ryan asked to customise the noise per reminder. What is stored for that is a
// single short string, and these tests hold the line on two things:
//
//   an unrecognised value must fall back to a real sound, never to silence --
//   a reminder that makes no noise because of a typo is the one outcome this
//   feature must not produce;
//
//   and the spoken option has to name the thing, since "that is the three-note
//   one" is a puzzle and "Bins out" is an answer.

import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/lib/alert-sounds.js";
import { renderPattern } from "../src/lib/chime-wav.js";

test("an alert with no sound set keeps the sound it always had", () => {
  assert.equal(S.soundOf(undefined), S.DEFAULT_SOUND);
  assert.equal(S.soundOf({}), S.DEFAULT_SOUND);
  assert.equal(S.soundOf({ at: "17:00" }), S.DEFAULT_SOUND,
    "every reminder written before this existed still sounds the same");
});

test("an unrecognised sound falls back rather than going silent", () => {
  // The failure this exists to prevent: a stored typo, or a tone removed in a
  // later version, turning a medication reminder into a silent one.
  assert.equal(S.soundOf({ sound: "trombone" }), S.DEFAULT_SOUND);
  assert.equal(S.soundOf({ sound: "" }), S.DEFAULT_SOUND);
  assert.equal(S.soundOf({ sound: null }), S.DEFAULT_SOUND);
  assert.equal(S.soundOf({ sound: 7 }), S.DEFAULT_SOUND);
});

test("every offered choice is one soundOf will actually honour", () => {
  for (const c of S.SOUND_CHOICES) {
    assert.equal(S.soundOf({ sound: c.id }), c.id, `"${c.label}" is offered but not honoured`);
  }
});

test("every tone renders to something audible", () => {
  for (const id of S.TONE_IDS) {
    const samples = renderPattern(S.specFor(id));
    const loudest = Math.max(...Array.from(samples, Math.abs));
    assert.ok(loudest > 0.05, `${id} rendered near-silent (peak ${loudest})`);
    assert.ok(samples.length > 1000, `${id} is too short to hear`);
  }
});

test("the tones are actually distinguishable from each other", () => {
  // Six names for the same beep would be worse than one beep, because it would
  // look like a feature.
  const shapes = S.TONE_IDS.map((id) => {
    const spec = S.specFor(id);
    return `${spec.wave}:${spec.notes.length}:${spec.notes.map((n) => Math.round(n.f)).join("-")}`;
  });
  assert.equal(new Set(shapes).size, shapes.length, "two tones are the same sound");
});

test("speech names the reminder, and the person when there is one", () => {
  assert.equal(S.spokenFor({ sound: "speak" }, { title: "Bins out" }), "Bins out");
  assert.equal(
    S.spokenFor({ sound: "speak" }, { title: "Feed the cat", personName: "Alex" }),
    "Alex — Feed the cat",
    "from the hall, a name turns a fact into a request");
});

test("speech never runs on, and never says nothing", () => {
  const long = "x".repeat(500);
  assert.ok(S.spokenFor({}, { title: long }).length <= 90, "a spoken sentence nobody waits through");
  assert.equal(S.spokenFor({}, {}), "Reminder", "not an empty utterance");
  assert.equal(S.spokenFor({}, { title: "   " }), "Reminder");
});

test("the whole feature costs one short string in the document", () => {
  // The reason it is not recorded audio: the document is re-encrypted and
  // re-uploaded on every change, so anything stored here is re-sent every time
  // somebody ticks a chore.
  for (const c of S.SOUND_CHOICES) {
    assert.ok(c.id.length <= 12, `"${c.id}" is a long thing to store on every alert`);
  }
});
