// HomeAssistantPanel.jsx — connecting a household to its own Home Assistant.
//
// Setup is where self-hosted integrations usually lose people: a wrong port, a
// token pasted with a trailing newline, http where https was needed, and the
// only feedback is a blank tab. So this tests before it saves, reports what it
// actually found, and refuses to store a connection that does not work — a
// half-saved integration is worse than none, because it looks connected.
//
// The token is write-only from the browser's point of view. It is sent once,
// sealed on the server, and never sent back. Nothing in this panel can display
// it again, which is deliberate: it is a full-access credential for somebody's
// home, and the fewer places it exists the better.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as session from "../lib/session.js";

const DOMAIN_LABELS = {
  light: "Lights", switch: "Switches", fan: "Fans", cover: "Blinds & garage",
  lock: "Locks", camera: "Cameras", sensor: "Sensors", binary_sensor: "Contact & motion",
  climate: "Thermostats", media_player: "Media", weather: "Weather", person: "People",
};

export default function HomeAssistantPanel({ theme: T }) {
  const [state, setState] = useState(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [dashboardUrl, setDashboardUrl] = useState("");
  const [controlEnabled, setControlEnabled] = useState(false);
  const [chosen, setChosen] = useState([]);
  const [available, setAvailable] = useState(null);
  const [search, setSearch] = useState("");
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await session.request("GET", `api/households/${session.householdId()}/home`);
      setState(s);
      if (s.connected) {
        setUrl(s.url || "");
        setDashboardUrl(s.dashboardUrl || "");
        setControlEnabled(Boolean(s.controlEnabled));
        setChosen(s.entities || []);
      }
    } catch (err) { setError(err.message); }
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
    try {
      setTest(await session.request("POST", `api/households/${session.householdId()}/home/test`,
        { url: url.trim(), token: token.trim() }));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function save(extra = {}) {
    setBusy("save"); setError(null);
    try {
      await session.request("PUT", `api/households/${session.householdId()}/home`, {
        url: url.trim(),
        // Omitted when unchanged, so nobody re-pastes a token to tick a box.
        ...(token.trim() ? { token: token.trim() } : {}),
        dashboardUrl: dashboardUrl.trim() || null,
        controlEnabled,
        entities: chosen,
        ...extra,
      });
      setToken("");
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function loadEntities() {
    setBusy("entities"); setError(null);
    try {
      setAvailable(await session.request("GET", `api/households/${session.householdId()}/home/entities/all`));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function disconnect() {
    if (!confirm(
      "Disconnect Home Assistant?\n\n" +
      "The access token is deleted from this server. Revoke it in Home Assistant too — " +
      "deleting it here does not make it stop working there."
    )) return;
    setBusy("disconnect"); setError(null);
    try {
      const out = await session.request("DELETE", `api/households/${session.householdId()}/home`);
      alert(out.note);
      setState({ connected: false }); setUrl(""); setToken(""); setChosen([]);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const grouped = useMemo(() => {
    if (!available) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? available.filter((e) => e.name.toLowerCase().includes(q) || e.entityId.includes(q))
      : available;
    const by = {};
    for (const e of filtered) (by[e.domain] ||= []).push(e);
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [available, search]);

  if (!state) return <p style={{ color: T.faint }}>Loading…</p>;

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {!state.connected && (
        <div style={{ ...card, background: "#eef4f7", borderColor: "#b7cede" }}>
          <div style={{ fontWeight: 600, color: "#12405c", marginBottom: 4 }}>Before you start</div>
          <ol style={{ margin: "0 0 0 18px", fontSize: 13, color: "#255a78", lineHeight: 1.5 }}>
            <li>In Home Assistant, ideally create a <strong>separate user</strong> for HouseHub
                rather than using your own owner account — this server will hold a token that
                can control your house.</li>
            <li>Open that user's profile → <strong>Long-lived access tokens</strong> → Create.</li>
            <li>Paste the token below with your Home Assistant address
                (e.g. <code>http://192.168.1.50:8123</code>).</li>
          </ol>
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>
          {state.connected ? "Connection" : "Connect Home Assistant"}
        </div>

        <label style={{ fontSize: 12, color: T.faint }}>Address</label>
        <input style={input} value={url} onChange={(e) => setUrl(e.target.value)}
               placeholder="http://192.168.1.50:8123" />

        <label style={{ fontSize: 12, color: T.faint }}>
          Long-lived access token {state.connected && "(leave blank to keep the current one)"}
        </label>
        <input style={input} type="password" value={token} onChange={(e) => setToken(e.target.value)}
               placeholder={state.connected ? "•••••••• unchanged" : "eyJhbGciOi…"} autoComplete="off" />

        <label style={{ fontSize: 12, color: T.faint }}>Dashboard link (optional)</label>
        <input style={input} value={dashboardUrl} onChange={(e) => setDashboardUrl(e.target.value)}
               placeholder="http://192.168.1.50:8123/lovelace/0" />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btn(false)} disabled={busy === "test" || !url || !token} onClick={runTest}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button style={btn(true)} disabled={busy === "save" || !url || (!token && !state.connected)}
                  onClick={() => save()}>
            {busy === "save" ? "Saving…" : state.connected ? "Save changes" : "Connect"}
          </button>
          {state.connected && (
            <button style={btn(false, true)} disabled={busy === "disconnect"} onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>

        {test && (
          <div style={{
            marginTop: 8, fontSize: 13,
            color: test.ok ? "#1e4620" : "#7a1c12",
          }}>
            {test.ok
              ? `Connected — ${test.entityCount} entities found (${Object.entries(test.domains)
                  .sort((a, b) => b[1] - a[1]).slice(0, 5)
                  .map(([d, n]) => `${n} ${DOMAIN_LABELS[d] || d}`).join(", ")}).`
              : test.error}
          </div>
        )}

        {state.connected && state.lastError && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#8a3d12" }}>
            Last error: {state.lastError}
          </div>
        )}
      </div>

      {state.connected && (
        <>
          <div style={card}>
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" checked={controlEnabled} style={{ marginTop: 3 }}
                     onChange={(e) => { setControlEnabled(e.target.checked); }} />
              <span>
                <span style={{ fontWeight: 600, color: T.ink }}>Let members switch things</span>
                <span style={{ display: "block", fontSize: 13, color: T.faint }}>
                  Lights, switches, fans and blinds. Locks always require someone signed in
                  with adult access and can never be operated from a shared display, whatever
                  else is enabled.
                </span>
              </span>
            </label>
            <button style={{ ...btn(true), marginTop: 8 }} disabled={busy === "save"} onClick={() => save()}>
              Save
            </button>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 600, color: T.ink }}>What to show</div>
                <div style={{ fontSize: 12, color: T.faint }}>
                  {chosen.length ? `${chosen.length} chosen` : "Nothing chosen yet — the Home tab stays hidden"}
                </div>
              </div>
              <button style={btn(false)} disabled={busy === "entities"} onClick={loadEntities}>
                {busy === "entities" ? "Loading…" : available ? "Reload list" : "Choose entities"}
              </button>
            </div>

            {available && (
              <div style={{ marginTop: 10 }}>
                <input style={input} value={search} onChange={(e) => setSearch(e.target.value)}
                       placeholder="Search…" />
                <div style={{ maxHeight: 260, overflowY: "auto", border: `1px solid ${T.line}`, borderRadius: 8 }}>
                  {grouped.map(([domain, items]) => (
                    <div key={domain}>
                      <div style={{
                        position: "sticky", top: 0, background: T.panelAlt, padding: "4px 8px",
                        fontSize: 12, fontWeight: 700, color: T.faint, borderBottom: `1px solid ${T.line}`,
                      }}>
                        {DOMAIN_LABELS[domain] || domain}
                      </div>
                      {items.map((e) => (
                        <label key={e.entityId} style={{
                          display: "flex", gap: 8, alignItems: "center", padding: "5px 8px",
                          fontSize: 13, color: T.ink, cursor: "pointer",
                        }}>
                          <input
                            type="checkbox"
                            checked={chosen.includes(e.entityId)}
                            onChange={(ev) => setChosen((c) =>
                              ev.target.checked ? [...c, e.entityId] : c.filter((x) => x !== e.entityId))}
                          />
                          <span style={{ flex: 1 }}>{e.name}</span>
                          <span style={{ color: T.faint, fontSize: 11 }}>{e.state}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <button style={{ ...btn(true), marginTop: 8 }} disabled={busy === "save"} onClick={() => save()}>
                  Save selection
                </button>
              </div>
            )}
          </div>

          <div style={{ ...card, background: "#eef4ee", borderColor: "#bcd4bc" }}>
            <div style={{ fontWeight: 600, color: "#1e4620", marginBottom: 4 }}>How this is kept</div>
            <div style={{ fontSize: 13, color: "#3a6b3c" }}>
              The token is stored encrypted on this server and never sent back to a browser.
              It is the one thing here the server must be able to read, because Home Assistant
              usually sits on a private network your phone cannot reach and its camera
              endpoints reject long-lived tokens in URLs. Everything else your household
              writes stays encrypted with a key this server does not have.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
