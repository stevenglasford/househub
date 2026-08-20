// caldav.js — two-way calendar sync, for iCloud and anything else that speaks CalDAV.
//
// Ryan: "Make it so that calendars are two way syncable. I know google calendars
// two way sync doesnt really work, but set it up for icloud at least."
//
// He is right about Google. Their CalDAV endpoint requires OAuth with a
// verification review for the calendar scope, which a self-hosted household
// server cannot realistically obtain. iCloud, by contrast, does plain CalDAV
// over HTTPS with an app-specific password, and Fastmail, Nextcloud, Radicale
// and Baikal all do the same. So this is a general CalDAV client that happens to
// be pointed at iCloud by default.
//
// What "two way" means here:
//
//   inbound   already worked -- the .ics subscription fetch in calendars.js
//   outbound  is this file: PUT an event to the server, DELETE it when it goes
//
// The outbound half is what makes it two-way, and it is the half with teeth:
// writing to somebody's real calendar is destructive if it goes wrong. Three
// rules keep it honest:
//
//   1. Only events HouseHub created are ever touched. Every one carries a UID
//      with our prefix, and anything without it is left strictly alone -- so a
//      bug here cannot delete somebody's dentist appointment.
//   2. Writes are conditional. A fresh event uses If-None-Match:*, an update
//      uses If-Match with the ETag we last saw. A 412 means somebody else got
//      there first, and we re-read rather than overwrite.
//   3. Nothing is deleted that we did not put there and can still account for.
//
// The credential is an app-specific password, sealed at rest like every other
// server-side secret. It is not the user's Apple ID password and cannot be used
// to sign in to anything else -- which is the only reason storing one is
// defensible at all.

import { resolveAndCheck, BlockedRequestError } from "./safe-fetch.js";

export const ICLOUD_CALDAV = "https://caldav.icloud.com";

/** Everything this app writes is marked, and only marked things are touched. */
export const UID_PREFIX = "househub-";
export const isOurs = (uid) => String(uid || "").startsWith(UID_PREFIX);
export const uidFor = (kind, id) => `${UID_PREFIX}${kind}-${id}`;

const TIMEOUT_MS = Number(process.env.CALDAV_TIMEOUT_MS) || 20000;
const MAX_BYTES = 10 * 1024 * 1024;

/* ------------------------------------------------------------ tiny XML --- */

/* A whole XML parser is not needed and would be a dependency. CalDAV responses
   are machine-generated and shallow; what matters is being namespace-agnostic,
   because servers disagree about prefixes -- `<d:href>`, `<D:href>` and
   `<href>` all appear in the wild for the same thing. */

const localName = (tag) => tag.replace(/^[^:]*:/, "").toLowerCase();

/** Every occurrence of a tag, whatever namespace prefix it carries. */
export function findAll(xml, name) {
  const out = [];
  /* The attribute group must be lazy and must not swallow the closing
     slash. Greedy, `<c:comp name="VTODO"/>` matched with the slash inside
     the attributes, so the tag looked non-self-closing, the search for a
     `</comp>` found nothing, and every component declaration was silently
     skipped -- which made a VTODO-only Reminders list look like a normal
     calendar. */
  const re = new RegExp(`<([A-Za-z0-9_.-]+:)?${name}(\\s[^>]*?)?\\s*(/)?>`, "gi");
  let m;
  while ((m = re.exec(xml))) {
    if (m[3]) { out.push({ inner: "", attrs: m[2] || "", selfClosing: true }); continue; }
    const openEnd = m.index + m[0].length;
    const close = new RegExp(`</([A-Za-z0-9_.-]+:)?${name}\\s*>`, "gi");
    close.lastIndex = openEnd;
    const c = close.exec(xml);
    if (!c) continue;
    out.push({ inner: xml.slice(openEnd, c.index), attrs: m[2] || "", selfClosing: false });
    re.lastIndex = c.index;
  }
  return out;
}

/** The text of the first such tag, unescaped, or "". */
export function findText(xml, name) {
  const hit = findAll(xml, name)[0];
  if (!hit) return "";
  return unescapeXml(hit.inner.replace(/<[^>]*>/g, "")).trim();
}

export const escapeXml = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const unescapeXml = (v) => String(v == null ? "" : v)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&");   // last, or "&amp;lt;" would decode twice

/**
 * Split a multistatus body into one entry per resource.
 *
 * Only 2xx propstats are read. A server routinely answers with a 404 propstat
 * alongside a 200 one -- "here is the displayname, and no, there is no colour"
 * -- and treating those as data yields empty strings that overwrite real ones.
 */
export function parseMultistatus(xml) {
  return findAll(xml, "response").map((res) => {
    const href = unescapeXml(findText(res.inner, "href"));
    let props = "";
    for (const ps of findAll(res.inner, "propstat")) {
      const status = findText(ps.inner, "status");
      if (!/\s2\d\d\s/.test(` ${status} `)) continue;
      props += findAll(ps.inner, "prop").map((p) => p.inner).join("");
    }
    return { href, props };
  }).filter((r) => r.href);
}

/* ----------------------------------------------------------------- URLs --- */

/** Resolve an href from a response against the request URL. */
export function resolveHref(base, href) {
  if (!href) return "";
  return new URL(href, base).toString();
}

/* -------------------------------------------------------------- request --- */

/**
 * One CalDAV request, with the same SSRF guard the .ics fetcher uses.
 *
 * Redirects are followed manually so each hop is re-checked: a server that
 * answers 302 to http://169.254.169.254 would otherwise walk straight past the
 * address check that was the entire point.
 */
export async function davRequest(url, {
  method = "PROPFIND", username, password, depth, body, contentType,
  headers = {}, fetchImpl = fetch, maxBytes = MAX_BYTES,
} = {}) {
  let target = new URL(String(url));
  let redirects = 0;

  while (true) {
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new BlockedRequestError(`Only http and https are supported (got ${target.protocol})`);
    }
    await resolveAndCheck(target.hostname);

    const h = {
      "User-Agent": "HouseHub/2.0 (+caldav)",
      ...(depth !== undefined ? { Depth: String(depth) } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(username ? {
        Authorization: "Basic " + Buffer.from(`${username}:${password || ""}`).toString("base64"),
      } : {}),
      ...headers,
    };

    const res = await fetchImpl(target, {
      method, headers: h, body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new BlockedRequestError("Redirect without a destination");
      if (++redirects > 3) throw new BlockedRequestError("Too many redirects");
      target = new URL(loc, target);
      continue;
    }

    const text = res.status === 204 ? "" : (await res.text()).slice(0, maxBytes);
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      etag: res.headers.get("etag") || "",
      url: target.toString(),
      text,
    };
  }
}

/* ------------------------------------------------------------ discovery --- */

const PROP_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROP_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const PROP_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
<d:prop>
  <d:resourcetype/><d:displayname/><d:current-user-privilege-set/>
  <c:supported-calendar-component-set/><ic:calendar-color/><cs:getctag/>
</d:prop></d:propfind>`;

/**
 * Find the account's calendars.
 *
 * Three hops, which is simply how CalDAV works: the well-known URL says who you
 * are, the principal says where your calendars live, and that collection lists
 * them.
 */
export async function discoverCalendars(baseUrl, { username, password, fetchImpl = fetch } = {}) {
  const opts = { username, password, fetchImpl };

  const root = await davRequest(new URL("/.well-known/caldav", baseUrl).toString(),
    { ...opts, depth: 0, body: PROP_PRINCIPAL, contentType: 'application/xml; charset="utf-8"' });
  if (root.status === 401) throw new AuthError("Those credentials were not accepted.");
  if (!root.ok) throw new Error(`The server answered ${root.status} when asked who you are.`);

  const principalHref = findText(parseMultistatus(root.text)[0]?.props || "", "href");
  const principal = resolveHref(root.url, principalHref || "/");

  const homeRes = await davRequest(principal,
    { ...opts, depth: 0, body: PROP_HOME, contentType: 'application/xml; charset="utf-8"' });
  if (!homeRes.ok) throw new Error(`The server answered ${homeRes.status} when asked where your calendars are.`);

  const homeHref = findText(parseMultistatus(homeRes.text)[0]?.props || "", "href");
  if (!homeHref) throw new Error("The account has no calendar home.");
  const home = resolveHref(homeRes.url, homeHref);

  const listRes = await davRequest(home,
    { ...opts, depth: 1, body: PROP_CALENDARS, contentType: 'application/xml; charset="utf-8"' });
  if (!listRes.ok) throw new Error(`The server answered ${listRes.status} when listing calendars.`);

  return parseMultistatus(listRes.text)
    .map((r) => toCalendar(r, listRes.url))
    .filter(Boolean);
}

export class AuthError extends Error {}

/** One entry of a calendar-home listing, or null if it is not a calendar. */
export function toCalendar(entry, baseUrl) {
  const { href, props } = entry;
  // The home collection lists itself; it is not a calendar.
  if (!/<[^>]*:?calendar(\s[^>]*)?\/>/i.test(props)) return null;

  /* Only calendars that hold events. iCloud exposes the Reminders lists through
     the same collection, and they accept VTODO but not VEVENT -- writing an
     event to one fails in a way that looks like a permissions problem. */
  const comps = findAll(props, "comp").map((c) => (/name\s*=\s*"([^"]+)"/i.exec(c.attrs) || [])[1]);
  const components = comps.filter(Boolean).map((x) => x.toUpperCase());
  if (components.length && !components.includes("VEVENT")) return null;

  const privs = findAll(props, "current-user-privilege-set")[0]?.inner || "";
  /* Absent privileges are treated as writable: plenty of servers omit the
     property entirely, and refusing to write to all of them would make the
     feature useless. A real refusal surfaces as a 403 on the first PUT, which
     is reported honestly rather than guessed at here. */
  const writable = privs ? /<[^>]*:?write(-content)?(\s[^>]*)?\/>/i.test(privs) : true;

  return {
    href: resolveHref(baseUrl, href),
    name: findText(props, "displayname") || "Calendar",
    color: (findText(props, "calendar-color") || "").slice(0, 9),
    ctag: findText(props, "getctag"),
    components: components.length ? components : ["VEVENT"],
    writable,
  };
}

/* ----------------------------------------------------------- serialising --- */

export const escapeICS = (v) => String(v == null ? "" : v)
  // "\;" is not an escape sequence in JS -- it collapses to a bare ";", which
  // is a field separator in iCalendar and silently truncates the text.
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

const pad = (n) => String(n).padStart(2, "0");
const stampOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

/**
 * One event as a complete VCALENDAR, ready to PUT.
 *
 * Timed events are written with an explicit TZID rather than converted to UTC,
 * so that a 7pm dinner stays 7pm in the phone's calendar even if the household
 * later moves timezone -- and so it survives a DST change the way a person
 * expects it to.
 */
export function toVEvent(event, { tz = "UTC", now = 0, prodId = "-//HouseHub//EN" } = {}) {
  const uid = event.uid || uidFor("event", event.id);
  const date = String(event.date || "").replace(/-/g, "");
  if (!/^\d{8}$/.test(date)) throw new Error(`Event ${uid} has no usable date`);

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stampOf(now)}`,
    `SUMMARY:${escapeICS(event.title || "(No title)")}`,
  ];

  if (event.allDay || !event.time) {
    const end = event.endDate ? String(event.endDate).replace(/-/g, "") : nextDay(date);
    lines.push(`DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    const start = `${date}T${String(event.time).replace(":", "")}00`;
    lines.push(`DTSTART;TZID=${tz}:${start}`);
    if (event.endTime) {
      lines.push(`DTEND;TZID=${tz}:${date}T${String(event.endTime).replace(":", "")}00`);
    }
  }

  if (event.notes) lines.push(`DESCRIPTION:${escapeICS(event.notes)}`);
  if (event.location) lines.push(`LOCATION:${escapeICS(event.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** All-day DTEND is exclusive, so a one-day event ends the following day. */
export function nextDay(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
}

/** Where an event lives inside a calendar collection. */
export const resourceUrl = (calendarHref, uid) =>
  new URL(encodeURIComponent(uid) + ".ics", calendarHref.endsWith("/") ? calendarHref : calendarHref + "/").toString();

/* ---------------------------------------------------------------- write --- */

/**
 * Create or update one event.
 *
 * `etag` decides which: absent means "this must not already exist", present
 * means "only if it still looks like what I last read". Either way a 412 is a
 * lost race, not an error to retry blindly -- somebody edited it on their
 * phone, and their version is at least as good as ours.
 */
export async function putEvent(calendarHref, event, {
  username, password, tz = "UTC", now = 0, etag = "", fetchImpl = fetch,
} = {}) {
  const uid = event.uid || uidFor("event", event.id);
  const url = resourceUrl(calendarHref, uid);
  const res = await davRequest(url, {
    method: "PUT", username, password, fetchImpl,
    contentType: "text/calendar; charset=utf-8",
    headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
    body: toVEvent({ ...event, uid }, { tz, now }),
  });

  if (res.status === 412 || res.status === 409) {
    return { ok: false, conflict: true, uid, status: res.status };
  }
  if (res.status === 403) {
    return { ok: false, forbidden: true, uid, status: 403 };
  }
  if (!res.ok) return { ok: false, uid, status: res.status };
  return { ok: true, uid, etag: res.etag, url };
}

/**
 * Remove an event we previously wrote.
 *
 * Refuses outright for a UID that is not ours. This is the guard that means a
 * bug in the caller cannot wipe somebody's real appointments -- the check is
 * here, at the only place that can do the damage, rather than at each call site.
 */
export async function deleteEvent(calendarHref, uid, {
  username, password, etag = "", fetchImpl = fetch,
} = {}) {
  if (!isOurs(uid)) {
    throw new Error(`Refusing to delete ${uid}: HouseHub did not create it.`);
  }
  const res = await davRequest(resourceUrl(calendarHref, uid), {
    method: "DELETE", username, password, fetchImpl,
    headers: etag ? { "If-Match": etag } : {},
  });
  // Already gone is the desired state, not a failure.
  if (res.status === 404 || res.status === 410) return { ok: true, uid, alreadyGone: true };
  if (res.status === 412) return { ok: false, conflict: true, uid, status: 412 };
  return { ok: res.ok, uid, status: res.status };
}

/* ------------------------------------------------------------ reconcile --- */

/**
 * What has to change on the remote calendar to make it match ours.
 *
 * Pure, and separated from the network on purpose: this is the part that
 * decides to delete things, and it should be testable without a real account.
 *
 * `remote` is what the server currently holds, as { uid, etag, signature }.
 * Anything remote whose UID is not ours is ignored entirely -- not reported,
 * not counted, and above all never deleted.
 */
export function planSync(local, remote) {
  const mine = new Map((local || []).map((e) => [e.uid || uidFor("event", e.id), e]));
  const theirs = new Map();
  for (const r of remote || []) if (isOurs(r.uid)) theirs.set(r.uid, r);

  const create = [], update = [], remove = [];

  for (const [uid, event] of mine) {
    const there = theirs.get(uid);
    if (!there) { create.push({ uid, event }); continue; }
    // Only rewrite when something a reader would notice has changed.
    if (there.signature !== signatureOf(event)) {
      update.push({ uid, event, etag: there.etag || "" });
    }
  }
  for (const [uid, there] of theirs) {
    if (!mine.has(uid)) remove.push({ uid, etag: there.etag || "" });
  }
  return { create, update, remove };
}

/** What a change to an event means for the calendar; the basis for "changed". */
export const signatureOf = (e) => [
  e.title || "", e.date || "", e.time || "", e.endTime || "",
  e.allDay ? "1" : "0", e.notes || "", e.location || "",
].join("\u0000");
