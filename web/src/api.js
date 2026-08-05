// Thin wrapper over the backend REST API.
// URLs are relative (no leading slash) so the app works both at the domain
// root and behind a prefix-stripping reverse proxy (e.g. nginx at /hub/).
// Everything the UI edits lives in one document, saved with PUT /api/state.
// Calendar feeds are the exception: the server fetches and caches those, so the
// browser only asks for the expanded events.

const j = async (res) => {
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch (_) {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
};

export const loadState = () => fetch("api/state").then(j);

export const saveState = (state) =>
  fetch("api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).then(j);

export const loadCalendarEvents = () => fetch("api/calendar-events").then(j);

export const addCalendar = (body) =>
  fetch("api/calendars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(j);

export const refreshCalendar = (id) =>
  fetch(`api/calendars/${id}/refresh`, { method: "POST" }).then(j);

export const deleteCalendar = (id) =>
  fetch(`api/calendars/${id}`, { method: "DELETE" }).then(j);

export const loadConfig = () => fetch("api/config").then(j);
