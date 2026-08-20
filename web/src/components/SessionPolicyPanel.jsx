// SessionPolicyPanel.jsx — whether this account may stay signed in, and for how long.
//
// The setting lives with the account rather than the server because the answer
// depends entirely on the device somebody is sitting at, and nobody else in the
// household is placed to judge that for them.
//
// The wording is deliberately concrete about what staying signed in means. It
// is not "keep me logged in" in the ordinary sense: the browser keeps a key
// that opens the household, which is a different proposition from a session
// cookie and people deserve to be told so before they choose.

import React, { useState, useEffect, useCallback } from "react";
import * as session from "../lib/session.js";
import ActionButton from "./ActionButton.jsx";

const CHOICES = [
  [24, "A day"],
  [168, "A week"],
  [720, "A month"],
  [8760, "A year"],
  [0, "Until I sign out"],
];

export default function SessionPolicyPanel({ theme: T }) {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try { setPolicy(await session.getSessionPolicy()); }
    catch (err) { setError(err.message); setPolicy({ enabled: false, hours: null, rememberedDevices: 0 }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const card = {
    background: T.panelAlt, border: `1px solid ${T.line}`,
    borderRadius: 12, padding: 12, marginBottom: 8,
  };
  const pill = (on) => ({
    background: on ? T.brand : T.panel, color: on ? "#fff" : T.sub,
    border: `1px solid ${on ? T.brand : T.line}`, borderRadius: 999,
    padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  });

  /* The duration pills are selection chips -- a spinner on one would be noise --
     so unlike the ActionButtons below, this catches and shows the failure
     itself. What it must not do is fail silently: the pill would appear to
     move while the account's actual policy had not changed. */
  async function choose(hours) {
    setError(null);
    try {
      const res = await session.setSessionPolicy(hours);
      await refresh();
      return res;
    } catch (err) {
      setError(err.message);
      await refresh();          // put the pills back to what the server really has
      throw err;                // ActionButton callers still get their failure
    }
  }

  if (!policy) return <p style={{ color: T.faint, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      <p style={{ color: T.faint, fontSize: 13, marginBottom: 10 }}>
        When this is on, ticking <em>Keep me signed in</em> lets a device come back without
        your password.
      </p>

      <div style={{ ...card, background: "#fff6e5", borderColor: "#f0d9a8" }}>
        <div style={{ color: "#6b4708", fontSize: 12.5, lineHeight: 1.5 }}>
          <strong>What that means.</strong> The browser keeps a key that can open your
          household — that is the only way it could show you anything without asking for
          your password again. Anyone who can use that device can read the household, and
          so could a script that got into the page. Nothing extra is stored on the server;
          this is entirely about the device in your hands.
        </div>
      </div>

      {error && (
        <div role="alert" style={{ ...card, background: "#fdecea", borderColor: "#f0b4ae", color: "#7a1c12" }}>
          {error}
        </div>
      )}

      <div style={card}>
        <div style={{ fontWeight: 600, color: T.ink, marginBottom: 8 }}>
          {policy.enabled ? "Devices stay signed in for" : "Staying signed in is off"}
        </div>

        {policy.enabled && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {CHOICES.map(([hours, label]) => (
              <button key={hours} style={pill(policy.hours === hours)}
                onClick={() => { choose(hours).catch(() => {}); }}>
                {label}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          {policy.enabled ? (
            <ActionButton
              theme={T} variant="danger" onClick={() => choose(null)}
              busyLabel="Turning off…" doneLabel="Turned off"
              confirm={
                policy.rememberedDevices
                  ? `Turn this off and sign out ${policy.rememberedDevices} remembered device(s)?\n\n`
                    + "You will stay signed in here."
                  : null
              }
            >
              Turn off, and forget every device
            </ActionButton>
          ) : (
            <ActionButton theme={T} variant="primary" onClick={() => choose(168)}
              busyLabel="Turning on…" doneLabel="On — a week">
              Allow staying signed in
            </ActionButton>
          )}
        </div>

        <div style={{ color: T.faint, fontSize: 12.5, marginTop: 8 }}>
          {policy.rememberedDevices > 0
            ? `${policy.rememberedDevices} device${policy.rememberedDevices === 1 ? "" : "s"} currently remembered.`
            : "No devices are currently remembered."}
          {policy.enabled && policy.hours === 0 && " These sessions do not expire on their own."}
        </div>
      </div>
    </div>
  );
}
