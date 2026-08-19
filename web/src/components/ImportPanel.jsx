// ImportPanel.jsx — bringing a household over from the old HouseHub.
//
// Three visible stages, and you can always see which one you are in:
//
//   1. CHOOSE   pick the files. Every file selected is listed by name and size
//               with a tick, so "did it take my file?" is never a question.
//   2. READY    what was found, itemised, with an explicit button to apply it.
//               Nothing has been written yet and the screen says so.
//   3. DONE     what actually arrived, itemised.
//
// The earlier version collapsed 1 and 2 together and rendered the result below
// the fold of a long settings page, so selecting a file appeared to do nothing
// whatsoever. Every stage now announces itself where the person is looking.
//
// Nothing is destroyed. An import merges into this household: existing entries
// are never removed or overwritten, people are matched up by name so nobody ends
// up duplicated, and running the same import twice changes nothing the second
// time. See mergeImport in lib/legacy-import.js.
//
// The whole conversion happens in this tab, because sealing needs the household
// key and the key exists only here. The server receives ciphertext.

import React, { useState, useCallback, useRef } from "react";
import * as session from "../lib/session.js";
import { addCalendar } from "../api.js";
import ActionButton from "./ActionButton.jsx";
import {
  readLegacyFile, prepareImport, mergeImport, describeMerge, LegacyImportError,
} from "../lib/legacy-import.js";

const kb = (n) => (n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / 1048576).toFixed(1)} MB`);

export default function ImportPanel({ theme: T, data, update, saveNow }) {
  const [picked, setPicked] = useState([]);      // [{ name, size, role, ok, note }]
  const [reading, setReading] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const iAmAdmin = session.snapshot().role === "admin";

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };

  /**
   * Read whatever was selected. Both files matter: the old app ran SQLite in WAL
   * mode, so a database copied off a running server keeps its most recent writes
   * in a separate `-wal`, and reading the .db alone silently yields an older
   * household.
   */
  const takeFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setError(null); setProposal(null); setResult(null); setReading(true);

    const wal = files.find((f) => /-wal$/i.test(f.name));
    const main = files.find((f) => f !== wal) || files[0];
    const extra = files.filter((f) => f !== wal && f !== main);

    // Listed immediately, before any parsing, so the selection is visibly
    // acknowledged even if reading the file then takes a moment.
    setPicked([
      { name: main.name, size: main.size, role: "database", ok: null },
      ...(wal && wal !== main ? [{ name: wal.name, size: wal.size, role: "write-ahead log", ok: null }] : []),
      ...extra.map((f) => ({ name: f.name, size: f.size, role: "ignored", ok: false,
        note: "not a database or a -wal file" })),
    ]);

    try {
      const bytes = new Uint8Array(await main.arrayBuffer());
      const walBytes = wal && wal !== main ? new Uint8Array(await wal.arrayBuffer()) : null;
      const read = readLegacyFile(bytes, main.name, walBytes);
      setProposal(prepareImport(read.doc, read));
      setPicked((cur) => cur.map((f) => (f.role === "ignored" ? f : { ...f, ok: true })));
    } catch (err) {
      setPicked((cur) => cur.map((f) => (f.role === "ignored" ? f : { ...f, ok: false })));
      setError(err instanceof LegacyImportError ? err.message : `Could not read that file: ${err.message}`);
    } finally {
      setReading(false);
    }
  }, []);

  /** Apply the proposal. Throws on failure so ActionButton can show it. */
  async function apply() {
    if (!proposal) throw new Error("Nothing to import");
    const notes = [];

    /* Calendar feeds first. Subscriptions live server-side -- the URL and the
       fetched .ics are sealed under the server key, because a browser cannot
       fetch a Google or iCloud feed itself. The server hands back an id that the
       document's entry is keyed by, so the ids must exist before the document
       that references them is saved. */
    const calendars = [];
    for (const feed of proposal.feeds) {
      try {
        calendars.push(await addCalendar({
          url: feed.url || undefined,
          icsText: feed.url ? undefined : feed.icsText,
          name: feed.name || "", color: feed.color || null, personId: feed.personId || "",
        }));
      } catch (err) {
        // One dead subscription must not cost the household everything else.
        notes.push(`Calendar "${feed.name || feed.url || "untitled"}" could not be added: ${err.message}`);
      }
    }

    /* Merge against the document we are holding, then save it explicitly and
       wait for the server to accept it. `update` alone queues a debounced save
       and swallows failures, so confirming off the back of it would announce
       success before anything had been written -- and keep announcing it if the
       write then failed. */
    const merged = mergeImport(data, proposal.doc);
    const next = {
      ...merged.doc,
      calendars: [...(data.calendars || []), ...calendars],
    };
    update(() => next);
    await saveNow(next);

    setResult({ lines: describeMerge(merged.report), notes, calendars: calendars.length });
    setProposal(null);
    setPicked([]);
  }

  function startOver() {
    setPicked([]); setProposal(null); setError(null); setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  /* ------------------------------------------------------------ render --- */

  if (!iAmAdmin) {
    return (
      <p style={{ color: T.faint, fontSize: 13 }}>
        Only an admin can import a household.
      </p>
    );
  }

  const stage = result ? 3 : proposal ? 2 : 1;

  return (
    <div>
      <StageBar stage={stage} T={T} />

      {/* ---------------------------------------------------- stage 3 --- */}
      {result && (
        <>
          <div role="status" style={{ ...card, background: "#e9f7ef", borderColor: "#b7e0c6" }}>
            <div style={{ fontWeight: 700, color: "#14532d", marginBottom: 6 }}>
              ✓ Imported successfully
            </div>
            {result.lines.length ? (
              <ul style={{ margin: "0 0 0 18px", color: "#14532d", fontSize: 13 }}>
                {result.lines.map((l, i) => <li key={i}>{l}</li>)}
                {result.calendars > 0 && <li>{result.calendars} calendar subscription(s)</li>}
              </ul>
            ) : (
              <div style={{ color: "#14532d", fontSize: 13 }}>
                Everything in that file was already here, so nothing needed adding.
              </div>
            )}
            <div style={{ color: "#14532d", fontSize: 12.5, marginTop: 8 }}>
              Nothing that was already in this household was changed or removed.
            </div>
          </div>
          <ActionButton theme={T} onClick={startOver} doneLabel="Ready">
            Import another file
          </ActionButton>
        </>
      )}

      {/* ---------------------------------------------------- stage 1 --- */}
      {!result && (
        <>
          <p style={{ color: T.faint, fontSize: 13, marginBottom: 10 }}>
            Moving from the old HouseHub? Everything comes across — people, chores and their
            whole completion history, tasks, meals, notes, projects, the agenda archive,
            check-in history and calendar subscriptions.
          </p>

          <div style={{ ...card, background: "#eef4ff", borderColor: "#c6d8f5" }}>
            <div style={{ color: "#1f3f73", fontSize: 12.5, lineHeight: 1.5 }}>
              <strong>Nothing here is deleted.</strong> An import adds to this household.
              Existing entries are never removed or overwritten, people with the same name
              are matched up rather than duplicated, and importing the same file twice
              changes nothing the second time.
              <br /><br />
              <strong>The file never leaves this browser.</strong> It is read from your disk,
              converted here, and encrypted with your household key before anything is sent.
            </div>
          </div>

          {error && (
            <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
              {error}
            </div>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); takeFiles(e.dataTransfer.files); }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
            style={{
              border: `2px dashed ${dragging ? T.brand : T.line}`,
              background: dragging ? `${T.brand}0d` : T.panelAlt,
              borderRadius: 12, padding: "22px 14px", textAlign: "center", cursor: "pointer",
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700, color: T.ink, marginBottom: 4 }}>
              {picked.length ? "Choose different files" : "Choose the old database"}
            </div>
            <div style={{ color: T.faint, fontSize: 12.5 }}>
              tap here, or drag files on — <code>househub.db</code> <strong>and</strong>{" "}
              <code>househub.db-wal</code> if there is one
            </div>
          </div>

          {/* No `accept` filter: `.db-wal` matches no extension list, and Safari
              resolves `accept` through UTIs, where `.db` maps to nothing at all —
              between them they greyed out every file. What a file actually is
              gets decided by sniffing its first bytes instead. */}
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => takeFiles(e.target.files)}
          />

          {/* Selected files, acknowledged individually. */}
          {picked.length > 0 && (
            <div style={card}>
              {picked.map((f, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8, fontSize: 13,
                  padding: "3px 0", color: f.ok === false ? "#7a1c12" : T.ink,
                }}>
                  <span aria-hidden="true" style={{ width: 14 }}>
                    {f.ok === true ? "✓" : f.ok === false ? "✕" : "…"}
                  </span>
                  <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{f.name}</span>
                  <span style={{ color: T.faint }}>{kb(f.size)}</span>
                  <span style={{ color: T.faint, fontSize: 12 }}>
                    {f.note || (f.role === "ignored" ? "ignored" : f.role)}
                  </span>
                </div>
              ))}
              {reading && (
                <div style={{ color: T.sub, fontSize: 12.5, marginTop: 6 }}>Reading…</div>
              )}
            </div>
          )}

          {/* -------------------------------------------------- stage 2 --- */}
          {proposal && (
            <>
              <div style={card}>
                <div style={{ fontWeight: 700, color: T.ink, marginBottom: 8 }}>
                  Found{proposal.householdName ? ` — "${proposal.householdName}"` : ""}
                </div>
                {proposal.summary.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "3px 12px", fontSize: 13 }}>
                    {proposal.summary.map(([label, n]) => (
                      <React.Fragment key={label}>
                        <span style={{ color: T.sub }}>{label}</span>
                        <span style={{ color: T.ink, fontWeight: 700, textAlign: "right" }}>{n}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: T.faint, fontSize: 13 }}>
                    That file opened cleanly but contains nothing to import.
                  </div>
                )}
              </div>

              {proposal.warnings.map((w, i) => (
                <div key={i} style={{
                  ...card,
                  background: w.level === "error" ? "#fdecea" : w.level === "warn" ? "#fff6e5" : T.panelAlt,
                  borderColor: w.level === "error" ? "#f0b4ae" : w.level === "warn" ? "#f0d9a8" : T.line,
                  color: w.level === "error" ? "#7a1c12" : w.level === "warn" ? "#6b4708" : T.sub,
                  fontSize: 12.5,
                }}>
                  {w.text}
                </div>
              ))}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                <ActionButton
                  theme={T}
                  variant="primary"
                  onClick={apply}
                  busyLabel="Importing…"
                  doneLabel="Imported"
                  disabled={!proposal.summary.length}
                >
                  Add this to my household
                </ActionButton>
                <ActionButton theme={T} onClick={startOver} doneLabel="Cleared">
                  Cancel
                </ActionButton>
              </div>
              <p style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>
                Nothing has been saved yet. Nothing already in this household will be
                changed or removed.
              </p>
            </>
          )}

          <details style={{ color: T.faint, fontSize: 12.5, marginTop: 10 }}>
            <summary style={{ cursor: "pointer" }}>Where do I find that file?</summary>
            <div style={{ marginTop: 6, lineHeight: 1.6 }}>
              On the machine running the old hub it sits next to the server —{" "}
              <code>server/househub.db</code>, or wherever <code>DB_FILE</code> pointed.
              Very early versions used <code>server/data.json</code> instead.
              <br /><br />
              <strong>Either stop the old server before copying, or copy both files.</strong>{" "}
              SQLite keeps recent writes in a log called <code>househub.db-wal</code>. A
              database copied from a running server without it is missing the last few
              things anyone did — and it opens perfectly happily, showing an older
              household with no warning. Select both here and they are put back together.
            </div>
          </details>
        </>
      )}
    </div>
  );
}

/** Where you are, and what is left. */
function StageBar({ stage, T }) {
  const steps = ["Choose files", "Check what was found", "Imported"];
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
      {steps.map((label, i) => {
        const n = i + 1;
        const active = n === stage;
        const past = n < stage;
        return (
          <span key={label} style={{
            fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
            background: active ? T.brand : past ? "#1f7a4d" : T.panelAlt,
            color: active || past ? "#fff" : T.faint,
            border: `1px solid ${active ? T.brand : past ? "#1f7a4d" : T.line}`,
          }}>
            {past ? "✓" : n}. {label}
          </span>
        );
      })}
    </div>
  );
}
