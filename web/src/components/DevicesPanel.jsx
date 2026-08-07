// DevicesPanel.jsx — organising a household's devices.
//
// Home Assistant will not let anything create a device: pairing runs through its
// own config flow, which is the right place for it. Everything after that is
// what actually makes a wall display readable, and it is all here — which
// entities appear, what they are called *in this house*, which room they are in,
// and what order they show in.
//
// The renaming is the part that earns its keep. Half the entities in a typical
// Home Assistant are called `sensor.0x00158d0004a1b2c3_temperature` by whatever
// integration created them, and nobody is going to fix that upstream. Calling it
// "Greenhouse" here takes two seconds and is the difference between a dashboard
// people read and one they stop looking at.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import * as session from "../lib/session.js";

const DOMAIN_LABELS = {
  light: "Lights", switch: "Switches", fan: "Fans", cover: "Blinds & garage",
  lock: "Locks", camera: "Cameras", sensor: "Sensors", binary_sensor: "Contact & motion",
  climate: "Thermostats", media_player: "Media", weather: "Weather", person: "People",
};

export default function DevicesPanel({ theme: T }) {
  const [data, setData] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [edits, setEdits] = useState({});          // entityId -> override patch
  const [newRoom, setNewRoom] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await session.homeDevices();
      setData(d);
      setRooms(d.rooms || []);
      setEdits({});
    } catch (err) {
      setError(err.status === 503
        ? "Home Assistant is not connected for this household yet."
        : err.message);
      setData({ entities: [], groups: [], rooms: [] });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };
  const btn = (primary, danger) => ({
    background: danger ? "#a12f1c" : primary ? T.brand : T.panel,
    color: danger || primary ? "#fff" : T.ink,
    border: `1px solid ${danger ? "#a12f1c" : primary ? T.brand : T.line}`,
    borderRadius: 10, padding: "7px 12px", fontWeight: 600, cursor: "pointer", fontSize: 13,
  });
  const input = {
    padding: "6px 9px", borderRadius: 8,
    border: `1px solid ${T.line}`, background: T.panel, color: T.ink, fontSize: 13,
  };

  /** Local, unsaved view of one entity. */
  const view = useCallback((e) => ({ ...e, ...(edits[e.entityId] || {}) }), [edits]);

  const patch = (entityId, change) =>
    setEdits((cur) => ({ ...cur, [entityId]: { ...(cur[entityId] || {}), ...change } }));

  async function save() {
    setBusy("save"); setError(null);
    try {
      await session.saveHomeDevices({ rooms, overrides: edits });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const addRoom = () => {
    const name = newRoom.trim();
    if (!name || rooms.includes(name)) return;
    setRooms((r) => [...r, name]);
    setNewRoom("");
  };

  const removeRoom = (name) => {
    setRooms((r) => r.filter((x) => x !== name));
    // Anything in it falls back to unassigned rather than disappearing.
    for (const e of data.entities) {
      if (view(e).room === name) patch(e.entityId, { room: null });
    }
  };

  const move = (entity, direction) => {
    const current = view(entity);
    const siblings = data.entities
      .map(view)
      .filter((e) => (e.room || null) === (current.room || null))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    const i = siblings.findIndex((e) => e.entityId === entity.entityId);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= siblings.length) return;

    // Renumber the whole room so ordering stays stable regardless of what the
    // stored numbers were.
    const reordered = [...siblings];
    [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
    reordered.forEach((e, index) => patch(e.entityId, { order: index }));
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.entities.filter((e) => {
      const v = view(e);
      return !q || v.name.toLowerCase().includes(q) || e.entityId.includes(q);
    });
  }, [data, search, view]);

  const grouped = useMemo(() => {
    const groups = [
      ...rooms.map((r) => ({ room: r, items: [] })),
      { room: null, items: [] },
    ];
    for (const e of filtered) {
      const v = view(e);
      const target = groups.find((g) => g.room === v.room) || groups[groups.length - 1];
      target.items.push(v);
    }
    for (const g of groups) g.items.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return groups.filter((g) => g.items.length || g.room);
  }, [filtered, rooms, view]);

  if (!data) return <p style={{ color: T.faint }}>Loading devices…</p>;

  const dirty = Object.keys(edits).length > 0 || JSON.stringify(rooms) !== JSON.stringify(data.rooms || []);

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {!data.entities.length && !error && (
        <p style={{ color: T.faint, fontSize: 13 }}>
          No devices selected yet. Choose some under <strong>Home Assistant → Choose
          entities</strong>, then come back here to name and arrange them.
        </p>
      )}

      {data.entities.length > 0 && (
        <>
          <div style={card}>
            <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>Rooms</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {rooms.map((r) => (
                <span key={r} style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  background: T.panel, border: `1px solid ${T.line}`, borderRadius: 999,
                  padding: "4px 10px", fontSize: 13, color: T.ink,
                }}>
                  {r}
                  <button onClick={() => removeRoom(r)} aria-label={`Remove ${r}`}
                          style={{ border: 0, background: "none", color: T.faint, cursor: "pointer" }}>×</button>
                </span>
              ))}
              {!rooms.length && <span style={{ color: T.faint, fontSize: 13 }}>None yet.</span>}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input style={{ ...input, flex: 1 }} value={newRoom} maxLength={40}
                     placeholder="Kitchen"
                     onChange={(e) => setNewRoom(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRoom())} />
              <button style={btn(false)} onClick={addRoom} disabled={!newRoom.trim()}>Add room</button>
            </div>
          </div>

          <input style={{ ...input, width: "100%", marginBottom: 8 }} value={search}
                 placeholder="Search devices…" onChange={(e) => setSearch(e.target.value)} />

          {grouped.map((g) => (
            <div key={g.room || "_none"} style={card}>
              <div style={{ fontWeight: 700, color: T.faint, fontSize: 12, marginBottom: 8, letterSpacing: 0.3 }}>
                {(g.room || "Not in a room").toUpperCase()}
              </div>

              {!g.items.length && (
                <p style={{ color: T.faint, fontSize: 12 }}>Nothing here yet.</p>
              )}

              {g.items.map((e, i) => (
                <div key={e.entityId} style={{
                  display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                  padding: "6px 0", borderTop: i ? `1px solid ${T.line}` : "none",
                }}>
                  <input
                    style={{ ...input, flex: "1 1 160px" }}
                    value={e.name}
                    maxLength={60}
                    onChange={(ev) => patch(e.entityId, { name: ev.target.value })}
                    title={`Called "${e.haName || e.name}" in Home Assistant`}
                  />

                  <select
                    style={input}
                    value={e.room || ""}
                    onChange={(ev) => patch(e.entityId, { room: ev.target.value || null })}
                  >
                    <option value="">No room</option>
                    {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>

                  <span style={{ color: T.faint, fontSize: 12, minWidth: 60 }}>
                    {DOMAIN_LABELS[e.domain] || e.domain}
                  </span>
                  <span style={{ color: T.faint, fontSize: 12, minWidth: 48 }}>{e.state}</span>

                  <button style={{ ...btn(false), padding: "4px 8px" }} onClick={() => move(e, -1)}
                          aria-label="Move up" disabled={i === 0}>↑</button>
                  <button style={{ ...btn(false), padding: "4px 8px" }} onClick={() => move(e, 1)}
                          aria-label="Move down" disabled={i === g.items.length - 1}>↓</button>
                  <button style={{ ...btn(false), padding: "4px 8px" }}
                          title="Hide from the Home tab and displays"
                          onClick={() => patch(e.entityId, { hidden: true })}>Hide</button>

                  {e.memberOnly && (
                    <span style={{ color: "#8a5b00", fontSize: 11 }}
                          title="Locks can only be operated by a signed-in member, never from a display">
                      members only
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, alignItems: "center", position: "sticky", bottom: 0, paddingTop: 8 }}>
            <button style={btn(true)} disabled={!dirty || busy === "save"} onClick={save}>
              {busy === "save" ? "Saving…" : "Save arrangement"}
            </button>
            {dirty && <span style={{ color: T.faint, fontSize: 12 }}>Unsaved changes</span>}
            {saved && <span style={{ color: "#1e4620", fontSize: 13 }}>Saved ✓</span>}
          </div>

          <p style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>
            Names and rooms are yours alone — nothing is written back to Home Assistant, so
            renaming here cannot break an automation you have set up there. Hidden devices
            can be brought back by clearing the search and reloading this page after saving.
          </p>
        </>
      )}
    </div>
  );
}
