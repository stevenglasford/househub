// rotation.js — whose turn a recurring chore is.
//
// Lifted out of App.jsx because it was wrong in a way that reading it did not
// reveal. The old helper that found the previous completion filtered with
//
//     isCompletion(v) && typeof v === "string"
//
// which was true when a completion *was* just a person id. Completions became
// objects; the filter was never revisited. From then on it matched nothing, the
// "who went last" lookup always returned null, and every rotation answered with
// the first person in the list forever. Nothing threw. The chore simply stopped
// taking turns, which is the entire point of a rotation.
//
// The rule, stated once:
//
//   * turns advance only when the chore is actually completed. A skipped or
//     missed day leaves the same person up, so an unfinished chore keeps
//     belonging to whoever owed it instead of sliding onto their partner.
//   * a completion someone did ON BEHALF of the person whose turn it was does
//     not consume that turn. If Alex empties the bins because Steven forgot,
//     Steven is still up next time -- he owes it, and covering for somebody is
//     not the same as taking their place in the queue.

import { completionOf, isCompletion } from "./completion.js";

/** The rotation list, or [] for a chore with a fixed assignee. */
export const rotationOf = (chore) =>
  Array.isArray(chore?.rotation) ? chore.rotation.filter(Boolean) : [];

export const isRotating = (chore) => rotationOf(chore).length > 1;

/**
 * The most recent completion strictly before `beforeKey`.
 *
 * Every stored shape counts -- legacy strings, `true`, and completion objects.
 * Skips are not completions and are ignored, which is what keeps a skipped day
 * from advancing the queue.
 */
export function lastCompletion(chore, beforeKey) {
  const entries = Object.entries(chore?.done || {})
    .filter(([k, v]) => isCompletion(v) && (!beforeKey || k < beforeKey))
    .sort((a, b) => b[0].localeCompare(a[0]));
  if (!entries.length) return null;
  const [date, mark] = entries[0];
  return { date, mark, completion: completionOf(mark) };
}

/**
 * Which person a rotating chore belongs to on a given day.
 *
 * A fixed chore always belongs to its assignee. For a rotation:
 *
 *   1. if it was completed on that very day, it belonged to whoever is credited
 *      -- or, if somebody covered, to whoever it was covered for
 *   2. otherwise, take the last completion before that day and move one along
 *   3. with no history at all, the first person in the list is up
 */
export function assigneeFor(chore, dateKey) {
  const rot = rotationOf(chore);
  if (!rot.length) return chore?.personId || "";
  if (rot.length === 1) return rot[0];

  const onDay = completionOf(chore?.done?.[dateKey]);
  if (onDay) {
    // Covered for somebody: the day belonged to the person who owed it.
    if (onDay.onBehalfOf && rot.includes(onDay.onBehalfOf)) return onDay.onBehalfOf;
    if (onDay.by && rot.includes(onDay.by)) return onDay.by;
  }

  const prior = lastCompletion(chore, dateKey);
  if (!prior) return rot[0];

  /* Advance from whoever's turn the last completion consumed. When somebody
     covered, no turn was consumed, so the person who owed it is up again
     rather than being stepped over. */
  const c = prior.completion;
  if (c.onBehalfOf && rot.includes(c.onBehalfOf)) return c.onBehalfOf;

  const base = rot.indexOf(c.by);
  return base === -1 ? rot[0] : rot[(base + 1) % rot.length];
}
