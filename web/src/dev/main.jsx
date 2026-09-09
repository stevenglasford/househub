// main.jsx (sandbox) — renders the household UI with no sign-in.
//
// The real entry (src/main.jsx) routes to Shell, which asks for a password
// before App ever mounts. Here App mounts straight away, on top of the mock
// session, because the point is to look at the UI while changing it.

import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import App from "../App.jsx";
import { hydrateConfig } from "../config.js";
import { resetDoc, isDisplay } from "./mock-session.js";
import "../index.css";

// Deliberately unmissable. A screenshot of the sandbox should never be mistaken
// for a screenshot of the real app -- the data in it is invented.
function SandboxBadge() {
  const [open, setOpen] = useState(false);
  const display = isDisplay();
  return (
    <div style={{
      position: "fixed", bottom: 10, right: 10, zIndex: 99999,
      fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.5,
    }}>
      {open && (
        <div style={{
          background: "#111827", color: "#e5e7eb", padding: "10px 12px",
          borderRadius: 8, marginBottom: 6, maxWidth: 260,
          boxShadow: "0 6px 24px rgba(0,0,0,.35)",
        }}>
          <div style={{ marginBottom: 6 }}>
            Fixture data in localStorage. No server, no login, no encryption.
          </div>
          {/* Signed in vs. shared display, as buttons rather than a console
              call. The two are genuinely different apps -- a display's
              completions are attributable to a screen rather than a person,
              which is what makes them correctable -- and until this was on
              screen the difference could only be tried from a laptop with
              devtools open. On a wall tablet, or on the hosted build, that
              meant it could not be tried at all. */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: "#9ca3af", marginBottom: 5 }}>Signed in as</div>
            <div style={{ display: "flex", gap: 5 }}>
              {[[false, "Ryan", "a member — their own ticks are locked"],
                [true, "Kitchen wall", "a display — ticks are correctable"]].map(([on, label, hint]) => (
                <button key={label} title={hint}
                  onClick={() => window.__hub.display(on)}
                  style={{
                    flex: 1, background: display === on ? "#B45309" : "#374151",
                    color: "#fff", border: 0, borderRadius: 6,
                    padding: "6px 8px", cursor: "pointer", fontSize: 11, fontWeight: 600,
                  }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ color: "#9ca3af", marginTop: 6, lineHeight: 1.45 }}>
              {display
                ? "No signed-in person. Tap a name on a finished row to say who really did it."
                : "Ryan's own completions stand and cannot be reassigned — that is the rule, not a bug."}
            </div>
          </div>

          <div style={{ marginBottom: 8, color: "#9ca3af" }}>
            Console: <code>__hub.doc()</code>, <code>__hub.set(fn)</code>
          </div>
          <button
            onClick={resetDoc}
            style={{
              background: "#374151", color: "#fff", border: 0,
              borderRadius: 6, padding: "5px 9px", cursor: "pointer", width: "100%",
            }}
          >
            Reset to fixture
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "#B45309", color: "#fff", border: 0, borderRadius: 999,
          padding: "5px 11px", cursor: "pointer", fontWeight: 600,
          letterSpacing: ".04em", boxShadow: "0 2px 10px rgba(0,0,0,.25)",
        }}
      >
        SANDBOX{display ? " · DISPLAY" : " · RYAN"}
      </button>
    </div>
  );
}

// Vite re-executes this module on hot update, and a second createRoot() on the
// same container warns and then detaches nodes React still thinks it owns --
// which surfaces as removeChild errors, not as anything resembling the cause.
// Keep one root for the life of the page.
const container = document.getElementById("root");
const root = (window.__hubRoot ||= ReactDOM.createRoot(container));

hydrateConfig().finally(() => {
  root.render(
    // No StrictMode: its double-invoke makes the save/merge path fire twice,
    // which is noise you would spend time chasing in a sandbox.
    <>
      <App />
      <SandboxBadge />
    </>
  );
});
