// chime-wav.test.js — the chime as a file, for the device that will not take it
// any other way.
//
// Reported: reminders chime on a laptop and are silent on the iPad mounted in
// the hall. iOS routes Web Audio through the ringer channel, so the mute switch
// silences an AudioContext while leaving an <audio> element alone. A laptop has
// no mute switch, which is why the same code behaves differently on the two.
//
// What can be tested without a browser is the audio itself: that a real WAV
// comes out, that it contains the notes asked for, and that it never clips into
// the kind of click that is worst in an alert sound.

import test from "node:test";
import assert from "node:assert/strict";
import * as W from "../src/lib/chime-wav.js";

const ALERT = {
  wave: "triangle", peak: 0.3, decay: 0.34,
  notes: [{ t: 0, f: 880 }, { t: 0.16, f: 1108.73 }, { t: 0.32, f: 1318.51 }],
};

test("a pattern renders to samples that are actually audible", () => {
  const s = W.renderPattern(ALERT);
  assert.ok(s.length > 1000, "there is some audio");
  const loudest = Math.max(...Array.from(s, Math.abs));
  assert.ok(loudest > 0.05, `expected an audible signal, peaked at ${loudest}`);
});

test("nothing clips into a click", () => {
  // Overlapping notes sum past 1. A wrapped sample is a loud click, which is
  // the worst possible artefact in a sound whose job is to be trusted.
  const stacked = { wave: "square", peak: 0.9, decay: 0.5,
    notes: [{ t: 0, f: 440 }, { t: 0, f: 660 }, { t: 0, f: 880 }] };
  for (const v of W.renderPattern(stacked)) {
    assert.ok(v >= -1 && v <= 1, `sample ${v} is outside the representable range`);
  }
});

test("the envelope starts and ends at silence", () => {
  const s = W.renderPattern(ALERT);
  assert.ok(Math.abs(s[0]) < 0.01, "no click at the start");
  assert.ok(Math.abs(s[s.length - 1]) < 0.02, "and none at the end");
});

test("the output is a WAV a browser will accept", () => {
  const bytes = W.toWav(W.renderPattern(ALERT));
  const ascii = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(ascii(36, 4), "data");

  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint16(34, true), 16, "16-bit");
  assert.equal(view.getUint32(4, true), bytes.length - 8, "the RIFF size matches the file");
  assert.equal(view.getUint32(40, true), bytes.length - 44, "and so does the data chunk");
});

test("it comes back as a data URI an <audio> tag can be handed", () => {
  const uri = W.patternDataUri(ALERT);
  assert.match(uri, /^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/);
  // Small enough to sit in the bundle without anybody noticing.
  assert.ok(uri.length < 200_000, `${uri.length} bytes is too much for a chime`);
});

test("a longer pattern makes a longer file", () => {
  const short = W.renderPattern({ ...ALERT, notes: [{ t: 0, f: 880 }] });
  const long = W.renderPattern({ ...ALERT, notes: [{ t: 0, f: 880 }, { t: 1.5, f: 880 }] });
  assert.ok(long.length > short.length);
});

test("an empty pattern is silence, not a crash", () => {
  const s = W.renderPattern({ notes: [] });
  assert.ok(s.length >= 1);
  assert.ok(Math.max(...Array.from(s, Math.abs)) === 0);
  assert.match(W.patternDataUri({}), /^data:audio\/wav;base64,/);
});
