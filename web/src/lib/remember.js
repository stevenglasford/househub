// remember.js — staying signed in, and exactly what that costs.
//
// session.js opens with a rule: keys live in memory only, so a reload asks for
// the password again. That rule is why a stolen laptop yields nothing. This
// module is the deliberate, opt-in exception. It is off unless somebody ticks a
// box AND their account permits it.
//
// WHY A COOKIE ALONE WOULD NOT HAVE DONE
//
// A session cookie authenticates you to the API, but the key that decrypts the
// household is derived from the password. Remember only the cookie and you come
// back "signed in", looking at ciphertext you cannot open. To genuinely stay
// signed in, this browser must keep something that can unlock the vault.
//
// WHAT IS ACTUALLY STORED, AND WHO CAN READ IT
//
// The identity private key, in IndexedDB, as bytes.
//
// Not as a non-extractable CryptoKey. That was the first design here and it was
// dishonest: HouseHub's X25519 key is a raw Uint8Array used by @noble/curves,
// not a Web Crypto key handle. And wrapping it under a non-extractable AES key
// would buy nothing either -- any script that can ask the browser to unwrap it
// receives the plaintext. There is no arrangement in which a page unlocks itself
// without the password and injected script on that page cannot.
//
// So, truthfully:
//
//   stolen or borrowed device   gets into the household with no password. This
//                               is inherent to every "stay signed in" feature
//                               that has ever shipped.
//   XSS while remembered        can read the identity key, and therefore the
//                               household. The strict CSP (script-src 'self',
//                               no CDN, no unsafe-eval) is what stands between
//                               an attacker and that, and it is unchanged.
//   stolen server or database   completely unchanged. None of this is sent
//                               anywhere; the server never sees it.
//
// The first two rows are the price. For a laptop only you touch, most people
// will judge it worth paying. For the tablet by the front door it plainly is
// not — which is why this is per account, off for any device that has not been
// explicitly ticked, and revocable for every device at once.

const DB_NAME = "househub-remember";
const STORE = "identity";
const RECORD = "current";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Is this browser able to remember anything at all? */
export const supported = () =>
  typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && Boolean(crypto.subtle);

/**
 * Keep this device signed in.
 *
 * `userId` is stored alongside so a remembered key is never handed to a
 * different account -- two people sharing a laptop must not inherit each
 * other's household.
 */
export async function remember({ userId, privateKey, publicKey }) {
  if (!supported()) return false;
  try {
    const db = await idb();
    await tx(db, "readwrite", (store) =>
      store.put({ userId, privateKey, publicKey, at: Date.now() }, RECORD));
    db.close();
    return true;
  } catch {
    // A browser in private mode, or with storage denied. Not an error worth
    // interrupting a sign-in for -- they simply will not be remembered.
    return false;
  }
}

/** What was kept, if anything. Null when this device was never remembered. */
export async function recall() {
  if (!supported()) return null;
  try {
    const db = await idb();
    const rec = await tx(db, "readonly", (store) => store.get(RECORD));
    db.close();
    if (!rec?.privateKey || !rec?.userId) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Forget this device.
 *
 * Called on sign-out, when the account turns persistence off, and whenever the
 * server refuses a remembered session. Failing quietly is right here: the
 * caller is already on its way to a locked state, and an exception would leave
 * somebody stuck on a screen they cannot get past.
 */
export async function forget() {
  if (!supported()) return;
  try {
    const db = await idb();
    await tx(db, "readwrite", (store) => store.delete(RECORD));
    db.close();
  } catch { /* nothing kept, or storage gone */ }
}
