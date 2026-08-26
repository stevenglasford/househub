// feed-events.js — attaching a subscribed event to the person who owns it.
//
// The reported fault was "the calendar, on today and the tab, are not
// corresponding to the correct person from the settings".
//
// The split that causes it is a deliberate one. A calendar's subscription URL
// lives on the server, because a browser cannot fetch it (CORS); the calendar's
// *name, colour and person* are household content and live in the encrypted
// document, which the server cannot read. So the server returns events tagged
// only with a `feedId`, and something has to put the two halves back together.
//
// Nothing did. Every subscribed event arrived with no personId and no colour,
// `colorFor` fell through to grey, and the person assigned to that calendar in
// settings had no effect on anything.

/** Index the household's calendar list by the id the server knows it by. */
const byFeedId = (calendars) =>
  new Map((calendars || []).filter((c) => c && c.id).map((c) => [c.id, c]));

/**
 * Decorate server events with what only the document knows.
 *
 * The server's own values are kept where the household has not overridden them:
 * a calendar the household never renamed should still say what the provider
 * calls it rather than going blank.
 */
export function decorateFeedEvents(events, calendars) {
  const feeds = byFeedId(calendars);
  return (events || []).map((e) => {
    const feed = feeds.get(e.feedId);
    return {
      ...e,
      source: e.source || "ics",
      personId: feed?.personId || "",
      color: feed?.color || e.color || "",
      calName: feed?.name || e.calName || "Calendar",
      // Derived events and subscribed ones are both read-only here; the
      // authority for a subscribed event is the calendar it came from.
      readOnly: true,
    };
  });
}

/**
 * Everything shown on a calendar day or tile, in the order people read it.
 *
 * All-day first, then by start time, then by title so the order is stable
 * between renders rather than depending on which feed answered first.
 */
export function sortEvents(events) {
  return [...(events || [])].sort((a, b) => {
    const aAll = a.allDay || !a.time, bAll = b.allDay || !b.time;
    if (aAll !== bAll) return aAll ? -1 : 1;
    if (!aAll && a.time !== b.time) return String(a.time).localeCompare(String(b.time));
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

/** A short, human description of when an event runs. */
export function whenLabel(ev, fmt) {
  if (ev.spanDays > 1) {
    return `${ev.time ? `${fmt(ev.time)} start · ` : ""}day ${ev.spanIndex + 1} of ${ev.spanDays}`;
  }
  if (!ev.time) return "All day";
  return ev.endTime ? `${fmt(ev.time)} – ${fmt(ev.endTime)}` : fmt(ev.time);
}
