// chime-wav.js — the chime as an audio file rather than as scheduled oscillators.
//
// The reported fault: reminders chime on a laptop and are silent on the iPad
// mounted in the hall, which is the one screen the feature exists for.
//
// The cause is not in this app. iOS routes Web Audio through the *ringer*
// channel, so anything scheduled on an AudioContext is silenced by the mute
// switch — while an <audio> element plays on the media channel and is not.
// A laptop has no such switch, so identical code behaves differently on the
// two devices, and the tablet looks broken while the test button on the laptop
// says everything is fine.
//
// There is no API to ask iOS for the media channel; the only way to get it is
// to be a media element. So the chime is rendered to a small WAV here and
// handed to an <audio> tag. The oscillator path stays as the fallback, because
// this one has its own failure mode -- a browser that refuses to decode, or an
// element that will not play -- and between them the two cover more ground than
// either alone.
//
// Rendered rather than shipped as an asset: a binary in the repo is a thing
// nobody can read in review, and the patterns are already described exactly in
// App.jsx. This turns that same description into samples.

const RATE = 22050;   // plenty for a two-note chime, and a quarter the bytes of 44.1k

/** One cycle of the named wave at phase p (0..1). */
function sample(wave, p) {
  const t = 2 * Math.PI * p;
  switch (wave) {
    case "square": return Math.sin(t) >= 0 ? 1 : -1;
    case "triangle": return (2 / Math.PI) * Math.asin(Math.sin(t));
    case "sawtooth": return 2 * (p - Math.floor(p + 0.5));
    default: return Math.sin(t);
  }
}

/**
 * Render a chime pattern to mono 16-bit PCM.
 *
 * The envelope matches what the Web Audio path does note for note -- a fast
 * linear attack then an exponential decay -- so the two routes sound the same.
 * If they drifted, a household would hear one chime on the tablet and a
 * different one on a phone, and reasonably conclude something was wrong.
 */
export function renderPattern(spec) {
  const notes = spec?.notes || [];
  const peak = typeof spec?.peak === "number" ? spec.peak : 0.2;
  const decay = typeof spec?.decay === "number" ? spec.decay : 0.4;
  const wave = spec?.wave || "sine";

  const end = notes.reduce((m, n) => Math.max(m, (n.t || 0) + decay), 0) + 0.05;
  const total = Math.max(1, Math.ceil(end * RATE));
  const buf = new Float32Array(total);

  for (const n of notes) {
    const start = Math.floor((n.t || 0) * RATE);
    const len = Math.ceil(decay * RATE);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= total) break;
      const t = i / RATE;
      // 15ms attack, then exponential decay to silence -- the same shape the
      // gain node draws in the Web Audio path.
      const env = t < 0.015
        ? (t / 0.015) * peak
        : peak * Math.pow(0.001 / peak, (t - 0.015) / Math.max(0.001, decay - 0.015));
      buf[idx] += env * sample(wave, (n.f || 440) * t);
    }
  }

  // Clip rather than wrap. Overlapping notes can sum past 1, and a wrapped
  // sample is a loud click -- the worst possible artefact in an alert sound.
  for (let i = 0; i < total; i++) buf[i] = Math.max(-1, Math.min(1, buf[i]));
  return buf;
}

/** Wrap mono float samples in a WAV container. Returns bytes. */
export function toWav(samples, rate = RATE) {
  const n = samples.length;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    view.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
  }
  return bytes;
}

/** base64, in a browser or in node. */
export function toBase64(bytes) {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString("base64");
}

/** A pattern spec as a `data:` URL an <audio> element will play. */
export function patternDataUri(spec) {
  return `data:audio/wav;base64,${toBase64(toWav(renderPattern(spec)))}`;
}
