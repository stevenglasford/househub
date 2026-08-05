// config.js — single place where every environment-dependent value is resolved.
//
// The rule: nothing about a particular household, machine or deployment is
// hardcoded anywhere else in the server. If you would otherwise edit a .js file
// to change a value between installs, that value belongs here instead.
//
// Everything has a working default, so the app still runs with no .env at all.
// See .env.example for the full list.
//
// Note: the Home Assistant credentials (HA_URL / HA_TOKEN) and the Siri
// Shortcuts apiToken are deliberately NOT here. HA config lives in
// homeassistant.js because the token must never reach the browser; the
// Shortcuts token is per-install data generated into the datastore. This file
// only holds settings that are safe to compute from the environment.

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

/* ---------- helpers ---------- */

// Resolve a path from env: absolute wins, relative is relative to server/.
const p = (val, fallback) => {
  const v = (val ?? "").trim() || fallback;
  return isAbsolute(v) ? v : resolve(DIR, v);
};

// Empty / unset must fall through to the default. Number("") is 0 and passes
// isFinite, so check for a non-empty string before coercing.
const num = (val, fallback) => {
  const raw = (val ?? "").toString().trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (val, fallback) => {
  const v = (val ?? "").toString().trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
};

const str = (val, fallback) => {
  const v = (val ?? "").toString().trim();
  return v || fallback;
};

const oneOf = (val, allowed, fallback) => {
  const v = (val ?? "").toString().trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
};

const csv = (val, fallback) => {
  const v = (val ?? "").toString().trim();
  if (!v) return fallback;
  return v.split(",").map((x) => x.trim()).filter(Boolean);
};

/* ---------- server ---------- */

export const PORT = num(process.env.PORT, 4000);
export const HOST = str(process.env.HOST, "0.0.0.0");
export const REFRESH_MINUTES = num(process.env.REFRESH_MINUTES, 15);

// Where the SQLite database lives, and the legacy JSON store to import from
// on first boot if the DB is empty.
export const DB_FILE = p(process.env.DB_FILE, "./hub.db");
export const LEGACY_JSON = p(process.env.DATA_FILE, "./data.json");

// Directory of built frontend assets served by Express.
export const PUBLIC_DIR = p(process.env.PUBLIC_DIR, "./public");

// Max size of an incoming JSON body. Calendar ICS text can be large.
export const BODY_LIMIT = str(process.env.BODY_LIMIT, "5mb");

// Timeout (ms) when fetching a subscribed calendar feed.
export const ICS_FETCH_TIMEOUT_MS = num(process.env.ICS_FETCH_TIMEOUT_MS, 15000);

/* ---------- seed defaults for a brand-new install ---------- */

// Household members for a fresh database, as "Name:#hexcolor" pairs.
//   HOUSEHOLD_PEOPLE="Alex:#2E9187,Sam:#E86A4C"
// Colors are optional and fall back to a rotating palette.
const PALETTE = ["#2E9187", "#E86A4C", "#4C6FE8", "#B8873A", "#7A4CE8", "#3A9B5C"];

function parsePeople(raw) {
  const v = (raw ?? "").trim();
  if (!v) return [];
  return v
    .split(",")
    .map((chunk, i) => {
      const [name, color] = chunk.split(":").map((x) => (x ?? "").trim());
      if (!name) return null;
      return { name, color: color || PALETTE[i % PALETTE.length] };
    })
    .filter(Boolean);
}

// Resolved fresh — env can change between calls in tests, and this is cheap.
export function seedDefaults() {
  return {
    householdName: str(process.env.HOUSEHOLD_NAME, "Our Household"),
    people: parsePeople(process.env.HOUSEHOLD_PEOPLE),
    groceryStores: csv(process.env.GROCERY_STORES, ["Costco", "Aldi", "Target"]),
    weather: {
      lat: num(process.env.WEATHER_LAT, 44.98),
      lon: num(process.env.WEATHER_LON, -93.27),
      label: str(process.env.WEATHER_LABEL, "Minneapolis"),
      unit: oneOf(process.env.WEATHER_UNIT, ["f", "c"], "f"),
    },
    layoutMode: oneOf(process.env.DEFAULT_LAYOUT_MODE, ["auto", "wall", "compact"], "auto"),
    noteDisplay: oneOf(process.env.DEFAULT_NOTE_DISPLAY, ["overlay", "row", "off"], "overlay"),
    showBreakdown: bool(process.env.DEFAULT_SHOW_BREAKDOWN, true),
  };
}

/* ---------- values handed to the browser ---------- */

// Exposed at GET /api/config so the frontend never hardcodes an endpoint.
// Only non-secret, display-level settings belong here.
export function clientConfig() {
  const d = seedDefaults();
  return {
    weatherApiBase: str(process.env.WEATHER_API_BASE, "https://api.open-meteo.com/v1/forecast"),
    geocodeApiBase: str(process.env.GEOCODE_API_BASE, "https://geocoding-api.open-meteo.com/v1/search"),
    weatherEnabled: bool(process.env.WEATHER_ENABLED, true),
    defaultWeather: d.weather,
    defaultHouseholdName: d.householdName,
    pollSeconds: num(process.env.CLIENT_POLL_SECONDS, 60),
  };
}
