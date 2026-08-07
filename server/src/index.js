// index.js — process bootstrap: migrate, mount, listen, shut down cleanly.

import express from "express";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORT, HOST, PUBLIC_URL, IS_PROD, BODY_LIMIT, VAULT_LIMIT, TRUST_PROXY,
  clientConfig, startupWarnings,
} from "./config.js";
import { migrate } from "./db/migrate.js";
import { closePool, q } from "./db/pool.js";
import { securityHeaders, csrfGuard, noStore } from "./middleware/security.js";
import { resolveSession } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { startMaintenance } from "./jobs/maintenance.js";

import authRoutes from "./routes/auth.js";
import householdRoutes from "./routes/households.js";
import vaultRoutes from "./routes/vault.js";
import inviteRoutes from "./routes/invites.js";
import aiRoutes from "./routes/ai.js";
import displayRoutes from "./routes/displays.js";
import adminRoutes from "./routes/admin.js";
import calendarRoutes from "./routes/calendars.js";
import proposalRoutes from "./routes/proposals.js";
import homeRoutes from "./routes/home.js";
import privacyRoutes from "./routes/privacy.js";
import integrationRoutes from "./routes/integrations.js";
import { loadDisplay } from "./routes/displays.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "..", "public");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Only trust forwarding headers when an operator has said a proxy is in front.
  // Trusting them unconditionally lets any client spoof its IP and walk past
  // every per-address rate limit in the system.
  if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY === "true" ? 1 : TRUST_PROXY);

  app.use(securityHeaders());
  app.use(cookieParser());

  // The vault gets a larger ceiling than everything else: a household document
  // with years of history is legitimately big, while no other endpoint has any
  // business receiving megabytes.
  app.use("/api/households/:householdId/vault", express.json({ limit: VAULT_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use(csrfGuard);
  app.use(resolveSession);

  // Everything under /api may carry decryptable material or personal data.
  // Registered BEFORE any route so nothing can slip past it -- /api/config was
  // previously defined above this line and shipped with no Cache-Control at all,
  // which security/pentest/run.js caught.
  app.use("/api", noStore);

  app.get("/api/health", (req, res) => res.json({ ok: true, at: Date.now() }));
  app.get("/api/config", (req, res) => res.json(clientConfig()));

  app.use("/api/auth", authRoutes);
  app.use("/api/invites", inviteRoutes);
  app.use("/api/privacy", privacyRoutes);
  app.use("/api/households", householdRoutes);
  app.use("/api/households", vaultRoutes);
  app.use("/api/households", calendarRoutes);
  app.use("/api/households", proposalRoutes);
  app.use("/api/households", displayRoutes.householdRouter);
  app.use("/api/households/:householdId/integrations", integrationRoutes);
  app.use("/api/households/:householdId/home", homeRoutes.memberRouter);
  app.use("/api/display", displayRoutes.publicRouter);
  // The display side of the Home Assistant bridge authenticates with the same
  // permanent token as the rest of /api/display.
  app.use("/api/display/home", loadDisplay, homeRoutes.displayRouter);
  app.use("/api/ai", aiRoutes);
  app.use("/api/admin", adminRoutes);

  app.use("/api", notFoundHandler);

  // Static front-end, when it has been built.
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, {
      index: false,
      maxAge: IS_PROD ? "1h" : 0,
      setHeaders(res, path) {
        // Vite fingerprints its assets, so they are safe to cache hard. The
        // entry HTML must not be, or a client keeps loading old JavaScript
        // against a new API -- and in this app, old crypto code.
        if (/\/assets\//.test(path)) res.set("Cache-Control", "public, max-age=31536000, immutable");
      },
    }));
    // SPA fallback. Explicitly not a wildcard over /api, which is handled above.
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(PUBLIC_DIR, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}

async function main() {
  await migrate();

  for (const w of startupWarnings()) console.warn(`[warn] ${w}`);

  const app = createApp();
  const server = app.listen(PORT, HOST, () => {
    console.log(`HouseHub listening on http://${HOST}:${PORT}  (public: ${PUBLIC_URL})`);
    if (!existsSync(PUBLIC_DIR)) {
      console.log("No built front-end found. Run `npm run build` in web/, or use the Vite dev server.");
    }
  });

  const stopMaintenance = startMaintenance();

  // Finish in-flight requests before exiting. A vault write cut off mid-commit
  // is the one thing a household would actually notice.
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] shutting down`);
    stopMaintenance();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => { console.error("forced exit"); process.exit(1); }, 15000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
