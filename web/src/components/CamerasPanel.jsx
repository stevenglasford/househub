// CamerasPanel.jsx — connecting a household's own CamWatch.
//
// Same shape as the Home Assistant panel, because it is the same idea: a
// separate system the household already runs, plugged in here so it appears on
// the screen by the door.
//
// The three switches below are separate on purpose. Live view, alert history,
// and face data are wildly different in sensitivity, and a single "enable
// cameras" toggle would quietly opt a household into the third while they were
// thinking about the first. Faces in particular are biometric data — special
// category under GDPR — and stay on the machine that already holds them.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";

export default function CamerasPanel({ theme: T }) {
  const [state, setState] = useState(null);
  const [available, setAvailable] = useState(null);
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [chosen, setChosen] = useState([]);
  const [flags, setFlags] = useState({ showAlerts: true, showFaces: false, showRecordings: false });
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await session.cameraConfig();
      setState(s);
      if (s.connected) {
        setUrl(s.url || "");
        setChosen(s.cameras || []);
        setFlags({
          showAlerts: s.showAlerts, showFaces: s.showFaces, showRecordings: s.showRecordings,
        });
      }
    } catch (err) { setError(err.message); setState({ connected: false }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };
  const btn = (primary, danger) => ({
    background: danger ? "#a12f1c" : primary ? T.brand : T.panel,
    color: danger || primary ? "#fff" : T.ink,
    border: `1px solid ${danger ? "#a12f1c" : primary ? T.brand : T.line}`,
    borderRadius: 10, padding: "8px 14px", fontWeight: 600, cursor: "pointer",
  });
  const input = {
    width: "100%", padding: "10px 12px", borderRadius: 10, marginBottom: 8,
    border: `1px solid ${T.line}`, background: T.panel, color: T.ink,
  };

  async function runTest() {
    setBusy("test"); setError(null); setTest(null);
    try { setTest(await session.testCameras({ url: url.trim(), password })); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function save() {
    setBusy("save"); setError(null);
    try {
      await session.saveCameras({
        url: url.trim(),
        ...(password ? { password } : {}),
        cameras: chosen,
        ...flags,
      });
      setPassword("");
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function loadAvailable() {
    setBusy("list"); setError(null);
    try { setAvailable(await session.availableCameras()); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function disconnect() {
    if (!confirm(
      "Disconnect CamWatch?\n\n" +
      "The password is deleted from this server. Your footage, faces and recordings were " +
      "never stored here and are untouched on your own machine."
    )) return;
    setBusy("disconnect");
    try {
      const out = await session.disconnectCameras();
      alert(out.note);
      setState({ connected: false }); setUrl(""); setPassword(""); setChosen([]);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!state) return <p style={{ color: T.faint }}>Loading…</p>;

  const Toggle = ({ id, label, hint, warn }) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8, cursor: "pointer" }}>
      <input type="checkbox" checked={flags[id]} style={{ marginTop: 3 }}
             onChange={(e) => setFlags((f) => ({ ...f, [id]: e.target.checked }))} />
      <span>
        <span style={{ fontWeight: 600, color: T.ink, fontSize: 14 }}>{label}</span>
        <span style={{ display: "block", color: warn ? "#8a3d12" : T.faint, fontSize: 12 }}>{hint}</span>
      </span>
    </label>
  );

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {!state.connected && (
        <div style={{ ...card, background: "#eef4f7", borderColor: "#b7cede" }}>
          <div style={{ fontWeight: 600, color: "#12405c", marginBottom: 4 }}>What this is</div>
          <p style={{ fontSize: 13, color: "#255a78", lineHeight: 1.5 }}>
            CamWatch is a separate security-camera system you run on your own hardware —
            object detection, face recognition and recordings, all local. HouseHub does not
            replace it; it shows your cameras on the screens you already have here.
            Nothing is copied onto this server.
          </p>
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>
          {state.connected ? "Connection" : "Connect CamWatch"}
        </div>

        <label style={{ fontSize: 12, color: T.faint }}>Address</label>
        <input style={input} value={url} onChange={(e) => setUrl(e.target.value)}
               placeholder="http://192.168.1.60:8000" />

        <label style={{ fontSize: 12, color: T.faint }}>
          Password {state.connected && "(leave blank to keep the current one)"}
        </label>
        <input style={input} type="password" value={password} autoComplete="off"
               onChange={(e) => setPassword(e.target.value)}
               placeholder={state.connected ? "•••••••• unchanged" : "your CamWatch password"} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn(false)} disabled={busy === "test" || !url || !password} onClick={runTest}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button style={btn(true)} disabled={busy === "save" || !url || (!password && !state.connected)}
                  onClick={save}>
            {busy === "save" ? "Saving…" : state.connected ? "Save changes" : "Connect"}
          </button>
          {state.connected && (
            <button style={btn(false, true)} disabled={busy === "disconnect"} onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>

        {test && (
          <div style={{ marginTop: 8, fontSize: 13, color: test.ok ? "#1e4620" : "#7a1c12" }}>
            {test.ok ? "Connected." : test.error}
          </div>
        )}
        {state.connected && state.lastError && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#8a3d12" }}>Last error: {state.lastError}</div>
        )}
      </div>

      {state.connected && (
        <>
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 600, color: T.ink }}>Which cameras</div>
                <div style={{ fontSize: 12, color: T.faint }}>
                  {chosen.length ? `${chosen.length} chosen` : "All of them"}
                </div>
              </div>
              <button style={btn(false)} disabled={busy === "list"} onClick={loadAvailable}>
                {busy === "list" ? "Loading…" : available ? "Reload" : "Choose cameras"}
              </button>
            </div>

            {available && (
              <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, maxHeight: 220, overflowY: "auto" }}>
                {available.map((c) => (
                  <label key={c.id} style={{
                    display: "flex", gap: 8, alignItems: "center", padding: "6px 8px",
                    fontSize: 13, color: T.ink, cursor: "pointer",
                  }}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(String(c.id))}
                      onChange={(e) => setChosen((cur) =>
                        e.target.checked ? [...cur, String(c.id)] : cur.filter((x) => x !== String(c.id)))}
                    />
                    <span style={{ flex: 1 }}>{c.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div style={card}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>What to surface</div>
            <Toggle id="showAlerts" label="Alert history"
                    hint="Detections and when they happened, alongside the rest of your evening." />
            <Toggle id="showRecordings" label="Recordings"
                    hint="Browse and download clips. They stay on your CamWatch machine." />
            <Toggle id="showFaces" warn label="Enrolled faces"
                    hint="Biometric data — special category under GDPR. It stays on your own machine
                          and is only displayed here. Off unless you want it." />
            <button style={btn(true)} disabled={busy === "save"} onClick={save}>Save</button>
          </div>

          <div style={{ ...card, background: "#eef4ee", borderColor: "#bcd4bc" }}>
            <div style={{ fontWeight: 600, color: "#1e4620", marginBottom: 4 }}>On your wall displays</div>
            <div style={{ fontSize: 13, color: "#3a6b3c" }}>
              A display granted the <strong>Home</strong> scope shows live cameras only —
              never alerts, faces or recordings. A screen in a hallway listing who came to
              the door is a different thing from one showing the garden right now. The
              display never holds your CamWatch password, so revoking it revokes the
              cameras with it.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
