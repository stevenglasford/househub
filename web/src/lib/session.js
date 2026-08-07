// session.js — the unlocked household, held in memory.
//
// This module owns every key the browser has: the user's identity key, and the
// household key it unwraps. Two rules govern all of it:
//
//   1. Keys live in memory only. Not localStorage, not IndexedDB, not a cookie.
//      A shared wall tablet, a borrowed laptop, or an XSS payload that survives
//      a reload should find nothing waiting for it. The cost is that a page
//      refresh asks for the password again, and that is the right trade for
//      software whose users may need it to be genuinely unreadable by someone
//      with physical access.
//
//   2. Nothing leaves here in the clear. `save()` seals before it fetches;
//      `load()` opens after. There is no code path that PUTs a plaintext
//      document, which is why the 5,600-line UI on top never has to think
//      about encryption at all.

import * as C from "./crypto.js";

const state = {
  token: null,
  user: null,
  householdId: null,
  role: null,
  keyEpoch: null,
  keys: null,          // { masterKey, masterKeyRaw, privateKey, publicKey }
  householdKey: null,  // raw 32 bytes
  version: 0,
  // Set when this tab is a wall display rather than a signed-in person.
  display: null,
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(snapshot()));

export const snapshot = () => ({
  signedIn: Boolean(state.token || state.display),
  unlocked: Boolean(state.householdKey),
  user: state.user,
  householdId: state.householdId,
  role: state.role,
  version: state.version,
  isDisplay: Boolean(state.display),
  displayScopes: state.display?.scopes || null,
  displayControlDomains: state.display?.controlDomains || [],
  displayName: state.display?.name || null,
  displayCanWrite: Boolean(state.display?.canWrite),
});

export const currentToken = () => state.token || state.display?.token || null;
export const householdId = () => state.householdId;
export const isDisplay = () => Boolean(state.display);

/* ------------------------------------------------------------- transport --- */

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}
export { ApiError };

export async function request(method, path, body) {
  const token = currentToken();
  const res = await fetch(path.replace(/^\//, ""), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  let json = null;
  const text = await res.text();
  if (text) { try { json = JSON.parse(text); } catch { /* non-JSON error page */ } }

  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

/* --------------------------------------------------------------- signing --- */

export async function register({ email, password, displayName, inviteToken }) {
  const cfg = await request("GET", "api/config");
  const { upload, keys } = await C.createIdentity(password, cfg.kdfIterations || 650000);
  const res = await request("POST", "api/auth/register", {
    email, displayName, ...upload,
    // The form will not submit without this ticked; sent so the server can
    // record when they were told.
    acknowledgedNoRecovery: true,
    // A closed server still admits somebody holding a valid invitation. Without
    // this the invite flow was unusable the moment ALLOW_SIGNUP was turned off,
    // which is exactly when a household starts inviting people.
    ...(inviteToken ? { inviteToken } : {}),
  });

  state.token = res.token;
  state.user = res.user;
  state.keys = keys;
  emit();
  return res;
}

export async function signIn({ email, password, totp }) {
  // Two steps, because the browser needs the salt before it can produce a proof.
  // The server answers with plausible decoy parameters for addresses it does
  // not know, so this exchange does not reveal whether an account exists.
  const params = await request("POST", "api/auth/kdf-params", { email });
  const authProof = await C.loginProof(password, params);

  const res = await request("POST", "api/auth/login", { email, authProof, totp });

  state.token = res.token;
  state.user = res.user;
  state.keys = await C.unlockIdentity(password, res.identity);
  emit();
  return res;
}

export async function signOut() {
  try { await request("POST", "api/auth/logout"); } catch { /* going anyway */ }
  wipe();
}

/** Zero the key material rather than just dropping the references. */
export function wipe() {
  try {
    state.householdKey?.fill(0);
    state.keys?.privateKey?.fill(0);
    state.keys?.masterKeyRaw?.fill(0);
  } catch { /* already gone */ }
  Object.assign(state, {
    token: null, user: null, householdId: null, role: null,
    keyEpoch: null, keys: null, householdKey: null, version: 0, display: null,
  });
  emit();
}

/* ------------------------------------------------------------ households --- */

/**
 * Every household this account belongs to, with its name decrypted.
 *
 * The name is sealed under each household's own key, so this unwraps each one
 * locally to read it. That is a little work per household and it is the only way
 * a picker can show "The Flat" rather than "Household" -- the server genuinely
 * cannot help, because it cannot read either the name or the key.
 */
export async function listHouseholds() {
  if (!state.keys) throw new Error("Sign in first.");
  const rows = await request("GET", "api/households");

  return Promise.all(rows.map(async (h) => {
    let name = null;
    let unlockable = false;
    if (h.wrappedKey) {
      try {
        const hk = await C.unwrapHouseholdKey(h.wrappedKey, state.keys.privateKey, state.keys.publicKey);
        unlockable = true;
        name = await C.openName(hk, h.nameEnc);
        hk.fill(0);
      } catch {
        // A key we cannot unwrap: usually a rotation we have not caught up with.
      }
    }
    return {
      ...h,
      name,
      unlockable,
      // Either the membership is still pending, or it is active but no admin
      // has wrapped the household key to us yet. Both mean "you cannot open
      // this one, and that is not your fault".
      pendingApproval: h.membership === "pending" || !h.wrappedKey,
    };
  }));
}

/** Refresh the signed-in user's own details. */
export async function loadMe() {
  const me = await request("GET", "api/auth/me");
  state.user = { id: me.id, email: me.email, displayName: me.displayName, isSuperAdmin: me.isSuperAdmin };
  emit();
  return me;
}

/** Open a household: fetch the wrapped key and unwrap it with the identity key. */
export async function openHousehold(id) {
  if (!state.keys) throw new Error("Sign in first.");
  const hh = await request("GET", `api/households/${id}`);

  state.householdKey = await C.unwrapHouseholdKey(
    hh.wrappedKey, state.keys.privateKey, state.keys.publicKey
  );
  state.householdId = hh.id;
  state.role = hh.role;
  state.keyEpoch = hh.keyEpoch;
  emit();
  return hh;
}

/** Create a household. The key is generated here and wrapped to ourselves. */
export async function createHousehold(name, seedDoc) {
  if (!state.keys) throw new Error("Sign in first.");
  const hk = C.newHouseholdKeyRaw();
  const wrappedKey = await C.wrapHouseholdKey(hk, state.keys.publicKey);

  const doc = { ...seedDoc, householdName: name };
  // The server assigns version 1; the placeholder id matches what it seals
  // against before the real id exists.
  const document = await C.sealDocument(hk, doc, { householdId: "pending", version: 1 });
  const nameEnc = await C.sealName(hk, name);

  const res = await request("POST", "api/households", { wrappedKey, document, nameEnc });

  state.householdKey = hk;
  state.householdId = res.id;
  state.role = "admin";
  state.keyEpoch = res.keyEpoch;
  state.version = 1;
  emit();
  return res;
}

/* ----------------------------------------------------------------- vault --- */

/**
 * The context bound into the document's AAD.
 *
 * A household's first document is sealed before its id exists, so version 1
 * uses the same "pending" placeholder the creation path used. Every later
 * version binds the real id.
 */
const docContext = (version) => ({
  householdId: version === 1 ? "pending" : state.householdId,
  version,
});

export async function loadVault() {
  const path = state.display ? "api/display/vault" : `api/households/${state.householdId}/vault`;
  const res = await request("GET", path);
  state.version = res.version;

  const doc = await C.openDocument(state.householdKey, {
    ciphertext: res.ciphertext,
    compression: res.compression,
    ...docContext(res.version),
  });
  emit();
  return doc;
}

/**
 * Seal and store. On a version conflict the server hands back the winning
 * document, so `onConflict` gets both sides and returns the merged result --
 * one round trip rather than a fetch-then-retry.
 */
export async function saveVault(doc, { onConflict } = {}) {
  if (!state.householdKey) throw new Error("The household is locked.");
  if (state.display && !state.display.canWrite) {
    throw new Error("This display can show things but not change them.");
  }

  const next = state.version + 1;
  const sealed = await C.sealDocument(state.householdKey, doc, docContext(next));

  try {
    const res = await request(
      "PUT",
      state.display ? "api/display/vault" : `api/households/${state.householdId}/vault`,
      { ...sealed, baseVersion: state.version }
    );
    state.version = res.version;
    emit();
    return res;
  } catch (err) {
    if (err.code !== "version_conflict" || !err.body?.current) throw err;

    const current = err.body.current;
    const theirs = await C.openDocument(state.householdKey, {
      ciphertext: current.ciphertext,
      compression: current.compression,
      ...docContext(current.version),
    });

    state.version = current.version;
    if (!onConflict) {
      // No merge strategy supplied: surface theirs rather than silently
      // discarding either side.
      const e = new Error("Someone else saved while you were editing.");
      e.code = "version_conflict";
      e.theirs = theirs;
      throw e;
    }
    return saveVault(await onConflict(doc, theirs), { onConflict });
  }
}

/**
 * Restore an earlier revision.
 *
 * Done here rather than on the server because the document's version is bound
 * into its AEAD associated data: ciphertext sealed at version 8 cannot simply be
 * stored as version 11, and only something holding the key can re-seal it. That
 * binding is what prevents a silent rollback by anybody with database access.
 *
 * The result is an ordinary forward write, so restoring is itself undoable.
 */
export async function restoreRevision(version) {
  if (!state.householdKey) throw new Error("The household is locked.");

  const rev = await request("GET", `api/households/${state.householdId}/vault/revisions/${version}`);
  const doc = await C.openDocument(state.householdKey, {
    ciphertext: rev.ciphertext,
    compression: rev.compression,
    ...docContext(Number(rev.version)),
  });

  // Saved as the next version, through the normal path -- which also means the
  // current document is archived as a revision first.
  return saveVault(doc);
}

export const listRevisions = () =>
  request("GET", `api/households/${state.householdId}/vault/revisions`);

/** Cheap poll for other devices' changes. */
export async function remoteVersion() {
  const path = state.display ? "api/display/version" : `api/households/${state.householdId}/vault/version`;
  const res = await request("GET", path);
  return res.version;
}

export const localVersion = () => state.version;

/* --------------------------------------------------------------- display --- */

/**
 * Bring up a wall display from its permanent link.
 *
 * The private key arrives in the URL *fragment*, which browsers never send to
 * the server. It is stashed in localStorage afterwards -- deliberately, and
 * unlike everything else in this module -- because a hallway tablet has to
 * survive a power cut without someone fetching the setup link again. It is
 * sealed under the display token, so the key and the thing that unseals it are
 * not both sitting in the same store.
 */
const DISPLAY_STORE = "hh.display.v1";

export async function startDisplay({ token, privateKeyB64 }) {
  let sealedKey = null;
  const saved = localStorage.getItem(DISPLAY_STORE);
  if (saved) {
    try { sealedKey = JSON.parse(saved); } catch { /* corrupt, re-provision */ }
  }

  let privateKey;
  if (privateKeyB64) {
    privateKey = C.fromB64(privateKeyB64);
    localStorage.setItem(DISPLAY_STORE, JSON.stringify({
      token, key: await C.sealDisplayKey(privateKey, token),
    }));
  } else if (sealedKey?.token === token) {
    privateKey = await C.openDisplayKey(sealedKey.key, token);
  } else {
    throw new Error("This display has not been set up on this device. Open its setup link again.");
  }

  state.display = { token };
  const boot = await request("GET", "api/display/bootstrap");

  const publicKey = C.publicKeyFromPrivate(privateKey);
  state.householdKey = await C.unwrapHouseholdKey(boot.wrappedKey, privateKey, publicKey, "display");
  state.householdId = boot.householdId;
  state.display = {
    token, id: boot.displayId, name: boot.name, scopes: boot.scopes,
    canWrite: Boolean(boot.canWrite),
    controlDomains: Array.isArray(boot.controlDomains) ? boot.controlDomains : [],
  };
  state.keyEpoch = boot.keyEpoch;
  emit();
  return boot;
}

export function forgetDisplay() {
  localStorage.removeItem(DISPLAY_STORE);
  wipe();
}

/**
 * Keep the sealed household name in step with the document.
 *
 * The name lives in two places -- inside the encrypted document, where the UI
 * edits it, and as a small separate ciphertext the picker can read without
 * downloading the vault. This pushes the second copy up when the first changes,
 * and backfills households created before names were stored separately.
 */
export async function syncHouseholdName(name) {
  if (!state.householdKey || !state.householdId) return;
  if (state._lastName === name) return;                 // nothing changed
  state._lastName = name;
  try {
    await request("PUT", `api/households/${state.householdId}/settings`, {
      nameEnc: await C.sealName(state.householdKey, name),
    });
  } catch {
    // Cosmetic. A failure here must never block a save of the real document.
  }
}

export const archiveHousehold = (id, archived = true) =>
  request("POST", `api/households/${id}/archive`, { archived });

export const deleteHousehold = (id) =>
  request("DELETE", `api/households/${id}`);

/** Drop the open household but stay signed in, for switching. */
export function closeHousehold() {
  try { state.householdKey?.fill(0); } catch {}
  state.householdKey = null;
  state.householdId = null;
  state.role = null;
  state.version = 0;
  state._lastName = null;
  emit();
}

/* ------------------------------------------------------------ membership --- */

/**
 * Wrap the household key to somebody else's public key.
 *
 * The household key itself never leaves this module -- callers hand in a
 * recipient and get back a sealed blob they can upload. This is the operation
 * the server cannot perform on its own, and the reason admitting a member needs
 * an admin's device rather than just a row in a table.
 */
export async function wrapForRecipient(publicKeyB64, context = "user") {
  if (!state.householdKey) throw new Error("The household is locked.");
  return C.wrapHouseholdKey(state.householdKey, C.fromB64(publicKeyB64), context);
}

/** Members of the current household, including those awaiting a key. */
export const listMembers = () =>
  request("GET", `api/households/${state.householdId}/members`);

export const createInvite = (body) =>
  request("POST", `api/households/${state.householdId}/invites`, body);

export const listInvites = () =>
  request("GET", `api/households/${state.householdId}/invites`);

export const revokeInvite = (id) =>
  request("DELETE", `api/households/${state.householdId}/invites/${id}`);

/**
 * Admit a pending member: wrap the household key to them and upload it.
 *
 * `publicKey` is echoed back to the server so it can reject the request if the
 * key changed between the member list being loaded and this call -- which is
 * what a server swapping in its own key mid-flow would look like.
 */
export async function grantAccess(userId, publicKeyB64) {
  const wrappedKey = await wrapForRecipient(publicKeyB64);
  return request("POST", `api/households/${state.householdId}/members/${userId}/key`, {
    wrappedKey, publicKey: publicKeyB64,
  });
}

export const setMemberRole = (userId, role) =>
  request("PUT", `api/households/${state.householdId}/members/${userId}/role`, { role });

export const removeMember = (userId) =>
  request("DELETE", `api/households/${state.householdId}/members/${userId}`);

/* -------------------------------------------------------------------- ai --- */

/**
 * Ask the local model for something.
 *
 * `context` is assembled by the caller from the *decrypted* document and is the
 * only household detail that reaches the server, for the duration of one
 * request. web/src/lib/checkin.js builds it, and defaults to sending counts
 * rather than content.
 */
export async function generate(kind, context, opts = {}) {
  return request("POST", `api/ai/households/${state.householdId}/generate`, {
    kind, context, ...opts,
  });
}

export const aiStatus = () => request("GET", "api/ai/status");

/** Which model this household uses, and whether its context stays local. */
export const aiProvider = () =>
  request("GET", `api/ai/households/${state.householdId}/provider`);

export const setAiProvider = (body) =>
  request("PUT", `api/ai/households/${state.householdId}/provider`, body);

/* -------------------------------------------------------------- cameras --- */

const camBase = () =>
  state.display ? "api/display/cameras" : `api/households/${state.householdId}/cameras`;

export const cameraConfig = () =>
  request("GET", `api/households/${state.householdId}/cameras`);

export const testCameras = (body) =>
  request("POST", `api/households/${state.householdId}/cameras/test`, body);

export const saveCameras = (body) =>
  request("PUT", `api/households/${state.householdId}/cameras`, body);

export const disconnectCameras = () =>
  request("DELETE", `api/households/${state.householdId}/cameras`);

export const availableCameras = () =>
  request("GET", `api/households/${state.householdId}/cameras/available`);

export const listCameras = () => request("GET", `${camBase()}/cameras`);
export const cameraAlerts = (limit = 50) =>
  request("GET", `api/households/${state.householdId}/cameras/alerts?limit=${limit}`);

/** Image and stream URLs, carrying the display token when this is a screen. */
export const cameraSnapshotUrl = (id) =>
  state.display
    ? `api/display/cameras/snapshot/${encodeURIComponent(id)}.jpg?token=${encodeURIComponent(state.display.token)}`
    : `api/households/${state.householdId}/cameras/snapshot/${encodeURIComponent(id)}.jpg`;

export const cameraStreamUrl = (id) =>
  state.display
    ? `api/display/cameras/stream/${encodeURIComponent(id)}?token=${encodeURIComponent(state.display.token)}`
    : `api/households/${state.householdId}/cameras/stream/${encodeURIComponent(id)}`;

/* --------------------------------------------------------- integrations --- */

export const listIntegrations = () =>
  request("GET", `api/households/${state.householdId}/integrations`);

/* -------------------------------------------------------------- privacy --- */

export const erasurePreview = () => request("GET", "api/privacy/erasure-preview");

/** Everything the server holds about this account, as a downloadable file. */
export async function downloadAccountExport() {
  const res = await fetch("api/privacy/export", {
    headers: { Authorization: `Bearer ${currentToken()}` },
    credentials: "same-origin",
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.blob();
}

/**
 * Delete this account.
 *
 * The password is re-derived here into an auth proof rather than sent, exactly
 * as at login -- so even erasing an account does not put a password on the wire.
 */
export async function eraseAccount(password, { deleteEmptyHouseholds = true } = {}) {
  const me = await request("GET", "api/auth/me");
  const authProof = await C.loginProof(password, me.identity);
  const out = await request("DELETE", "api/privacy/me", {
    authProof, confirm: "DELETE", deleteEmptyHouseholds,
  });
  wipe();
  return out;
}

/* --------------------------------------------------------------- actor ---- */

/**
 * Who is doing something, for attribution.
 *
 * `personId` links an account to an entry in the household document's people
 * list -- they are different things: an account is who signs in, a person is who
 * the chores belong to. Until a member links themselves, completions record the
 * account and the UI shows the email.
 */
export function currentActor(doc) {
  if (state.display) {
    return {
      isDisplay: true,
      displayId: state.display.id,
      displayName: state.display.name,
      canWrite: state.display.canWrite,
      controlDomains: state.display.controlDomains,
    };
  }
  const person = (doc?.people || []).find((p) => p.userId && p.userId === state.user?.id);
  return {
    isDisplay: false,
    userId: state.user?.id || null,
    personId: person?.id || "",
    displayName: state.user?.displayName || state.user?.email || null,
    role: state.role,
  };
}

/* ------------------------------------------------------------- displays --- */

export const listDisplays = () =>
  request("GET", `api/households/${state.householdId}/displays`);

export const createDisplay = (body) =>
  request("POST", `api/households/${state.householdId}/displays`, body);

/** A proof only this admin's key can produce, so the server cannot forge consent. */
export async function approvalProofFor(displayId, displayPublicKeyB64) {
  if (!state.keys) throw new Error("Sign in first.");
  return C.approvalProof(state.keys, displayId, C.fromB64(displayPublicKeyB64));
}

export const approveDisplay = (id, decision, proof) =>
  request("POST", `api/households/${state.householdId}/displays/${id}/approve`, { decision, proof });

/**
 * Wrap the household key to a display and collect its permanent link.
 *
 * The wrap happens here because the household key is here and nowhere else --
 * which is what makes the multi-admin sign-off a real constraint rather than a
 * server-side `if` somebody could patch out.
 */
export async function activateDisplay(displayId, displayPublicKey) {
  if (!state.householdKey) throw new Error("The household is locked.");
  const wrappedKey = await C.wrapHouseholdKey(state.householdKey, displayPublicKey, "display");
  return request("POST", `api/households/${state.householdId}/displays/${displayId}/activate`, {
    wrappedKey, publicKey: C.toB64(displayPublicKey),
  });
}

export const updateDisplay = (id, patch) =>
  request("PATCH", `api/households/${state.householdId}/displays/${id}`, patch);

export const revokeDisplay = (id) =>
  request("DELETE", `api/households/${state.householdId}/displays/${id}`);

/* ------------------------------------------------------------ proposals --- */

export const listProposals = () =>
  request("GET", `api/households/${state.householdId}/proposals`);

export const createProposal = (kind, payload) =>
  request("POST", `api/households/${state.householdId}/proposals`, { kind, payload });

export const decideProposal = (id, decision) =>
  request("POST", `api/households/${state.householdId}/proposals/${id}/decide`, { decision });

export const markProposalApplied = (id) =>
  request("POST", `api/households/${state.householdId}/proposals/${id}/applied`);

export const withdrawProposal = (id) =>
  request("DELETE", `api/households/${state.householdId}/proposals/${id}`);

/* ----------------------------------------------------------------- home --- */

export const homeEntities = () =>
  state.display
    ? request("GET", "api/display/home/entities")
    : request("GET", `api/households/${state.householdId}/home/entities`);

export const homeControl = (entityId, action = "toggle") =>
  state.display
    ? request("POST", "api/display/home/control", { entityId, action })
    : request("POST", `api/households/${state.householdId}/home/control`, { entityId, action });

/** Devices with this household's own names, rooms and ordering applied. */
export const homeDevices = () =>
  state.display
    ? request("GET", "api/display/home/devices")
    : request("GET", `api/households/${state.householdId}/home/devices`);

export const saveHomeDevices = (body) =>
  request("PUT", `api/households/${state.householdId}/home/devices`, body);

export const cameraUrl = (entityId) =>
  state.display
    ? `api/display/home/camera/${encodeURIComponent(entityId)}.jpg?token=${encodeURIComponent(state.display.token)}`
    : `api/households/${state.householdId}/home/camera/${encodeURIComponent(entityId)}.jpg`;
