// main.jsx — entry point and the three things this origin can be.
//
//   /display   a wall tablet running from its permanent link
//   /join      someone claiming an invitation
//   anything   the household app, behind sign-in

import React from "react";
import ReactDOM from "react-dom/client";

import Shell from "./Shell.jsx";
import DisplayApp from "./DisplayApp.jsx";
import JoinPage from "./JoinPage.jsx";
import { hydrateConfig } from "./config.js";
import "./index.css";

function Root() {
  // Path-based rather than a router dependency: there are three routes, and the
  // app is served from both the domain root and behind a prefix such as /beta.
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/display")) return <DisplayApp />;
  if (path.endsWith("/join")) return <JoinPage />;
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
