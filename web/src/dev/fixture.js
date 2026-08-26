// fixture.js — a believable household, for the no-login dev sandbox.
//
// Shapes here must match lib/document.js. They are deliberately varied rather
// than minimal: every branch of the UI that only shows up with real data --
// a rotation mid-cycle, a chore someone else covered, a note about to expire,
// a project part-done -- needs an example or it never gets looked at.

import { dueOn } from "../lib/cadence.js";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayFrom = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return ymd(d);
};

const TODAY = dayFrom(0);
const P = { ryan: "p-ryan", sam: "p-sam", kid: "p-kid" };
const U = { ryan: "u-ryan", sam: "u-sam" };

// A signed-in completion: locked, attributable, and not editable after the fact.
const byUser = (personId, userId, at) => ({
  by: personId, actorUserId: userId, byType: "user",
  source: null, at: at || Date.now(), locked: true,
});
// A shared screen: nobody knows who pressed it, so it stays correctable.
const byDisplay = (personId) => ({
  by: personId, actorUserId: null, byType: "display",
  source: "Kitchen wall", at: Date.now(), locked: false, presumed: true,
});

export function fixtureDoc() {
  const doc = {
    householdName: "Preston Road",
    people: [
      { id: P.ryan, name: "Ryan", color: "#2E9187", userId: U.ryan },
      { id: P.sam, name: "Sam", color: "#C98A2B", userId: U.sam },
      { id: P.kid, name: "Alex", color: "#5D6FE0" },
    ],

    events: [
      { id: "e1", title: "Dentist", date: TODAY, time: "09:30", personId: P.sam },
      { id: "e2", title: "Alex football", date: TODAY, time: "17:00", personId: P.kid },
      { id: "e3", title: "Dinner with the Hales", date: dayFrom(2), time: "19:00", personId: "" },
      { id: "e4", title: "Car service", date: dayFrom(5), time: "08:00", personId: P.ryan },
    ],

    meals: {
      [TODAY]: {
        breakfast: [{ id: "m1", title: "Porridge", personId: P.ryan, togo: false, time: "07:30", cookId: P.ryan }],
        lunch: [{ id: "m2", title: "Leftover curry", personId: P.sam, togo: true, time: "12:30", cookId: "" }],
        dinner: [{ id: "m3", title: "Roast chicken", personId: "", togo: false, time: "18:30", cookId: P.sam }],
      },
      [dayFrom(1)]: {
        dinner: [{ id: "m4", title: "Tacos", personId: "", togo: false, time: "18:30", cookId: P.ryan }],
      },
    },

    chores: [
      // Plain daily, already done today by a signed-in person.
      { id: "c1", title: "Feed the cat", personId: P.kid, cadence: { type: "daily" },
        done: { [TODAY]: byUser(P.kid, null), [dayFrom(-1)]: byUser(P.kid, null) } },

      /* Interval with an explicit start -- the "I did it today, shift the
         pattern" case from lib/cadence.js. Also the one carrying a standing
         checklist and a couple of dated notes, so the chore-day sheet has
         something in every section it can render. */
      { id: "c2", title: "Take the bins out", personId: P.ryan,
        cadence: { type: "interval", everyN: 2, start: dayFrom(-2) },
        checklist: ["Black bin to the kerb", "Recycling box on top", "Bring the caddy back in"],
        notes: {
          [dayFrom(-4)]: "Lorry never came — left it out overnight.",
          [dayFrom(-8)]: "Ran out of blue bags, took the box instead.",
        },
        done: {} },

      // Weekly on specific days.
      { id: "c3", title: "Hoover downstairs", personId: P.sam,
        cadence: { type: "weekly", days: [1, 4] }, done: {} },

      // Monthly.
      { id: "c4", title: "Change the water filter", personId: "",
        cadence: { type: "monthly", dayOfMonth: 15 }, done: {} },

      /* Per-person: the day decides the person, not a rotation. `rotation` is
         still populated because that is the only way the app itself can produce
         one -- the editor offers "Each person's own day" only when a rotation of
         two or more exists, and iterates it to draw the day pickers. A fixture
         without it renders fine but cannot be edited, which is a state the app
         cannot actually reach. */
      { id: "c5", title: "Kitchen deep clean", rotation: [P.ryan, P.sam],
        cadence: { type: "perPerson", people: { [P.ryan]: { days: [1] }, [P.sam]: { days: [5] } } },
        done: {} },

      // A rotation mid-cycle, with one turn covered by somebody else.
      { id: "c6", title: "Dishes", rotation: [P.ryan, P.sam, P.kid], cadence: { type: "daily" },
        done: {
          [dayFrom(-1)]: { ...byUser(P.sam, U.sam), onBehalfOf: P.ryan },
          [dayFrom(-2)]: byDisplay(P.kid),
        } },

      // Ticked from the wall display: correctable, because a screen only knows
      // that somebody pressed it.
      { id: "c7", title: "Lock up", personId: "", cadence: { type: "daily" },
        done: { [dayFrom(-1)]: byDisplay(P.ryan) } },
    ],

    tasks: [
      { id: "t1", title: "Ring the plumber", personId: P.ryan, date: TODAY, done: false },
      { id: "t2", title: "Post Alex's form", personId: P.sam, date: dayFrom(-2), done: false },
      { id: "t3", title: "Book the MOT", personId: P.ryan, date: dayFrom(3), done: false },
      { id: "t4", title: "Return the library books", personId: P.kid, date: TODAY, done: true },
    ],

    projects: [
      { id: "pr1", title: "Repaint the hallway", notes: "Two coats, satin.", percent: 40,
        personId: P.ryan, createdOn: dayFrom(-20),
        stages: [
          { id: "s1", title: "Strip wallpaper", done: true, date: dayFrom(-14) },
          { id: "s2", title: "Fill and sand", done: true, date: dayFrom(-7) },
          { id: "s3", title: "First coat", done: false, date: dayFrom(2) },
          { id: "s4", title: "Second coat", done: false, date: dayFrom(6) },
        ] },
      { id: "pr2", title: "Sort the loft", notes: "", percent: 10, personId: "", createdOn: dayFrom(-3), stages: [] },
    ],

    grocery: [
      { id: "g1", title: "Milk", qty: "2", aisle: "Dairy", store: "Any", done: false },
      { id: "g2", title: "Sourdough", qty: "", aisle: "Bakery", store: "Fenwicks", done: false },
      { id: "g3", title: "Washing powder", qty: "", aisle: "Household", store: "Any", done: true, boughtAt: Date.now() - 86400e3 },
      { id: "g4", title: "Coffee beans", qty: "1kg", aisle: "Drinks", store: "Fenwicks", done: false },
    ],
    groceryStores: ["Any", "Fenwicks", "Corner shop"],
    grocerySort: "aisle",
    groceryHistory: {
      milk: { title: "Milk", last: dayFrom(-3), count: 14, store: "Any", aisle: "Dairy" },
    },

    notes: [
      { id: "n1", text: "Bin day moved to Thursday this week", color: "#F6D785", personId: "", at: Date.now() - 3600e3, from: dayFrom(-1), until: dayFrom(2) },
      { id: "n2", text: "Alex needs a packed lunch Friday", color: "#BFE3C8", personId: P.sam, at: Date.now() - 86400e3, from: dayFrom(-1) },
      // Already past its end date -- should be off the board and in history.
      { id: "n3", text: "Parcel with next door", color: "#F2B8B5", personId: P.ryan, at: Date.now() - 6 * 86400e3, from: dayFrom(-6), until: dayFrom(-2) },
    ],

    dates: [
      { id: "d1", title: "Sam's birthday", date: dayFrom(9), annual: true },
      { id: "d2", title: "Anniversary", date: dayFrom(40), annual: true },
    ],

    agenda: [
      { id: "a1", text: "Christmas — whose family this year?", personId: P.ryan, category: "plan", at: Date.now() - 7200e3, resolved: false },
      { id: "a2", text: "The car noise is back", personId: P.sam, category: "house", at: Date.now() - 86400e3, resolved: false },
    ],
    agendaArchive: [
      { date: dayFrom(-4), items: [{ id: "a0", text: "Broadband renewal", personId: P.ryan, category: "money" }] },
    ],
    agendaPrompts: [],

    status: {
      [dayFrom(-1)]: {
        [P.ryan]: { happiness: 4, connection: 4, intimacy: 3 },
        [P.sam]: { happiness: 5, connection: 4, intimacy: 4 },
      },
    },

    dateJars: [
      { id: "cheap", name: "Cheap", color: "#2E9187" },
      { id: "long", name: "Long", color: "#5D6FE0" },
      { id: "fancy", name: "Fancy", color: "#C98A2B" },
    ],
    dateIdeas: [
      { id: "di1", text: "Walk the coast path and chips after", jarId: "cheap", personId: P.ryan, notes: "", addedOn: dayFrom(-30), doneCount: 1, lastDoneOn: dayFrom(-12) },
      { id: "di2", text: "That tasting menu we keep talking about", jarId: "fancy", personId: P.sam, notes: "Book weeks ahead", addedOn: dayFrom(-25), doneCount: 0 },
    ],

    lists: [
      { id: "l1", title: "Films to watch", icon: "Video", color: "#5D6FE0",
        items: [
          { id: "li1", text: "The Zone of Interest", done: false },
          { id: "li2", text: "Past Lives", done: true },
        ], createdOn: dayFrom(-15), updatedOn: dayFrom(-2) },
    ],

    weather: { lat: 44.98, lon: -93.27, label: "Minneapolis", unit: "fahrenheit" },
    layoutMode: "auto",
    noteDisplay: "overlay",
    showBreakdown: true,
    checkin: {
      offsetMinutes: 45, anchorPersonId: P.ryan, workCalendarId: "", workMatch: "work",
      fallbackTime: "20:00", soundOn: true, overrides: {}, log: {},
    },
    homeEntities: [],
    homeDashboardUrl: "",
    upNextSources: null,
    calendars: [
      { id: "cal-work", name: "Ryan — work", color: "#6B7280", personId: P.ryan },
    ],
    secondBlock: {},
    alertSnooze: {},
    reminderRelay: { enabled: false, endpoint: "", priority: "default" },
    alertRelayed: {},
    noteDrift: false,
  };

  // A recurring chore with no history at all reads as centuries overdue, which
  // is not what any real household looks like and would drown out a genuine
  // regression. Fill in the past by the same dueOn() the app uses, so the two
  // can never disagree, and leave the newest turn of one chore open so there is
  // still something overdue to look at.
  const byId = Object.fromEntries(doc.chores.map((c) => [c.id, c]));
  for (const id of ["c3", "c4", "c5"]) {
    const chore = byId[id];
    for (let i = 60; i >= 1; i--) {
      const key = dayFrom(-i);
      if (dueOn(chore, key)) chore.done[key] = byUser(chore.personId || P.sam, U.sam, null);
    }
  }
  // "Hoover downstairs" stays outstanding from its last turn.
  const hoover = byId.c3;
  const openTurn = Object.keys(hoover.done).sort().pop();
  if (openTurn) delete hoover.done[openTurn];

  return doc;
}

// Events that would come from a subscribed .ics feed. Read-only in the UI --
// lib/feed-events.js decorates these.
export function fixtureFeedEvents() {
  // The key is `feedId`, not `calendarId`. services/calendars.js stamps
  // `feedId: row.id` onto every expanded event, and lib/feed-events.js joins on
  // exactly that to recover the person and colour the household assigned. Get
  // the name wrong here and every event silently arrives unowned and grey --
  // which looks identical to the bug this fixture is meant to detect.
  const base = { source: "ics", feedId: "cal-work", calName: "Ryan — work" };
  return [
    { ...base, id: "ics-1", title: "Standup", date: TODAY, time: "09:00", endTime: "09:15",
      allDay: false, location: "Zoom", notes: "Daily sync — standing agenda in the doc." },
    { ...base, id: "ics-2", title: "Sprint review", date: TODAY, time: "15:00", endTime: "16:00",
      allDay: false, location: "Meeting room 2, second floor", notes: "Demo the import flow." },
    { ...base, id: "ics-3", title: "Team offsite", date: dayFrom(3), allDay: true,
      spanDays: 2, spanIndex: 0, location: "Ashdown Park", notes: "" },
    { ...base, id: "ics-4", title: "1:1 with Priya", date: dayFrom(1), time: "11:00", endTime: "11:30",
      allDay: false, location: "", notes: "" },
  ];
}

export const FIXTURE_USER = {
  id: U.ryan, email: "ryan@example.com", displayName: "Ryan",
};
