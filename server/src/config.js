// config.js — every knob, resolved from the environment in one place.
//
// Two of these are load-bearing for security and the server refuses to start
// without them in production: SECRET_KEY (seals what the server must hold) and
// DATABASE_URL. Everything else has a defensible default so that `docker
// compose up` produces a working, private hub with no editing.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

const env = process.env;
const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const NODE_ENV = env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";

export const PORT = int(env.PORT, 4000);
export const HOST = env.HOST || "127.0.0.1";

// Public origin. Used for cookie scoping, CSRF origin checks, and the links
// printed into display setup QR codes -- so it must be the URL users actually
// type, including any reverse-proxy path prefix.
export const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/**
 * The path the app is mounted at, derived from PUBLIC_URL.
 *
 * Deploying under a prefix -- https://home.example.com/beta -- means the
 * session cookie must be scoped to that prefix. Left at "/" it would be sent to
 * every other application on the same hostname, which on a home server is
 * usually several. Scoping it is the difference between "my hub's cookie" and
 * "a credential my whole domain can see".
 */
export const BASE_PATH = (() => {
  try {
    const p = new URL(PUBLIC_URL).pathname.replace(/\/+$/, "");
    return p || "/";
  } catch {
    return "/";
  }
})();
export const COOKIE_PATH = BASE_PATH === "/" ? "/" : `${BASE_PATH}/`;

export const DATABASE_URL = env.DATABASE_URL || "postgres://househub:househub@localhost:5432/househub";
export const DB_POOL_MAX = int(env.DB_POOL_MAX, 10);
export const DB_SSL = bool(env.DB_SSL, false);

/* ------------------------------------------------------------ secret key ---
 * One 32-byte root secret. Every server-side key is derived from it by HKDF
 * with a distinct label, so there is exactly one thing to back up and exactly
 * one thing to protect. It is NOT sufficient to read household content -- that
 * needs a member's password -- but it does seal emails, TOTP secrets, calendar
 * URLs and wallet configuration.
 *
 * In development we generate and persist one automatically, because a hub that
 * won't boot until you read the docs is a hub nobody evaluates. In production
 * that convenience is refused: an operator who never set a key would otherwise
 * ship a server whose secret sits in a world-readable file beside the data.
 */
function loadSecretKey() {
  if (env.SECRET_KEY) {
    const raw = Buffer.from(env.SECRET_KEY, "base64");
    if (raw.length < 32) throw new Error("SECRET_KEY must decode to at least 32 bytes of base64");
    return raw;
  }
  if (env.SECRET_KEY_FILE) {
    const raw = Buffer.from(readFileSync(env.SECRET_KEY_FILE, "utf8").trim(), "base64");
    if (raw.length < 32) throw new Error("SECRET_KEY_FILE must contain at least 32 bytes of base64");
    return raw;
  }
  if (IS_PROD) {
    throw new Error(
      "SECRET_KEY is required in production. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      "and set SECRET_KEY, or point SECRET_KEY_FILE at a file containing it.\n" +
      "Losing this key makes sealed server-side values unrecoverable -- back it up."
    );
  }
  const path = resolve(env.SECRET_KEY_PATH || "./.secret-key");
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on odd filesystems */ }
  console.warn(`[config] development SECRET_KEY generated at ${path}`);
  return key;
}
export const SECRET_KEY = loadSecretKey();

/* ------------------------------------------------------------------ auth --- */
export const SESSION_TTL_HOURS = int(env.SESSION_TTL_HOURS, 24 * 14);
export const SESSION_IDLE_HOURS = int(env.SESSION_IDLE_HOURS, 24 * 7);
export const MAX_FAILED_LOGINS = int(env.MAX_FAILED_LOGINS, 8);
export const LOCKOUT_MINUTES = int(env.LOCKOUT_MINUTES, 15);
export const ALLOW_SIGNUP = bool(env.ALLOW_SIGNUP, true);
// Argon2id verifier parameters. 64 MiB / t=3 is the OWASP baseline.
export const ARGON_MEMORY_KIB = int(env.ARGON_MEMORY_KIB, 65536);
export const ARGON_TIME = int(env.ARGON_TIME, 3);
export const ARGON_PARALLELISM = int(env.ARGON_PARALLELISM, 1);
// Client-side stretching. Raising this only affects accounts created afterwards.
export const CLIENT_KDF_ITERATIONS = int(env.CLIENT_KDF_ITERATIONS, 650000);

/* -------------------------------------------------------------------- ai ---
 * Inference is local, always. There is no remote-provider branch in this
 * codebase by design: adding one would mean household context leaving the
 * machine, which is the single thing the whole architecture exists to prevent.
 */
export const OLLAMA_URL = (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
export const OLLAMA_MODEL = env.OLLAMA_MODEL || "qwen3:14b";
// Generous, because the *first* call after a model is evicted from memory pays
// the load cost -- measured at 16-29s for a 14B model on a warm SSD, and worse
// for a 30B. Subsequent calls are well under a second. OLLAMA_KEEP_WARM below
// is what stops the nightly check-in being the request that pays it.
export const OLLAMA_TIMEOUT_MS = int(env.OLLAMA_TIMEOUT_MS, 120000);
// Ollama unloads an idle model after ~5 minutes. Pinging it periodically keeps
// the wall display's check-in instant at the cost of holding VRAM.
export const OLLAMA_KEEP_WARM = bool(env.OLLAMA_KEEP_WARM, true);
export const OLLAMA_KEEP_ALIVE = env.OLLAMA_KEEP_ALIVE || "15m";
export const AI_ENABLED = bool(env.AI_ENABLED, true);
// Per-household generations per hour. Ollama is a shared, slow resource; one
// household must not be able to starve the rest.
export const AI_RATE_PER_HOUR = int(env.AI_RATE_PER_HOUR, 60);

/* --------------------------------------------------------------- limits ---- */
export const BODY_LIMIT = env.BODY_LIMIT || "4mb";
export const VAULT_LIMIT = env.VAULT_LIMIT || "16mb";
export const REFRESH_MINUTES = int(env.REFRESH_MINUTES, 15);
export const VAULT_REVISIONS_KEPT = int(env.VAULT_REVISIONS_KEPT, 50);
// How long a household with no active members is kept before being removed.
// Its vault is already unreadable at that point -- the last key went with the
// last member -- but the delay covers an accidental account deletion.
export const ORPHAN_GRACE_DAYS = int(env.ORPHAN_GRACE_DAYS, 30);

/* -------------------------------------------------------------- upgrades --- */
export const UPGRADES_ENABLED = bool(env.UPGRADES_ENABLED, false);
export const UPGRADE_REPO_URL = env.UPGRADE_REPO_URL || "https://github.com/stevenglasford/househub";
export const UPGRADE_WORK_DIR = env.UPGRADE_WORK_DIR || "/var/lib/househub/upgrades";
export const UPGRADE_BASE_BRANCH = env.UPGRADE_BASE_BRANCH || "main";
export const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
export const GITHUB_TOKEN = env.GITHUB_TOKEN || "";
// Pushing straight to the base branch is possible and switched off. An AI-authored
// change should be a pull request a human reads, not a deploy nobody saw.
export const UPGRADE_DIRECT_PUSH = bool(env.UPGRADE_DIRECT_PUSH, false);
export const UPGRADE_MAX_ZIP_MB = int(env.UPGRADE_MAX_ZIP_MB, 50);
export const UPGRADE_TIMEOUT_MS = int(env.UPGRADE_TIMEOUT_MS, 30 * 60 * 1000);

/* ------------------------------------------------------------ home assist --
 * Home Assistant is configured per household in the app, not here. It used to
 * be HA_URL/HA_TOKEN environment variables, which on a server hosting more than
 * one family showed all of them the same house. See migrations/007.
 *
 * These two remain only so an existing single-household install is told where
 * its settings went rather than silently losing its Home tab.
 */
export const LEGACY_HA_URL = env.HA_URL || "";
export const LEGACY_HA_TOKEN = env.HA_TOKEN || "";

/* ---------------------------------------------------------------- billing -- */
export const BILLING_ENABLED = bool(env.BILLING_ENABLED, false);
export const PRICE_FEED_URL = env.PRICE_FEED_URL || "";
export const INVOICE_TTL_MINUTES = int(env.INVOICE_TTL_MINUTES, 60);

/* ---------------------------------------------------------------- trust ----
 * Set TRUST_PROXY when running behind Caddy/nginx so rate limiting sees the
 * real client address. Left off by default: trusting X-Forwarded-For without a
 * proxy in front lets anyone spoof their way past every per-IP limit.
 */
export const TRUST_PROXY = env.TRUST_PROXY || "";

export function clientConfig() {
  return {
    publicUrl: PUBLIC_URL,
    allowSignup: ALLOW_SIGNUP,
    aiEnabled: AI_ENABLED,
    aiModel: OLLAMA_MODEL,
    billingEnabled: BILLING_ENABLED,
    kdfIterations: CLIENT_KDF_ITERATIONS,
    // Whether Home Assistant is connected is now a per-household fact,
    // answered by GET /api/households/:id/home.
    homeAssistant: "per-household",
  };
}

// Surfaced at boot so misconfiguration is loud rather than silently insecure.
export function startupWarnings() {
  const w = [];
  if (IS_PROD && PUBLIC_URL.startsWith("http://"))
    w.push("PUBLIC_URL is http:// in production -- session cookies will not be marked Secure.");
  if (IS_PROD && HOST === "0.0.0.0" && !TRUST_PROXY)
    w.push("Binding 0.0.0.0 without TRUST_PROXY: put a TLS terminating proxy in front.");
  if (UPGRADES_ENABLED && !GITHUB_TOKEN)
    w.push("UPGRADES_ENABLED without GITHUB_TOKEN: jobs will build and verify but cannot open a PR.");
  if (UPGRADES_ENABLED && UPGRADE_DIRECT_PUSH)
    w.push("UPGRADE_DIRECT_PUSH is on: AI-authored changes will land on the base branch unreviewed.");
  if (LEGACY_HA_URL || LEGACY_HA_TOKEN)
    w.push("HA_URL/HA_TOKEN are no longer used. Connect Home Assistant per household in " +
           "Settings -> Home; a server-wide token showed every household the same house.");
  if (BILLING_ENABLED && !PRICE_FEED_URL)
    w.push("BILLING_ENABLED without PRICE_FEED_URL: invoices need a manually supplied exchange rate.");
  return w;
}
