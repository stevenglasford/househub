// session-persistence.test.js — "remember me", and the account's right to refuse it.
//
// The rule, stated once so the table below is readable:
//
//   Ticking "remember me" is a request, not an instruction. The account holds
//   the policy, and if that policy says no, the person gets an ordinary session
//   and an explanation. Silently ignoring the tick would be worse than either
//   answer -- they would believe they were remembered and be signed out later
//   with no idea why.
//
// Policy values: null = off, 0 = never expires, N = hours.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionLifetime } from "../src/routes/auth.js";

const DEFAULT_HOURS = 24 * 14;      // SESSION_TTL_HOURS
const FOREVER = 24 * 365 * 10;

test("not asking to be remembered gives an ordinary session", () => {
  for (const policy of [null, 0, 1, 168, 8760]) {
    const r = resolveSessionLifetime(policy, false);
    assert.deepEqual(r, { hours: DEFAULT_HOURS, persistent: false, refused: false },
      `policy ${policy} must not change an unticked sign-in`);
  }
});

test("asking, when the account allows it, is honoured", () => {
  const r = resolveSessionLifetime(168, true);
  assert.equal(r.hours, 168, "one week");
  assert.equal(r.persistent, true);
  assert.equal(r.refused, false);
});

test("a policy of 0 means never expires", () => {
  const r = resolveSessionLifetime(0, true);
  assert.equal(r.hours, FOREVER);
  assert.equal(r.persistent, true);
  assert.equal(r.refused, false);
});

test("asking, when the account forbids it, is refused and said so", () => {
  // The case the popup exists for.
  const r = resolveSessionLifetime(null, true);
  assert.equal(r.refused, true, "the client must be told, not left guessing");
  assert.equal(r.persistent, false, "and no persistent session is created");
  assert.equal(r.hours, DEFAULT_HOURS, "they still get an ordinary session — sign-in worked");
});

test("a refused request still signs you in", () => {
  // Refusing persistence must not refuse the login. The password was right.
  const r = resolveSessionLifetime(null, true);
  assert.ok(r.hours > 0);
});

test("undefined policy is treated as off, not as forever", () => {
  // A column that has not been backfilled must fail closed. Reading `undefined`
  // as 0 would silently give every such account a ten-year session.
  const r = resolveSessionLifetime(undefined, true);
  assert.equal(r.refused, true);
  assert.equal(r.persistent, false);
});

test("the custom durations a person can choose all resolve sensibly", () => {
  for (const [hours, label] of [[24, "a day"], [168, "a week"], [720, "a month"], [8760, "a year"]]) {
    const r = resolveSessionLifetime(hours, true);
    assert.equal(r.hours, hours, label);
    assert.equal(r.persistent, true);
  }
});
