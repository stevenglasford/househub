// PrivacyPanel.jsx — your data, and getting rid of it.
//
// Two exports, because they are two different things and conflating them would
// misrepresent both:
//
//   Your account       what the server holds *about you*. It is the controller,
//                      so this is a subject access response. Fetched from the API.
//
//   This household     the calendar, chores, lists, notes. Written by everyone
//                      who lives here, about everyone who lives here. The server
//                      cannot read a word of it, so this export is produced here
//                      in the browser from the decrypted document. It is your
//                      household's data, which you happen to co-control -- not a
//                      subject access response about you.
//
// The second distinction has a consequence people find surprising, so the panel
// says it in plain words rather than leaving it to be discovered: deleting your
// account cannot remove your name from the shared calendar, because the server
// cannot see the shared calendar.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";

function download(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick; revoking immediately can cancel the download in
  // Safari before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PrivacyPanel({ theme: T, data, me }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");

  const loadPreview = useCallback(async () => {
    try { setPreview(await session.erasurePreview()); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { loadPreview(); }, [loadPreview]);

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

  const stamp = new Date().toISOString().slice(0, 10);

  async function exportAccount() {
    setBusy("account"); setError(null);
    try {
      const blob = await session.downloadAccountExport();
      download(`househub-account-${stamp}.json`, await blob.text());
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  function exportHousehold() {
    setBusy("household"); setError(null);
    try {
      // Straight from the decrypted document held in memory. Nothing is asked of
      // the server, because the server could not answer.
      download(`househub-${(data.householdName || "household").replace(/\W+/g, "-").toLowerCase()}-${stamp}.json`,
        JSON.stringify({
          _about: {
            what: "A complete copy of this household's contents, decrypted in your browser.",
            exportedAt: new Date().toISOString(),
            exportedBy: me?.email || me?.id || null,
            note:
              "This is your household's data, written jointly by its members. It contains " +
              "personal data about other people who live here — treat it accordingly. " +
              "The server never saw any of this in readable form and could not have " +
              "produced this file.",
            format: "The document as the app stores it. Re-importable into HouseHub.",
          },
          household: data,
        }, null, 2));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function erase() {
    setBusy("erase"); setError(null);
    try {
      const out = await session.eraseAccount(password);
      alert(
        `Your account has been deleted.\n\n${out.note}` +
        (out.householdsDeleted?.length
          ? `\n\n${out.householdsDeleted.length} household(s) that only you belonged to were deleted too.`
          : "")
      );
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {/* ------------------------------------------------------- exports --- */}
      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink }}>Download your account data</div>
        <p style={{ color: T.faint, fontSize: 13, margin: "4px 0 8px" }}>
          Everything this server holds about you: your account, which households you belong
          to, your sessions, and a log of actions you have taken. Machine-readable JSON.
        </p>
        <button style={btn(true)} disabled={busy === "account"} onClick={exportAccount}>
          {busy === "account" ? "Preparing…" : "Download account data"}
        </button>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink }}>Download this household</div>
        <p style={{ color: T.faint, fontSize: 13, margin: "4px 0 8px" }}>
          The calendar, meals, chores, lists, notes and history — decrypted here in your
          browser, because the server cannot read them. This is the household's data,
          written by everyone who lives here, so it contains information about other
          people too.
        </p>
        <button style={btn(true)} disabled={busy === "household"} onClick={exportHousehold}>
          {busy === "household" ? "Preparing…" : "Download household data"}
        </button>
      </div>

      {/* ------------------------------------------------------- erasure --- */}
      <div style={{ ...card, borderColor: "#e0b4ae" }}>
        <div style={{ fontWeight: 600, color: T.ink }}>Delete your account</div>

        {preview && (
          <div style={{ fontSize: 13, color: T.faint, margin: "8px 0" }}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 2 }}>This will delete</div>
            <ul style={{ margin: "0 0 8px 18px" }}>
              {preview.willBeDeleted.map((x) => <li key={x}>{x}</li>)}
            </ul>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 2 }}>This will not</div>
            <ul style={{ margin: "0 0 8px 18px" }}>
              {preview.willNotBeDeleted.map((x) => <li key={x}>{x}</li>)}
            </ul>

            {preview.blockers?.length > 0 && (
              <div style={{ background: "#fff6e5", border: "1px solid #e0c184", borderRadius: 8, padding: 8, color: "#6b4708" }}>
                <strong>You cannot delete your account yet.</strong>
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {preview.blockers.map((b) => <li key={b.householdId}>{b.reason}</li>)}
                </ul>
              </div>
            )}

            {preview.householdsThatWouldBeLeftEmpty?.length > 0 && (
              <div style={{ color: "#8a3d12" }}>
                {preview.householdsThatWouldBeLeftEmpty.length} household(s) have only you in
                them and will be deleted with your account — nobody else holds a key, so
                they would be unreadable to everyone anyway.
              </div>
            )}
          </div>
        )}

        {!confirming ? (
          <button
            style={btn(false, true)}
            disabled={preview?.blockers?.length > 0}
            onClick={() => setConfirming(true)}
          >
            Delete my account…
          </button>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: T.ink, margin: "8px 0" }}>
              Enter your password to confirm. This cannot be undone.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Your password"
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 10, marginBottom: 8,
                border: `1px solid ${T.line}`, background: T.panel, color: T.ink,
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn(false, true)} disabled={busy === "erase" || password.length < 8} onClick={erase}>
                {busy === "erase" ? "Deleting…" : "Permanently delete"}
              </button>
              <button style={btn(false)} onClick={() => { setConfirming(false); setPassword(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
