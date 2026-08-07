// SecondBlock.jsx — the configurable second row on Today.
//
// Ported from the fork Steven's partner sent over. The idea is a good one: the
// three-column dashboard is fixed to what the app thinks matters, and the space
// under it is the only place a household can say "actually, what we look at on
// the way out of the door is the back garden" — or the shopping list, or
// whatever the date jar has in it.
//
// Chosen per person-filter, so "All" can show cameras while filtering to one
// person shows their groceries. That per-filter detail is from the original and
// is worth keeping: what you want on a shared screen and what you want on your
// own phone are rarely the same thing.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";
import { suggestDateIdea } from "../lib/checkin.js";

export const BLOCK_KINDS = [
  ["none", "Nothing"],
  ["grocery", "Grocery list"],
  ["dateJar", "Date jar"],
  ["camera", "Cameras"],
  ["devices", "Lights & devices"],
];

/** What this filter is set to show. Tolerates the older string-only shape. */
export function secondBlockFor(data, filter) {
  const raw = (data.secondBlock || data.mealsSecondRow || {})[filter || "all"];
  if (!raw) return { kind: "none", picks: [] };
  if (typeof raw === "string") return { kind: raw, picks: [] };   // pre-picker saves
  return { kind: raw.kind || "none", picks: Array.isArray(raw.picks) ? raw.picks : [] };
}

/* --------------------------------------------------------------- blocks --- */

function BlockGrocery({ data, update, T }) {
  const items = (data.grocery || []).filter((g) => !g.done).slice(0, 12);
  if (!items.length) {
    return <p style={{ color: T.faint, fontSize: 13 }}>Nothing on the list.</p>;
  }
  const toggle = (id) => update((d) => ({
    ...d,
    grocery: (d.grocery || []).map((g) =>
      g.id === id ? { ...g, done: true, boughtAt: Date.now() } : g),
  }));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 6 }}>
      {items.map((g) => (
        <button key={g.id} onClick={() => toggle(g.id)} className="tapfade text-left"
                style={{
                  background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 10,
                  padding: "7px 10px", color: T.ink, fontSize: 13.5,
                }}>
          <span style={{ fontWeight: 600 }}>{g.title}</span>
          {g.qty && <span style={{ color: T.faint }}> · {g.qty}</span>}
          {g.aisle && <span style={{ display: "block", color: T.faint, fontSize: 11 }}>{g.aisle}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The date jar, with a draw and an AI suggestion.
 *
 * The suggestion honours the household's own AI instructions, which is the whole
 * point of having them: "team building for platonic housemates" and "sexual
 * discovery for partners" should not produce the same list, and the app has no
 * business guessing which household this is.
 */
function BlockDateJar({ data, update, T }) {
  const jars = data.dateJars || [];
  const [jarId, setJarId] = useState(jars[0]?.id || "");
  const [drawn, setDrawn] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ideas = (data.dateIdeas || []).filter((i) => !i.retired && (!jarId || i.jarId === jarId));

  /** Never-drawn first, then longest ago — a small jar otherwise repeats itself. */
  const draw = () => {
    if (!ideas.length) return;
    const pool = ideas.filter((i) => i.id !== drawn?.id) .length ? ideas.filter((i) => i.id !== drawn?.id) : ideas;
    const sorted = [...pool].sort((a, b) => (a.drawnAt || 0) - (b.drawnAt || 0));
    const pick = sorted[0];
    setDrawn(pick);
    setSuggestion(null);
    update((d) => ({
      ...d,
      dateIdeas: (d.dateIdeas || []).map((i) => i.id === pick.id ? { ...i, drawnAt: Date.now() } : i),
    }));
  };

  async function suggest() {
    setBusy(true); setError(null); setDrawn(null);
    try {
      const idea = await suggestDateIdea(data, {
        jar: jars.find((j) => j.id === jarId)?.name,
        existing: ideas.map((i) => i.text),
      });
      setSuggestion(idea);
    } catch (err) {
      setError(err.status === 409 ? "AI needs setting up in Settings → AI." : err.message);
    } finally { setBusy(false); }
  }

  const keep = () => {
    if (!suggestion) return;
    update((d) => ({
      ...d,
      dateIdeas: [...(d.dateIdeas || []), {
        id: Math.random().toString(36).slice(2, 9),
        text: suggestion, jarId, addedOn: new Date().toISOString().slice(0, 10),
      }],
    }));
    setSuggestion(null);
  };

  const btn = (primary) => ({
    background: primary ? T.brand : T.panelAlt, color: primary ? "#fff" : T.ink,
    border: `1px solid ${primary ? T.brand : T.line}`, borderRadius: 10,
    padding: "6px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer",
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        {jars.map((j) => (
          <button key={j.id} onClick={() => setJarId(j.id)} className="tapfade"
                  style={{
                    ...btn(jarId === j.id),
                    background: jarId === j.id ? (j.color || T.brand) : T.panelAlt,
                    borderColor: jarId === j.id ? (j.color || T.brand) : T.line,
                  }}>
            {j.name}
          </button>
        ))}
        <button onClick={draw} disabled={!ideas.length} style={btn(false)}>Draw</button>
        <button onClick={suggest} disabled={busy} style={btn(false)}>
          {busy ? "Thinking…" : "Suggest one"}
        </button>
      </div>

      {error && <p style={{ color: "#8a3d12", fontSize: 12 }}>{error}</p>}

      {drawn && (
        <div style={{ background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>{drawn.text}</div>
          <div style={{ color: T.faint, fontSize: 12 }}>
            {drawn.doneCount ? `done ${drawn.doneCount}×` : "never done"}
          </div>
        </div>
      )}

      {suggestion && (
        <div style={{ background: "#eef7ee", border: "1px solid #bcdcbc", borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1e4620" }}>{suggestion}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button onClick={keep} style={btn(true)}>Add to the jar</button>
            <button onClick={suggest} disabled={busy} style={btn(false)}>Another</button>
          </div>
        </div>
      )}

      {!drawn && !suggestion && !ideas.length && (
        <p style={{ color: T.faint, fontSize: 13 }}>
          This jar is empty. Press <strong>Suggest one</strong> for an idea, or add your own
          under Agenda → Date jar.
        </p>
      )}
    </div>
  );
}

/** Live camera stills from the household's CamWatch. */
function BlockCamera({ picks, T }) {
  const [cameras, setCameras] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    session.listCameras().then(setCameras).catch(() => setCameras([]));
    const t = setInterval(() => setTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, []);

  if (!cameras) return <p style={{ color: T.faint, fontSize: 13 }}>Loading cameras…</p>;
  const shown = picks.length ? cameras.filter((c) => picks.includes(c.id)) : cameras;
  if (!shown.length) {
    return <p style={{ color: T.faint, fontSize: 13 }}>No cameras. Connect CamWatch in Settings.</p>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 8 }}>
      {shown.slice(0, 6).map((c) => (
        <div key={c.id} style={{ borderRadius: 10, overflow: "hidden", background: "#1B1720", aspectRatio: "16/9", position: "relative" }}>
          <img
            src={`${session.cameraSnapshotUrl(c.id)}${session.cameraSnapshotUrl(c.id).includes("?") ? "&" : "?"}t=${tick}`}
            alt={c.name}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          <div style={{
            position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 8px",
            background: "linear-gradient(transparent,#0009)", color: "#fff", fontSize: 12, fontWeight: 700,
          }}>{c.name}</div>
        </div>
      ))}
    </div>
  );
}

/** Lights and switches, tappable where this viewer is allowed to. */
function BlockDevices({ picks, T }) {
  const [entities, setEntities] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    session.homeEntities().then(setEntities).catch(() => setEntities([]));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  if (!entities) return <p style={{ color: T.faint, fontSize: 13 }}>Loading…</p>;

  const SWITCHABLE = ["light", "switch", "fan", "cover"];
  const shown = (picks.length ? entities.filter((e) => picks.includes(e.entityId)) : entities)
    .filter((e) => SWITCHABLE.includes(e.domain)).slice(0, 12);

  if (!shown.length) {
    return <p style={{ color: T.faint, fontSize: 13 }}>Nothing to show. Connect Home Assistant in Settings.</p>;
  }

  const toggle = async (e) => {
    setError(null);
    try { await session.homeControl(e.entityId, "toggle"); load(); }
    catch (err) { setError(err.message); }
  };

  return (
    <>
      {error && <p style={{ color: "#8a3d12", fontSize: 12, marginBottom: 6 }}>{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 6 }}>
        {shown.map((e) => {
          const on = ["on", "open", "unlocked"].includes(String(e.state).toLowerCase());
          return (
            <button key={e.entityId} onClick={() => toggle(e)} className="tapfade text-left"
                    style={{
                      background: on ? `${T.gold}22` : T.panelAlt,
                      border: `1px solid ${on ? T.gold : T.line}`,
                      borderRadius: 10, padding: "7px 10px", color: T.ink, fontSize: 13.5,
                    }}>
              <span style={{ fontWeight: 600 }}>{e.name}</span>
              <span style={{ display: "block", color: T.faint, fontSize: 11 }}>{e.state}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- shell --- */

export default function SecondBlock({ data, update, filter, theme: T }) {
  const { kind, picks } = secondBlockFor(data, filter);
  if (kind === "none") return null;

  const title = BLOCK_KINDS.find(([k]) => k === kind)?.[1] || "";

  return (
    <section style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, color: T.faint, marginBottom: 6, letterSpacing: 0.3 }}>
        {title.toUpperCase()}
      </h3>
      {kind === "grocery" && <BlockGrocery data={data} update={update} T={T} />}
      {kind === "dateJar" && <BlockDateJar data={data} update={update} T={T} />}
      {kind === "camera" && <BlockCamera picks={picks} T={T} />}
      {kind === "devices" && <BlockDevices picks={picks} T={T} />}
    </section>
  );
}

/** The picker, for Settings. */
export function SecondBlockSettings({ data, update, theme: T, people }) {
  const filters = [["all", "Everyone"], ...(people || []).map((p) => [p.id, p.name])];

  const set = (filterId, kind) => update((d) => ({
    ...d,
    secondBlock: { ...(d.secondBlock || {}), [filterId]: { kind, picks: [] } },
  }));

  return (
    <div>
      <p style={{ color: T.faint, fontSize: 13, marginBottom: 8 }}>
        An extra row under the Today columns. Chosen separately for each person filter, so a
        shared screen and your own phone can show different things.
      </p>
      {filters.map(([id, label]) => (
        <div key={id} style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 8, padding: "6px 0", flexWrap: "wrap",
        }}>
          <span style={{ color: T.ink, fontWeight: 600, fontSize: 14 }}>{label}</span>
          <select
            value={secondBlockFor(data, id).kind}
            onChange={(e) => set(id, e.target.value)}
            style={{
              background: T.panel, color: T.ink, border: `1px solid ${T.line}`,
              borderRadius: 8, padding: "6px 8px",
            }}
          >
            {BLOCK_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}
