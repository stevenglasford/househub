// second-block.js — what the configurable extra row on Today is set to show.
//
// Pure, and separated from the component so it can be tested without a DOM.
// That mattered here: the reported fault ("you select one, but it doesn't
// actually display") was not in the rendering at all, it was the setting being
// dropped by the document merge — and proving that needs this readable from a
// plain test.

export const BLOCK_KINDS = [
  ["none", "Nothing"],
  ["grocery", "Grocery list"],
  ["dateJar", "Date jar"],
  ["camera", "Cameras"],
  ["devices", "Lights & devices"],
];

/** Kinds where "which ones?" is a real question. */
export const PICKABLE = ["camera", "devices"];

/**
 * What this person-filter is set to show.
 *
 * Tolerates every shape the document has held: absent, the original fork's
 * `mealsSecondRow` key, and the pre-picker format where the value was a bare
 * kind string with no selection alongside it.
 */
export function secondBlockFor(data, filter) {
  const all = data?.secondBlock || data?.mealsSecondRow || {};

  /* Fall back to the "Everyone" setting when this filter has none of its own.
     Without it the row was set up under Everyone, and then disappeared the
     moment anybody filtered Today to a person -- which is the whole of "you
     select one, but it doesn't actually display". Per-person overrides still
     win where they exist; this only fills the gap, which is the common case. */
  const raw = all[filter || "all"] ?? all.all;
  if (!raw) return { kind: "none", picks: [] };
  if (typeof raw === "string") return { kind: raw, picks: [] };
  return { kind: raw.kind || "none", picks: Array.isArray(raw.picks) ? raw.picks : [] };
}

/**
 * Is this filter showing its own choice, or Everyone's?
 *
 * The settings screen needs to say which, or "Nothing" next to a person's name
 * looks like a contradiction of the row they can see on Today.
 */
export function isInherited(data, filter) {
  const all = data?.secondBlock || data?.mealsSecondRow || {};
  return Boolean(filter && filter !== "all" && all[filter] === undefined && all.all);
}
