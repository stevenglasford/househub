// camwatch.js — a household's own CamWatch security system.
//
// CamWatch is a separate project: Python, YOLOv8 object detection, InsightFace
// recognition, its own recordings on its own disk. It is not absorbed here and
// it should not be -- it needs GPUs and a vision stack that has no business
// inside a Node process, and it is genuinely useful on its own.
//
// HouseHub plugs into a running instance, the same way it plugs into Home
// Assistant. What that buys a household:
//
//   - cameras on the wall display without that tablet holding CamWatch's
//     password, so revoking the display revokes the cameras
//   - alerts alongside the rest of the evening, rather than in another tab
//   - one place to see the house, on the screen already by the door
//
// WHAT IS DELIBERATELY NOT DONE. No footage, snapshot, face or recording is
// stored here. Everything is proxied on demand and forgotten. Face data in
// particular is biometric information under GDPR Article 9, and the right place
// for it is the machine the household already trusts with it -- copying it into
// a second system to make a thumbnail load faster would be a bad trade.
//
// CamWatch authenticates with one shared password and a session cookie. That is
// its design, not one we can change from here, so the password is sealed under
// the server key and the session is cached in memory rather than handed out.

import { q } from "../db/pool.js";
import { seal, openText } from "../crypto/seal.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// householdId -> { cookie, at }
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

export class CamWatchError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.status = status;
  }
}

/**
 * CamWatch lives on the household's own network, so the SSRF blocklist that
 * guards calendar feeds cannot apply -- a private address is the normal case.
 * Loopback and link-local are still refused: those are the HouseHub server
 * itself and the cloud metadata endpoint.
 */
export async function assertReachableTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new CamWatchError("That is not a valid URL", { status: 400 }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new CamWatchError("CamWatch must be an http:// or https:// address", { status: 400 });
  }

  const host = u.hostname;
  let addresses;
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  } catch {
    throw new CamWatchError(`Could not resolve ${host}`, { status: 400 });
  }
  for (const a of addresses) {
    if (/^127\./.test(a) || a === "::1" || /^169\.254\./.test(a)) {
      throw new CamWatchError(
        "That address points at the HouseHub server itself, not at CamWatch. " +
        "Use the address other devices on your network use.",
        { status: 400 }
      );
    }
  }
  return u;
}

/* ------------------------------------------------------------- config ----- */

export async function getConfig(householdId) {
  const { rows } = await q(
    `SELECT url_enc, password_enc, cameras, show_alerts, show_faces, show_recordings,
            last_ok_at, last_error
       FROM household_cameras WHERE household_id = $1`,
    [householdId]
  );
  if (!rows[0]) return null;
  try {
    return {
      url: openText("camUrl", rows[0].url_enc, householdId),
      password: openText("camPassword", rows[0].password_enc, householdId),
      cameras: rows[0].cameras || [],
      showAlerts: rows[0].show_alerts,
      showFaces: rows[0].show_faces,
      showRecordings: rows[0].show_recordings,
      lastOkAt: rows[0].last_ok_at,
      lastError: rows[0].last_error,
    };
  } catch {
    return null;
  }
}

export async function saveConfig(householdId, patch, actorId) {
  await assertReachableTarget(patch.url);
  const existing = await getConfig(householdId);
  const password = patch.password || existing?.password;
  if (!password) throw new CamWatchError("A password is needed the first time you connect", { status: 400 });

  // Proven before it is stored. A connection that looks configured and is not
  // fails at the moment somebody glances at the screen to check the back garden.
  await login({ url: patch.url, password });

  await q(
    `INSERT INTO household_cameras
       (household_id, url_enc, password_enc, cameras, show_alerts, show_faces, show_recordings,
        configured_by, last_ok_at, last_error, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8, now(), NULL, now())
     ON CONFLICT (household_id) DO UPDATE SET
       url_enc = EXCLUDED.url_enc,
       password_enc = EXCLUDED.password_enc,
       cameras = COALESCE(EXCLUDED.cameras, household_cameras.cameras),
       show_alerts = EXCLUDED.show_alerts,
       show_faces = EXCLUDED.show_faces,
       show_recordings = EXCLUDED.show_recordings,
       configured_by = EXCLUDED.configured_by,
       last_ok_at = now(), last_error = NULL, updated_at = now()`,
    [householdId, seal("camUrl", patch.url, householdId), seal("camPassword", password, householdId),
     patch.cameras ? JSON.stringify(patch.cameras) : null,
     patch.showAlerts ?? true, patch.showFaces ?? false, patch.showRecordings ?? false, actorId]
  );
  sessions.delete(householdId);
}

export async function removeConfig(householdId) {
  await q("DELETE FROM household_cameras WHERE household_id = $1", [householdId]);
  sessions.delete(householdId);
}

/* ------------------------------------------------------------ transport --- */

async function login({ url, password }) {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    if (err.cause?.code === "ECONNREFUSED") {
      throw new CamWatchError("Nothing is listening at that address. Check the URL and port.", { status: 400 });
    }
    throw new CamWatchError("Could not reach CamWatch", { status: 503 });
  });

  if (res.status === 401) throw new CamWatchError("CamWatch rejected that password", { status: 400 });
  if (!res.ok) throw new CamWatchError(`CamWatch returned ${res.status}`);

  const cookie = res.headers.get("set-cookie");
  const token = /session_token=([^;]+)/.exec(cookie || "")?.[1];
  if (!token) throw new CamWatchError("CamWatch did not return a session");
  return `session_token=${token}`;
}

/** A live session for this household, logging in again when it ages out. */
async function sessionFor(householdId, config) {
  const hit = sessions.get(householdId);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.cookie;

  const cookie = await login(config);
  sessions.set(householdId, { cookie, at: Date.now() });
  return cookie;
}

/**
 * Call CamWatch on a household's behalf.
 *
 * `raw` returns the Response, for streams and images that must be piped rather
 * than buffered -- an MJPEG stream never ends, so reading it into memory would
 * be a slow way to run out of it.
 */
export async function call(householdId, path, { raw = false, method = "GET", body = null, timeoutMs = 15_000, signal } = {}) {
  const config = await getConfig(householdId);
  if (!config) throw new CamWatchError("Cameras are not connected for this household", { status: 503 });

  const attempt = async (cookie) => fetch(`${config.url.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    // A stream lives as long as the viewer watches it, so it gets the caller's
    // abort signal rather than a timeout.
    signal: signal || AbortSignal.timeout(timeoutMs),
  });

  let cookie = await sessionFor(householdId, config);
  let res = await attempt(cookie);

  // The cached session expired on CamWatch's side; log in once and retry.
  if (res.status === 401) {
    sessions.delete(householdId);
    cookie = await sessionFor(householdId, config);
    res = await attempt(cookie);
  }

  if (!res.ok) {
    await q("UPDATE household_cameras SET last_error = $2 WHERE household_id = $1",
      [householdId, `CamWatch returned ${res.status}`]).catch(() => {});
    throw new CamWatchError(`CamWatch returned ${res.status}`, { status: res.status === 404 ? 404 : 502 });
  }
  return raw ? res : res.json();
}

/* -------------------------------------------------------------- surface --- */

export async function listCameras(householdId) {
  const config = await getConfig(householdId);
  const all = await call(householdId, "/api/cameras");
  const chosen = config?.cameras || [];
  // An empty selection means "all", so a household that connects and does
  // nothing else still sees its cameras.
  const filtered = chosen.length
    ? all.filter((c) => chosen.includes(String(c.id)))
    : all;
  return filtered.map((c) => ({
    id: String(c.id),
    name: c.name,
    enabled: c.enabled !== false,
  }));
}

export async function status(householdId) {
  try {
    const s = await call(householdId, "/api/status", { timeoutMs: 8000 });
    await q("UPDATE household_cameras SET last_ok_at = now(), last_error = NULL WHERE household_id = $1",
      [householdId]).catch(() => {});
    return { ok: true, ...s };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listAlerts(householdId, { limit = 50 } = {}) {
  const config = await getConfig(householdId);
  if (!config?.showAlerts) throw new CamWatchError("Alerts are not enabled for this household", { status: 403 });
  const alerts = await call(householdId, `/api/alerts?limit=${Math.min(200, limit)}`);
  const chosen = config.cameras || [];
  return (Array.isArray(alerts) ? alerts : alerts?.alerts || [])
    .filter((a) => !chosen.length || chosen.includes(String(a.camera_id)));
}

/** Whether a camera is one this household chose to surface. */
export async function isAllowedCamera(householdId, cameraId) {
  const config = await getConfig(householdId);
  if (!config) return false;
  const chosen = config.cameras || [];
  return !chosen.length || chosen.includes(String(cameraId));
}
