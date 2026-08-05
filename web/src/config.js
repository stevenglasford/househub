// config.js — runtime configuration for the frontend.
//
// Values come from GET /api/config (served by the backend from its env), so
// changing a weather provider or default location is a server env change and a
// restart — no rebuild, no editing source. Build-time VITE_* vars still win if
// set, and there are hardcoded fallbacks underneath, so the UI renders even if
// /api/config is briefly unreachable.

import { loadConfig } from "./api.js";

const envNum = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Last-resort defaults. Overridden by /api/config on boot.
const FALLBACK = {
  weatherApiBase: import.meta.env.VITE_WEATHER_API_BASE
    || "https://api.open-meteo.com/v1/forecast",
  geocodeApiBase: import.meta.env.VITE_GEOCODE_API_BASE
    || "https://geocoding-api.open-meteo.com/v1/search",
  weatherEnabled: import.meta.env.VITE_WEATHER_ENABLED !== "false",
  defaultWeather: {
    lat: envNum(import.meta.env.VITE_WEATHER_LAT, 44.98),
    lon: envNum(import.meta.env.VITE_WEATHER_LON, -93.27),
    label: import.meta.env.VITE_WEATHER_LABEL || "Minneapolis",
    unit: import.meta.env.VITE_WEATHER_UNIT || "f",
  },
  defaultHouseholdName: import.meta.env.VITE_HOUSEHOLD_NAME || "Our Household",
  pollSeconds: envNum(import.meta.env.VITE_POLL_SECONDS, 60),
};

let current = { ...FALLBACK };

export const getConfig = () => current;

// Called once at startup, before the app renders.
export async function hydrateConfig() {
  try {
    const server = await loadConfig();
    current = {
      ...current,
      ...server,
      defaultWeather: { ...current.defaultWeather, ...(server.defaultWeather || {}) },
    };
  } catch (e) {
    console.warn("Config unavailable, using defaults:", e.message);
  }
  return current;
}
