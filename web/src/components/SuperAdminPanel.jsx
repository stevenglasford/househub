// SuperAdminPanel.jsx — operating the server, from the ordinary settings page.
//
// Kept in the same Settings modal as everything else rather than behind a
// separate console, because a super-admin is usually also just somebody living
// in one of these households and should not have to go somewhere else to check
// whether their server is healthy.
//
// What is deliberately absent is as important as what is here. There is no
// "view household" button, no way to read a family's data, no password reset.
// Not because they are hidden -- because the server holds no household key and
// no endpoint exists that could do it. The panel says so, since an operator who
// believes otherwise will eventually promise a user something they cannot
// deliver.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";

const bytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

export default function SuperAdminPanel({ theme: T }) {
  const [tab, setTab] = useState("overview");
  const [overview, setOverview] = useState(null);
  const [households, setHouseholds] = useState([]);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, h] = await Promise.all([
        session.request("GET", "api/admin/overview"),
        session.request("GET", "api/admin/households"),
      ]);
      setOverview(o);
      setHouseholds(h);
    } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };
  const btn = (primary) => ({
    background: primary ? T.brand : T.panel, color: primary ? "#fff" : T.ink,
    border: `1px solid ${primary ? T.brand : T.line}`,
    borderRadius: 10, padding: "6px 12px", fontWeight: 600, cursor: "pointer", fontSize: 13,
  });

  async function verifyChain() {
    setBusy(true); setError(null);
    try { setAudit(await session.request("GET", "api/admin/audit/verify")); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function setStatus(id, status) {
    if (!confirm(status === "suspended"
      ? "Suspend this household?\n\nIt becomes read-only. Members keep their data and can still export it."
      : "Restore full access to this household?")) return;
    setBusy(true); setError(null);
    try {
      await session.request("POST", `api/admin/households/${id}/status`, { status });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (error && !overview) {
    return <p style={{ color: "#7a1c12" }}>{error}</p>;
  }
  if (!overview) return <p style={{ color: T.faint }}>Loading server status…</p>;

  const TABS = [["overview", "Server"], ["households", "Households"], ["audit", "Audit"]];

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={btn(tab === k)}>{label}</button>
        ))}
      </div>

      {error && (
        <div style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>{error}</div>
      )}

      {tab === "overview" && (
        <>
          <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10 }}>
            {[
              ["Accounts", overview.users.total],
              ["Households", overview.households.total],
              ["Displays", overview.displays.active],
              ["Stored", bytes(overview.storageBytes)],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 22, fontWeight: 700, color: T.ink }}>{value}</div>
                <div style={{ fontSize: 12, color: T.faint }}>{label}</div>
              </div>
            ))}
          </div>

          <div style={card}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 4 }}>Local AI</div>
            <div style={{ fontSize: 13, color: T.faint }}>
              {overview.ai.available
                ? `Reachable · ${overview.ai.models.length} model(s) installed`
                : "Not reachable — check that Ollama is running"}
            </div>
          </div>

          <div style={{ ...card, background: "#eef4ee", borderColor: "#bcd4bc" }}>
            <div style={{ fontWeight: 600, color: "#1e4620", marginBottom: 4 }}>What you cannot do</div>
            <div style={{ fontSize: 13, color: "#3a6b3c" }}>
              You can see that a household exists, how many people are in it and how much
              space it uses. You cannot read any of its contents, add yourself to it, or
              reset anyone's password — this server holds no household key, so there is no
              endpoint that could. If someone loses their password their data is gone.
              Tell people that before they sign up, not after.
            </div>
          </div>
        </>
      )}

      {tab === "households" && (
        <>
          <p style={{ color: T.faint, fontSize: 12, marginBottom: 8 }}>
            Identified by id only. Names are encrypted under each household's own key.
          </p>
          {households.map((h) => (
            <div key={h.id} style={{ ...card, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <code style={{ fontSize: 12, color: T.ink }}>{h.id.slice(0, 8)}</code>
                <div style={{ fontSize: 12, color: T.faint }}>
                  {h.members} member(s) · {h.displays} display(s) · {bytes(h.vault_bytes)}
                  {h.status !== "active" && <span style={{ color: "#a4500f" }}> · {h.status}</span>}
                </div>
              </div>
              <button
                style={btn(false)}
                disabled={busy}
                onClick={() => setStatus(h.id, h.status === "suspended" ? "active" : "suspended")}
              >
                {h.status === "suspended" ? "Restore" : "Suspend"}
              </button>
            </div>
          ))}
        </>
      )}

      {tab === "audit" && (
        <>
          <div style={card}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>Tamper check</div>
            <p style={{ fontSize: 13, color: T.faint, marginBottom: 8 }}>
              Every audit entry commits to the hash of the one before it. If any row were
              edited or removed, the chain breaks at that point and this reports where.
            </p>
            <button style={btn(true)} disabled={busy} onClick={verifyChain}>
              {busy ? "Checking…" : "Verify the chain"}
            </button>
            {audit && (
              <div style={{ marginTop: 8, fontSize: 13, color: audit.ok ? "#1e4620" : "#7a1c12" }}>
                {audit.ok
                  ? `Intact — ${audit.entries} entries verified.`
                  : `BROKEN at entry ${audit.brokenAt}: ${audit.reason}`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
