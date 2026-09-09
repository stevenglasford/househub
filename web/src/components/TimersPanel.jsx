// TimersPanel.jsx — kitchen timers on the wall, by voice or by thumb.
//
// Ryan: "add a timer ... activated by voice and the ability to set multiple
// times that are named and also have an audio alarm go off with each."
//
// Three surfaces, because a timer is useless if it is behind a tab:
//
//   TimerBar    a strip that appears whenever anything is counting, above the
//               tabs, on every screen. Also the only place a timer is started,
//               so there is one thing to reach for rather than a tab to find.
//   TimerAlarm  a takeover when one finishes. Deliberately hard to miss and
//               deliberately easy to dismiss -- the two things a kitchen alarm
//               has to be at once.
//   The voice button, which is a button rather than an always-on microphone.
//               That is a decision, not a limitation: this thing lives in a
//               room people talk in, and a display that is always listening is
//               a different product with a different threat model than the one
//               whose whole premise is that the server cannot read anything.
//
// The countdown ticks locally, once a second, and is never written to the
// document -- the document holds the two timestamps in lib/timers.js and
// nothing else, so a tick costs nothing and syncs nothing.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Play, Pause, Plus, X, RotateCcw, Mic, Timer as TimerIcon } from "lucide-react";
import * as TM from "../lib/timers.js";
import { parseDuration, parseTimerCommand, parseStopCommand, matchTimerByName } from "../lib/timer-voice.js";
import { connectVoice } from "../lib/ha-voice.js";
import * as session from "../lib/session.js";
import { loadVoiceLink } from "../api.js";

/* Quick durations, in minutes. Chosen for a kitchen rather than for round
   numbers: 3 is tea, 12 is pasta, 25 is a pomodoro and a tray of vegetables. */
const QUICK = [1, 3, 5, 10, 12, 15, 20, 25, 30, 45, 60];

/** Re-render every second, but only while something is actually counting. */
function useTick(active) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/* --------------------------------------------------------------- speech --- */

/**
 * The browser's own speech recognition, or nothing.
 *
 * Web Speech is Chrome-shaped: `webkitSpeechRecognition` on Chrome and Edge,
 * absent on Firefox, and on desktop Chrome it reaches Google's servers to do
 * the recognition. That last part matters here more than it would in another
 * app -- this one's premise is that household content never leaves the house in
 * readable form -- so the microphone is push-to-talk, the transcript is shown
 * before anything is created, and `useVoice` reports `supported: false` rather
 * than pretending, so the UI can simply not offer it.
 */
export function useVoice({ onResult }) {
  const Rec = typeof window !== "undefined"
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const ref = useRef(null);
  const cb = useRef(onResult);
  cb.current = onResult;

  const stop = useCallback(() => {
    try { ref.current && ref.current.stop(); } catch (e) { /* already stopped */ }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!Rec) return;
    setError(""); setHeard("");
    let rec;
    try { rec = new Rec(); } catch (e) { setError("The microphone could not be opened."); return; }
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-GB";
    rec.interimResults = true;   // so the household sees it hearing them, not a dead button
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      setHeard(text.trim());
      const last = ev.results[ev.results.length - 1];
      if (last && last.isFinal) cb.current && cb.current(text.trim());
    };
    rec.onerror = (ev) => {
      setError(ev?.error === "not-allowed"
        ? "This screen is not allowed to use the microphone."
        : "That did not come through.");
      setListening(false);
    };
    rec.onend = () => setListening(false);

    ref.current = rec;
    try { rec.start(); setListening(true); } catch (e) { setError("The microphone is busy."); }
  }, [Rec]);

  useEffect(() => () => { try { ref.current && ref.current.abort(); } catch (e) { /* gone */ } }, []);

  return { supported: Boolean(Rec), listening, heard, error, start, stop, setHeard };
}

/**
 * Commands heard by a satellite microphone somewhere else in the house.
 *
 * The push-to-talk microphone above only helps somebody standing at the screen.
 * Satellites solve that, and move the transcript into Home Assistant -- so this
 * subscribes to it directly rather than letting the HouseHub server relay it.
 * See lib/ha-voice.js for why that distinction is the whole design.
 *
 * Silently does nothing on a server that has no voice endpoint yet, which is
 * every server until Steven ships the other half.
 */
function useSatelliteVoice(onCommand) {
  const [state, setState] = useState("off");
  const cb = useRef(onCommand);
  cb.current = onCommand;

  useEffect(() => {
    let conn = null, dead = false;
    (async () => {
      const link = await loadVoiceLink();
      if (dead || !link || !link.url || !link.token || link.enabled === false) return;
      conn = connectVoice({
        url: link.url,
        token: link.token,
        screenName: session.snapshot().displayName || "",
        onState: setState,
        onCommand: (text) => cb.current && cb.current(text),
      });
    })();
    return () => { dead = true; conn && conn.close(); };
  }, []);

  return state;
}

/* ------------------------------------------------------------ one timer --- */

function TimerPill({ t, now, T, onOpen }) {
  const state = TM.timerState(t, now);
  const left = TM.remainingMs(t, now);
  const ringing = state === "ringing";
  const paused = state === "paused";

  return (
    <button onClick={() => onOpen(t.id)} className="tapfade text-left"
      style={{
        display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto",
        background: ringing ? "#7a1c12" : T.panelAlt,
        border: `1px solid ${ringing ? "#7a1c12" : T.line}`,
        borderRadius: 999, padding: "6px 12px",
        color: ringing ? "#fff" : T.ink,
        opacity: paused ? 0.7 : 1,
      }}>
      {paused ? <Pause size={13} /> : <TimerIcon size={13} />}
      <span style={{ fontWeight: 600, fontSize: 13 }}>{TM.timerName(t)}</span>
      <span style={{
        fontVariantNumeric: "tabular-nums", fontWeight: 700, fontSize: 14,
        color: ringing ? "#fff" : T.faint,
      }}>
        {ringing ? "done" : TM.formatDuration(left)}
      </span>
    </button>
  );
}

/* --------------------------------------------------------------- adding --- */

function AddTimer({ T, onAdd, onClose, voice }) {
  const [name, setName] = useState("");
  const [custom, setCustom] = useState("");

  /* The typed box takes the same phrasings the microphone does -- "1 hour 30",
     "90 seconds", "5:30" -- because having two grammars for the one feature is
     how they drift apart. */
  const [bad, setBad] = useState(false);
  const submitCustom = () => {
    const ms = parseDuration(custom);
    if (ms === null || ms <= 0) { setBad(true); return; }
    onAdd(ms, name);
    onClose();
  };

  return (
    <div style={{
      position: "absolute", bottom: "100%", left: 0, marginBottom: 8, zIndex: 40,
      background: T.panel, border: `1px solid ${T.line}`, borderRadius: 14,
      padding: 12, minWidth: 288, boxShadow: "0 10px 30px rgba(0,0,0,.28)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.faint, letterSpacing: .4 }}>NEW TIMER</span>
        <button onClick={onClose} className="tapfade" style={{ color: T.faint }} aria-label="Close"><X size={15} /></button>
      </div>

      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What for? (optional)"
        style={{
          width: "100%", background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 9,
          padding: "7px 9px", color: T.ink, fontSize: 13.5, marginBottom: 9,
        }} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 9 }}>
        {QUICK.map((m) => (
          <button key={m} onClick={() => { onAdd(m * 60 * 1000, name); onClose(); }} className="tapfade"
            style={{
              background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 8,
              padding: "5px 9px", color: T.ink, fontSize: 12.5, fontWeight: 600,
            }}>{m}m</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <input value={custom} onChange={(e) => { setCustom(e.target.value); setBad(false); }}
          onKeyDown={(e) => e.key === "Enter" && submitCustom()}
          placeholder="or: 1 hour 30, 90 seconds, 5:30"
          style={{
            flex: 1, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 9,
            padding: "7px 9px", color: T.ink, fontSize: 13.5,
          }} />
        <button onClick={submitCustom} className="tapfade"
          style={{
            background: T.accent || "#2f6f4f", border: "none", borderRadius: 9,
            padding: "7px 12px", color: "#fff", fontSize: 13, fontWeight: 700,
          }}>Start</button>
      </div>

      {bad && (
        <p style={{ color: "#c2564a", fontSize: 12, marginTop: 7 }}>
          No length in that — try “10 minutes”, “1 hour 30” or “5:30”.
        </p>
      )}

      {/* The same parser serves the keyboard and the microphone, so the phrasing
          hint here is true of both. */}
      {voice?.supported && (
        <p style={{ color: T.faint, fontSize: 11.5, marginTop: 8, lineHeight: 1.45 }}>
          Or hold the microphone and say “set a timer for ten minutes for the pasta”.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the strip --- */

/**
 * The always-there timer bar.
 *
 * Rendered even with nothing running, because it is the only way to start one;
 * it collapses to a single button in that case so it costs almost no room on a
 * wall display that is already tight.
 */
export function TimerBar({ data, update, T, personId = "" }) {
  const timers = data?.timers || [];
  const anyLive = timers.some((t) => TM.timerState(t) !== "done");
  useTick(anyLive);
  const now = Date.now();

  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const active = TM.activeTimers(data, now);

  const add = useCallback((ms, label) => update((d) => ({
    ...d,
    timers: [...(d.timers || []), TM.newTimer({ label, durationMs: ms, personId, now: Date.now() })],
  })), [update, personId]);

  const apply = useCallback((id, fn) => update((d) => ({
    ...d,
    timers: (d.timers || []).map((t) => (t.id === id ? fn(t, Date.now()) : t)),
  })), [update]);

  const drop = useCallback((id) => update((d) => ({
    ...d, timers: (d.timers || []).filter((t) => t.id !== id),
  })), [update]);

  /* Voice. A spoken instruction is either "start one" or "stop one", and the
     stop check runs first: "cancel the pasta timer" contains no duration, but
     "stop the 10 minute one" does, and reading that as a new timer would be a
     genuinely annoying way to fail. */
  const handleSpoken = useCallback((text) => {
    const stopCmd = parseStopCommand(text);
    if (stopCmd) {
      const live = TM.activeTimers({ timers }, Date.now());
      if (stopCmd.all) { live.forEach((t) => apply(t.id, TM.silenceTimer)); return; }
      const hit = matchTimerByName(live, stopCmd.name)
        || TM.ringingTimers({ timers }, Date.now())[0]
        || live[0];
      if (hit) apply(hit.id, TM.silenceTimer);
      return;
    }
    const cmd = parseTimerCommand(text);
    if (cmd) add(cmd.durationMs, cmd.label);
  }, [timers, apply, add]);

  /* Both microphones run the same handler. A command heard at the screen and
     one heard by a satellite in the next room are the same instruction, and
     giving them separate paths is how they end up behaving differently. */
  const voice = useVoice({ onResult: handleSpoken });
  const satellite = useSatelliteVoice(handleSpoken);

  const open = active.find((t) => t.id === openId) || null;

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 7, padding: "4px 12px 6px", background: T.bg }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, overflowX: "auto", flex: 1, minWidth: 0 }}>
        {active.map((t) => <TimerPill key={t.id} t={t} now={now} T={T} onOpen={setOpenId} />)}
      </div>

      {voice.supported && (
        <button onClick={() => (voice.listening ? voice.stop() : voice.start())} className="tapfade"
          aria-label={voice.listening ? "Stop listening" : "Set a timer by voice"}
          style={{
            flex: "0 0 auto", background: voice.listening ? "#7a1c12" : T.panelAlt,
            border: `1px solid ${voice.listening ? "#7a1c12" : T.line}`, borderRadius: 999,
            padding: "6px 10px", color: voice.listening ? "#fff" : T.ink,
            display: "flex", alignItems: "center", gap: 6,
          }}>
          <Mic size={14} />
          {voice.listening && <span style={{ fontSize: 12, fontWeight: 700 }}>Listening…</span>}
        </button>
      )}

      {/* Shown only when satellites are actually connected: a screen claiming
          to be listening when Home Assistant is unreachable is worse than one
          that says nothing, because the household stops checking. */}
      {satellite === "listening" && (
        <span title="Listening for voice commands from Home Assistant"
          style={{ flex: "0 0 auto", color: T.faint, display: "flex", alignItems: "center" }}>
          <Mic size={13} />
        </span>
      )}

      <button onClick={() => setAdding((v) => !v)} className="tapfade" aria-label="New timer"
        style={{
          flex: "0 0 auto", background: T.panelAlt, border: `1px solid ${T.line}`,
          borderRadius: 999, padding: "6px 10px", color: T.ink, display: "flex", alignItems: "center", gap: 5,
        }}>
        <Plus size={14} /><TimerIcon size={14} />
      </button>

      {adding && <AddTimer T={T} onAdd={add} onClose={() => setAdding(false)} voice={voice} />}

      {/* What was heard, shown before and after it is acted on. A voice control
          that silently does the wrong thing is worse than one that does
          nothing, and this is the whole of the difference. */}
      {(voice.heard || voice.error) && (
        <div style={{
          position: "absolute", bottom: "100%", right: 12, marginBottom: 6,
          background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10,
          padding: "6px 10px", fontSize: 12.5, color: voice.error ? "#c2564a" : T.faint, maxWidth: 320,
        }}>
          {voice.error || `“${voice.heard}”`}
        </div>
      )}

      {open && (
        <div style={{
          position: "absolute", bottom: "100%", left: 12, marginBottom: 8, zIndex: 40,
          background: T.panel, border: `1px solid ${T.line}`, borderRadius: 14, padding: 10,
          display: "flex", alignItems: "center", gap: 6, boxShadow: "0 10px 30px rgba(0,0,0,.28)",
        }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: T.ink, marginRight: 4 }}>{TM.timerName(open)}</span>
          {TM.timerState(open, now) === "paused" ? (
            <IconBtn T={T} label="Resume" onClick={() => apply(open.id, TM.resumeTimer)}><Play size={14} /></IconBtn>
          ) : (
            <IconBtn T={T} label="Pause" onClick={() => apply(open.id, TM.pauseTimer)}><Pause size={14} /></IconBtn>
          )}
          <TextBtn T={T} onClick={() => apply(open.id, (t, n) => TM.addTime(t, 60000, n))}>+1 min</TextBtn>
          <TextBtn T={T} onClick={() => apply(open.id, TM.restartTimer)}><RotateCcw size={13} /></TextBtn>
          <TextBtn T={T} onClick={() => { drop(open.id); setOpenId(null); }}>Remove</TextBtn>
          <IconBtn T={T} label="Close" onClick={() => setOpenId(null)}><X size={14} /></IconBtn>
        </div>
      )}
    </div>
  );
}

const IconBtn = ({ T, label, onClick, children }) => (
  <button onClick={onClick} className="tapfade" aria-label={label}
    style={{ background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 8, padding: "6px 8px", color: T.ink }}>
    {children}
  </button>
);

const TextBtn = ({ T, onClick, children }) => (
  <button onClick={onClick} className="tapfade"
    style={{
      background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 8,
      padding: "6px 9px", color: T.ink, fontSize: 12.5, fontWeight: 600,
    }}>
    {children}
  </button>
);

/* ---------------------------------------------------------------- alarm --- */

/**
 * The takeover when a timer finishes.
 *
 * Silencing writes to the document, so this closes on every screen at once --
 * the same property the reminder snoozes have, and for the same reason: nobody
 * should have to walk round the house dismissing one alarm.
 */
export function TimerAlarm({ data, update, T }) {
  useTick(true);
  const now = Date.now();
  const ringing = TM.ringingTimers(data, now);
  const t = ringing[0];
  if (!t) return null;

  const apply = (fn) => update((d) => ({
    ...d, timers: (d.timers || []).map((x) => (x.id === t.id ? fn(x, Date.now()) : x)),
  }));

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 90, background: "rgba(12,10,9,.86)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: T.panel, border: `1px solid ${T.line}`, borderRadius: 20,
        padding: "28px 26px", textAlign: "center", maxWidth: 460, width: "100%",
      }}>
        <p style={{ color: T.faint, fontSize: 12.5, fontWeight: 700, letterSpacing: .6 }}>TIMER FINISHED</p>
        <h2 style={{ color: T.ink, fontSize: 34, fontWeight: 800, margin: "8px 0 4px" }}>{TM.timerName(t)}</h2>
        <p style={{ color: T.faint, fontSize: 14 }}>{TM.spokenDuration(t.durationMs)}</p>

        {ringing.length > 1 && (
          <p style={{ color: T.faint, fontSize: 12.5, marginTop: 6 }}>
            and {ringing.length - 1} other{ringing.length > 2 ? "s" : ""} waiting
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
          <button onClick={() => apply(TM.silenceTimer)} className="tapfade"
            style={{
              background: "#7a1c12", border: "none", borderRadius: 12, padding: "12px 28px",
              color: "#fff", fontSize: 16, fontWeight: 800,
            }}>Stop</button>
          <button onClick={() => apply((x, n) => TM.addTime(x, 60000, n))} className="tapfade"
            style={{
              background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 12,
              padding: "12px 20px", color: T.ink, fontSize: 15, fontWeight: 700,
            }}>+1 min</button>
          <button onClick={() => apply(TM.restartTimer)} className="tapfade"
            style={{
              background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 12,
              padding: "12px 20px", color: T.ink, fontSize: 15, fontWeight: 700,
            }}>Again</button>
        </div>
      </div>
    </div>
  );
}
