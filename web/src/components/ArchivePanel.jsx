// ArchivePanel.jsx — the record of who actually did what.
//
// Two jobs. It shows the archive, and it is where an admin turns archiving on
// and off — which are very different acts and are presented as such.
//
// Turning it ON is one click. Turning it OFF destroys the record permanently, so
// it needs every admin to agree first (routes/proposals.js). That asymmetry is
// deliberate: the archive exists partly so a household can see who is carrying
// the work, and the person it reflects worst is exactly the person most likely
// to want it gone.
//
// The panel is also honest about how much each row is worth. A completion ticked
// on a shared screen is labelled as such, because "the kitchen iPad recorded
// this" and "Sam says they did this while signed in" are not the same claim, and
// showing them identically would quietly overstate the first.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as session from "../lib/session.js";
import * as C from "../lib/completion.js";
import ActionButton from "./ActionButton.jsx";

const dayLabel = (key) => {
  if (!key) return "";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
};

export default function ArchivePanel({ theme: T, data, update, me }) {
  const [proposals, setProposals] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState("all");

  const settings = data.archiveSettings || {};
  const entries = useMemo(
    () => [...(data.archive?.chores || [])].sort((a, b) => (b.completedAt || b.at) - (a.completedAt || a.at)),
    [data.archive]
  );

  const personById = useCallback(
    (id) => (data.people || []).find((p) => p.id === id) || null,
    [data.people]
  );

  const refresh = useCallback(async () => {
    try { setProposals(await session.listProposals()); }
    catch (err) { setError(err.message); }
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

  /* --------------------------------------------------------- switching --- */

  function enable(kind) {
    update((d) => ({ ...d, archiveSettings: { ...(d.archiveSettings || {}), [kind]: true } }));
  }

  async function proposeDisable(kind) {
    if (!confirm(
      `Turn the ${C.ARCHIVABLE[kind].toLowerCase()} archive off?\n\n` +
      `Every admin has to agree. Once they all do, the existing record is wiped ` +
      `permanently — it cannot be recovered by anyone.\n\n` +
      `Nothing recorded after that point is affected; there simply won't be a record.`
    )) return;
    setBusy(kind); setError(null);
    try {
      await session.createProposal("disable_archive", { collections: [kind] });
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  // Uncaught on purpose: ActionButton shows a failure beside the button and
  // withholds the tick. A swallowed error here would tell an admin their refusal
  // had been recorded when it had not.
  async function decide(proposal, decision) {
    setError(null);
    const res = await session.decideProposal(proposal.id, decision);
    // Approved by everyone: carry it out, then tell the server it happened so
    // the audit trail records the wipe rather than only the agreement.
    if (res.status === "approved") {
      const collections = proposal.payload?.collections || [];
      update((d) => C.wipeArchive(d, collections));
      await session.markProposalApplied(proposal.id);
    }
    await refresh();
  }

  /* ------------------------------------------------------ attribution --- */

  function attribute(entry, personId) {
    try {
      update((d) => C.attributeChore(d, entry.choreId, entry.dateKey, personId, session.currentActor(d)));
    } catch (err) { setError(err.message); }
  }

  const shown = filter === "all" ? entries : entries.filter((e) => e.by === filter);

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {/* ---- proposals awaiting other admins ---- */}
      {proposals.filter((p) => p.kind === "disable_archive").map((p) => {
        const mine = p.decisions.find((d) => d.userId === me?.id);
        const approved = p.decisions.filter((d) => d.decision === "approve").length;
        return (
          <div key={p.id} style={{ ...card, background: "#fff6e5", borderColor: "#e0c184" }}>
            <div style={{ fontWeight: 700, color: "#6b4708" }}>
              Proposal: turn off the {(p.payload?.collections || []).join(", ")} archive
            </div>
            <div style={{ fontSize: 13, color: "#6b4708", margin: "4px 0 8px" }}>
              {approved} of {p.required} admins have agreed. This permanently deletes the
              existing record. Any admin can refuse, and one refusal ends it.
            </div>
            {iAmAdmin && !mine && (
              <div style={{ display: "flex", gap: 8 }}>
                  <ActionButton theme={T} variant="danger" onClick={() => decide(p, "approve")}
                    busyLabel="Recording your agreement…" doneLabel="Agreed">
                    Agree — wipe it
                  </ActionButton>
                  <ActionButton theme={T} onClick={() => decide(p, "deny")}
                    busyLabel="Refusing…" doneLabel="Refused">
                    Refuse
                  </ActionButton>
              </div>
            )}
            {mine && <div style={{ fontSize: 13, color: "#6b4708" }}>You have already {mine.decision}d.</div>}
          </div>
        );
      })}

      {/* ---- what is being recorded ---- */}
      <h4 style={{ fontWeight: 700, marginBottom: 8, color: T.ink }}>What gets kept</h4>
      {Object.entries(C.ARCHIVABLE).map(([kind, label]) => {
        const on = Boolean(settings[kind]);
        const pending = proposals.some((p) => p.payload?.collections?.includes(kind));
        const supported = kind === "chores";
        return (
          <div key={kind} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, color: T.ink }}>
                {label}{!supported && <span style={{ color: T.faint, fontWeight: 400 }}> — not yet recorded</span>}
              </div>
              <div style={{ color: T.faint, fontSize: 12 }}>
                {on ? "Recording. Entries are never deleted while this is on." : "Not recording."}
              </div>
            </div>
            {iAmAdmin && supported && (
              on
                ? <button style={btn(false)} disabled={pending || busy === kind} onClick={() => proposeDisable(kind)}>
                    {pending ? "Awaiting admins" : "Turn off…"}
                  </button>
                : <button style={btn(true)} onClick={() => enable(kind)}>Turn on</button>
            )}
          </div>
        );
      })}

      {/* ---- the record ---- */}
      <h4 style={{ fontWeight: 700, margin: "18px 0 8px", color: T.ink }}>
        Completed chores ({entries.length})
      </h4>

      {!settings.chores && !entries.length && (
        <p style={{ color: T.faint, fontSize: 13 }}>
          Nothing is being recorded yet. Turn the chores archive on above and completions
          will start being kept, along with who ticked each one off.
        </p>
      )}

      {entries.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "6px 8px" }}
          >
            <option value="all">Everyone</option>
            {(data.people || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="">Unattributed</option>
          </select>
        </div>
      )}

      {shown.slice(0, 300).map((e) => {
        const doer = personById(e.by);
        const assignee = personById(e.assignedTo);
        // The interesting case, and the reason both are stored: somebody did a
        // chore that was not theirs.
        const covering = e.by && e.assignedTo && e.by !== e.assignedTo;
        const editable = e.byType === "display" || e.byType === "legacy";

        return (
          <div key={e.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 600, color: T.ink }}>{e.title}</div>
                <div style={{ color: T.faint, fontSize: 12 }}>
                  {dayLabel(e.dateKey)}
                  {" · "}
                  {C.describeActor(e, personById)}
                  {covering && (
                    <span style={{ color: T.brand }}>
                      {" · covered for "}{assignee?.name || "someone else"}
                    </span>
                  )}
                </div>
              </div>

              {editable && (
                <select
                  value={e.by || ""}
                  onChange={(ev) => attribute(e, ev.target.value)}
                  title="Who actually did this?"
                  style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "4px 6px", fontSize: 13 }}
                >
                  <option value="">Not attributed</option>
                  {(data.people || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              {!editable && (
                <span style={{ color: T.faint, fontSize: 12, alignSelf: "center" }} title="Recorded while signed in — cannot be reassigned">
                  signed in ✓
                </span>
              )}
            </div>
          </div>
        );
      })}

      {shown.length > 300 && (
        <p style={{ color: T.faint, fontSize: 12 }}>Showing the most recent 300 of {shown.length}.</p>
      )}
    </div>
  );
}
