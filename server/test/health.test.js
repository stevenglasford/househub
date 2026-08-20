// health.test.js — the server admits when it cannot do its job.
//
// These cover the stability problem Ryan identified in his Postgres build: a
// health endpoint that answers `{ ok: true }` without touching the database.
//
// It matters here more than it did there. The Docker healthcheck calls this
// endpoint, and HouseHub clients hold the decrypted household in memory and
// save on a debounce — so when the database stops accepting writes, the app
// looks completely normal to the people using it. Every save fails, nothing
// says so, and the loss is only discovered on the next reload.
//
// Two distinct faults, and one probe does not find both:
//
//   unreachable          a SELECT fails
//   refusing writes      SELECT works, writes do not — a full disk, a failover
//                        replica, a revoked grant
//
// No database needed: these test the decision logic directly.

import test from "node:test";
import assert from "node:assert/strict";
import { isStorageFault, noteWriteFailure, noteWriteSuccess, resetHealth } from "../src/services/health.js";

test("a full disk is a storage fault", () => {
  // Postgres class 53 — insufficient resources.
  assert.equal(isStorageFault({ code: "53100" }), true, "disk full");
  assert.equal(isStorageFault({ code: "53300" }), true, "too many connections");
});

test("a read-only transaction is a storage fault", () => {
  // What a failover replica gives you: reads fine, every write refused.
  assert.equal(isStorageFault({ code: "25006" }), true);
});

test("an unreachable server is a storage fault", () => {
  assert.equal(isStorageFault({ code: "08006" }), true, "connection failure");
  assert.equal(isStorageFault({ code: "57P01" }), true, "admin shutdown");
  assert.equal(isStorageFault({ message: "connect ECONNREFUSED 127.0.0.1:5432" }), true);
});

test("the application refusing a request is NOT a storage fault", () => {
  // This is the important half. A quota rejection or a unique-key conflict is
  // the server working correctly; reporting it as ill would make the container
  // flap and teach everyone to ignore the health status.
  assert.equal(isStorageFault({ code: "23505" }), false, "unique violation");
  assert.equal(isStorageFault({ code: "23503" }), false, "foreign key violation");
  assert.equal(isStorageFault({ code: "23514" }), false, "check constraint");
  assert.equal(isStorageFault({ code: "42P01" }), false, "undefined table");
  assert.equal(isStorageFault({}), false, "an error with no code at all");
  assert.equal(isStorageFault(new Error("Vault limit exceeded")), false);
});

test("a recorded write failure is remembered, and a success clears it", async () => {
  const { checkHealth } = await import("../src/services/health.js");
  resetHealth();

  noteWriteFailure({ code: "53100" });
  // now = the probe TTL is irrelevant here; the write failure is what decides.
  const ill = await checkHealth(Date.now(), { probeFn: async () => {} });
  assert.equal(ill.database, "not-accepting-writes");
  assert.equal(ill.ok, false, "the healthcheck must fail so somebody finds out");
  assert.equal(ill.lastWriteErrorCode, "53100");

  noteWriteSuccess();
  const well = await checkHealth(Date.now(), { probeFn: async () => {} });
  assert.equal(well.database, "ok");
  assert.equal(well.ok, true);
  resetHealth();
});

test("an old write failure stops being reported", async () => {
  // A blip an hour ago is history. Only a live fault should hold the container
  // unhealthy, or the status becomes permanently red and stops meaning anything.
  const { checkHealth } = await import("../src/services/health.js");
  resetHealth();
  noteWriteFailure({ code: "53100" });

  const later = Date.now() + 6 * 60 * 1000;
  const health = await checkHealth(later, { probeFn: async () => {} });
  assert.equal(health.database, "ok");
  resetHealth();
});

test("the response never leaks the driver's message", async () => {
  // This endpoint is unauthenticated. A raw Postgres error names the host, the
  // database, and often the schema.
  const { checkHealth } = await import("../src/services/health.js");
  resetHealth();
  noteWriteFailure({
    code: "53100",
    message: 'could not extend file "base/16384/2601": No space left on device',
  });
  const health = await checkHealth(Date.now(), { probeFn: async () => {} });
  const body = JSON.stringify(health);
  assert.ok(!/base\/16384/.test(body), "no file paths");
  assert.ok(!/No space left/.test(body), "no driver text");
  assert.match(body, /53100/, "the class of failure is enough to act on");
  resetHealth();
});

test("an unreachable database is reported as unreachable, not as a write fault", async () => {
  // The two faults must stay distinguishable: one means the database is gone,
  // the other means it is there and refusing. They call for different actions.
  const { checkHealth } = await import("../src/services/health.js");
  resetHealth();
  const health = await checkHealth(Date.now(), {
    probeFn: async () => { throw new Error("connect ECONNREFUSED"); },
  });
  assert.equal(health.database, "unreachable");
  assert.equal(health.ok, false);
  resetHealth();
});

test("a healthy database reports ok", async () => {
  const { checkHealth } = await import("../src/services/health.js");
  resetHealth();
  const health = await checkHealth(Date.now(), { probeFn: async () => {} });
  assert.deepEqual({ ok: health.ok, database: health.database }, { ok: true, database: "ok" });
  resetHealth();
});
