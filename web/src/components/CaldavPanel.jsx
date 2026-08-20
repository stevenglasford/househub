// CaldavPanel.jsx — connecting a real calendar account, and choosing what
// HouseHub is allowed to write to it.
//
// Ryan: "Make it so that calendars are two way syncable. I know google calendars
// two way sync doesnt really work, but set it up for icloud at least."
//
// The panel is deliberately blunt about what connecting one costs. Every other
// secret this server holds is narrow -- a subscription URL reads one calendar, a
// camera token reads one camera. A CalDAV login can rewrite a calendar, so the
// screen says what it is storing, insists on an app-specific password, and
// leaves every calendar read-only until somebody turns one on by name.

import React, { useState, useEffect, useCallback } from "react";
import * as api from "../api.js";

const APPLE_ID_HELP = "https://account.apple.com/account/manage";

export default function CaldavPanel({ theme: T, iAmAdmin, collectEvents }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ username: "", password: "" });

  const load = useCallback(() => {
    api.loadCaldav().then(setState).catch(() => setState({ accounts: [] }));
  }, []);
  useEffect(load, [load]);

  const connect = async () => {
    setBusy("connect"); setError(null); setNotice(null);
    try {
      const res = await api.connectCaldav(form);
      setForm({ username: "", password: "" });
      setState({ ...state, accounts: res.accounts });
      setNotice(`Connected. Found ${res.calendars} calendar${res.calendars === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err?.message || "Could not connect.");
    } finally { setBusy(""); }
  };

  const disconnect = async (id) => {
    if (!confirm("Disconnect this account? Events HouseHub wrote will stay on the calendar.")) return;
    setBusy(id); setError(null);
    try {
      const res = await api.disconnectCaldav(id);
      setState({ ...state, accounts: res.accounts });
    } catch (err) { setError(err?.message || "Could not disconnect."); }
    finally { setBusy(""); }
  };

  const togglePush = async (cal) => {
    setBusy(cal.id); setError(null);
    try {
      const res = await api.setCaldavPush(cal.id, !cal.pushEnabled);
      setState({ ...state, accounts: res.accounts });
    } catch (err) { setError(err?.message || "Could not change that."); }
    finally { setBusy(""); }
  };

  /* The events themselves come from the caller, because they live in the
     encrypted document and neither this panel nor the server can go and get
     them. The whole set is sent; the server works out what changed. */
  const syncNow = async (cal) => {
    setBusy(cal.id); setError(null); setNotice(null);
    try {
      const events = collectEvents ? collectEvents(cal.id) : [];
      const r = await api.pushCaldav(cal.id, events);
      const parts = [
        r.created ? `${r.created} added` : "",
        r.updated ? `${r.updated} updated` : "",
        r.removed ? `${r.removed} removed` : "",
        r.conflicts ? `${r.conflicts} changed on another device and left alone` : "",
        r.failed ? `${r.failed} failed` : "",
      ].filter(Boolean);
      setNotice(`${cal.name}: ${parts.length ? parts.join(", ") : "already up to date"}.`);
      load();
    } catch (err) {
      setError(err?.message || "Could not sync.");
    } finally { setBusy(""); }
  };

  if (!state) return <p style={{ color: T.faint, fontSize: 13 }}>Checking…</p>;

  const card = {
    background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12,
    padding: 12, marginBottom: 10,
  };
  const input = {
    background: T.panel, color: T.ink, border: `1px solid ${T.line}`,
    borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 14,
  };

  return (
    <div>
      <p style={{ color: T.faint, fontSize: 13, marginBottom: 10 }}>
        Subscribed calendars are read-only: HouseHub sees them but cannot change
        them. Connecting an iCloud account lets it write events back out — so a
        date added here shows up on your phone.
      </p>

      {error && (
        <div role="alert" style={{
          background: "#FBE7E1", border: "1px solid #E6B8AA", color: "#8E2F1F",
          borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 10,
        }}>{error}</div>
      )}
      {notice && (
        <div style={{
          background: T.brandSoft, border: `1px solid ${T.brand}`, color: T.brandInk,
          borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 10,
        }}>{notice}</div>
      )}

      {(state.accounts || []).map((acct) => (
        <div key={acct.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: T.ink, fontSize: 14 }}>
                {acct.serverUrl.replace(/^https?:\/\//, "")}
              </div>
              <div style={{ color: T.faint, fontSize: 12 }}>
                {acct.lastError
                  ? acct.lastError
                  : acct.lastOkAt ? `Working as of ${new Date(acct.lastOkAt).toLocaleDateString()}` : "Connected"}
              </div>
            </div>
            {iAmAdmin && (
              <button onClick={() => disconnect(acct.id)} disabled={busy === acct.id}
                style={{ ...input, width: "auto", color: "#8E2F1F", fontWeight: 700, cursor: "pointer" }}>
                Disconnect
              </button>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            {acct.calendars.length === 0 && (
              <p style={{ color: T.faint, fontSize: 12.5 }}>No calendars found on this account.</p>
            )}
            {acct.calendars.map((cal) => (
              <div key={cal.id} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                borderTop: `1px solid ${T.line}`,
              }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 999, flexShrink: 0,
                  background: cal.color || T.faint,
                }} />
                <span style={{ flex: 1, minWidth: 0, color: T.ink, fontSize: 14, fontWeight: 600 }}>
                  {cal.name}
                  {!cal.writable && (
                    <span style={{ color: T.faint, fontWeight: 500 }}> · read-only</span>
                  )}
                  {cal.lastError && (
                    <span style={{ color: "#8E2F1F", fontWeight: 500, display: "block", fontSize: 11.5 }}>
                      {cal.lastError}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => togglePush(cal)}
                  disabled={!iAmAdmin || !cal.writable || busy === cal.id}
                  title={cal.writable ? "" : "The provider says this calendar cannot be written to"}
                  style={{
                    background: cal.pushEnabled ? T.brand : T.panelAlt,
                    color: cal.pushEnabled ? "#fff" : (cal.writable ? T.ink : T.faint),
                    border: `1px solid ${cal.pushEnabled ? T.brand : T.line}`,
                    borderRadius: 999, padding: "4px 12px", fontSize: 12.5, fontWeight: 700,
                    cursor: cal.writable && iAmAdmin ? "pointer" : "not-allowed",
                  }}>
                  {cal.pushEnabled ? "Writing" : "Off"}
                </button>
                {cal.pushEnabled && (
                  <button onClick={() => syncNow(cal)} disabled={busy === cal.id}
                    style={{
                      background: T.panelAlt, color: T.ink, border: `1px solid ${T.line}`,
                      borderRadius: 999, padding: "4px 10px", fontSize: 12.5, fontWeight: 700,
                      cursor: "pointer",
                    }}>
                    {busy === cal.id ? "…" : "Sync now"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {iAmAdmin && (
        <div style={card}>
          <div style={{ fontWeight: 700, color: T.ink, fontSize: 14, marginBottom: 8 }}>
            Connect iCloud
          </div>

          {/* Said before the fields, not after: by the time somebody has typed a
              password into a box, telling them which one to use is too late. */}
          <div style={{
            background: "#FAF0DC", border: "1px solid #E2C88E", color: "#6B4708",
            borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 10,
          }}>
            Use an <strong>app-specific password</strong>, not your Apple ID password.
            Make one at <a href={APPLE_ID_HELP} target="_blank" rel="noreferrer"
              style={{ color: "#6B4708", textDecoration: "underline" }}>account.apple.com</a> under
            Sign-In and Security. It only works for this app and you can revoke it on its own.
            It is stored encrypted on this server — which does mean this server can
            change that calendar, so connect it only if you are happy with that.
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="Apple ID email"
              autoComplete="off"
              style={input}
            />
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="app-specific password (xxxx-xxxx-xxxx-xxxx)"
              autoComplete="new-password"
              style={input}
            />
            <button
              onClick={connect}
              disabled={busy === "connect" || !form.username || !form.password}
              style={{
                background: busy === "connect" ? T.panelAlt : T.brand,
                color: busy === "connect" ? T.faint : "#fff",
                border: "none", borderRadius: 8, padding: "9px 12px",
                fontWeight: 700, fontSize: 14, cursor: "pointer",
              }}>
              {busy === "connect" ? "Checking…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {!iAmAdmin && (state.accounts || []).length === 0 && (
        <p style={{ color: T.faint, fontSize: 13 }}>An admin can connect a calendar account.</p>
      )}
    </div>
  );
}
