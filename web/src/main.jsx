// main.jsx — entry point and the three things this origin can be.
//
//   /display   a wall tablet running from its permanent link
//   /join      someone claiming an invitation
//   anything   the household app, behind sign-in

import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";

import Shell from "./Shell.jsx";
import DisplayApp from "./DisplayApp.jsx";
import * as session from "./lib/session.js";
import { hydrateConfig } from "./config.js";
import "./index.css";

/* ------------------------------------------------------------------ join --- */

function Join() {
  // The invite token arrives in the fragment, so it stays out of the server's
  // access log -- only the explicit POST below ever carries it.
  const [token] = useState(() => {
    const t = window.location.hash.slice(1);
    if (t) history.replaceState(null, "", window.location.pathname);
    return t;
  });
  const [stage, setStage] = useState(token ? "check" : "missing");
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;
    session.request("POST", "api/invites/inspect", { token })
      .then((inv) => { setInvite(inv); setStage("ready"); })
      .catch((err) => { setError(err.message); setStage("error"); });
  }, [token]);

  async function accept() {
    setStage("working");
    try {
      const res = await session.request("POST", "api/invites/accept", { token });
      setInvite((prev) => ({ ...prev, ...res }));
      setStage("pending");
    } catch (err) {
      setError(err.status === 401
        ? "Sign in or create an account first, then open this link again."
        : err.message);
      setStage("error");
    }
  }

  const wrap = (children) => (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm bg-slate-800 rounded-2xl shadow-xl p-6 text-slate-100">{children}</div>
    </div>
  );

  if (stage === "missing") return wrap(<p>This link is incomplete. Ask for a new invitation.</p>);
  if (stage === "check" || stage === "working") return wrap(<p className="text-slate-400">One moment…</p>);

  if (stage === "error") return wrap(
    <>
      <h1 className="text-lg font-semibold mb-2">That did not work</h1>
      <p className="text-sm text-rose-300">{error}</p>
      <a href="/" className="block mt-4 text-sm underline text-slate-400">Go to HouseHub</a>
    </>
  );

  if (stage === "pending") return wrap(
    <>
      <h1 className="text-lg font-semibold mb-2">Almost there</h1>
      <p className="text-sm text-slate-400">
        An admin of the household needs to approve you before you can see anything.
        If you can, check your key fingerprint with them in person — that is what
        stops anyone in the middle substituting their own.
      </p>
      <a href="/" className="block mt-4 text-sm underline text-slate-400">Go to HouseHub</a>
    </>
  );

  return wrap(
    <>
      <h1 className="text-lg font-semibold mb-1">You have been invited</h1>
      <p className="text-sm text-slate-400 mb-5">
        You would join as <strong className="text-slate-200">{invite.role}</strong>.
        Nothing about the household is shown until an admin grants you a key.
      </p>
      <button onClick={accept}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 font-medium">
        Accept invitation
      </button>
    </>
  );
}

/* ----------------------------------------------------------------- route --- */

function Root() {
  // Path-based rather than a router dependency: there are three routes, and the
  // app is served from both the domain root and behind a proxy prefix.
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/display")) return <DisplayApp />;
  if (path.endsWith("/join")) return <Join />;
  return <Shell />;
}

// Runtime settings first, so nothing renders against stale defaults and flips.
hydrateConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
});
