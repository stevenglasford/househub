import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { hydrateConfig } from "./config.js";
import "./index.css";

// Pull runtime settings from the server before first paint, so components
// never render against stale defaults and then flip.
hydrateConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
