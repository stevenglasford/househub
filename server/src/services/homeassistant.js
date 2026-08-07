// homeassistant.js — read-only bridge to Home Assistant.
//
// The long-lived access token lives here on the server and is never sent to a
// browser. That matters for two reasons:
//   1. It's a full-access credential — anything holding it can control the house.
//   2. HA's camera URLs don't accept long-lived tokens as a ?token= query param
//      (that only works with short-lived tokens that expire in minutes), so a
//      browser can't fetch snapshots directly anyway. Proxying solves both.
//
// Configure with environment variables:
//   HA_URL=http://192.168.1.50:8123
//   HA_TOKEN=<long-lived access token from your HA profile page>

const HA_URL = (process.env.HA_URL || "").replace(/\/+$/, "");
const HA_TOKEN = process.env.HA_TOKEN || "";

// How long to reuse a response before asking HA again. Keeps a wall display
// polling every second or two from hammering the HA instance.
const STATE_TTL_MS = 4000;
const SNAPSHOT_TTL_MS = 1000;

export const isConfigured = () => Boolean(HA_URL && HA_TOKEN);

let stateCache = { at: 0, data: null };
const snapCache = new Map(); // entityId -> { at, buf, type }

async function haFetch(path, { raw = false, timeoutMs = 8000, method = "GET", body = null } = {}) {
  if (!isConfigured()) throw new Error("Home Assistant isn't configured on the server");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HA_URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Home Assistant returned ${res.status}`);
    return raw ? res : res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Home Assistant didn't respond in time");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Quick reachability probe for the settings screen.
export async function ping() {
  const j = await haFetch("/");
  return { ok: true, message: j?.message || "running" };
}

/* Trim HA's state objects down to what a dashboard actually renders. A full
   /api/states payload on a busy install is hundreds of KB of attributes we'd
   throw away, and shipping all of it to a tablet every few seconds is waste. */
function slim(e) {
  const a = e.attributes || {};
  const out = {
    id: e.entity_id,
    domain: e.entity_id.split(".")[0],
    name: a.friendly_name || e.entity_id,
    state: e.state,
  };
  if (a.device_class) out.deviceClass = a.device_class;
  if (a.unit_of_measurement) out.unit = a.unit_of_measurement;
  if (typeof a.brightness === "number") out.brightness = Math.round((a.brightness / 255) * 100);
  if (Array.isArray(a.rgb_color)) out.rgb = a.rgb_color;
  if (a.current_temperature !== undefined) out.currentTemp = a.current_temperature;
  if (a.entity_picture) out.hasPicture = true;
  return out;
}

// Domains worth surfacing on a household display. Anything else (automations,
// update entities, diagnostics, the hundreds of `sensor.*_uptime` style
// entities) is noise here.
const USEFUL_DOMAINS = new Set([
  "light", "switch", "scene", "lock", "cover", "fan", "climate",
  "binary_sensor", "sensor", "camera", "media_player", "person", "device_tracker",
]);

export async function getStates({ only = null, allDomains = false } = {}) {
  const now = Date.now();
  if (!stateCache.data || now - stateCache.at > STATE_TTL_MS) {
    const raw = await haFetch("/states");
    stateCache = { at: now, data: Array.isArray(raw) ? raw : [] };
  }
  let list = stateCache.data;
  if (!allDomains) list = list.filter((e) => USEFUL_DOMAINS.has(e.entity_id.split(".")[0]));
  let slimmed = list.map(slim);
  if (Array.isArray(only) && only.length) {
    const want = new Set(only);
    slimmed = slimmed.filter((e) => want.has(e.id));
    // preserve the user's chosen order rather than HA's alphabetical one
    slimmed.sort((a, b) => only.indexOf(a.id) - only.indexOf(b.id));
  }
  return slimmed;
}

/* Fetch a camera still. Snapshots rather than a live stream is deliberate:
   they're a fraction of the CPU, survive a dropped connection by simply
   showing a slightly older frame, and need no video decoder on the display. */
export async function getSnapshot(entityId) {
  if (!/^camera\.[a-z0-9_]+$/i.test(entityId)) throw new Error("Not a camera entity");
  const cached = snapCache.get(entityId);
  const now = Date.now();
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached;

  const res = await haFetch(`/camera_proxy/${encodeURIComponent(entityId)}`, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const entry = { at: now, buf, type: res.headers.get("content-type") || "image/jpeg" };
  snapCache.set(entityId, entry);
  return entry;
}

/* ---------------------------------------------------------------- control ---
 *
 * The original hub was display-only, and said so: "a stray tap on a wall-mounted
 * screen can't unlock a door." That was the right instinct and slightly too
 * broad -- a visitor turning the hall light on, or glancing at the garden camera
 * to see where the dogs are, is exactly what a screen by the door is for.
 *
 * So control is split by consequence rather than switched on wholesale:
 *
 *   light, switch, fan, cover   reversible, visible, low stakes -- a display may
 *   lock                        physical access to the house -- members only
 *
 * The lock rule is enforced in routes/home.js against the *caller*, not here, so
 * that no display capability list can ever grant it.
 */

const SERVICES = {
  light:  { on: "turn_on", off: "turn_off", toggle: "toggle" },
  switch: { on: "turn_on", off: "turn_off", toggle: "toggle" },
  fan:    { on: "turn_on", off: "turn_off", toggle: "toggle" },
  cover:  { on: "open_cover", off: "close_cover", toggle: "toggle" },
  // "on" means unlocked, matching how Home Assistant reports lock state.
  lock:   { on: "unlock", off: "lock" },
};

/** Domains a display may ever be granted. Locks are deliberately absent. */
export const DISPLAY_CONTROLLABLE = ["light", "switch", "fan", "cover"];

/** Domains that require a signed-in member, whatever else is configured. */
export const MEMBER_ONLY_DOMAINS = ["lock"];

export const domainOf = (entityId) => String(entityId || "").split(".")[0];

export function isControllable(entityId) {
  return Boolean(SERVICES[domainOf(entityId)]);
}

export async function callService(entityId, action = "toggle") {
  const domain = domainOf(entityId);
  const map = SERVICES[domain];
  if (!map) throw new Error(`${domain || "That"} cannot be switched from here`);

  const service = map[action] || map.toggle;
  if (!service) throw new Error(`Cannot ${action} a ${domain}`);

  await haFetch(`/services/${domain}/${service}`, {
    method: "POST",
    body: { entity_id: entityId },
  });

  // The cached state is stale the instant we change something; drop it so the
  // next poll reflects reality rather than showing the light still off.
  stateCache = { at: 0, data: null };
  return { entityId, domain, service };
}
