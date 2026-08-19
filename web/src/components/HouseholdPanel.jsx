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

import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as session from "../lib/session.js";
import { keyFingerprint } from "../lib/crypto.js";
import ActionButton from "./ActionButton.jsx";

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
  const [tz, setTz] = useState(null);

  // What this device thinks the zone is. Only ever a suggestion -- the household
  // is the authority, since its members may not all be sitting in it.
  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  /* A short list rather than the full IANA set: the browser's own zone, the
     server default, whatever is already chosen, and the common ones. Anything
     else can still be set through the API, and the server validates it. */
  const zoneChoices = useMemo(() => {
    const common = [
      "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
      "America/Anchorage", "Pacific/Honolulu", "America/Sao_Paulo",
      "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Madrid", "Europe/Paris",
      "Europe/Berlin", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw",
      "Europe/Athens", "Europe/Kyiv", "Africa/Lagos", "Africa/Johannesburg",
      "Asia/Jerusalem", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai",
      "Asia/Tokyo", "Asia/Seoul", "Australia/Perth", "Australia/Sydney",
      "Pacific/Auckland", "UTC",
    ];
    return [...new Set([browserTz, tz?.serverDefault, tz?.timezone, ...common].filter(Boolean))].sort();
  }, [browserTz, tz?.serverDefault, tz?.timezone]);

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
    // Separate, and deliberately not fatal: a household that cannot read its
    // timezone should still get the member list it came here for.
    try { setTz(await session.getTimezone()); } catch { /* leave it unknown */ }
  }, []);

  async function saveTimezone(value) {
    setBusy("tz"); setError(null);
    try {
      await session.setTimezone(value);
      setTz(await session.getTimezone());
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }


  useEffect(() => { refresh(); }, [refresh]);

  const iAmAdmin = members?.find((m) => m.userId === me?.id)?.role === "admin";

  async function makeInvite() {
    const res = await session.createInvite({ role: inviteRole, expiresInHours: 72 });
    setNewLink(res.url);            // shown once; the server keeps only a hash
    await refresh();
  }

  /* Throws rather than swallowing: ActionButton turns a rejection into a
     message beside the button, which is where somebody is looking. */
  async function grant(member) {
    await session.grantAccess(member.userId, member.publicKey);
    setConfirming(null);
    await refresh();
  }

  async function changeRole(member, role) {
    setBusy(member.userId); setError(null);
    try { await session.setMemberRole(member.userId, role); await refresh(); }
    catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function remove(member) {
    await session.removeMember(member.userId);
    await refresh();
  }

  const REMOVE_WARNING =
    "Remove this person from the household?\n\n" +
    "They lose access immediately. Rotate the household key afterwards — until you do, " +
    "anything they already downloaded stays readable to them.";

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
      {/* Which household this is.
          There is deliberately no "Switch household" button here any more. It
          used to sit in this card -- directly above the "Waiting for you"
          section -- so the control that throws away the whole screen was the
          nearest neighbour of the two-tap flow for letting somebody in. A
          near-miss there does not misfire harmlessly: it closes the household,
          and the admin lands back at the picker wondering why the grant did
          nothing. The same button already exists under Settings → Account,
          which is where a navigation control belongs. */}
      <div style={{ ...card }}>
        <div style={{ fontWeight: 600, color: T.ink }}>{householdName || "This household"}</div>
        <div style={{ color: T.faint, fontSize: 12 }}>
          {active.length} {active.length === 1 ? "person" : "people"} · you are {members.find((m) => m.userId === me?.id)?.role || "a member"}
        </div>
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
                  {/* Repeated here as well as at the top of the panel. This list
                      can be long, and a failure announced above the fold of a
                      scrolled panel reads as the button having done nothing at
                      all -- which is precisely the report that sent us looking
                      for this. */}
                  {error && (
                    <div role="alert" style={{
                      background: "#fdecea", border: "1px solid #f0b4ae", color: "#7a1c12",
                      borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 8,
                    }}>
                      {error}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <ActionButton theme={T} variant="primary" onClick={() => grant(m)}
                      busyLabel="Letting them in…" doneLabel="They're in">
                      Yes — let them in
                    </ActionButton>
                    <button style={btn(false)} onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={btn(true)} disabled={!iAmAdmin} onClick={() => setConfirming(m.userId)}>
                    Grant access
                  </button>
                  <ActionButton theme={T} onClick={() => remove(m)} confirm={REMOVE_WARNING}
                    busyLabel="Declining…" doneLabel="Declined">Decline</ActionButton>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- which zone days are measured in ---- */}
      <h4 style={{ fontWeight: 700, marginBottom: 6, color: T.ink }}>Timezone</h4>
      <div style={card}>
        {tz === null ? (
          <div style={{ color: T.faint, fontSize: 13 }}>Checking…</div>
        ) : (
          <>
            <p style={{ color: T.faint, fontSize: 13, marginBottom: 10 }}>
              Which zone this household's calendar days are measured in. Subscribed
              calendars are expanded into days on the server, so if this is wrong,
              evening events quietly land on the following day — nothing errors, the
              calendar is just gently untrustworthy.
            </p>

            {/* A mismatch is the whole reason this is worth showing: nobody goes
                looking for a timezone setting, they just stop believing the wall
                display. */}
            {tz.effective !== browserTz && (
              <div role="alert" style={{
                background: "#fff6e5", border: "1px solid #f0d9a8", color: "#6b4708",
                borderRadius: 8, padding: "8px 10px", fontSize: 13, marginBottom: 10,
              }}>
                This browser is in <strong>{browserTz}</strong> but the household is set
                to <strong>{tz.effective}</strong>
                {!tz.configured && " (the server default, because nothing has been chosen)"}.
                If you live in {browserTz}, pick it below.
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                value={tz.timezone || ""}
                onChange={(e) => saveTimezone(e.target.value)}
                disabled={!iAmAdmin || busy === "tz"}
                style={{
                  background: T.panel, color: T.ink, border: `1px solid ${T.line}`,
                  borderRadius: 8, padding: "8px 10px", minWidth: 240,
                }}
              >
                <option value="">Server default ({tz.serverDefault})</option>
                {zoneChoices.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
              {busy === "tz" && <span style={{ color: T.faint, fontSize: 13 }}>Saving…</span>}
            </div>

            <div style={{ color: T.faint, fontSize: 12.5, marginTop: 8 }}>
              Days are currently measured in <strong>{tz.effective}</strong>.
              {!iAmAdmin && " Only an admin can change this."}
            </div>
          </>
        )}
      </div>


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
                <ActionButton theme={T} onClick={() => remove(m)} confirm={REMOVE_WARNING}
                  busyLabel="Removing…" doneLabel="Removed">Remove</ActionButton>
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
              <ActionButton theme={T} variant="primary" onClick={makeInvite}
                busyLabel="Creating…" doneLabel="Link created">
                Create invite link
              </ActionButton>
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
