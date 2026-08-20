// remember-me.test.js — staying signed in, end to end, against a real database.
//
// The unit tests next door cover the decision table. These cover what the
// household actually experiences: tick the box, get a long session; turn the
// setting off, get told why; turn it off later, and every remembered device is
// cut loose rather than merely stopped from renewing.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import * as C from "../../web/src/lib/crypto.js";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.PUBLIC_URL = process.env.PUBLIC_URL || "http://127.0.0.1:4131";
process.env.ALLOW_SIGNUP = "1";
process.env.SERVER_KEY ||= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
process.env.BLIND_INDEX_PEPPER ||= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const { createApp } = await import("../src/index.js");
const { migrate } = await import("../src/db/migrate.js");
const { q, closePool } = await import("../src/db/pool.js");

const ITER = 100000;
let server, base;

before(async () => {
  await migrate();
  await q("TRUNCATE users, households, audit_log, rate_limits CASCADE");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closePool();
});

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Origin: process.env.PUBLIC_URL,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

const PASSWORD = "a sufficiently long passphrase";

/* Unique per run. Three suites in this directory truncate the same tables and
   reuse the same addresses; the runner is serialised now, but a suite that can
   only pass when it has the database to itself is a suite that will fail again
   the day somebody parallelises it. */
const RUN = Math.random().toString(36).slice(2, 8);
const addr = (name) => `${name}-${RUN}@example.com`;

async function register(email) {
  /* These tests create more accounts than the registration budget allows, which
     is the rate limiter working correctly. Clearing the buckets is test
     scaffolding, not a workaround -- security/pentest/run.js is what proves the
     limiter still bites. */
  await q("TRUNCATE rate_limits");
  const { upload } = await C.createIdentity(PASSWORD, ITER);
  const r = await api("POST", "/api/auth/register",
    { body: { email, ...upload, acknowledgedNoRecovery: true } });
  assert.ok(r.status < 300, `register failed: ${r.text.slice(0, 200)}`);
  return r.body.token;
}

async function login(email, { remember } = {}) {
  await q("TRUNCATE rate_limits");
  const params = await api("POST", "/api/auth/kdf-params", { body: { email } });
  const authProof = await C.loginProof(PASSWORD, params.body);
  return api("POST", "/api/auth/login", { body: { email, authProof, ...(remember ? { remember } : {}) } });
}


describe("remember me", () => {
  test("a plain sign-in creates an ordinary session", async () => {
    const email = addr("plain");
    await register(email);
    const r = await login(email);
    assert.equal(r.status, 200);
    assert.equal(r.body.persistence.requested, false);
    assert.equal(r.body.persistence.granted, false);
  });

  test("ticking remember me is honoured by default, for one week", async () => {
    // The requested default: a new account may stay signed in for a week.
    const email = addr("remembered");
    await register(email);
    const r = await login(email, { remember: true });

    assert.equal(r.status, 200);
    assert.equal(r.body.persistence.granted, true, "should be honoured");
    assert.equal(r.body.persistence.refused, false);
    assert.equal(r.body.persistence.hours, 168, "one week is the default");
  });

  test("the cookie's lifetime matches what was granted", async () => {
    // Session row and cookie must agree, or one outlives the other and the
    // person is signed out by whichever is shorter with no explanation.
    const email = addr("cookie");
    await register(email);
    const r = await login(email, { remember: true });
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("hh_session"));
    assert.ok(cookie, "a session cookie is set");
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    assert.equal(maxAge, 168 * 3600, "one week, in seconds");
  });

  test("turning the setting off means remember me is refused, with a reason", async () => {
    const email = addr("refuses");
    const token = await register(email);
    const off = await api("PUT", "/api/auth/session-policy", { token, body: { hours: null } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);

    const r = await login(email, { remember: true });
    assert.equal(r.status, 200, "sign-in still succeeds — the password was right");
    assert.equal(r.body.persistence.refused, true, "and the client is told why");
    assert.equal(r.body.persistence.granted, false);
  });

  test("never-expires is a real option", async () => {
    const email = addr("forever");
    const token = await register(email);
    await api("PUT", "/api/auth/session-policy", { token, body: { hours: 0 } });

    const r = await login(email, { remember: true });
    assert.equal(r.body.persistence.granted, true);
    assert.ok(r.body.persistence.hours >= 24 * 365, "years, not hours");
  });

  test("turning it off cuts remembered devices loose", async () => {
    // The point of the switch. Somebody turning this off has usually realised a
    // device is somewhere it should not be; "no new ones" is a useless answer.
    const email = addr("revoke");
    const token = await register(email);

    await login(email, { remember: true });
    await login(email, { remember: true });

    const before = await api("GET", "/api/auth/session-policy", { token });
    assert.equal(before.body.rememberedDevices, 2);

    const off = await api("PUT", "/api/auth/session-policy", { token, body: { hours: null } });
    assert.equal(off.body.revokedDevices, 2, "both remembered devices are signed out");

    const after = await api("GET", "/api/auth/session-policy", { token });
    assert.equal(after.body.rememberedDevices, 0);
  });

  test("turning it off does not sign you out of the tab you are in", async () => {
    // The session doing the turning-off is an ordinary one and must survive,
    // or the setting logs you out every time you touch it.
    const email = addr("keepme");
    const token = await register(email);
    await api("PUT", "/api/auth/session-policy", { token, body: { hours: null } });
    const me = await api("GET", "/api/auth/me", { token });
    assert.equal(me.status, 200, "the current session still works");
  });

  test("the policy is per account, not shared", async () => {
    const a = addr("alice"), b = addr("bob");
    const ta = await register(a);
    await register(b);
    await api("PUT", "/api/auth/session-policy", { token: ta, body: { hours: null } });

    assert.equal((await login(a, { remember: true })).body.persistence.refused, true);
    assert.equal((await login(b, { remember: true })).body.persistence.granted, true,
      "one person's choice must not change anybody else's");
  });

  test("the policy cannot be read or set without signing in", async () => {
    assert.equal((await api("GET", "/api/auth/session-policy")).status, 401);
    assert.equal((await api("PUT", "/api/auth/session-policy", { body: { hours: 0 } })).status, 401);
  });

  test("a nonsense duration is refused", async () => {
    const token = await register(addr("nonsense"));
    for (const hours of [-1, 24 * 365 * 100, 1.5, "week"]) {
      const r = await api("PUT", "/api/auth/session-policy", { token, body: { hours } });
      assert.equal(r.status, 400, `hours=${hours} should be rejected`);
    }
  });
});
