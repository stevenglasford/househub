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
import ActionButton from "./ActionButton.jsx";

const SCOPES = [
  ["today", "Today", "The dashboard: schedule, meals, to-dos"],
  ["calendar", "Calendar", "The week view"],
  ["meals", "Meals", "What everyone is eating"],
  ["todos", "To-dos", "Chores and tasks"],
  ["grocery", "Grocery", "The shopping list"],
  ["projects", "Projects", "House projects"],
  ["notes", "Notes", "Sticky notes"],
  ["countdowns", "Countdowns", "Dates being counted down to"],
  ["agenda", "Together", "Things to talk about tonight"],
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
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(null);

  // Held only until the display is activated: the private half of the new
  // screen's keypair, which never goes to the server.

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
    setError(null);
    // session.createDisplay generates the keypair and escrows the private half
    // sealed under the household key, so this no longer depends on the key
    // surviving in this tab.
    const created = await session.createDisplay({
      name: form.name.trim(),
      scopes: form.scopes,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      canWrite: form.canWrite,
      controlDomains: form.controlDomains,
    });
    setCreating(false);
    setForm({ name: "", scopes: ["today"], expiresAt: "", canWrite: false, controlDomains: [] });
    await refresh();

    if (created.approvals?.length >= created.required) await activate(created.id);
  }

  /* Uncaught: ActionButton reports failures beside the button. Swallowing here
     would tell an admin their approval was recorded when it was not -- and a
     display nobody approved is exactly what the sign-off exists to prevent. */
  async function approve(display, decision) {
    setError(null);
    const proof = decision === "approve"
      ? await session.approvalProofFor(display.id, display.publicKey)
      : undefined;
    await session.approveDisplay(display.id, decision, proof);
    await refresh();
  }

  /**
   * Bring a display to life: wrap the household key to it and issue the link.
   *
   * Only possible from an admin's browser, and only once the server agrees the
   * approvals are in.
   */
  /**
   * Bring a display to life. Any admin, on any device.
   *
   * The private key comes out of escrow rather than out of this tab's memory,
   * which is the whole fix: previously only the proposing browser could finish
   * the job, and only until it was refreshed.
   */
  async function activate(displayId) {
    setError(null);
    const display = displays.find((d) => d.id === displayId);
    if (!display) throw new Error("That display is no longer in the list. Reload and try again.");

    /* Two distinct dead ends, and they need different words. A display proposed
       before the key was escrowed has nothing to recover at all; one whose
       escrow will not open was sealed under a household key since rotated away.
       Both are fixed by recreating it, but saying "sealed under an older key"
       about a display that never had a stored key is just confusing. */
    if (!display.privateKeyEnc) {
      throw new Error(
        `"${display.name}" was set up before display keys were saved, so its key exists only ` +
        "in the browser tab that proposed it — which is why it cannot be activated here. " +
        "Revoke it and add it again; the new one can be finished by either of you, on any device."
      );
    }
    const privateKey = await session.displayPrivateKey(display.privateKeyEnc);
    if (!privateKey) {
      throw new Error(
        `"${display.name}"'s key cannot be opened with this household's current key, which ` +
        "happens after a key rotation. Revoke it and add it again."
      );
    }

    const res = await session.activateDisplay(displayId, C.publicKeyFromPrivate(privateKey));
    // token + private key, both in the fragment, which browsers never transmit.
    const url = `${res.url}.${C.toB64(privateKey)}`;
    // Kept where the household can retrieve it, so the other people who live
    // here can set up the screen without this one person being present.
    await session.escrowDisplayLink(displayId, url);
    setLink({ id: displayId, url });
    await refresh();
  }

  /** Show a link that was issued earlier. Does not re-mint it. */
  async function showLink(display) {
    setError(null);
    const url = await session.openDisplayLink(display.linkEnc);
    if (!url) {
      throw new Error(
        "The link for this display was not saved, or was sealed under an older household key. " +
        "Revoke it and add it again to get a fresh one."
      );
    }
    setLink({ id: display.id, url });
  }

  const revokeWarning = (name) =>
    `Revoke "${name}"?\n\n` +
    "The link stops working immediately. If the device is out of your control, rotate " +
    "the household key afterwards too — it still holds a copy of the current one.";

  async function revoke(display) {
    setError(null);
    const out = await session.revokeDisplay(display.id);
    if (out.rotationRecommended) setNote(out.note || null);
    await refresh();
  }

  const toggleIn = (list, value) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  if (displays === null) return <p style={{ color: T.faint }}>Loading displays…</p>;

  return (
    <div>
      {note && (
        <div role="status" style={{ ...card, background: "#fff6e5", borderColor: "#f0d9a8", color: "#6b4708", fontSize: 13 }}>
          {note}
        </div>
      )}

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
                    <ActionButton theme={T} variant="primary" onClick={() => approve(d, "approve")}
                      busyLabel="Approving…" doneLabel="Approved">
                      Approve
                    </ActionButton>
                    <ActionButton theme={T} onClick={() => approve(d, "deny")}
                      busyLabel="Refusing…" doneLabel="Refused">
                      Refuse
                    </ActionButton>
                  </>
                )}
                {d.status === "pending" && ready && iAmAdmin && (
                  <ActionButton theme={T} variant="primary" onClick={() => activate(d.id)}
                    busyLabel="Activating…" doneLabel="Live">
                    Activate
                  </ActionButton>
                )}
                {d.status === "active" && d.linkEnc && (
                  <ActionButton theme={T} onClick={() => showLink(d)}
                    busyLabel="Fetching…" doneLabel="Shown">
                    Show link
                  </ActionButton>
                )}
                {iAmAdmin && d.status !== "revoked" && (
                  <ActionButton theme={T} variant="danger" onClick={() => revoke(d)}
                    confirm={revokeWarning(d.name)}
                    busyLabel="Revoking…" doneLabel="Revoked">
                    Revoke
                  </ActionButton>
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
