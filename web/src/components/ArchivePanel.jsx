// ArchivePanel.jsx — the record of who actually did what.
//
// Two jobs, and they are now in two places, because they belong to two
// different people at two different moments.
//
//   ArchiveRecord   the record itself. Lives in the To-Dos tab alongside
//                   History and Report, which is where somebody goes when the
//                   question is "who did what" -- they should not have to know
//                   that part of the answer is filed under Settings.
//
//   ArchivePanel    the admin controls: what gets recorded, and the proposal
//                   flow for turning it off. These stay in Settings, and
//                   deliberately do NOT follow the record onto a tab a shared
//                   display can reach. Turning the archive off destroys it
//                   permanently, and a wall tablet in a hallway is not where
//                   that decision should be one tap away.
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

      {/* The record now lives in To-Dos → History → Archive, which is where
          somebody goes when the question is "who did what". Repeating all of it
          here would give the household two places to read the same thing and
          two places to keep in step. */}
      <h4 style={{ fontWeight: 700, margin: "18px 0 8px", color: T.ink }}>
        The record ({(data.archive?.chores || []).length})
      </h4>
      <p style={{ color: T.faint, fontSize: 13 }}>
        Kept completions are shown in <strong style={{ color: T.ink }}>To-Dos → History → Archive</strong>,
        alongside the rest of the history, where they can also be reattributed.
      </p>

    </div>
  );
}

/**
 * The archive itself: every recorded completion, with who did it.
 *
 * Split out so the To-Dos tab can show it without also showing the controls
 * that can destroy it. Takes no `me` and no proposal machinery — it reads.
 */
export function ArchiveRecord({ theme: T, data, update, showEmptyHint = true }) {
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);

  const settings = data.archiveSettings || {};
  const entries = useMemo(
    () => [...(data.archive?.chores || [])].sort((a, b) => (b.completedAt || b.at) - (a.completedAt || a.at)),
    [data.archive]
  );
  const personById = useCallback(
    (id) => (data.people || []).find((p) => p.id === id) || null,
    [data.people]
  );
  const card = {
    background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10,
    padding: "10px 12px", marginBottom: 8,
  };

  /* Correcting who a completion is credited to. Goes through
     C.attributeChore, which refuses on a signed-in member's own locked claim —
     so this cannot quietly rewrite a first-person record. */
  const attribute = (entry, personId) => {
    setError(null);
    try {
      update((d) => C.attributeChore(d, entry.choreId, entry.dateKey, personId, session.currentActor(d)));
    } catch (e) {
      setError(e?.message || "That could not be reassigned.");
    }
  };

  const shown = filter === "all" ? entries : entries.filter((e) => e.by === filter);

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {showEmptyHint && !settings.chores && !entries.length && (
        <p style={{ color: T.faint, fontSize: 13 }}>
          Nothing is being recorded yet. Turn the chores archive on in
          Settings → Archive and completions will start being kept, along with
          who ticked each one off.
        </p>
      )}

      {entries.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter the archive by person"
            style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "6px 8px" }}
          >
            <option value="all">Everyone</option>
            {(data.people || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="">Unattributed</option>
          </select>
        </div>
      )}

      {shown.slice(0, 300).map((e) => {
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

              {editable ? (
                <select
                  value={e.by || ""}
                  onChange={(ev) => attribute(e, ev.target.value)}
                  title="Who actually did this?"
                  style={{ background: T.panel, color: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, padding: "4px 6px", fontSize: 13 }}
                >
                  <option value="">Not attributed</option>
                  {(data.people || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
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

