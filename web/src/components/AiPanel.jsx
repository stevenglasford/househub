// AiPanel.jsx — which model this household uses, and what to ask it for.
//
// Two settings that matter more than they look.
//
// THE INSTRUCTIONS. The same app serves platonic flatmates, co-parents, and
// couples who want something considerably more intimate. No default serves all
// three, and guessing would be worse than asking. The household says what it
// wants and the model follows it — within the base rules, which it cannot
// overwrite.
//
// THE PROVIDER. Local is the default and the only setting where "nothing leaves
// this machine" is true. A household may choose Claude, ChatGPT or a remote
// Ollama instead, and if it does, the context for every generated question goes
// to that company. That is a legitimate choice and it is not one to make by
// accident, so it takes a deliberate confirmation and the panel says plainly
// what changes.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";

const PRIVACY = [
  ["minimal", "Nothing", "No detail about your household at all. The question will be generic."],
  ["signals", "Counts only", "\"2 overdue tasks, 1 thing to discuss\" — never the actual titles."],
  ["full", "Titles too", "Includes what the open topics actually are."],
];

const EXAMPLES = [
  "Team-building for platonic housemates who don't know each other well yet",
  "Warm and practical — we're co-parents first",
  "Playful, a bit cheeky, we've been together nine years",
  "Focused on intimacy and sexual discovery between partners",
  "Gentle. One of us is going through a hard time.",
];

export default function AiPanel({ theme: T, data, update }) {
  const [provider, setProvider] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pendingId, setPendingId] = useState(null);

  const checkin = data.checkin || {};
  const [instructions, setInstructions] = useState(checkin.instructions || "");

  const load = useCallback(async () => {
    try { setProvider(await session.aiProvider()); }
    catch (err) { setError(err.message); }
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
    borderRadius: 10, padding: "8px 14px", fontWeight: 600, cursor: "pointer",
  });
  const field = {
    width: "100%", padding: "10px 12px", borderRadius: 10, marginBottom: 8,
    border: `1px solid ${T.line}`, background: T.panel, color: T.ink,
  };

  const saveInstructions = () =>
    update((d) => ({ ...d, checkin: { ...(d.checkin || {}), instructions: instructions.trim() } }));

  const setField = (key, value) =>
    update((d) => ({ ...d, checkin: { ...(d.checkin || {}), [key]: value } }));

  async function choose(id, consent) {
    setBusy("provider"); setError(null);
    try {
      const target = provider.available.find((p) => p.id === id);
      await session.setAiProvider({
        providerId: id,
        model: target?.defaultModel || undefined,
        consent: Boolean(consent),
      });
      setPendingId(null);
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function chooseModel(model) {
    setBusy("model"); setError(null);
    try {
      await session.setAiProvider({
        providerId: provider.providerId, model,
        // Re-asserted, because switching provider clears consent by design.
        consent: !provider.isLocal,
      });
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!provider) return <p style={{ color: T.faint }}>Loading…</p>;

  const pending = pendingId ? provider.available.find((p) => p.id === pendingId) : null;

  return (
    <div>
      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      {/* ------------------------------------------------- instructions --- */}
      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink }}>What should it ask about?</div>
        <p style={{ color: T.faint, fontSize: 13, margin: "4px 0 8px" }}>
          Tell the model what kind of household this is and what you want from the nightly
          question. This steers check-in questions and date-night ideas.
        </p>

        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={saveInstructions}
          rows={3}
          maxLength={1200}
          placeholder="e.g. Team-building for housemates who are still getting to know each other"
          style={{ ...field, resize: "vertical", fontFamily: "inherit" }}
        />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button"
                    onClick={() => { setInstructions(ex); update((d) => ({ ...d, checkin: { ...(d.checkin || {}), instructions: ex } })); }}
                    style={{ ...btn(false), fontSize: 12, padding: "4px 9px" }}>
              {ex.length > 42 ? `${ex.slice(0, 40)}…` : ex}
            </button>
          ))}
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: T.ink, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={(checkin.audience || "shared") === "private"}
            style={{ marginTop: 3 }}
            onChange={(e) => setField("audience", e.target.checked ? "private" : "shared")}
          />
          <span>
            No shared screens see this
            <span style={{ display: "block", color: T.faint, fontSize: 12 }}>
              By default the model is told a question may appear on a wall display and to keep
              it suitable for that. Tick this if nobody but the household will ever see it —
              which matters if you have asked for something intimate.
            </span>
          </span>
        </label>
      </div>

      {/* ---------------------------------------------------- context ---- */}
      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>How much to share with it</div>
        {PRIVACY.map(([id, label, hint]) => (
          <label key={id} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, cursor: "pointer" }}>
            <input type="radio" name="aiPrivacy" checked={(checkin.aiPrivacy || "signals") === id}
                   style={{ marginTop: 3 }} onChange={() => setField("aiPrivacy", id)} />
            <span>
              <span style={{ fontWeight: 600, color: T.ink, fontSize: 14 }}>{label}</span>
              <span style={{ display: "block", color: T.faint, fontSize: 12 }}>{hint}</span>
            </span>
          </label>
        ))}
      </div>

      {/* --------------------------------------------------- provider ---- */}
      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink }}>Which model</div>

        <div style={{
          margin: "8px 0", padding: 10, borderRadius: 8, fontSize: 13,
          background: provider.isLocal ? "#eef4ee" : "#fff6e5",
          border: `1px solid ${provider.isLocal ? "#bcd4bc" : "#e0c184"}`,
          color: provider.isLocal ? "#1e4620" : "#6b4708",
        }}>
          <strong>{provider.label}</strong>
          <span style={{ display: "block", marginTop: 2 }}>{provider.privacy}</span>
        </div>

        {provider.blocked === "consent_required" && (
          <div style={{ ...card, background: "#fff6e5", borderColor: "#e0c184", color: "#6b4708" }}>
            You selected <strong>{provider.selectedLabel}</strong> but nobody has confirmed that
            context may leave this machine, so the local model is being used instead.
            Choose it again below to confirm.
          </div>
        )}

        {provider.available.map((p) => {
          const current = p.id === provider.providerId;
          return (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", flexWrap: "wrap" }}>
              <div>
                <span style={{ fontWeight: current ? 700 : 500, color: T.ink }}>{p.label}</span>
                <span style={{ color: p.isLocal ? "#1e4620" : "#8a5b00", fontSize: 12, marginLeft: 8 }}>
                  {p.isLocal ? "on your hardware" : "leaves your network"}
                </span>
              </div>
              {!current && (
                <button style={btn(false)} disabled={busy === "provider"}
                        onClick={() => (p.isLocal ? choose(p.id, false) : setPendingId(p.id))}>
                  Use this
                </button>
              )}
            </div>
          );
        })}

        {/* The confirmation. Deliberately unmissable: this is the moment a
            household stops being end-to-end private about its check-ins. */}
        {pending && (
          <div style={{ ...card, marginTop: 8, background: "#fdecea", borderColor: "#f0b4ae" }}>
            <div style={{ fontWeight: 700, color: "#7a1c12", marginBottom: 6 }}>
              This sends your household's context to {pending.label}
            </div>
            <p style={{ fontSize: 13, color: "#7a1c12", marginBottom: 8 }}>
              Everything else in HouseHub stays encrypted with a key this server does not
              have. This is the exception: to write tonight's question, a summary of your
              day — how many things are overdue, how many topics are waiting, and your
              instructions above — is sent to a company outside your home, under their terms
              and their retention policy, not ours.
              <span style={{ display: "block", marginTop: 6 }}>
                If you chose "Counts only" above, that is all that goes. If you chose
                "Titles too", the titles go with it.
              </span>
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={btn(false, true)} disabled={busy === "provider"} onClick={() => choose(pending.id, true)}>
                I understand — use {pending.label}
              </button>
              <button style={btn(false)} onClick={() => setPendingId(null)}>Keep it local</button>
            </div>
          </div>
        )}

        {provider.models?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 12, color: T.faint }}>Model</label>
            <select
              value={provider.model || ""}
              disabled={busy === "model"}
              onChange={(e) => chooseModel(e.target.value)}
              style={{ ...field, marginBottom: 0 }}
            >
              {!provider.models.includes(provider.model) && provider.model && (
                <option value={provider.model}>{provider.model}</option>
              )}
              {provider.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}

        <p style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>
          A super admin adds providers under Server → Advanced. Offering one does not send
          anybody's data anywhere; each household chooses for itself.
        </p>
      </div>
    </div>
  );
}
