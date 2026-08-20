// caldav.test.js — two-way calendar sync.
//
// Ryan asked for iCloud sync. Writing to somebody's real calendar is the most
// destructive thing this app does, so the tests here are less about the happy
// path than about the ways it must refuse to act:
//
//   * it must never delete an event HouseHub did not create
//   * it must never overwrite a change somebody made on their phone
//   * it must not treat a Reminders list as somewhere to put an event
//   * it must not follow a redirect into the private network
//
// The network is injected, so every one of these runs against recorded
// iCloud-shaped responses with no account and no connection.

import test from "node:test";
import assert from "node:assert/strict";
import {
  findAll, findText, parseMultistatus, resolveHref, toCalendar,
  toVEvent, nextDay, resourceUrl, planSync, signatureOf,
  putEvent, deleteEvent, discoverCalendars, davRequest,
  uidFor, isOurs, escapeICS, UID_PREFIX,
} from "../src/services/caldav.js";

/* A fetch that answers from a table and records what it was asked. */
function fakeNet(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${new URL(url).pathname}`;
    calls.push({ key, url: String(url), headers: opts.headers || {}, body: opts.body });
    const hit = routes[key] ?? routes[opts.method || "GET"] ?? null;
    if (!hit) return mkRes(404, "");
    return typeof hit === "function" ? hit(calls.length) : hit;
  };
  impl.calls = calls;
  return impl;
}
const mkRes = (status, text, headers = {}) => ({
  status,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  text: async () => text,
});

/* ------------------------------------------------------------------ XML --- */

test("XML is read whatever namespace prefix the server uses", () => {
  // The same document, three ways, all seen in the wild.
  for (const xml of [
    "<d:href>/cal/</d:href>", "<D:href>/cal/</D:href>", "<href>/cal/</href>",
  ]) {
    assert.equal(findText(xml, "href"), "/cal/");
  }
});

test("entities are decoded, and not twice", () => {
  assert.equal(findText("<d:displayname>Ryan &amp; Steven</d:displayname>", "displayname"),
    "Ryan & Steven");
  assert.equal(findText("<d:displayname>&amp;lt;</d:displayname>", "displayname"), "&lt;",
    "an escaped entity must survive one decode, not collapse to a tag");
});

test("a multistatus keeps only the propstats that succeeded", () => {
  /* Servers routinely answer "here is the name (200), and there is no colour
     (404)". Reading the 404 block yields an empty displayname that overwrites
     the real one. */
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>/cal/home/</d:href>
      <d:propstat><d:prop><d:displayname>Home</d:displayname></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      <d:propstat><d:prop><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/></d:prop>
        <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
    </d:response>
  </d:multistatus>`;
  const rows = parseMultistatus(xml);
  assert.equal(rows.length, 1);
  assert.equal(findText(rows[0].props, "displayname"), "Home");
});

test("hrefs resolve against the request URL", () => {
  assert.equal(resolveHref("https://caldav.icloud.com/123/calendars/", "/123/calendars/work/"),
    "https://caldav.icloud.com/123/calendars/work/");
  assert.equal(resolveHref("https://caldav.icloud.com/123/calendars/", "work/"),
    "https://caldav.icloud.com/123/calendars/work/");
});

/* ---------------------------------------------------- calendar detection --- */

const calProps = (name, { comps = ["VEVENT"], privs = null, color = "" } = {}) => ({
  href: `/123/calendars/${name}/`,
  props: `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
    <d:displayname>${name}</d:displayname>
    ${color ? `<ic:calendar-color>${color}</ic:calendar-color>` : ""}
    <c:supported-calendar-component-set>
      ${comps.map((c) => `<c:comp name="${c}"/>`).join("")}
    </c:supported-calendar-component-set>
    ${privs === null ? "" : `<d:current-user-privilege-set>${privs}</d:current-user-privilege-set>`}`,
});

test("a Reminders list is not offered as a calendar", () => {
  /* iCloud exposes Reminders through the same collection. It accepts VTODO and
     refuses VEVENT, so writing an event there fails in a way that reads like a
     permissions problem. */
  const todo = toCalendar(calProps("Reminders", { comps: ["VTODO"] }), "https://caldav.icloud.com/");
  assert.equal(todo, null);

  const events = toCalendar(calProps("Home"), "https://caldav.icloud.com/");
  assert.ok(events);
  assert.equal(events.name, "Home");
});

test("a plain collection is not a calendar", () => {
  const notCal = toCalendar({ href: "/123/calendars/", props: "<d:resourcetype><d:collection/></d:resourcetype>" },
    "https://caldav.icloud.com/");
  assert.equal(notCal, null);
});

test("write permission is read when stated and assumed when not", () => {
  const ro = toCalendar(calProps("Shared", { privs: "<d:privilege><d:read/></d:privilege>" }),
    "https://caldav.icloud.com/");
  assert.equal(ro.writable, false, "read-only must be reported honestly");

  const rw = toCalendar(calProps("Mine", { privs: "<d:privilege><d:write/></d:privilege>" }),
    "https://caldav.icloud.com/");
  assert.equal(rw.writable, true);

  /* Many servers omit the property. Refusing to write to all of them would
     make the feature useless; a real refusal arrives as a 403 on the PUT. */
  assert.equal(toCalendar(calProps("Quiet"), "https://caldav.icloud.com/").writable, true);
});

/* -------------------------------------------------------------- VEVENT --- */

test("a timed event keeps its wall time and its zone", () => {
  // Converting to UTC would make a 7pm dinner drift when the clocks change.
  const ics = toVEvent({ id: "e1", title: "Dinner", date: "2026-09-04", time: "19:00", endTime: "21:00" },
    { tz: "America/Chicago", now: 0 });
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20260904T190000/);
  assert.match(ics, /DTEND;TZID=America\/Chicago:20260904T210000/);
  assert.match(ics, /UID:househub-event-e1/);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/);
});

test("an all-day event ends the following day", () => {
  // All-day DTEND is exclusive; using the same date makes a zero-length event
  // that some clients simply do not draw.
  const ics = toVEvent({ id: "e2", title: "Trip", date: "2026-09-04", allDay: true }, { now: 0 });
  assert.match(ics, /DTSTART;VALUE=DATE:20260904/);
  assert.match(ics, /DTEND;VALUE=DATE:20260905/);
  assert.equal(nextDay("20261231"), "20270101", "and it rolls over a year end");
  assert.equal(nextDay("20260228"), "20260301");
});

test("separators in a title cannot break the field", () => {
  const ics = toVEvent({ id: "e3", title: "Dinner; drinks, then home", date: "2026-09-04", allDay: true }, { now: 0 });
  assert.match(ics, /SUMMARY:Dinner\\; drinks\\, then home/);
});

test("an event with no usable date is refused rather than written", () => {
  assert.throws(() => toVEvent({ id: "e4", title: "Whenever", date: "" }, { now: 0 }));
});

test("the resource URL is built safely from the UID", () => {
  assert.equal(resourceUrl("https://x.test/cal", "househub-event-a1"),
    "https://x.test/cal/househub-event-a1.ics");
  assert.equal(resourceUrl("https://x.test/cal/", "househub-event-a1"),
    "https://x.test/cal/househub-event-a1.ics");
});

/* ------------------------------------------------------------ the guard --- */

test("HouseHub refuses to delete an event it did not create", async () => {
  /* The most important test here. Everything we write is prefixed, and the
     check lives at the only place that can do the damage. */
  await assert.rejects(
    () => deleteEvent("https://x.test/cal/", "8A1B-dentist-appointment", { fetchImpl: fakeNet({}) }),
    /did not create/);

  assert.equal(isOurs("househub-event-1"), true);
  assert.equal(isOurs("random-uid-from-outlook"), false);
  assert.ok(uidFor("event", "abc").startsWith(UID_PREFIX));
});

test("planning a sync never proposes deleting a stranger's event", () => {
  const local = [{ id: "a", title: "Ours", date: "2026-09-01" }];
  const remote = [
    { uid: uidFor("event", "a"), etag: '"1"', signature: signatureOf({ title: "Ours", date: "2026-09-01" }) },
    { uid: "APPLE-GENERATED-DENTIST", etag: '"2"', signature: "x" },
    { uid: uidFor("event", "gone"), etag: '"3"', signature: "y" },
  ];
  const plan = planSync(local, remote);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, [], "an unchanged event is left alone");
  assert.deepEqual(plan.remove.map((r) => r.uid), [uidFor("event", "gone")],
    "only our own orphan is removed; the dentist is not even considered");
});

test("a changed event is updated, a new one created", () => {
  const local = [
    { id: "a", title: "Renamed", date: "2026-09-01" },
    { id: "b", title: "Brand new", date: "2026-09-02" },
  ];
  const remote = [{ uid: uidFor("event", "a"), etag: '"1"', signature: signatureOf({ title: "Old", date: "2026-09-01" }) }];
  const plan = planSync(local, remote);
  assert.deepEqual(plan.create.map((c) => c.uid), [uidFor("event", "b")]);
  assert.deepEqual(plan.update.map((u) => u.uid), [uidFor("event", "a")]);
  assert.equal(plan.update[0].etag, '"1"', "the update carries the etag, so it can be conditional");
});

test("the signature notices what a reader would notice", () => {
  const base = { title: "T", date: "2026-09-01", time: "19:00" };
  assert.equal(signatureOf(base), signatureOf({ ...base, personId: "p9" }),
    "who it belongs to is not written to the remote calendar, so it is not a change");
  assert.notEqual(signatureOf(base), signatureOf({ ...base, time: "20:00" }));
  assert.notEqual(signatureOf(base), signatureOf({ ...base, title: "Other" }));
});

/* ------------------------------------------------------------- writing --- */

test("a new event is written only if it does not already exist", async () => {
  const net = fakeNet({ "PUT /cal/househub-event-e1.ics": mkRes(201, "", { etag: '"abc"' }) });
  const res = await putEvent("https://caldav.icloud.com/cal/", { id: "e1", title: "X", date: "2026-09-01", allDay: true },
    { username: "u", password: "p", fetchImpl: net, now: 0 });

  assert.equal(res.ok, true);
  assert.equal(res.etag, '"abc"');
  assert.equal(net.calls[0].headers["If-None-Match"], "*",
    "without this, a race would silently overwrite whatever was there");
  assert.match(net.calls[0].headers.Authorization, /^Basic /);
});

test("an update is conditional on the etag we last saw", async () => {
  const net = fakeNet({ "PUT /cal/househub-event-e1.ics": mkRes(204, "", { etag: '"v2"' }) });
  await putEvent("https://caldav.icloud.com/cal/", { id: "e1", title: "X", date: "2026-09-01", allDay: true },
    { username: "u", password: "p", etag: '"v1"', fetchImpl: net, now: 0 });
  assert.equal(net.calls[0].headers["If-Match"], '"v1"');
  assert.equal(net.calls[0].headers["If-None-Match"], undefined);
});

test("losing a race is reported, not retried over the top", async () => {
  // 412 means somebody edited it on their phone. Their version is at least as
  // good as ours, so the caller is told rather than the write being forced.
  const net = fakeNet({ "PUT /cal/househub-event-e1.ics": mkRes(412, "") });
  const res = await putEvent("https://caldav.icloud.com/cal/", { id: "e1", title: "X", date: "2026-09-01", allDay: true },
    { username: "u", password: "p", etag: '"stale"', fetchImpl: net, now: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
});

test("a read-only calendar reports a refusal rather than looking like success", async () => {
  const net = fakeNet({ "PUT /cal/househub-event-e1.ics": mkRes(403, "") });
  const res = await putEvent("https://caldav.icloud.com/cal/", { id: "e1", title: "X", date: "2026-09-01", allDay: true },
    { username: "u", password: "p", fetchImpl: net, now: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.forbidden, true);
});

test("deleting something already gone is success, not an error", async () => {
  const net = fakeNet({ "DELETE /cal/househub-event-e1.ics": mkRes(404, "") });
  const res = await deleteEvent("https://caldav.icloud.com/cal/", uidFor("event", "e1"),
    { username: "u", password: "p", fetchImpl: net });
  assert.equal(res.ok, true);
  assert.equal(res.alreadyGone, true);
});

/* ----------------------------------------------------------- discovery --- */

test("discovery walks principal then home then calendars", async () => {
  const principal = `<d:multistatus xmlns:d="DAV:"><d:response>
    <d:href>/.well-known/caldav</d:href>
    <d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const home = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response>
    <d:href>/123/principal/</d:href>
    <d:propstat><d:prop><c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const list = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
    <d:response><d:href>/123/calendars/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>${calProps("Home").href}</d:href>
      <d:propstat><d:prop>${calProps("Home").props}</d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>/123/calendars/Reminders/</d:href>
      <d:propstat><d:prop>${calProps("Reminders", { comps: ["VTODO"] }).props}</d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  </d:multistatus>`;

  const net = fakeNet({
    "PROPFIND /.well-known/caldav": mkRes(207, principal),
    "PROPFIND /123/principal/": mkRes(207, home),
    "PROPFIND /123/calendars/": mkRes(207, list),
  });

  const cals = await discoverCalendars("https://caldav.icloud.com",
    { username: "u@me.com", password: "app-specific", fetchImpl: net });

  assert.equal(cals.length, 1, "the home collection and the Reminders list are both excluded");
  assert.equal(cals[0].name, "Home");
  assert.equal(cals[0].href, "https://caldav.icloud.com/123/calendars/Home/");
});

test("bad credentials say so, rather than failing obscurely", async () => {
  const net = fakeNet({ "PROPFIND /.well-known/caldav": mkRes(401, "") });
  await assert.rejects(
    () => discoverCalendars("https://caldav.icloud.com", { username: "u", password: "wrong", fetchImpl: net }),
    /not accepted/);
});

/* ------------------------------------------------------------- the SSRF --- */

test("a redirect into the private network is refused", async () => {
  /* Following redirects without re-checking is how an SSRF guard gets walked
     past: the first hop is a public host, the second is the metadata service. */
  const net = fakeNet({
    "PROPFIND /.well-known/caldav": mkRes(302, "", { location: "http://169.254.169.254/latest/meta-data/" }),
  });
  await assert.rejects(
    () => davRequest("https://caldav.icloud.com/.well-known/caldav", { fetchImpl: net, body: "", depth: 0 }),
    (err) => /blocked|private|not allowed|link-local|refus/i.test(err.message));
});

test("only http and https are accepted", async () => {
  await assert.rejects(
    () => davRequest("file:///etc/passwd", { fetchImpl: fakeNet({}) }),
    /Only http and https/);
});
