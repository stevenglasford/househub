// mock-session.js — stands in for lib/session.js in the dev sandbox.
//
// session.js is the only module that talks to the network or touches crypto, so
// replacing exactly it -- and nothing above it -- means api.js, App.jsx, every
// component and every lib/* file run as the real thing, with hot reload. What
// you see is the actual UI against a real document; only the transport is fake.
//
// The document lives in localStorage, so edits survive a refresh. Reset it from
// the banner, or in the console:  __hub.reset()
//
// This file is never bundled by `npm run dev` or `npm run build` -- vite.config
// only swaps it in under `--mode sandbox`.

import { normalize } from "../lib/document.js";
import { fixtureDoc, fixtureFeedEvents, FIXTURE_USER } from "./fixture.js";

const KEY = "househub:dev:doc";
const VKEY = "househub:dev:version";

/* ------------------------------------------------------------------ state --- */

/* The sandbox can run as a signed-in member or as a wall display, because the
   two are genuinely different apps: a display's completions are attributable to
   a screen rather than a person, which is what makes them correctable, and it
   is refused locks and writes it has no scope for. Toggle with __hub.display().

   Kept in localStorage so it survives the reload that applies it. */
const DKEY = "househub:dev:display";
const asDisplay = localStorage.getItem(DKEY) === "1";

const state = {
  user: asDisplay ? null : { ...FIXTURE_USER },
  householdId: "hh-dev",
  role: asDisplay ? null : "admin",
  version: Number(localStorage.getItem(VKEY) || 1),
  display: asDisplay
    ? {
        id: "d-kitchen",
        name: "Kitchen wall",
        token: "dev-display-token",
        scopes: ["today", "calendar", "meals", "todos", "grocery", "board", "home"],
        controlDomains: ["light", "cover", "switch", "fan"],   // never "lock"
        canWrite: true,
      }
    : null,
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(snapshot()));

export const snapshot = () => ({
  signedIn: true,
  unlocked: true,
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

export const currentToken = () => "dev-token";
export const householdId = () => state.householdId;
export const isDisplay = () => Boolean(state.display);
export const localVersion = () => state.version;

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}
export { ApiError };

/* --------------------------------------------------------------- the doc --- */

function readDoc() {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through to a fresh one */ }
  }
  const fresh = fixtureDoc();
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return fresh;
}

function writeDoc(doc) {
  state.version += 1;
  localStorage.setItem(KEY, JSON.stringify(doc));
  localStorage.setItem(VKEY, String(state.version));
}

// A touch of latency, so loading states and races are visible rather than
// hidden behind an instant synchronous resolve.
const tick = (value, ms = 90) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export async function loadVault() {
  const doc = await tick(readDoc(), 140);
  emit();
  return normalize(doc);
}

export async function saveVault(doc) {
  await tick(null, 60);
  writeDoc(doc);
  emit();
  return { version: state.version };
}

export const remoteVersion = async () => state.version;
export const listRevisions = async () => [];
export const restoreRevision = async () => readDoc();

export async function syncHouseholdName(name) {
  if (!name) return;
  const doc = readDoc();
  if (doc.householdName !== name) { doc.householdName = name; writeDoc(doc); }
}

/* -------------------------------------------------------------- transport --- */

// Endpoints the UI calls directly. Anything unlisted resolves to null rather
// than throwing: a panel for an integration nobody configured should render its
// empty state, not an error boundary.
const ROUTES = [
  [/api\/config$/, () => ({
    weatherEnabled: true,
    defaultWeather: { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "f" },
    defaultHouseholdName: "Preston Road",
    pollSeconds: 60,
    allowSignup: true,
    publicUrl: "http://localhost:5173",
  })],
  [/calendar-events$/, () => fixtureFeedEvents()],
  [/\/calendars$/, () => [
    { id: "cal-work", last_sync_at: new Date().toISOString(), last_error: null },
  ]],
  [/\/caldav$/, () => ({ accounts: [], calendars: [] })],
  [/\/home$/, () => ({ connected: false, displayDomains: [] })],
  [/api\/ai\/status$/, () => ({ enabled: false, provider: "ollama", model: "llama3.2:3b" })],
  [/api\/auth\/session-policy$/, () => ({ hours: 12 })],
  // `effective` is what the panel prints; `serverDefault` feeds the zone list.
  [/\/timezone$/, () => ({
    timezone: "America/Chicago", serverDefault: "America/Chicago", effective: "America/Chicago",
  })],
  // `status` matters: HouseholdPanel splits on active vs pending, so members
  // without it count as neither and the panel reports "0 people".
  [/\/members$/, () => [
    { userId: "u-ryan", email: "ryan@example.com", displayName: "Ryan", role: "admin", status: "active", hasCurrentKey: true,
      publicKey: "HyYtNDtCSVBXXmVsc3qBiI+WnaSrsrnAx87V3OPq8fg=" },
    { userId: "u-sam", email: "sam@example.com", displayName: "Sam", role: "admin", status: "active", hasCurrentKey: true,
      publicKey: "PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30+wIJEBc=" },
    { userId: "u-alex", email: "alex@example.com", displayName: "Alex", role: "dependant", status: "active", hasCurrentKey: true,
      publicKey: "XWRrcnmAh46VnKOqsbi/xs3U2+Lp8Pf+BQwTGiEoLzY=" },
  ]],
  [/\/invites$/, () => []],
  [/\/displays$/, () => []],
  [/\/proposals$/, () => []],
  [/\/integrations$/, () => []],
];

export async function request(method, path) {
  await tick(null, 50);
  if (method !== "GET") return { ok: true, version: state.version };
  for (const [pattern, handler] of ROUTES) {
    if (pattern.test(path)) return handler();
  }
  return null;
}

/* ------------------------------------------------------------------ actor --- */

export function currentActor(doc) {
  if (state.display) {
    return {
      isDisplay: true, displayId: "d-dev", displayName: state.display.name,
      canWrite: state.display.canWrite, controlDomains: state.display.controlDomains,
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

/* ------------------------------------------------------- everything else --- */
//
// Stubs, so that opening a settings panel shows its real empty state instead of
// crashing. Each returns the shape its caller expects.

const no = async () => null;
const none = async () => [];
const ok = async () => ({ ok: true });

export const register = no;
export const signIn = no;
export const resumeRemembered = no;
export const signOut = async () => { console.info("[sandbox] sign-out is a no-op"); };
export const wipe = () => {};
export const listHouseholds = none;
export const loadMe = async () => state.user;
export const openHousehold = no;
export const createHousehold = no;
export const closeHousehold = () => {};
export const archiveHousehold = ok;
export const deleteHousehold = ok;
export const getSessionPolicy = async () => ({ hours: 12 });
export const setSessionPolicy = ok;

export const wrapForRecipient = no;
export const listMembers = async () => request("GET", "/members");
export const createInvite = async () => ({ token: "dev-invite", url: "http://localhost:5173/join?t=dev-invite" });
export const listInvites = none;
export const revokeInvite = ok;
export const grantAccess = ok;
export const setMemberRole = ok;
export const removeMember = ok;

export const getTimezone = async () => request("GET", "/timezone");
export const setTimezone = ok;

// The check-in question. Local Ollama in the real app; canned here so the
// nightly walkthrough has something to show.
export const generate = async (kind) => {
  await tick(null, 400);
  if (kind === "dateIdeas") {
    return { text: "A drive to somewhere neither of you has been, with no plan past lunch." };
  }
  return { text: "What is something the other person did this week that you noticed but didn't mention?" };
};
export const aiStatus = async () => ({ enabled: false });

// Shapes below mirror what each panel destructures, not what looked plausible.
// A stub that returns the wrong shape crashes the panel, and because
// SettingsModal has no error boundary one bad panel blanks the whole modal.
export const aiProvider = async () => ({
  providerId: "ollama",
  label: "Ollama, on this machine",
  privacy: "Your check-in context never leaves your network.",
  isLocal: true,
  blocked: null,
  selectedLabel: null,
  model: "llama3.2:3b",
  models: ["llama3.2:3b", "qwen3:14b", "qwen2.5-coder:32b"],
  available: [
    { id: "ollama", label: "Ollama, on this machine", isLocal: true },
    { id: "ollama-remote", label: "Ollama on another host", isLocal: false },
    { id: "claude", label: "Claude", isLocal: false },
  ],
});
export const setAiProvider = ok;

export const cameraConfig = async () => ({ connected: false });
export const testCameras = async () => ({ ok: false, error: "No CamWatch in the sandbox" });
export const saveCameras = ok;
export const disconnectCameras = ok;
export const availableCameras = none;
export const listCameras = none;
export const cameraAlerts = none;
export const cameraSnapshotUrl = () => "";
export const cameraStreamUrl = () => "";
export const cameraUrl = () => "";

export const listIntegrations = none;
export const erasurePreview = async () => ({
  willBeDeleted: ["Your account and sign-in", "Your completion history", "Your device keys"],
  willNotBeDeleted: [
    "Your name on Preston Road's calendar — the server cannot read it, so a member has to remove it",
  ],
  blockers: [],
  householdsThatWouldBeLeftEmpty: [],
});
export const downloadAccountExport = async () => { console.info("[sandbox] export is a no-op"); };
export const eraseAccount = ok;

export const listDisplays = none;
export const createDisplay = no;
export const displayPrivateKey = no;
export const approvalProofFor = no;
export const approveDisplay = ok;
export const activateDisplay = no;
export const escrowDisplayLink = ok;
export const openDisplayLink = no;
export const updateDisplay = ok;
export const revokeDisplay = ok;
export const startDisplay = no;
export const forgetDisplay = () => {};

export const listProposals = none;
export const createProposal = ok;
export const decideProposal = ok;
export const markProposalApplied = ok;
export const withdrawProposal = ok;

export const homeEntities = none;
export const homeControl = ok;
export const homeDevices = async () => ({ entities: [], groups: [], rooms: [] });
export const saveHomeDevices = ok;

/* ----------------------------------------------------------------- console --- */

export function resetDoc() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(VKEY);
  location.reload();
}

if (typeof window !== "undefined") {
  window.__hub = {
    reset: resetDoc,
    /** Run the sandbox as a wall display (or back as a member). Reloads. */
    display: (on = true) => {
      if (on) localStorage.setItem(DKEY, "1");
      else localStorage.removeItem(DKEY);
      location.reload();
    },
    isDisplay: () => asDisplay,
    doc: readDoc,
    // Edit the document by hand, e.g. __hub.set(d => { d.chores = []; })
    set: (fn) => { const d = readDoc(); fn(d); writeDoc(d); location.reload(); },
  };
}
