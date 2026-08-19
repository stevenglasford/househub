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
import ActionButton from "./ActionButton.jsx";

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

  // Uncaught so ActionButton can report it: a chain check that silently failed
  // would be indistinguishable from one that passed.
  async function verifyChain() {
    setError(null);
    setAudit(await session.request("GET", "api/admin/audit/verify"));
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

  const TABS = [["overview", "Server"], ["households", "Households"], ["audit", "Audit"], ["advanced", "Advanced"]];

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
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 4 }}>AI providers</div>
            <div style={{ fontSize: 13, color: T.faint }}>
              {(overview.ai?.providers || []).length
                ? (overview.ai.providers).map((p) =>
                    `${p.label}${p.isLocal ? "" : " (offsite)"}`).join(" · ")
                : "None configured"}
            </div>
            <div style={{ fontSize: 12, color: T.faint, marginTop: 4 }}>
              Manage them under Advanced. Each household chooses its own.
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

      {tab === "advanced" && <AiProviders theme={T} card={card} btn={btn} />}

      {tab === "audit" && (
        <>
          <div style={card}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>Tamper check</div>
            <p style={{ fontSize: 13, color: T.faint, marginBottom: 8 }}>
              Every audit entry commits to the hash of the one before it. If any row were
              edited or removed, the chain breaks at that point and this reports where.
            </p>
            <ActionButton theme={T} variant="primary" onClick={verifyChain}
              busyLabel="Checking…" doneLabel="Checked">
              Verify the chain
            </ActionButton>
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


/* ------------------------------------------------------- AI providers ----- */

/**
 * Models households may choose from.
 *
 * Adding one here does NOT route anybody to it. Each household picks its own,
 * and a non-local provider additionally needs that household's recorded
 * consent -- so an operator cannot decide on a family's behalf that their
 * evenings get summarised by a company in another country.
 */
function AiProviders({ theme: T, card, btn }) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: "", kind: "ollama", baseUrl: "", apiKey: "", defaultModel: "" });
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try { setProviders(await session.request("GET", "api/admin/ai/providers")); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    try {
      const out = await session.request("PUT", "api/admin/ai/providers", {
        label: form.label.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim() || null,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        defaultModel: form.defaultModel.trim() || undefined,
      });
      setResult(out);
      setForm({ label: "", kind: "ollama", baseUrl: "", apiKey: "", defaultModel: "" });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function remove(p) {
    if (!confirm(`Remove "${p.label}"?\n\nHouseholds using it fall back to the local model.`)) return;
    setBusy(true);
    try { await session.request("DELETE", `api/admin/ai/providers/${p.id}`); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const input = {
    width: "100%", padding: "9px 11px", borderRadius: 10, marginBottom: 8,
    border: `1px solid ${T.line}`, background: T.panel, color: T.ink,
  };

  if (!providers) return <p style={{ color: T.faint }}>Loading…</p>;

  return (
    <div>
      {error && <div style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>{error}</div>}

      {providers.map((p) => (
        <div key={p.id} style={{ ...card, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 600, color: T.ink }}>{p.label}</div>
            <div style={{ fontSize: 12, color: p.isLocal ? "#1e4620" : "#8a5b00" }}>
              {p.kind}{p.baseUrl ? ` · ${p.baseUrl}` : ""}
              {p.hasKey ? " · key stored" : ""}
              {p.isLocal ? " · stays on your hardware" : " · context leaves your network"}
            </div>
          </div>
          {!p.isLocal && (
            <ActionButton theme={T} onClick={() => remove(p)}
              busyLabel="Removing…" doneLabel="Removed">Remove</ActionButton>
          )}
        </div>
      ))}

      <form onSubmit={save} style={card}>
        <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>Add a provider</div>

        <input style={input} placeholder="Name households will see" required maxLength={80}
               value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />

        <select style={input} value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
          <option value="ollama">Ollama (local or on your network)</option>
          <option value="anthropic">Claude (Anthropic)</option>
          <option value="openai">OpenAI, or anything with its API</option>
        </select>

        <input style={input} placeholder={form.kind === "ollama"
          ? "http://192.168.1.20:11434 (blank = this server)"
          : "Base URL (blank = the provider's default)"}
               value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} />

        {form.kind !== "ollama" && (
          <input style={input} type="password" autoComplete="off" placeholder="API key"
                 value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
        )}

        <input style={input} placeholder="Default model (optional)"
               value={form.defaultModel} onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))} />

        <button style={btn(true)} disabled={busy || !form.label.trim()}>
          {busy ? "Checking…" : "Add provider"}
        </button>

        {result && (
          <div style={{ marginTop: 8, fontSize: 13, color: result.isLocal ? "#1e4620" : "#8a5b00" }}>
            Added.{result.models?.length ? ` ${result.models.length} models available.` : " No model list returned — households can type one in."}
            {result.warning && <span style={{ display: "block", marginTop: 4 }}>{result.warning}</span>}
          </div>
        )}
      </form>

      <div style={{ ...card, background: "#eef4ee", borderColor: "#bcd4bc" }}>
        <div style={{ fontWeight: 600, color: "#1e4620", marginBottom: 4 }}>What adding one does</div>
        <div style={{ fontSize: 13, color: "#3a6b3c" }}>
          It offers a choice. It does not move anybody's data. Each household selects its own
          provider, and choosing a non-local one requires that household to confirm that
          context may leave this machine — recorded against a person and a time. You cannot
          make that choice for them, deliberately.
        </div>
      </div>
    </div>
  );
}