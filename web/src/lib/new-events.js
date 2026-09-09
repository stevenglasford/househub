// new-events.js — what has appeared on the calendar since you last looked.
//
// Ryan: "I want to be able to see what are new items that have been added to
// the calendar somehow that can be specific to the calendar and the person
// viewing."
//
// The hard half is "new to whom". "Added recently" is a property of the event
// and is the same for everybody looking at it -- which is exactly the thing
// that was *not* asked for. "New to me" is a property of the reader, and the
// document held nothing per-reader at all.
//
// So each person gets a mark: the moment they last looked at the calendar.
// Anything added after their mark is new to them, and opening the tab moves it.
// Two people who last looked on different days see different things, which is
// the whole point.
//
// A DISPLAY has no signed-in person and so has no mark, and giving it one would
// be wrong twice over: a wall tablet is looked at by everybody and by nobody, so
// its mark would be moved constantly by whoever walked past and would clear the
// dots for a household that had not seen anything. It gets a recency window
// instead -- "added in the last few days" -- which is honest about being
// household-wide rather than personal, and which clears on its own.

/** How far back a screen with no signed-in person calls something new. */
export const DISPLAY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Where the per-person marks live in the document. */
export const SEEN_KEY = "seenCalendar";

/**
 * When this reader last looked, or null for a reader who has no mark.
 *
 * Null is not zero. Zero would mean "looked at the dawn of time", making
 * everything new forever; null means "we have no idea", and the caller decides
 * what to do about that -- which for a new member is to show nothing as new
 * rather than every event in the household's history.
 */
export function seenAt(data, personId) {
  if (!personId) return null;
  const raw = (data?.[SEEN_KEY] || {})[personId];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** When an event was added, or null if it does not say. */
export function addedAt(ev) {
  const n = Number(ev?.addedAt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Is this event new to this reader?
 *
 * An event with no `addedAt` is never new. Everything written before this
 * feature existed has none, and treating those as new would light up the whole
 * calendar on the day it ships -- which trains people to ignore the marker
 * before they have once found it useful.
 */
export function isNewTo(ev, { mark, now = Date.now(), isDisplay = false } = {}) {
  const added = addedAt(ev);
  if (added === null) return false;
  if (isDisplay || mark === null || mark === undefined) {
    // No personal mark: household-wide recency, which clears on its own.
    return isDisplay ? now - added <= DISPLAY_WINDOW_MS : false;
  }
  return added > mark;
}

/**
 * Everything new to this reader, optionally narrowed to one calendar.
 *
 * The calendar key is `feedId` for a subscribed event and `calendarId` for one
 * created here. Both are checked, because "specific to the calendar" has to
 * work for a subscribed work calendar as much as for a hub-made one -- and
 * because getting this join wrong is the bug that made every subscribed event
 * arrive unowned (see lib/feed-events.js).
 */
export function newEvents(events, { mark, now = Date.now(), isDisplay = false, calendarId = null } = {}) {
  return (events || []).filter((ev) => {
    if (!isNewTo(ev, { mark, now, isDisplay })) return false;
    if (!calendarId) return true;
    return ev.feedId === calendarId || ev.calendarId === calendarId;
  });
}

/** How many new events each calendar has, as { calendarId: count }. */
export function newCountByCalendar(events, opts = {}) {
  const out = {};
  for (const ev of newEvents(events, opts)) {
    const key = ev.feedId || ev.calendarId || "";
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Move this reader's mark to now.
 *
 * Returns the document unchanged for a reader with no id -- a display must not
 * write a mark, or it would clear the dots for a household that had not seen
 * anything.
 */
export function markSeen(data, personId, at = Date.now()) {
  if (!personId) return data;
  return { ...data, [SEEN_KEY]: { ...(data?.[SEEN_KEY] || {}), [personId]: at } };
}
