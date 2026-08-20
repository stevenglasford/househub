// ics-zones.js — resolving the timezone names that turn up in real calendar feeds.
//
// `TZID=` is supposed to name an IANA zone. Outlook and Exchange do not: they
// emit Windows zone names like "Central Standard Time", and those are not IANA
// names, so `Intl` throws on them. In this codebase that throw was swallowed and
// the offset defaulted to zero, which silently reinterpreted every one of those
// wall times as UTC. A 9am clinic displayed as 4am. Nothing errored; the
// calendar was just wrong by the household's own offset, on every affected row.
//
// Three ways to resolve a name, tried in order of how much we can trust them:
//
//   1. Intl knows it            -- a real IANA name, use the system tz database
//   2. a Windows alias          -- map to the IANA zone it means, then as above
//   3. the feed's own VTIMEZONE -- the offsets are written into the file itself
//
// and if none of those work, the caller treats the time as floating, which is
// the least-wrong answer available: an unknown zone read as local lands on the
// right day at roughly the right time, where reading it as UTC does not.

/* ------------------------------------------------- Windows zone aliases --- */

/* From the CLDR windowsZones mapping (the "001" default territory for each).
   Not exhaustive -- there are ~140 -- but these are the ones that appear in
   feeds from Outlook, Exchange and the Windows calendar, which is what
   "Central Standard Time" in a Google-hosted .ics actually came from.

   Note the names lie: "Central Standard Time" means the zone that observes CST
   *and* CDT, not a fixed -6. Mapping it to America/Chicago is what makes the
   summer offset come out right. */
export const WINDOWS_ZONES = {
  "dateline standard time": "Etc/GMT+12",
  "utc-11": "Etc/GMT+11",
  "aleutian standard time": "America/Adak",
  "hawaiian standard time": "Pacific/Honolulu",
  "marquesas standard time": "Pacific/Marquesas",
  "alaskan standard time": "America/Anchorage",
  "utc-09": "Etc/GMT+9",
  "pacific standard time (mexico)": "America/Tijuana",
  "utc-08": "Etc/GMT+8",
  "pacific standard time": "America/Los_Angeles",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time (mexico)": "America/Chihuahua",
  "mountain standard time": "America/Denver",
  "yukon standard time": "America/Whitehorse",
  "central america standard time": "America/Guatemala",
  "central standard time": "America/Chicago",
  "easter island standard time": "Pacific/Easter",
  "central standard time (mexico)": "America/Mexico_City",
  "canada central standard time": "America/Regina",
  "sa pacific standard time": "America/Bogota",
  "eastern standard time (mexico)": "America/Cancun",
  "eastern standard time": "America/New_York",
  "haiti standard time": "America/Port-au-Prince",
  "cuba standard time": "America/Havana",
  "us eastern standard time": "America/Indianapolis",
  "turks and caicos standard time": "America/Grand_Turk",
  "paraguay standard time": "America/Asuncion",
  "atlantic standard time": "America/Halifax",
  "venezuela standard time": "America/Caracas",
  "central brazilian standard time": "America/Cuiaba",
  "sa western standard time": "America/La_Paz",
  "pacific sa standard time": "America/Santiago",
  "newfoundland standard time": "America/St_Johns",
  "tocantins standard time": "America/Araguaina",
  "e. south america standard time": "America/Sao_Paulo",
  "sa eastern standard time": "America/Cayenne",
  "argentina standard time": "America/Buenos_Aires",
  "greenland standard time": "America/Godthab",
  "montevideo standard time": "America/Montevideo",
  "magallanes standard time": "America/Punta_Arenas",
  "saint pierre standard time": "America/Miquelon",
  "bahia standard time": "America/Bahia",
  "utc-02": "Etc/GMT+2",
  "azores standard time": "Atlantic/Azores",
  "cape verde standard time": "Atlantic/Cape_Verde",
  "utc": "Etc/UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "sao tome standard time": "Africa/Sao_Tome",
  "morocco standard time": "Africa/Casablanca",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "central european standard time": "Europe/Warsaw",
  "w. central africa standard time": "Africa/Lagos",
  "gtb standard time": "Europe/Bucharest",
  "middle east standard time": "Asia/Beirut",
  "egypt standard time": "Africa/Cairo",
  "e. europe standard time": "Europe/Chisinau",
  "syria standard time": "Asia/Damascus",
  "west bank standard time": "Asia/Hebron",
  "south africa standard time": "Africa/Johannesburg",
  "fle standard time": "Europe/Kiev",
  "israel standard time": "Asia/Jerusalem",
  "south sudan standard time": "Africa/Juba",
  "kaliningrad standard time": "Europe/Kaliningrad",
  "sudan standard time": "Africa/Khartoum",
  "libya standard time": "Africa/Tripoli",
  "namibia standard time": "Africa/Windhoek",
  "jordan standard time": "Asia/Amman",
  "arabic standard time": "Asia/Baghdad",
  "turkey standard time": "Europe/Istanbul",
  "arab standard time": "Asia/Riyadh",
  "belarus standard time": "Europe/Minsk",
  "russian standard time": "Europe/Moscow",
  "e. africa standard time": "Africa/Nairobi",
  "iran standard time": "Asia/Tehran",
  "arabian standard time": "Asia/Dubai",
  "astrakhan standard time": "Europe/Astrakhan",
  "azerbaijan standard time": "Asia/Baku",
  "russia time zone 3": "Europe/Samara",
  "mauritius standard time": "Indian/Mauritius",
  "saratov standard time": "Europe/Saratov",
  "georgian standard time": "Asia/Tbilisi",
  "volgograd standard time": "Europe/Volgograd",
  "caucasus standard time": "Asia/Yerevan",
  "afghanistan standard time": "Asia/Kabul",
  "west asia standard time": "Asia/Tashkent",
  "ekaterinburg standard time": "Asia/Yekaterinburg",
  "pakistan standard time": "Asia/Karachi",
  "qyzylorda standard time": "Asia/Qyzylorda",
  "india standard time": "Asia/Calcutta",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Katmandu",
  "central asia standard time": "Asia/Almaty",
  "bangladesh standard time": "Asia/Dhaka",
  "omsk standard time": "Asia/Omsk",
  "myanmar standard time": "Asia/Rangoon",
  "se asia standard time": "Asia/Bangkok",
  "altai standard time": "Asia/Barnaul",
  "w. mongolia standard time": "Asia/Hovd",
  "north asia standard time": "Asia/Krasnoyarsk",
  "n. central asia standard time": "Asia/Novosibirsk",
  "tomsk standard time": "Asia/Tomsk",
  "china standard time": "Asia/Shanghai",
  "north asia east standard time": "Asia/Irkutsk",
  "singapore standard time": "Asia/Singapore",
  "w. australia standard time": "Australia/Perth",
  "taipei standard time": "Asia/Taipei",
  "ulaanbaatar standard time": "Asia/Ulaanbaatar",
  "aus central w. standard time": "Australia/Eucla",
  "transbaikal standard time": "Asia/Chita",
  "tokyo standard time": "Asia/Tokyo",
  "north korea standard time": "Asia/Pyongyang",
  "korea standard time": "Asia/Seoul",
  "yakutsk standard time": "Asia/Yakutsk",
  "cen. australia standard time": "Australia/Adelaide",
  "aus central standard time": "Australia/Darwin",
  "e. australia standard time": "Australia/Brisbane",
  "aus eastern standard time": "Australia/Sydney",
  "west pacific standard time": "Pacific/Port_Moresby",
  "tasmania standard time": "Australia/Hobart",
  "vladivostok standard time": "Asia/Vladivostok",
  "lord howe standard time": "Australia/Lord_Howe",
  "bougainville standard time": "Pacific/Bougainville",
  "russia time zone 10": "Asia/Srednekolymsk",
  "magadan standard time": "Asia/Magadan",
  "norfolk standard time": "Pacific/Norfolk",
  "sakhalin standard time": "Asia/Sakhalin",
  "central pacific standard time": "Pacific/Guadalcanal",
  "russia time zone 11": "Asia/Kamchatka",
  "new zealand standard time": "Pacific/Auckland",
  "fiji standard time": "Pacific/Fiji",
  "chatham islands standard time": "Pacific/Chatham",
  "utc+13": "Etc/GMT-13",
  "tonga standard time": "Pacific/Tongatapu",
  "samoa standard time": "Pacific/Apia",
  "line islands standard time": "Pacific/Kiritimati",
};

/** The IANA zone a Windows name means, or null. Quotes and case are forgiving. */
export function ianaFromWindows(name) {
  if (!name || typeof name !== "string") return null;
  const key = name.replace(/^["']|["']$/g, "").trim().toLowerCase();
  return WINDOWS_ZONES[key] || null;
}

/* ------------------------------------------------------- VTIMEZONE rules --- */

/* Some feeds name a zone nothing recognises -- Outlook writes "Customized Time
   Zone" when somebody has hand-edited one. Those feeds still carry the answer:
   a VTIMEZONE block stating the offsets and when they change. It is less
   precise than a real tz database (no history, and only the recurrence patterns
   actually written down) but for an event in the present it is right, and right
   beats a five-hour error. */

/** "-0530" -> -330 minutes. */
function parseOffset(s) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(s || "").trim());
  if (!m) return null;
  const mins = (+m[2]) * 60 + (+m[3]);
  return m[1] === "-" ? -mins : mins;
}

/**
 * The nth weekday of a month. `spec` is an RRULE BYDAY value: "2SU" is the
 * second Sunday, "-1SU" the last.
 */
export function nthWeekdayOfMonth(year, month, spec) {
  const m = /^(-?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(String(spec || "").trim().toUpperCase());
  if (!m) return null;
  const n = m[1] ? +m[1] : 1;
  const dow = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[m[2]];

  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - dow + 7) % 7) + (n + 1) * 7;
}

/**
 * Pull the usable transition rules out of every VTIMEZONE in a feed.
 *
 * Feeds carry decades of history -- the America/Chicago block starts in 1883 --
 * and each historical rule is capped with UNTIL. The rules still in force are
 * the ones without it, so those win; a zone that never changes (Singapore) has
 * a single STANDARD block and no recurrence at all.
 */
export function parseVTimezones(text) {
  const zones = new Map();
  for (const block of String(text || "").matchAll(/BEGIN:VTIMEZONE([\s\S]*?)END:VTIMEZONE/g)) {
    const body = block[1];
    const tzid = (/^TZID:(.*)$/m.exec(body) || [])[1];
    if (!tzid) continue;

    const zone = { std: null, dst: null };
    for (const sub of body.matchAll(/BEGIN:(STANDARD|DAYLIGHT)([\s\S]*?)END:\1/g)) {
      const kind = sub[1] === "STANDARD" ? "std" : "dst";
      const s = sub[2];
      const offset = parseOffset((/^TZOFFSETTO:(.*)$/m.exec(s) || [])[1]);
      if (offset === null) continue;

      const rrule = (/^RRULE:(.*)$/m.exec(s) || [])[1] || "";
      const parts = {};
      rrule.split(";").forEach((p) => { const [k, v] = p.split("="); if (k) parts[k.toUpperCase()] = v; });
      const expired = Boolean(parts.UNTIL);

      const dt = (/^DTSTART:(.*)$/m.exec(s) || [])[1] || "";
      const hm = /T(\d{2})(\d{2})/.exec(dt);

      const rule = {
        offset,
        month: parts.BYMONTH ? +parts.BYMONTH : null,
        byday: parts.BYDAY || null,
        hour: hm ? +hm[1] : 2,
        minute: hm ? +hm[2] : 0,
        expired,
      };
      /* A rule still in force always beats a historical one; between two of
         the same kind the later one wins, which is the order they are written
         in. So the only rule that never replaces anything is a historical one
         arriving after a current one. */
      const beatsWhatWeHave = !zone[kind] || zone[kind].expired || !expired;
      if (beatsWhatWeHave) zone[kind] = rule;
    }
    if (zone.std || zone.dst) zones.set(tzid.trim(), zone);
  }
  return zones;
}

/**
 * The offset, in minutes, that a VTIMEZONE says applies to a given wall time.
 *
 * Returns null when the block did not say enough to tell, so the caller can
 * fall through rather than act on a guess.
 */
export function offsetFromVTimezone(zone, y, mo, d, h = 0, mi = 0) {
  if (!zone) return null;
  const { std, dst } = zone;
  if (!std && !dst) return null;
  if (!dst || !std) return (std || dst).offset;
  // Without a stated recurrence there is nothing to decide DST from.
  if (!dst.month || !dst.byday || !std.month || !std.byday) return std.offset;

  const at = (rule) => {
    const day = nthWeekdayOfMonth(y, rule.month, rule.byday);
    return day === null ? null : Date.UTC(y, rule.month - 1, day, rule.hour, rule.minute);
  };
  const startDst = at(dst), endDst = at(std);
  if (startDst === null || endDst === null) return std.offset;

  const t = Date.UTC(y, mo - 1, d, h, mi);
  // Northern hemisphere: DST runs from spring to autumn within one year.
  // Southern: it wraps the new year, so the test inverts.
  return startDst < endDst
    ? (t >= startDst && t < endDst ? dst.offset : std.offset)
    : (t >= startDst || t < endDst ? dst.offset : std.offset);
}
