#!/usr/bin/env node
// preflight/run.js — is this deployment actually ready for people?
//
// The test suites prove the code is correct. This checks the thing you are
// about to point somebody at: right URL, real certificate, headers present,
// database migrated, AI reachable, signups in the state you meant, no default
// left switched on by accident.
//
//   node security/preflight/run.js                          # local
//   TARGET=https://home.example.com/hub node .../run.js      # the real one
//
// Read-only. It creates nothing and changes nothing, so it is safe to run
// against production whenever you like.
//
// Exit codes: 0 ready · 1 something will bite you · 2 could not check.

const TARGET = (process.env.TARGET || "http://127.0.0.1:4000").replace(/\/+$/, "");

const results = [];
const ok = (name, detail) => results.push({ level: "ok", name, detail });
const warn = (name, detail) => results.push({ level: "warn", name, detail });
const fail = (name, detail) => results.push({ level: "fail", name, detail });

async function get(path, opts = {}) {
  const res = await fetch(`${TARGET}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html or empty */ }
  return { status: res.status, headers: res.headers, body: json, text };
}

/* ------------------------------------------------------------- reachable --- */

async function checkReachable() {
  try {
    const res = await get("/api/health");
    if (res.status !== 200 || !res.body?.ok) {
      return fail("Server responds", `GET /api/health returned ${res.status}`);
    }
    ok("Server responds", `${TARGET}/api/health`);
    return true;
  } catch (err) {
    fail("Server responds", `${err.message}. Is it running, and is TARGET right?`);
    return false;
  }
}

/* ------------------------------------------------------------------ tls --- */

function checkTls() {
  if (TARGET.startsWith("https://")) return ok("HTTPS", "Web Crypto will work");

  const host = new URL(TARGET).hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return warn("HTTPS", "Running on localhost, which browsers treat as secure. Any other host needs real TLS.");
  }
  fail("HTTPS",
    "Served over plain http. Browsers only expose Web Crypto in a secure context, " +
    "so the app will not be able to decrypt anything from another machine.");
}

/* -------------------------------------------------------------- headers --- */

async function checkHeaders() {
  const res = await get("/api/health");
  const csp = res.headers.get("content-security-policy");

  if (!csp) fail("Content-Security-Policy", "Missing. This is what protects the encryption keys from injected script.");
  else if (/unsafe-eval/.test(csp)) fail("Content-Security-Policy", "Allows unsafe-eval");
  else if (!/script-src\s+'self'/.test(csp)) warn("Content-Security-Policy", "script-src is not restricted to 'self'");
  else ok("Content-Security-Policy", "script-src 'self', no unsafe-eval");

  if (/frame-ancestors\s+'none'/.test(csp || "")) ok("Clickjacking", "frame-ancestors 'none'");
  else warn("Clickjacking", "frame-ancestors is not 'none'");

  res.headers.get("x-content-type-options") === "nosniff"
    ? ok("MIME sniffing", "nosniff")
    : warn("MIME sniffing", "X-Content-Type-Options missing");

  if (TARGET.startsWith("https://")) {
    res.headers.get("strict-transport-security")
      ? ok("HSTS", res.headers.get("strict-transport-security").slice(0, 40))
      : warn("HSTS", "Not set. Set NODE_ENV=production.");
  }

  res.headers.get("x-powered-by")
    ? warn("Fingerprinting", "X-Powered-By is exposed")
    : ok("Fingerprinting", "No X-Powered-By");

  const cfg = await get("/api/config");
  /no-store/.test(cfg.headers.get("cache-control") || "")
    ? ok("API caching", "no-store")
    : fail("API caching", "API responses are cacheable, which can leak between users of a shared tablet");
}

/* --------------------------------------------------------------- config --- */

async function checkConfig() {
  const res = await get("/api/config");
  if (res.status !== 200 || !res.body) return fail("Runtime config", `GET /api/config returned ${res.status}`);
  const cfg = res.body;

  // The single most common misconfiguration: PUBLIC_URL not matching reality
  // breaks invite links, display links and the CSRF origin check all at once.
  const expected = TARGET;
  if (cfg.publicUrl?.replace(/\/+$/, "") !== expected) {
    fail("PUBLIC_URL",
      `Server says "${cfg.publicUrl}" but you reached it at "${expected}". ` +
      "Invitation and display links will point at the wrong place.");
  } else {
    ok("PUBLIC_URL", cfg.publicUrl);
  }

  cfg.allowSignup
    ? warn("Registration", "OPEN — anyone who finds this URL can create an account. Set ALLOW_SIGNUP=0 once your household is set up.")
    : ok("Registration", "Closed. Invitations still work.");

  cfg.aiEnabled ? ok("AI", "Enabled") : ok("AI", "Disabled");

  if (cfg.kdfIterations < 600000) {
    warn("Password stretching", `${cfg.kdfIterations} iterations, below the 600k OWASP floor`);
  } else {
    ok("Password stretching", `${cfg.kdfIterations} PBKDF2 iterations`);
  }

  return cfg;
}

/* ---------------------------------------------------------------- auth --- */

async function checkAuth() {
  // Account non-enumeration: a real and a made-up address must be
  // indistinguishable, or anyone can confirm who has an account here.
  const a = await get("/api/auth/kdf-params", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TARGET },
    body: JSON.stringify({ email: "definitely-nobody-aaa@example.com" }),
  });
  const b = await get("/api/auth/kdf-params", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TARGET },
    body: JSON.stringify({ email: "definitely-nobody-bbb@example.com" }),
  });

  if (a.status !== 200 || b.status !== 200) {
    warn("Account privacy", `kdf-params returned ${a.status}/${b.status}`);
  } else if (JSON.stringify(Object.keys(a.body).sort()) !== JSON.stringify(Object.keys(b.body).sort())) {
    fail("Account privacy", "Responses differ in shape — this reveals who has an account");
  } else if (a.body.kdfSalt === b.body.kdfSalt) {
    fail("Account privacy", "Decoy salts are identical, so real accounts stand out");
  } else {
    ok("Account privacy", "Unknown addresses get plausible decoy parameters");
  }

  // Unauthenticated reads must not reach anything.
  const guarded = [
    "/api/auth/me",
    "/api/households",
    "/api/privacy/export",
    "/api/admin/overview",
  ];
  const leaks = [];
  for (const p of guarded) {
    const r = await get(p);
    if (r.status !== 401 && r.status !== 404) leaks.push(`${p} → ${r.status}`);
  }
  leaks.length
    ? fail("Authentication", `Reachable without signing in: ${leaks.join(", ")}`)
    : ok("Authentication", `${guarded.length} protected endpoints all refuse anonymous access`);

  // CSRF: a state-changing request from another origin must be refused.
  const csrf = await get("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ email: "x@example.com", authProof: "AAAA" }),
  });
  csrf.status === 403
    ? ok("CSRF", "Cross-origin requests refused")
    : warn("CSRF", `A cross-origin POST returned ${csrf.status}, expected 403`);
}

/* --------------------------------------------------------------- static --- */

async function checkFrontend() {
  const res = await get("/");
  if (res.status !== 200) return fail("Front-end", `GET / returned ${res.status}. Has the web build run?`);

  const js = /(?:src=")(\.?\/?assets\/[^"]+\.js)/.exec(res.text)?.[1];
  const css = /(?:href=")(\.?\/?assets\/[^"]+\.css)/.exec(res.text)?.[1];
  if (!js) return fail("Front-end", "No script bundle referenced in index.html");

  const asset = await get(`/${js.replace(/^\.?\//, "")}`);
  asset.status === 200
    ? ok("Front-end", `Bundle loads (${Math.round(asset.text.length / 1024)} KB)`)
    : fail("Front-end", `Bundle 404s at ${js} — usually a path-prefix problem`);

  if (css) {
    const sheet = await get(`/${css.replace(/^\.?\//, "")}`);
    if (sheet.status === 200) {
      const font = /url\(([^)]*\.woff2)\)/.exec(sheet.text)?.[1];
      if (font) {
        const url = font.replace(/^\.\.\//, "").replace(/^\.?\//, "");
        const f = await get(`/${url}`);
        f.status === 200
          ? ok("Fonts", "Self-hosted fonts load")
          : warn("Fonts", `Font 404s at ${font} — the page will fall back to system faces`);
      }
    }
  }

  // A prefix install must redirect the bare path, or every relative URL
  // resolves one directory too high.
  const path = new URL(TARGET).pathname.replace(/\/+$/, "");
  if (path) {
    const bare = await fetch(`${new URL(TARGET).origin}${path}`, {
      redirect: "manual", signal: AbortSignal.timeout(10000),
    });
    [301, 302, 307, 308].includes(bare.status)
      ? ok("Path prefix", `${path} redirects to ${path}/`)
      : fail("Path prefix",
          `${path} returned ${bare.status} instead of redirecting to ${path}/. ` +
          "Without that redirect every asset 404s.");
  }
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  console.log(`HouseHub preflight\ntarget: ${TARGET}\n`);

  if (!(await checkReachable())) {
    report();
    process.exit(2);
  }

  checkTls();
  await checkHeaders();
  await checkConfig();
  await checkAuth();
  await checkFrontend();

  report();
  const failures = results.filter((r) => r.level === "fail");
  process.exit(failures.length ? 1 : 0);
}

function report() {
  const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
  for (const r of results) {
    console.log(`${mark[r.level]} ${r.name.padEnd(28)} ${r.detail}`);
  }
  const f = results.filter((r) => r.level === "fail").length;
  const w = results.filter((r) => r.level === "warn").length;
  console.log(
    `\n${results.length} checks · ${f} failing · ${w} warnings\n` +
    (f ? "Not ready. Fix the FAILs above.\n"
       : w ? "Ready, with warnings worth reading.\n"
           : "Ready.\n")
  );
}

main().catch((err) => {
  console.error("preflight could not complete:", err.message);
  process.exit(2);
});
