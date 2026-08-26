// main.jsx (sandbox) — renders the household UI with no sign-in.
//
// The real entry (src/main.jsx) routes to Shell, which asks for a password
// before App ever mounts. Here App mounts straight away, on top of the mock
// session, because the point is to look at the UI while changing it.

import React, { useState } from "react";
import ReactDOM from "react-dom/client";

import App from "../App.jsx";
import { hydrateConfig } from "../config.js";
import { resetDoc } from "./mock-session.js";
import "../index.css";

// Deliberately unmissable. A screenshot of the sandbox should never be mistaken
// for a screenshot of the real app -- the data in it is invented.
function SandboxBadge() {
  const [open, setOpen] = useState(false);
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
        SANDBOX
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
