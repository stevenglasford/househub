// security.js — transport and browser-level hardening.
//
// The end-to-end encryption in web/src/lib/crypto.js is only as good as the
// JavaScript that runs it. An attacker who can inject a script into this origin
// reads plaintext straight out of memory, and no amount of ciphertext at rest
// helps. So the Content-Security-Policy here is not boilerplate -- it is the
// control protecting the key material.

import helmet from "helmet";
import { IS_PROD, PUBLIC_URL } from "../config.js";
import { forbidden } from "./errors.js";

/**
 * Weather comes from Open-Meteo, fetched by the *browser* rather than proxied.
 * That is deliberate: proxying would tell this server where the household
 * lives, and the whole point is that it does not know. The trade is that
 * Open-Meteo and any network observer see an approximate location.
 * Set WEATHER_PROXY=1 to reverse that choice -- see docs/THREAT-MODEL.md.
 */
const WEATHER_HOSTS = ["https://api.open-meteo.com", "https://geocoding-api.open-meteo.com"];

/**
 * Hosts a household may send phone reminders to, e.g. their own ntfy instance.
 *
 * Opt-in, empty by default, and set by the operator rather than by a household,
 * because connect-src is a property of the origin and not of one document. A
 * household cannot widen this by editing anything it controls.
 *
 * Understand what it costs before setting it. connect-src is part of what stops
 * injected script from posting key material somewhere useful to an attacker;
 * every host added here is one more place it could post to. Name the exact
 * origin -- "https://ntfy.example.com", never a wildcard -- and prefer one you
 * run. See docs/REMINDERS.md.
 */
const PUSH_HOSTS = (process.env.PUSH_HOSTS || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((s) => {
    // A wildcard here would undo the point of the directive, so refuse it
    // loudly at boot instead of silently accepting a policy nobody intended.
    if (s === "*" || s.includes("*")) {
      console.warn(`[security] ignoring wildcard PUSH_HOSTS entry ${JSON.stringify(s)}`);
      return false;
    }
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" && u.hostname !== "localhost" && !u.hostname.startsWith("127.")) {
        console.warn(`[security] ignoring non-https PUSH_HOSTS entry ${JSON.stringify(s)}`);
        return false;
      }
      return true;
    } catch {
      console.warn(`[security] ignoring unparseable PUSH_HOSTS entry ${JSON.stringify(s)}`);
      return false;
    }
  });

export function securityHeaders() {
  const connectSrc = [
    "'self'",
    ...(process.env.WEATHER_PROXY ? [] : WEATHER_HOSTS),
    ...PUSH_HOSTS,
  ];

  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-eval', no CDN, no inline script. Vite emits external
        // bundles, so nothing here needs relaxing -- and any future dependency
        // that demands eval should be rejected rather than accommodated.
        scriptSrc: ["'self'"],
        // React writes inline style attributes for dynamic colours and layout.
        // Confined to style, which cannot execute.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc,
        mediaSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],       // no embedding: blocks clickjacking
        frameSrc: ["'none'"],
        baseUri: ["'self'"],              // stops <base> hijacking relative URLs
        formAction: ["'self'"],
        ...(IS_PROD && PUBLIC_URL.startsWith("https://") ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // Cross-origin isolation. Also what makes the referrer policy below stick.
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: IS_PROD ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
    // The default is fine but stated explicitly: these are the ones that matter.
    noSniff: true,
    frameguard: { action: "deny" },
    xssFilter: false,   // the legacy XSS auditor is deprecated and can introduce bugs
  });
}

/**
 * Origin check for anything that changes state.
 *
 * Session cookies are SameSite=Strict, which already blocks classic CSRF. This
 * is the second lock: SameSite has had bypasses, and browsers on a wall tablet
 * are frequently several years old.
 */
export function csrfGuard(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  // Requests authenticated by a bearer header cannot be forged cross-site --
  // a browser will not attach that header on its own.
  if (req.get("authorization")) return next();

  const origin = req.get("origin");
  const referer = req.get("referer");
  const source = origin || referer;

  if (!source) {
    // No Origin and no Referer on a state-changing request. Legitimate browsers
    // send at least one; tooling that does not can authenticate with a header.
    return next(forbidden("Missing Origin header on a state-changing request"));
  }

  let sourceOrigin;
  try { sourceOrigin = new URL(source).origin; } catch { return next(forbidden("Malformed Origin")); }

  const allowed = new Set([new URL(PUBLIC_URL).origin]);
  if (!IS_PROD) {
    allowed.add("http://localhost:5173");   // Vite dev server
    allowed.add("http://127.0.0.1:5173");
  }
  if (!allowed.has(sourceOrigin)) {
    return next(forbidden("Cross-origin request rejected"));
  }
  next();
}

/**
 * Marks responses that carry decryptable material or personal data as
 * uncacheable, so a shared wall tablet's browser cache and any intermediate
 * proxy do not retain them.
 */
export function noStore(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  next();
}
