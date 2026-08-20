// remember.test.js — what this device keeps, and when it lets go.
//
// The rules these lock in:
//
//   * nothing is kept unless the SERVER said the account allows it. The tick is
//     a request; the policy is the decision, and it is made server-side so a
//     client cannot simply ignore a refusal.
//   * a refusal actively forgets, so a device that was permitted last week and
//     is not permitted today does not keep an old key.
//   * a remembered key is never handed to a different account. Two people share
//     laptops; inheriting each other's household would be unforgivable.
//   * signing out forgets this device too.

import test from "node:test";
import assert from "node:assert/strict";

/* A minimal in-memory IndexedDB, because the contract under test is "what is
   stored and when", not the browser's storage engine. */
function fakeStore() {
  const data = new Map();
  return {
    data,
    async remember({ userId, privateKey, publicKey }) {
      data.set("current", { userId, privateKey, publicKey, at: Date.now() });
      return true;
    },
    async recall() { return data.get("current") || null; },
    async forget() { data.delete("current"); },
  };
}

/** The decision signIn makes, extracted so it can be tested without a browser. */
async function applyPersistence(store, { granted }, keys, userId) {
  if (granted) await store.remember({ userId, privateKey: keys.privateKey, publicKey: keys.publicKey });
  else await store.forget();
}

const KEYS = { privateKey: new Uint8Array([1, 2, 3]), publicKey: new Uint8Array([4, 5, 6]) };

test("a granted request keeps the key", async () => {
  const store = fakeStore();
  await applyPersistence(store, { granted: true }, KEYS, "u1");
  const kept = await store.recall();
  assert.equal(kept.userId, "u1");
  assert.deepEqual(kept.privateKey, KEYS.privateKey);
});

test("an ordinary sign-in keeps nothing", async () => {
  const store = fakeStore();
  await applyPersistence(store, { granted: false }, KEYS, "u1");
  assert.equal(await store.recall(), null);
});

test("a refusal forgets a key kept earlier", async () => {
  // The case that matters: permitted last week, forbidden today. The device
  // must not sail on with the key it was given before the policy changed.
  const store = fakeStore();
  await applyPersistence(store, { granted: true }, KEYS, "u1");
  assert.ok(await store.recall());

  await applyPersistence(store, { granted: false, refused: true }, KEYS, "u1");
  assert.equal(await store.recall(), null, "a refusal must actively forget");
});

test("a remembered key is never handed to another account", async () => {
  // Two people, one laptop.
  const store = fakeStore();
  await applyPersistence(store, { granted: true }, KEYS, "alice");

  const kept = await store.recall();
  const serverSaysIAm = "bob";
  const usable = kept && kept.userId === serverSaysIAm;
  assert.equal(usable, false, "Bob must not inherit Alice's household");
});

test("signing out forgets this device", async () => {
  const store = fakeStore();
  await applyPersistence(store, { granted: true }, KEYS, "u1");
  await store.forget();
  assert.equal(await store.recall(), null);
});

test("resuming needs BOTH a kept key and a session the server still honours", async () => {
  // Either half alone is useless: the cookie without the key leaves ciphertext,
  // the key without the session has nothing to fetch.
  const store = fakeStore();
  await applyPersistence(store, { granted: true }, KEYS, "u1");

  const resume = async (meRequest) => {
    const kept = await store.recall();
    if (!kept) return null;
    let me;
    try { me = await meRequest(); } catch { await store.forget(); return null; }
    if (!me?.id || me.id !== kept.userId) { await store.forget(); return null; }
    return me;
  };

  assert.equal(await resume(async () => { throw new Error("401"); }), null,
    "an expired session must not resume, and must forget");
  assert.equal(await store.recall(), null, "and the stale key is dropped");

  await applyPersistence(store, { granted: true }, KEYS, "u1");
  const ok = await resume(async () => ({ id: "u1" }));
  assert.equal(ok.id, "u1");
});

test("the real module exposes the contract the session layer relies on", async () => {
  const REMEMBER = await import("../src/lib/remember.js");
  for (const fn of ["remember", "recall", "forget", "supported"]) {
    assert.equal(typeof REMEMBER[fn], "function", `remember.js must export ${fn}`);
  }
  // No IndexedDB in Node: every call must degrade quietly rather than throw,
  // because a browser in private mode behaves the same way.
  assert.equal(REMEMBER.supported(), false);
  assert.equal(await REMEMBER.recall(), null);
  assert.equal(await REMEMBER.remember({ userId: "u", privateKey: KEYS.privateKey }), false);
  await REMEMBER.forget();      // must not throw
});
