// ha-voice.test.js — a command heard by a satellite, acted on by a display.
//
// The whole point of this path is that the transcript never touches the
// HouseHub server, so the test drives a fake WebSocket rather than a fake
// server: what is being checked is that the display talks to Home Assistant
// directly and gets the handshake right.

import test from "node:test";
import assert from "node:assert/strict";
import * as HV from "../src/lib/ha-voice.js";
import { parseTimerCommand } from "../src/lib/timer-voice.js";

/** A stand-in for the browser's WebSocket, driven by the test. */
function fakeSocket() {
  const sent = [];
  const s = {
    sent,
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    close() { s.closed = true; s.onclose && s.onclose(); },
    closed: false,
    // the server's half
    say(msg) { s.onmessage && s.onmessage({ data: JSON.stringify(msg) }); },
  };
  return s;
}

test("http and https map to the right websocket scheme", () => {
  assert.equal(HV.wsUrlFor("http://192.168.1.50:8123"), "ws://192.168.1.50:8123/api/websocket");
  assert.equal(HV.wsUrlFor("https://ha.example.com"), "wss://ha.example.com/api/websocket");
  assert.equal(HV.wsUrlFor("http://192.168.1.50:8123/"), "ws://192.168.1.50:8123/api/websocket",
    "a trailing slash is not a different server");
  assert.equal(HV.wsUrlFor(""), "");
});

test("the handshake authenticates, then subscribes", () => {
  const s = fakeSocket();
  const states = [];
  HV.connectVoice({
    url: "http://ha.local:8123", token: "TOKEN", screenName: "Kitchen wall",
    makeSocket: () => s, onState: (st) => states.push(st), onCommand: () => {},
  });

  s.say({ type: "auth_required" });
  assert.deepEqual(s.sent[0], { type: "auth", access_token: "TOKEN" });

  s.say({ type: "auth_ok" });
  assert.equal(s.sent[1].type, "subscribe_events");
  assert.equal(s.sent[1].event_type, HV.VOICE_EVENT);
  assert.ok(states.includes("listening"));
});

test("a rejected token does not start a reconnect loop", () => {
  // A token Home Assistant refused will be refused again. Retrying just fills
  // its log and hides the real problem behind a screen that looks busy.
  const s = fakeSocket();
  const states = [];
  const conn = HV.connectVoice({
    url: "http://ha.local:8123", token: "BAD",
    makeSocket: () => s, onState: (st) => states.push(st), onCommand: () => {},
  });

  s.say({ type: "auth_required" });
  s.say({ type: "auth_invalid", message: "Invalid access token" });

  assert.ok(states.includes("unauthorised"), "the screen is told why, not left blank");
  assert.equal(s.closed, true);
  conn.close();
});

test("a spoken command reaches the handler, and becomes a timer", () => {
  const s = fakeSocket();
  const heard = [];
  HV.connectVoice({
    url: "http://ha.local:8123", token: "T", screenName: "Kitchen wall",
    makeSocket: () => s, onCommand: (text) => heard.push(text),
  });
  s.say({ type: "auth_required" });
  s.say({ type: "auth_ok" });

  s.say({ type: "event", event: { data: { text: "set a timer for 10 minutes for the pasta" } } });
  assert.deepEqual(heard, ["set a timer for 10 minutes for the pasta"]);

  // and the same parser the on-screen microphone uses turns it into a timer
  const cmd = parseTimerCommand(heard[0]);
  assert.equal(cmd.durationMs, 10 * 60 * 1000);
  assert.equal(cmd.label.toLowerCase(), "pasta");
});

test("a named display is the only one that acts", () => {
  // Without this, a household with a wall tablet and a hallway screen gets two
  // timers from one sentence.
  const kitchen = [], hallway = [];
  const mk = (name, sink) => {
    const s = fakeSocket();
    HV.connectVoice({ url: "http://ha.local:8123", token: "T", screenName: name,
      makeSocket: () => s, onCommand: (t) => sink.push(t) });
    s.say({ type: "auth_required" });
    s.say({ type: "auth_ok" });
    return s;
  };
  const k = mk("Kitchen wall", kitchen);
  const h = mk("Hallway", hallway);

  const ev = { type: "event", event: { data: { text: "set a timer for 5 minutes", display: "Kitchen wall" } } };
  k.say(ev); h.say(ev);

  assert.equal(kitchen.length, 1, "the named screen acts");
  assert.equal(hallway.length, 0, "and the other does not");
});

test("an untargeted command is a broadcast to whoever is listening", () => {
  // The common case: one wall tablet, and an automation nobody bothered to
  // give a target. It has to work, or the feature appears broken on setup.
  const heard = [];
  const s = fakeSocket();
  HV.connectVoice({ url: "http://ha.local:8123", token: "T", screenName: "Kitchen wall",
    makeSocket: () => s, onCommand: (t) => heard.push(t) });
  s.say({ type: "auth_required" });
  s.say({ type: "auth_ok" });
  s.say({ type: "event", event: { data: { text: "set a timer for 3 minutes" } } });

  assert.equal(heard.length, 1);
});

test("the target name is matched forgivingly", () => {
  // It is typed twice — once in HouseHub, once in a Home Assistant automation.
  // Expecting those to match exactly is how this silently does nothing.
  assert.equal(HV.isForThisScreen({ display: "kitchen wall" }, "Kitchen Wall"), true);
  assert.equal(HV.isForThisScreen({ display: " Kitchen wall " }, "Kitchen wall"), true);
  assert.equal(HV.isForThisScreen({ display: "Hallway" }, "Kitchen wall"), false);
  assert.equal(HV.isForThisScreen({}, "Kitchen wall"), true, "no target means everyone");
});

test("the transcript field can be called any of the obvious things", () => {
  assert.equal(HV.textOf({ text: "a" }), "a");
  assert.equal(HV.textOf({ command: "b" }), "b");
  assert.equal(HV.textOf({ transcript: "c" }), "c");
  assert.equal(HV.textOf({}), "");
});

test("a dropped connection is retried", () => {
  // A wall tablet stays awake for weeks across router reboots. A voice control
  // that stops at the first blip is worse than none, because nobody finds out
  // until the moment they need it.
  let made = 0;
  const sockets = [];
  const conn = HV.connectVoice({
    url: "http://ha.local:8123", token: "T", retryMs: 1,
    makeSocket: () => { made++; const s = fakeSocket(); sockets.push(s); return s; },
    onCommand: () => {},
  });
  assert.equal(made, 1);
  sockets[0].close();

  return new Promise((resolve) => setTimeout(() => {
    assert.ok(made >= 2, `expected a reconnect, saw ${made} attempts`);
    conn.close();
    resolve();
  }, 30));
});
