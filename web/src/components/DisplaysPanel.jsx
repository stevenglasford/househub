// DisplaysPanel.jsx — the always-on screen by the door.
//
// This is the UI for the sign-off flow the server enforces. One admin proposes a
// screen; every other admin has to agree; only then can the household key be
// wrapped to it and a link issued.
//
// The wrap is the part that matters and it is why this has to be a UI rather
// than an API call somebody could script. The household key exists only in an
// admin's browser, so activation genuinely cannot happen without an admin
// present -- an operator who patched the approval check out of the server would
// still have no way to produce the wrapped key that brings the screen to life.
//
// The setup link is shown exactly once and is assembled here:
//
//     https://host/beta/display#<token>.<private key>
//
// Both halves live in the URL *fragment*, which browsers never send in a
// request. The server issued the token but has never seen the private key and
// cannot derive it, so it can neither use nor reissue this link.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";
import * as C from "../lib/crypto.js";
import { appPath } from "../lib/paths.js";

const SCOPES = [
  ["today", "Today", "The dashboard: schedule, meals, to-dos"],
  ["calendar", "Calendar", "The week view"],
  ["meals", "Meals", "What everyone is eating"],
  ["todos", "To-dos", "Chores and tasks"],
  ["grocery", "Grocery", "The shopping list"],
  ["projects", "Projects", "House projects"],
  ["notes", "Notes", "Sticky notes"],
  ["countdowns", "Countdowns", "Dates being counted down to"],
  ["agenda", "Agenda", "Things to talk about tonight"],
  ["weather", "Weather", "Forecast"],
  ["home", "Home", "Cameras, lights and sensors"],
  ["checkin", "Check-in", "The nightly walkthrough"],
];

const CONTROL_DOMAINS = [
  ["light", "Lights"],
  ["switch", "Switches"],
  ["fan", "Fans"],
  ["cover", "Blinds & garage"],
];

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export default function DisplaysPanel({ theme: T, me }) {
  const [displays, setDisplays] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(null);

  // Held only until the display is activated: the private half of the new
  // screen's keypair, which never goes to the server.
  const [pending, setPending] = useState({});

  const [form, setForm] = useState({
    name: "", scopes: ["today"], expiresAt: "", canWrite: false, controlDomains: [],
  });

  const refresh = useCallback(async () => {
    setError(null);
    try { setDisplays(await session.listDisplays()); }
    catch (err) { setError(err.message); setDisplays([]); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const iAmAdmin = session.snapshot().role === "admin";

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
    width: "100%", padding: "9px 11px", borderRadius: 10, marginBottom: 8,
    border: `1px solid ${T.line}`, background: T.panel, color: T.ink,
  };

  /* ------------------------------------------------------------ propose --- */

  async function propose(e) {
    e.preventDefault();
    setBusy("create"); setError(null);
    try {
      // Generated here. The server only ever receives the public half.
      const keys = C.newDisplayKeypair();
      const created = await session.createDisplay({
        name: form.name.trim(),
        scopes: form.scopes,
        publicKey: C.toB64(keys.publicKey),
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        canWrite: form.canWrite,
        controlDomains: form.controlDomains,
      });
      setPending((p) => ({ ...p, [created.id]: keys }));
      setCreating(false);
      setForm({ name: "", scopes: ["today"], expiresAt: "", canWrite: false, controlDomains: [] });
      await refresh();

      if (created.approvals?.length >= created.required) await activate(created.id, keys);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function approve(display, decision) {
    setBusy(display.id); setError(null);
    try {
      const proof = decision === "approve"
        ? await session.approvalProofFor(display.id, display.publicKey)
        : undefined;
      await session.approveDisplay(display.id, decision, proof);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  /**
   * Bring a display to life: wrap the household key to it and issue the link.
   *
   * Only possible from an admin's browser, and only once the server agrees the
   * approvals are in.
   */
  async function activate(displayId, keys) {
    const material = keys || pending[displayId];
    if (!material) {
      setError(
        "The private key for this display was generated on the device that proposed it and " +
        "is not in this browser. Ask that admin to finish it, or delete it and start again."
      );
      return;
    }
    setBusy(displayId); setError(null);
    try {
      const res = await session.activateDisplay(displayId, material.publicKey);
      // token + private key, both in the fragment.
      setLink({
        id: displayId,
        url: `${res.url}.${C.toB64(material.privateKey)}`,
      });
      setPending((p) => { const n = { ...p }; delete n[displayId]; return n; });
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function revoke(display) {
    if (!confirm(
      `Revoke "${display.name}"?\n\n` +
      "The link stops working immediately. If the device is out of your control, rotate " +
      "the household key afterwards too — it still holds a copy of the current one."
    )) return;
    setBusy(display.id); setError(null);
    try {
      const out = await session.revokeDisplay(display.id);
      if (out.rotationRecommended) alert(out.note);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const toggleIn = (list, value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  if (displays === null) return <p style={{ color: T.faint }}>Loading displays…</p>;

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {/* ---- the one-time setup link ---- */}
      {link && (
        <div style={{ ...card, background: "#eef7ee", borderColor: "#bcdcbc" }}>
          <div style={{ fontWeight: 700, color: "#1e4620", marginBottom: 6 }}>
            Open this on the tablet. It is shown once.
          </div>
          <code style={{
            display: "block", background: "#fff", border: "1px solid #bcdcbc", borderRadius: 8,
            padding: "8px 10px", fontSize: 11, wordBreak: "break-all", marginBottom: 8, color: "#1e4620",
          }}>{link.url}</code>
          <p style={{ fontSize: 12, color: "#3a6b3c", marginBottom: 8 }}>
            The half after the <code>#</code> is the display's own key. Browsers never send it
            to a server, so this link cannot be recovered or reissued by anyone — including
            whoever runs this server. Lose it and you make a new display.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button style={btn(true)} onClick={async () => {
              const ok = await copyText(link.url);
              setCopied(ok ? "ok" : "failed");
              setTimeout(() => setCopied(null), 4000);
            }}>
              {copied === "ok" ? "Copied ✓" : "Copy link"}
            </button>
            <button style={btn(false)} onClick={() => { setLink(null); setCopied(null); }}>Done</button>
            {copied === "failed" && (
              <span style={{ fontSize: 12, color: "#8a3d12" }}>
                Clipboard unavailable — select the link above and copy it manually.
              </span>
            )}
          </div>
        </div>
      )}

      {/* ---- existing displays ---- */}
      {displays.length === 0 && !creating && (
        <p style={{ color: T.faint, fontSize: 13, marginBottom: 8 }}>
          No displays yet. A display is a screen you leave on — a tablet by the door — that
          shows only what you choose and cannot be used to sign in as anyone.
        </p>
      )}

      {displays.map((d) => {
        const approvals = d.approvals.filter((a) => a.decision === "approve");
        const denied = d.approvals.some((a) => a.decision === "deny");
        const mine = d.approvals.find((a) => a.userId === me?.id);
        const ready = approvals.length >= d.requiredApprovals && !denied;

        return (
          <div key={d.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: T.ink }}>
                  {d.name}
                  <span style={{
                    marginLeft: 8, fontSize: 12, fontWeight: 600,
                    color: d.status === "active" ? "#1e4620" : d.status === "pending" ? "#8a5b00" : "#7a1c12",
                  }}>
                    {d.status}
                  </span>
                </div>
                <div style={{ color: T.faint, fontSize: 12 }}>
                  {d.scopes.join(", ")}
                  {d.canWrite && " · can tick things off"}
                  {d.controlDomains?.length > 0 && ` · controls ${d.controlDomains.join(", ")}`}
                </div>
                {d.expiresAt && (
                  <div style={{ color: T.faint, fontSize: 12 }}>
                    expires {new Date(d.expiresAt).toLocaleDateString()}
                  </div>
                )}
                {d.lastSeenAt && (
                  <div style={{ color: T.faint, fontSize: 12 }}>
                    last seen {new Date(d.lastSeenAt).toLocaleString()}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                {d.status === "pending" && iAmAdmin && !mine && (
                  <>
                    <button style={btn(true)} disabled={busy === d.id} onClick={() => approve(d, "approve")}>
                      Approve
                    </button>
                    <button style={btn(false)} disabled={busy === d.id} onClick={() => approve(d, "deny")}>
                      Refuse
                    </button>
                  </>
                )}
                {d.status === "pending" && ready && iAmAdmin && (
                  <button style={btn(true)} disabled={busy === d.id} onClick={() => activate(d.id)}>
                    {busy === d.id ? "Activating…" : "Activate"}
                  </button>
                )}
                {iAmAdmin && d.status !== "revoked" && (
                  <button style={btn(false, true)} disabled={busy === d.id} onClick={() => revoke(d)}>
                    Revoke
                  </button>
                )}
              </div>
            </div>

            {d.status === "pending" && (
              <div style={{ marginTop: 8, fontSize: 13, color: denied ? "#7a1c12" : "#8a5b00" }}>
                {denied
                  ? "An admin refused this display. Any admin can veto a screen that will sit in their home."
                  : `${approvals.length} of ${d.requiredApprovals} admins have approved.` +
                    (ready ? " Ready to activate." : " Waiting for the others.")}
              </div>
            )}
          </div>
        );
      })}

      {/* ---- propose a new one ---- */}
      {iAmAdmin && (creating ? (
        <form onSubmit={propose} style={card}>
          <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>New display</div>

          <label style={{ fontSize: 12, color: T.faint }}>Name</label>
          <input style={input} value={form.name} required maxLength={60}
                 placeholder="Hallway iPad"
                 onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />

          <label style={{ fontSize: 12, color: T.faint }}>What it may show</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 4, marginBottom: 8 }}>
            {SCOPES.map(([id, label, hint]) => (
              <label key={id} title={hint} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: T.ink }}>
                <input type="checkbox" checked={form.scopes.includes(id)}
                       onChange={() => setForm((f) => ({ ...f, scopes: toggleIn(f.scopes, id) }))} />
                {label}
              </label>
            ))}
          </div>

          <label style={{ fontSize: 12, color: T.faint }}>Stops working on (optional)</label>
          <input style={input} type="date" value={form.expiresAt}
                 onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8, fontSize: 13, color: T.ink }}>
            <input type="checkbox" checked={form.canWrite} style={{ marginTop: 3 }}
                   onChange={(e) => setForm((f) => ({ ...f, canWrite: e.target.checked }))} />
            <span>
              Let people tick things off on it
              <span style={{ display: "block", color: T.faint, fontSize: 12 }}>
                Completions are recorded as coming from this screen, never credited to a
                person — somebody can say who it was afterwards.
              </span>
            </span>
          </label>

          <label style={{ fontSize: 12, color: T.faint }}>What it may switch</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
            {CONTROL_DOMAINS.map(([id, label]) => (
              <label key={id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: T.ink }}>
                <input type="checkbox" checked={form.controlDomains.includes(id)}
                       onChange={() => setForm((f) => ({ ...f, controlDomains: toggleIn(f.controlDomains, id) }))} />
                {label}
              </label>
            ))}
          </div>
          <p style={{ color: T.faint, fontSize: 12, marginBottom: 8 }}>
            Locks are deliberately not on this list and cannot be added. A screen mounted by
            the front door that can unlock the front door is a keypad with no code.
          </p>

          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(true)} disabled={busy === "create" || !form.name.trim() || !form.scopes.length}>
              {busy === "create" ? "Creating…" : "Propose display"}
            </button>
            <button type="button" style={btn(false)} onClick={() => setCreating(false)}>Cancel</button>
          </div>
          <p style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>
            Every other admin has to approve before it goes live, and any one of them can
            refuse. Keep this tab open until it is activated — the display's key is generated
            here and only exists in this browser until then.
          </p>
        </form>
      ) : (
        <button style={btn(true)} onClick={() => setCreating(true)}>Add a display</button>
      ))}

      {!iAmAdmin && (
        <p style={{ color: T.faint, fontSize: 13 }}>Only admins can add or approve displays.</p>
      )}
    </div>
  );
}
