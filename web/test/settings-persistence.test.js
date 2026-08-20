// settings-persistence.test.js — settings that survive a merge.
//
// Ryan: "On the settings, and under Extra row on today, you select one, but it
// doesn't actually display on the Today page."
//
// It was not a rendering bug. `mergeDocuments` starts from the server's copy and
// only lets the local copy win for a listed set of scalar keys. `secondBlock`
// was not on that list, so the choice was written locally and then discarded by
// the next merge — which happens on every save that meets a newer version.
//
// This is a whole class of bug rather than one instance: any future setting
// added to the document and forgotten here will vanish the same way, silently,
// and look like the feature not working. Hence the last test.

import test from "node:test";
import assert from "node:assert/strict";
import { mergeDocuments } from "../src/api.js";
import { secondBlockFor } from "../src/lib/second-block.js";

test("REGRESSION: choosing an extra row survives a merge", () => {
  // Exactly the losing case: I have just set it, the server copy predates that.
  const mine = { secondBlock: { all: { kind: "devices", picks: ["light.kitchen"] } } };
  const theirs = {};
  const out = mergeDocuments(mine, theirs);
  assert.deepEqual(out.secondBlock, mine.secondBlock,
    "without this the setting is written, discarded on the next sync, and looks broken");
});

test("the device picks survive too, not just the kind", () => {
  const mine = { secondBlock: { all: { kind: "devices", picks: ["light.hall", "switch.lamp"] } } };
  const out = mergeDocuments(mine, { secondBlock: { all: { kind: "camera", picks: [] } } });
  assert.deepEqual(out.secondBlock.all.picks, ["light.hall", "switch.lamp"]);
  assert.equal(out.secondBlock.all.kind, "devices", "the change I just made wins");
});

test("lists survive a merge as well", () => {
  const mine = { lists: [{ id: "l1", title: "Packing", items: [] }] };
  assert.deepEqual(mergeDocuments(mine, {}).lists, mine.lists);
});

test("a setting I did not touch keeps the server's value", () => {
  const out = mergeDocuments({}, { secondBlock: { all: { kind: "grocery", picks: [] } } });
  assert.equal(out.secondBlock.all.kind, "grocery");
});

test("secondBlockFor tolerates every shape the document has held", () => {
  assert.deepEqual(secondBlockFor({}, "all"), { kind: "none", picks: [] });
  assert.deepEqual(secondBlockFor({ secondBlock: {} }, "all"), { kind: "none", picks: [] });
  // The pre-picker save format was a bare string.
  assert.deepEqual(secondBlockFor({ secondBlock: { all: "grocery" } }, "all"),
    { kind: "grocery", picks: [] });
  // And the original fork's key name.
  assert.deepEqual(secondBlockFor({ mealsSecondRow: { all: "camera" } }, "all"),
    { kind: "camera", picks: [] });
  assert.deepEqual(secondBlockFor({ secondBlock: { all: { kind: "devices", picks: null } } }, "all"),
    { kind: "devices", picks: [] }, "a bad picks value must not throw");
});

test("every document setting the app writes is carried by the merge", () => {
  /* The guard on the class of bug rather than the instance. If a setting is
     added to the document and not to the merge, it is silently discarded — and
     the symptom is "the setting does nothing", which reads as a UI fault and
     gets looked for in entirely the wrong place. */
  const SETTINGS = [
    "householdName", "grocerySort", "layoutMode", "noteDisplay", "showBreakdown",
    "weather", "checkin", "upNextSources", "homeEntities", "homeDashboardUrl",
    "groceryStores", "secondBlock", "lists",
  ];
  const mine = Object.fromEntries(SETTINGS.map((k) => [k, `mine:${k}`]));
  const theirs = Object.fromEntries(SETTINGS.map((k) => [k, `theirs:${k}`]));
  const out = mergeDocuments(mine, theirs);

  const dropped = SETTINGS.filter((k) => out[k] !== `mine:${k}`);
  assert.deepEqual(dropped, [],
    `these settings would be silently discarded on the next sync: ${dropped.join(", ")}`);
});
