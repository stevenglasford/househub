// HouseholdPanel.jsx — inviting people, and admitting them.
//
// This is the UI for the two-step handshake that lets a second person into a
// household without the server ever holding a key:
//
//   1. an admin creates an invite link
//   2. the invitee opens it, signs up, and accepts -- at which point they are
//      *pending* and can see nothing at all
//   3. an admin's browser wraps the household key to their public key
//
// Step 3 is the one that matters and it is why this panel exists rather than
// the server just flipping a flag. The wrap happens here, in this tab, using a
// key held only in this browser's memory.
//
// The fingerprint is displayed prominently because it is the single point in the
// whole design that depends on a human. The public key being wrapped to comes
// from the server; if the server substituted its own, it would be admitted.
// Reading eight groups of hex aloud to the person sitting next to you closes
// that, and nothing else does.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";
import { keyFingerprint } from "../lib/crypto.js";

/**
 * Copy to clipboard, and say whether it worked.
 *
 * navigator.clipboard is unavailable outside a secure context and can be
 * refused by permissions policy, in which case the old code failed silently and
 * left people staring at a button that appeared to do nothing. The textarea
 * fallback works everywhere, and the caller always learns the outcome.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const ROLE_HELP = {
  admin: "Full control: can invite, remove, approve displays, rotate the key.",
  adult: "Reads and writes everything. Cannot change who is in the household.",
  dependent: "For a child's account. Reads and writes, no settings.",
  viewer: "Read-only.",
};

export default function HouseholdPanel({ theme: T, me, householdName }) {
  const [members, setMembers] = useState(null);
  const [invites, setInvites] = useState([]);
  const [inviteRole, setInviteRole] = useState("admin");
  const [newLink, setNewLink] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [copied, setCopied] = useState(null);   // 'ok' | 'failed'


  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [m, i] = await Promise.all([session.listMembers(), session.listInvites()]);
      setMembers(m);
      setInvites(i);
    } catch (err) {
      setError(err.message);
      setMembers([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const iAmAdmin = members?.find((m) => m.userId === me?.id)?.role === "admin";

  async function makeInvite() {
    setBusy("invite"); setError(null);
    try {
      const res = await session.createInvite({ role: inviteRole, expiresInHours: 72 });
      setNewLink(res.url);            // shown once; the server keeps only a hash
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function grant(member) {
    setBusy(member.userId); setError(null);
    try {
      await session.grantAccess(member.userId, member.publicKey);
      setConfirming(null);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function changeRole(member, role) {
    setBusy(member.userId); setError(null);
    try { await session.setMemberRole(member.userId, role); await refresh(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function remove(member) {
    if (!confirm(
      `Remove this person from the household?\n\n` +
      `They lose access immediately. Rotate the household key afterwards — until you do, ` +
      `anything they already downloaded stays readable to them.`
    )) return;
    setBusy(member.userId); setError(null);
    try { await session.removeMember(member.userId); await refresh(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };
  const btn = (primary) => ({
    background: primary ? T.brand : T.panel,
    color: primary ? "#fff" : T.ink,
    border: `1px solid ${primary ? T.brand : T.line}`,
    borderRadius: 10, padding: "8px 14px", fontWeight: 600, cursor: "pointer",
  });

  if (members === null) {
    return <p style={{ color: T.faint }}>Loading household…</p>;
  }

  const pending = members.filter((m) => m.status === "pending");
  const active = members.filter((m) => m.status === "active");

  return (
    <div>
      {/* Which household this is, and the way out of it. Switching used to mean
          signing out and back in, which is a strange thing to have to do to look
          at a different calendar. */}
      <div style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600, color: T.ink }}>{householdName || "This household"}</div>
          <div style={{ color: T.faint, fontSize: 12 }}>
            {active.length} {active.length === 1 ? "person" : "people"} · you are {members.find((m) => m.userId === me?.id)?.role || "a member"}
          </div>
        </div>
        <button
          style={btn(false)}
          onClick={() => window.dispatchEvent(new CustomEvent("househub:switch-household"))}
        >
          Switch household
        </button>
      </div>

      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {/* ---- people waiting to be let in ---- */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <h4 style={{ fontWeight: 700, marginBottom: 6, color: T.ink }}>
            Waiting for you ({pending.length})
          </h4>
          <p style={{ color: T.faint, fontSize: 13, marginBottom: 10 }}>
            They have an account and accepted the invitation, but can see nothing yet.
            Check the fingerprint with them <strong>in person</strong> before letting them in —
            it is what stops anyone in the middle swapping in their own key.
          </p>

          {pending.map((m) => (
            <div key={m.userId} style={card}>
              <div style={{ fontWeight: 600, color: T.ink }}>{m.email || m.displayName || "New member"}</div>
              <div style={{ color: T.faint, fontSize: 13, marginBottom: 8 }}>
                joining as {m.role} · {ROLE_HELP[m.role]}
              </div>

              <div style={{ color: T.faint, fontSize: 12, marginBottom: 4 }}>Their key fingerprint</div>
              <code style={{
                display: "block", background: T.panel, border: `1px solid ${T.line}`,
                borderRadius: 8, padding: "8px 10px", fontSize: 14, letterSpacing: 1,
                marginBottom: 10, color: T.ink, wordBreak: "break-all",
              }}>
                {keyFingerprint(m.publicKey)}
              </code>

              {confirming === m.userId ? (
                <div>
                  <p style={{ fontSize: 13, color: T.ink, marginBottom: 8 }}>
                    Does that match exactly what they see on their screen?
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={btn(true)} disabled={busy === m.userId} onClick={() => grant(m)}>
                      {busy === m.userId ? "Granting…" : "Yes — let them in"}
                    </button>
                    <button style={btn(false)} onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={btn(true)} disabled={!iAmAdmin} onClick={() => setConfirming(m.userId)}>
                    Grant access
                  </button>
                  <button style={btn(false)} onClick={() => remove(m)}>Decline</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- current members ---- */}
      <h4 style={{ fontWeight: 700, marginBottom: 8, color: T.ink }}>Members ({active.length})</h4>
      {active.map((m) => (
        <div key={m.userId} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 600, color: T.ink }}>
                {m.email || m.displayName || "Member"}
                {m.userId === me?.id && <span style={{ color: T.faint, fontWeight: 400 }}> — you</span>}
              </div>
              <div style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
                {keyFingerprint(m.publicKey)}
              </div>
              {!m.hasCurrentKey && (
                <div style={{ color: "#a4500f", fontSize: 12, marginTop: 4 }}>
                  No key for the current epoch — rotate the household key to restore their access.
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <select
                value={m.role}
                disabled={!iAmAdmin || busy === m.userId}
                onChange={(e) => changeRole(m, e.target.value)}
                style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "6px 8px" }}
              >
                {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {iAmAdmin && m.userId !== me?.id && (
                <button style={btn(false)} disabled={busy === m.userId} onClick={() => remove(m)}>Remove</button>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* ---- invite ---- */}
      {iAmAdmin && (
        <div style={{ marginTop: 20 }}>
          <h4 style={{ fontWeight: 700, marginBottom: 8, color: T.ink }}>Invite someone</h4>

          {newLink ? (
            <div style={{ ...card, background: "#eef7ee", borderColor: "#bcdcbc" }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: "#1e4620" }}>
                Send them this link. It is shown once.
              </div>
              <code style={{
                display: "block", background: "#fff", border: "1px solid #bcdcbc", borderRadius: 8,
                padding: "8px 10px", fontSize: 12, wordBreak: "break-all", marginBottom: 8, color: "#1e4620",
              }}>{newLink}</code>
              <p style={{ fontSize: 12, color: "#3a6b3c", marginBottom: 8 }}>
                The server stores only a hash of it, so nobody — including whoever runs this
                server — can recover or re-issue it. After they accept, come back here to
                check their fingerprint and let them in.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  style={btn(true)}
                  onClick={async () => {
                    const ok = await copyText(newLink);
                    setCopied(ok ? "ok" : "failed");
                    setTimeout(() => setCopied(null), 4000);
                  }}
                >
                  {copied === "ok" ? "Copied ✓" : "Copy link"}
                </button>
                <button style={btn(false)} onClick={() => { setNewLink(null); setCopied(null); }}>Done</button>
                {copied === "failed" && (
                  <span style={{ fontSize: 12, color: "#8a3d12" }}>
                    Could not reach the clipboard — select the link above and copy it manually.
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 10px" }}
              >
                {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <button style={btn(true)} disabled={busy === "invite"} onClick={makeInvite}>
                {busy === "invite" ? "Creating…" : "Create invite link"}
              </button>
            </div>
          )}

          <p style={{ color: T.faint, fontSize: 12, marginTop: 6 }}>{ROLE_HELP[inviteRole]}</p>

          {invites.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: T.faint, fontSize: 12, marginBottom: 6 }}>
                Outstanding invitations
              </div>
              {invites.map((i) => (
                <div key={i.id} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: T.ink }}>
                    {i.role}{i.claimed_by ? " · accepted, awaiting your approval" : " · not used yet"}
                    <span style={{ color: T.faint }}> · expires {new Date(i.expires_at).toLocaleDateString()}</span>
                  </span>
                  <button style={btn(false)} onClick={async () => { await session.revokeInvite(i.id); refresh(); }}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!iAmAdmin && (
        <p style={{ color: T.faint, fontSize: 13, marginTop: 12 }}>
          Only admins can invite people or change roles.
        </p>
      )}
    </div>
  );
}
