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
  const raw = (data?.secondBlock || data?.mealsSecondRow || {})[filter || "all"];
  if (!raw) return { kind: "none", picks: [] };
  if (typeof raw === "string") return { kind: raw, picks: [] };
  return { kind: raw.kind || "none", picks: Array.isArray(raw.picks) ? raw.picks : [] };
}
