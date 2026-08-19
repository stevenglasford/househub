// DisplayApp.jsx — the always-on screen by the door.
//
// This runs on a tablet nobody signs into. It bootstraps from its permanent
// link, unwraps the household key with the device key held in the URL fragment,
// and renders only the panels the admins granted.
//
// The scope filtering here is honest about what it is: a renderer that draws
// less than it holds. The server cannot redact a ciphertext it cannot read, so
// this display *has* the whole document even when it shows three panels of it.
// What the scopes buy is that a passer-by cannot navigate to the rest, and what
// actually protects the household if the tablet is stolen is revocation plus a
// key rotation. docs/THREAT-MODEL.md says so in as many words.

import React, { useEffect, useState, useCallback, useRef } from "react";
import App from "./App.jsx";
import * as session from "./lib/session.js";

function Message({ title, detail, action }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 p-8">
      <div className="max-w-md text-center text-slate-300">
        <h1 className="text-2xl font-semibold mb-2 text-slate-100">{title}</h1>
        {detail && <p className="text-sm text-slate-400 whitespace-pre-line">{detail}</p>}
        {action}
      </div>
    </div>
  );
}

export default function DisplayApp() {
  const [state, setState] = useState({ status: "starting" });
  const started = useRef(false);

  const boot = useCallback(async () => {
    // The fragment carries `<token>.<privateKey>`. Fragments are never sent in
    // an HTTP request, so the private half reaches this tablet without ever
    // passing through the server or its access logs.
    const fragment = window.location.hash.slice(1);
    const [token, privateKeyB64] = fragment.split(".");

    // Strip it immediately: a setup link left in the address bar is a key
    // sitting on a screen in a hallway.
    if (fragment) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    try {
      const stored = localStorage.getItem("hh.display.v1");
      const knownToken = stored ? JSON.parse(stored).token : null;
      const boot = await session.startDisplay({
        token: token || knownToken,
        privateKeyB64: privateKeyB64 || null,
      });
      setState({ status: "ready", boot });
    } catch (err) {
      setState({ status: "error", error: err.message });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;   // StrictMode double-invoke would re-provision
    started.current = true;
    boot();
  }, [boot]);

  // A wall tablet runs for months. Re-bootstrap periodically so that a key
  // rotation or a revocation takes effect without anyone walking over to it.
  useEffect(() => {
    if (state.status !== "ready") return;
    const timer = setInterval(async () => {
      try {
        await session.request("GET", "api/display/version");
      } catch (err) {
        // 403/404 means revoked or expired. Show it rather than displaying a
        // household's life on a screen that is no longer authorised.
        if (err.status === 403 || err.status === 404) {
          setState({ status: "error", error: err.message || "This display is no longer authorised." });
        }
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [state.status]);

  if (state.status === "starting") {
    return <Message title="Starting up…" />;
  }

  if (state.status === "error") {
    return (
      <Message
        title="This display is not available"
        detail={`${state.error}\n\nAn admin can issue a new display link from Settings.`}
        action={
          <button
            onClick={() => { session.forgetDisplay(); window.location.reload(); }}
            className="mt-4 text-sm underline text-slate-400 hover:text-slate-200"
          >
            Forget this device
          </button>
        }
      />
    );
  }

  // App reads the household through the same api.js seam as a signed-in member;
  // session.js routes its requests to the display endpoints instead.
  /* App reads the display's scopes and name from the session rather than from
     props -- it takes none. Passing them here looked like it configured
     something and configured nothing, which is how the scope filtering came to
     be documented but never implemented. */
  return <App />;
}
