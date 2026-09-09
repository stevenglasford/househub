// document.js — the shape of the household document, and the logic that seeds
// and migrates it. This is storage-agnostic: both the SQLite store (store.js)
// and the plain JSON store (store-json.js) import from here, so the two can
// never drift apart.
//
// Every value that a fresh install seeds — household name, members, weather
// location, grocery stores, display defaults — comes from config.js, which
// reads the environment. Nothing about a particular household is hardcoded.

// Runs in the browser now, not on the server: this document is sealed before it
// is ever sent anywhere, so its shape and its migrations are the client's job.
// Nothing here may import from the server.

const seedDefaults = () => ({
  householdName: "Our home",
  people: [],
  groceryStores: ["Any"],
  weather: { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "fahrenheit" },
  layoutMode: "auto",
  noteDisplay: "overlay",
  showBreakdown: true,
});

export const uid = () => Math.random().toString(36).slice(2, 9);

// Kept for documents written by older versions, which carried a voice-endpoint
// token in the document itself. New installs authenticate every route properly,
// so nothing generates one any more -- but normalize() must not choke on it.
export const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* Meals used to be one dish per slot for the whole household, with separate
   cooks/times maps hanging off the day. That assumed everyone eats the same
   thing, which isn't true for breakfast and lunch. Each slot is now a list of
   entries, so two people can have different meals — or the same shared one. */
export function migrateMeals(meals) {
  const out = {};
  for (const [date, day] of Object.entries(meals || {})) {
    if (!day || typeof day !== "object") continue;
    const cooks = day.cooks || {};
    const times = day.times || {};
    const fresh = {};
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const v = day[slot];
      if (Array.isArray(v)) {
        fresh[slot] = v;                                  // already migrated
      } else if (typeof v === "string" && v.trim()) {
        fresh[slot] = [{
          id: uid(), title: v.trim(), personId: "", togo: false,
          time: times[slot] || "", cookId: cooks[slot] || "",
        }];
      }
    }
    if (Object.keys(fresh).length) out[date] = fresh;
  }
  return out;
}

const defaultJars = () => [
  { id: "cheap", name: "Cheap", color: "#2E9187" },
  { id: "long", name: "Long", color: "#5D6FE0" },
  { id: "fancy", name: "Fancy", color: "#C98A2B" },
];

const defaultCheckin = () => ({
  offsetMinutes: 45, anchorPersonId: "", workCalendarId: "", workMatch: "work",
  fallbackTime: "20:00", soundOn: true, overrides: {}, log: {},
});

// A brand-new install. All household-specific values come from config (env).
export function seed() {
  const d = seedDefaults();
  const people = d.people.length
    ? d.people.map((p) => ({ id: uid(), name: p.name, color: p.color }))
    : [];
  // A couple of starter chores only make sense if we know who's in the house.
  const chores = people.length
    ? [
        { id: uid(), title: "Feed pets", personId: people[0].id, done: {} },
        { id: uid(), title: "Dishes", personId: people[Math.min(1, people.length - 1)].id, done: {} },
        { id: uid(), title: "Take out trash", personId: "", done: {} },
      ]
    : [];
  return {
    householdName: d.householdName,
    people,
    events: [],                // hub-local one-off events (editable)
    // { "YYYY-MM-DD": { breakfast: [entry], lunch: [entry], dinner: [entry] } }
    // entry = { id, title, personId, togo, time, cookId }
    meals: {},
    chores,
    tasks: [],                 // { id, title, personId, date, done }
    projects: [],              // { id, title, notes, percent, dates[], stages[], personId, createdOn, doneOn }
    grocery: [],               // { id, title, qty, aisle, store, done, boughtAt }
    groceryStores: [...d.groceryStores],
    grocerySort: "aisle",      // aisle | store
    groceryHistory: {},        // { key: { title, last, count, store, aisle } }
    notes: [],                 // { id, text, color, personId, at }
    dates: [],                 // { id, title, date, annual }
    agenda: [],                // { id, text, personId, category, at, resolved }
    agendaArchive: [],         // [{ date, items: [...] }]
    status: {},                // status[date][personId] = { happiness, connection, intimacy }
    agendaPrompts: [],
    dateJars: defaultJars(),
    dateIdeas: [],             // { id, text, jarId, personId, notes, addedOn, drawnAt, doneCount, lastDoneOn, retired }
    weather: { ...d.weather },
    layoutMode: d.layoutMode,  // auto | wall | compact
    noteDisplay: d.noteDisplay, // overlay | row | off
    checkin: defaultCheckin(),
    showBreakdown: d.showBreakdown,
    homeEntities: [],          // HA entity_ids to show on the Home tab, in order
    homeDashboardUrl: "",      // optional link out to HA's own dashboard
    upNextSources: null,       // null/empty = every source
    calendars: [],             // { id, name, color, personId, url, icsText, lastSync, error }
    secondBlock: {},           // filterId -> { kind, picks[] } for the extra Today row
    lists: [],                 // { id, title, icon, color, items[], createdOn, updatedOn }
    // Shared reminder snoozes: { "c<choreId>" | "t<taskId>": epochMs }.
    //
    // In the document rather than in each browser's local storage, because the
    // document is what syncs. A snooze that lived on one device would leave the
    // wall tablet still chiming after somebody silenced it on their phone, and
    // the reminder would have to be dismissed once per screen in the house.
    alertSnooze: {},
    // Optional phone reminders, sent by the browser straight to a push service
    // the household runs. Off unless somebody turns it on -- see lib/relay.js
    // for what each party learns.
    reminderRelay: { enabled: false, endpoint: "", priority: "default" },
    alertRelayed: {},          // { alertKey: escalationStep } -- stops duplicate sends
    noteDrift: false,          // gentle idle wander for the sticky notes
    // Kitchen timers. In the document rather than per-device for the same
    // reason snoozes are: a timer started in the kitchen has to be visible from
    // a phone, and silencing the alarm anywhere has to quiet the tablet too.
    // Only timestamps are stored -- see lib/timers.js for why nothing here is
    // a running/ringing flag.
    timers: [],                // { id, label, durationMs, startedAt, endsAt, pausedAt, remainingMs, silencedAt, personId }
    // When each person last looked at the calendar, so "new" can mean new *to
    // them* rather than merely recent. See lib/new-events.js.
    seenCalendar: {},          // { personId: epochMs }
  };
}

// Fill in fields absent from documents written by older versions. Mutates and
// returns the same object. Mirrors exactly what the JSON store did on load,
// with defaults sourced from config so an upgrade honours the environment.
export function normalize(state) {
  const d = seedDefaults();
  if (!state.meals || typeof state.meals !== "object") state.meals = {};
  state.meals = migrateMeals(state.meals);
  if (!Array.isArray(state.people)) state.people = [];
  if (!Array.isArray(state.events)) state.events = [];
  if (!Array.isArray(state.chores)) state.chores = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.projects)) state.projects = [];
  if (!Array.isArray(state.grocery)) state.grocery = [];
  if (!Array.isArray(state.groceryStores)) state.groceryStores = [...d.groceryStores];
  if (!state.grocerySort) state.grocerySort = "aisle";
  if (!state.groceryHistory || typeof state.groceryHistory !== "object") state.groceryHistory = {};
  if (!Array.isArray(state.notes)) state.notes = [];
  if (!Array.isArray(state.dates)) state.dates = [];
  if (!Array.isArray(state.agenda)) state.agenda = [];
  if (!Array.isArray(state.agendaArchive)) state.agendaArchive = [];
  if (!state.status || typeof state.status !== "object") state.status = {};
  if (!Array.isArray(state.agendaPrompts)) state.agendaPrompts = [];
  if (!Array.isArray(state.dateJars) || !state.dateJars.length) state.dateJars = defaultJars();
  if (!Array.isArray(state.dateIdeas)) state.dateIdeas = [];
  if (!state.weather) state.weather = { ...d.weather };
  if (!state.layoutMode) state.layoutMode = d.layoutMode;
  if (!state.noteDisplay) state.noteDisplay = d.noteDisplay;
  if (!state.checkin || typeof state.checkin !== "object") state.checkin = defaultCheckin();
  if (!state.checkin.overrides) state.checkin.overrides = {};
  if (!state.checkin.log) state.checkin.log = {};
  if (state.showBreakdown === undefined) state.showBreakdown = d.showBreakdown;
  if (!Array.isArray(state.homeEntities)) state.homeEntities = [];
  if (typeof state.homeDashboardUrl !== "string") state.homeDashboardUrl = "";
  if (!Array.isArray(state.calendars)) state.calendars = [];
  if (!state.secondBlock || typeof state.secondBlock !== "object") state.secondBlock = {};
  if (!Array.isArray(state.lists)) state.lists = [];
  if (!state.alertSnooze || typeof state.alertSnooze !== "object") state.alertSnooze = {};
  if (!state.alertRelayed || typeof state.alertRelayed !== "object") state.alertRelayed = {};
  if (!state.reminderRelay || typeof state.reminderRelay !== "object") {
    state.reminderRelay = { ...d.reminderRelay };
  }
  if (state.noteDrift === undefined) state.noteDrift = d.noteDrift;
  if (!Array.isArray(state.timers)) state.timers = [];
  if (!state.seenCalendar || typeof state.seenCalendar !== "object") state.seenCalendar = {};
  // migrate the old single-source field to the multi-select list
  if (state.upNextSources === undefined) {
    state.upNextSources = (state.upNextSource && state.upNextSource !== "all")
      ? [state.upNextSource] : null;
  }
  delete state.upNextSource;
  return state;
}
