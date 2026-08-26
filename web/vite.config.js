import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Sandbox mode — the app with no server, no login and no encryption.
 *
 * lib/session.js is the single module that talks to the network and holds keys,
 * so swapping exactly it for a fixture-backed stand-in leaves everything above
 * it -- api.js, App.jsx, every component and lib/* -- running as the real code
 * under hot reload. Redirecting at resolve time rather than with an alias keeps
 * it precise: only the real src/lib/session.js is intercepted, whatever
 * relative path a given importer used to reach it.
 *
 * Active only under `--mode sandbox`, so `npm run dev` and `npm run build` are
 * untouched and the mock can never reach a production bundle.
 */
const SANDBOX_SWAPS = {
  // The network and key-holding layer.
  "src/lib/session.js": "src/dev/mock-session.js",
  // crypto.js throws at import time when Web Crypto is absent, which it is on
  // any plain-http LAN address -- so on a phone or another machine the page
  // went blank before React mounted. Two settings panels import it directly,
  // so swapping session.js alone did not take it out of the graph.
  "src/lib/crypto.js": "src/dev/mock-crypto.js",
};

const sandboxSession = () => ({
  name: "househub-sandbox-session",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !/\.js$/.test(source)) return null;
    const target = resolve(dirname(importer), source);
    for (const [real, mock] of Object.entries(SANDBOX_SWAPS)) {
      if (target === resolve(here, real)) return resolve(here, mock);
    }
    return null;
  },
});

// Builds straight into ../server/public, which the Express server serves.
// In dev, `npm run dev` proxies /api to the backend on :4000.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "sandbox" ? [sandboxSession()] : [])],
  base: "./", // relative asset URLs, so the build works at / or behind /hub/
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    // A different port from the real dev server, so both can run at once.
    port: mode === "sandbox" ? 5174 : 5173,
    proxy: {
      "/api": {
        target: process.env.API_TARGET || "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
}));
