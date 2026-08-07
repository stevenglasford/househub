// homeassistant.js — a bridge to ONE household's Home Assistant.
//
// Every function here takes an explicit connection, and that is the whole point
// of this rewrite. The previous version read HA_URL and HA_TOKEN from the
// environment at import time, so every household on a server saw the same
// house: one family's cameras, lights and door sensors shown to all of them.
// Nobody had hit it because nobody had connected Home Assistant on a shared
// server yet, which is exactly the kind of bug that waits. Configuration is now
// per household (migrations/007) and nothing in this file has a default.
//
// The access token stays server-side and is never sent to a browser, for two
// reasons that have not changed:
//
//   1. It is a full-access credential. Anything holding it can control the
//      house, so it should exist in as few places as possible.
//   2. Home Assistant's camera endpoints reject long-lived tokens as query
//      parameters -- only short-lived ones work that way -- so a browser could
//      not fetch snapshots directly even if we wanted it to. Proxying solves
//      both, and makes a camera tile a plain <img> that keeps working.
//
// Caches are keyed by household, so one family's polling can never serve
// another family's state -- which the single global cache would have done the
// moment a second household connected.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const STATE_TTL_MS = 4000;
const SNAPSHOT_TTL_MS = 1000;

const stateCache = new Map();   // householdId -> { at, data }
const snapCache = new Map();    // `${householdId}:${entityId}` -> { at, buf, type }

/* ---------------------------------------------------------------- fetch --- */

/**
 * Home Assistant almost always lives on a private address, so the SSRF
 * blocklist that guards calendar feeds cannot apply here -- 192.168.x.x is the
 * normal case, not an attack.
 *
 * What stands in for it: only a member of the household can set this URL, it is
 * checked at save time, and the response is only ever parsed as Home Assistant
 * JSON or served as an image. Loopback and link-local are still refused, because
 * those point at the HouseHub server itself and at the cloud metadata endpoint,
 * neither of which is anybody's Home Assistant.
 */
export async function assertReachableTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("That is not a valid URL"); }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Home Assistant must be an http:// or https:// address");
  }

  const host = u.hostname;
  let addresses;
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  } catch {
    throw new Error(`Could not resolve ${host}`);
  }

  for (const address of addresses) {
    if (/^127\./.test(address) || address === "::1" || /^169\.254\./.test(address)) {
      throw new Error(
        "That address points at the HouseHub server itself, not at Home Assistant. " +
        "Use the address other devices on your network use."
      );
    }
  }
  return u;
}

async function haFetch(conn, path, { raw = false, method = "GET", body = null, timeoutMs = 8000 } = {}) {
  if (!conn?.url || !conn?.token) throw new Error("Home Assistant is not connected for this household");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(conn.url).replace(/\/+$/, "")}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Home Assistant rejected the access token. Create a new one and save it again.");
    }
    if (!res.ok) throw new Error(`Home Assistant returned ${res.status}`);
    return raw ? res : res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Home Assistant did not respond in time");
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error("Nothing is listening at that address. Check the URL and port.");
    }
    if (err.cause?.code === "ENOTFOUND") throw new Error("That hostname could not be resolved");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ discovery --- */

/** Prove a URL and token work, and report what was found. Used by setup. */
export async function testConnection({ url, token }) {
  await assertReachableTarget(url);
  const conn = { url, token };
  const info = await haFetch(conn, "/");
  const states = await haFetch(conn, "/states");

  const domains = {};
  for (const s of states) {
    const d = String(s.entity_id).split(".")[0];
    domains[d] = (domains[d] || 0) + 1;
  }
  return { ok: true, message: info?.message || "running", entityCount: states.length, domains };
}

// Noise on a wall display: automations, updates, and the bookkeeping entities
// every integration adds for itself.
const HIDDEN_DOMAINS = new Set([
  "automation", "script", "scene", "update", "persistent_notification",
  "input_boolean", "input_number", "input_select", "input_text", "input_datetime",
  "device_tracker", "zone", "sun", "tts", "conversation", "todo",
  "number", "select", "button", "event",
]);

const friendly = (s) => s.attributes?.friendly_name || s.entity_id;

const shape = (s) => ({
  entityId: s.entity_id,
  domain: String(s.entity_id).split(".")[0],
  name: friendly(s),
  state: s.state,
  unit: s.attributes?.unit_of_measurement || null,
  deviceClass: s.attributes?.device_class || null,
  brightness: s.attributes?.brightness ?? null,
  changedAt: s.last_changed,
});

/** Everything worth offering in the entity picker, grouped and sorted. */
export async function listEntities(conn, { all = false } = {}) {
  const states = await haFetch(conn, "/states");
  return states
    .filter((s) => all || !HIDDEN_DOMAINS.has(String(s.entity_id).split(".")[0]))
    .map(shape)
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** States for the entities a household chose, cached briefly per household. */
export async function getStates(conn, householdId, only = null) {
  const hit = stateCache.get(householdId);
  let all = hit && Date.now() - hit.at < STATE_TTL_MS ? hit.data : null;
  if (!all) {
    all = await haFetch(conn, "/states");
    stateCache.set(householdId, { at: Date.now(), data: all });
  }
  const wanted = only?.length ? new Set(only) : null;
  return all.filter((s) => !wanted || wanted.has(s.entity_id)).map(shape);
}

export const invalidate = (householdId) => stateCache.delete(householdId);

/* -------------------------------------------------------------- cameras --- */

export async function getSnapshot(conn, householdId, entityId) {
  const key = `${householdId}:${entityId}`;
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit;

  const res = await haFetch(conn, `/camera_proxy/${encodeURIComponent(entityId)}`, {
    raw: true, timeoutMs: 6000,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const entry = { at: Date.now(), buf, type: res.headers.get("content-type") || "image/jpeg" };
  snapCache.set(key, entry);

  // Unbounded growth would be a slow leak on a server with many households.
  if (snapCache.size > 200) {
    for (const [k, v] of snapCache) if (Date.now() - v.at > 60_000) snapCache.delete(k);
  }
  return entry;
}

/* -------------------------------------------------------------- control --- */

const SERVICES = {
  light:  { on: "turn_on", off: "turn_off", toggle: "toggle" },
  switch: { on: "turn_on", off: "turn_off", toggle: "toggle" },
  fan:    { on: "turn_on", off: "turn_off", toggle: "toggle" },
  cover:  { on: "open_cover", off: "close_cover", toggle: "toggle" },
  // "on" means unlocked, matching how Home Assistant reports lock state.
  lock:   { on: "unlock", off: "lock" },
};

/** Domains a shared display may ever be granted. Locks are deliberately absent. */
export const DISPLAY_CONTROLLABLE = ["light", "switch", "fan", "cover"];

/** Domains that require a signed-in member, whatever else is configured. */
export const MEMBER_ONLY_DOMAINS = ["lock"];

export const domainOf = (entityId) => String(entityId || "").split(".")[0];
export const isControllable = (entityId) => Boolean(SERVICES[domainOf(entityId)]);

export async function callService(conn, householdId, entityId, action = "toggle") {
  const domain = domainOf(entityId);
  const map = SERVICES[domain];
  if (!map) throw new Error(`${domain || "That"} cannot be switched from here`);

  const service = map[action] || map.toggle;
  if (!service) throw new Error(`Cannot ${action} a ${domain}`);

  await haFetch(conn, `/services/${domain}/${service}`, {
    method: "POST",
    body: { entity_id: entityId },
  });

  invalidate(householdId);   // cached state is stale the instant we change something
  return { entityId, domain, service };
}
