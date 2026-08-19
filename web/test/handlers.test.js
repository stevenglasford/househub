// handlers.test.js — no async action can fail silently.
//
// This exists because of a regression made while adding consistent button
// feedback: several handlers had their try/catch removed so that ActionButton
// could report the failure, but the corresponding button was not actually
// converted. The result was worse than before -- the request could fail, the
// rejection went nowhere, and the person saw no busy state, no error and no
// change. Exactly the "I press it and nothing happens" complaint that prompted
// the work in the first place.
//
// The rule: an async handler that can reject must be wired to something that
// reports rejections. Either it catches its own errors, or it is attached to an
// ActionButton, which shows the message beside the button.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components");

/** The body of a function, matched by counting braces rather than guessing. */
function bodyOf(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openBraceIndex, i + 1);
    }
  }
  return src.slice(openBraceIndex);
}

/** Async functions that can reject: they await something and never catch. */
function rejectingHandlers(src) {
  const found = [];
  for (const m of src.matchAll(/async function (\w+)\s*\([^)]*\)\s*\{/g)) {
    const name = m[1];
    const body = bodyOf(src, m.index + m[0].length - 1);
    if (!/\bawait\b/.test(body)) continue;
    if (/\bcatch\s*[({]/.test(body)) continue;
    found.push(name);
  }
  return found;
}

test("every async handler that can reject is wired to something that reports it", () => {
  const offenders = [];

  for (const file of readdirSync(COMPONENTS).filter((f) => f.endsWith(".jsx"))) {
    const src = readFileSync(join(COMPONENTS, file), "utf8");
    for (const name of rejectingHandlers(src)) {
      // A plain <button> has nowhere to put an error message.
      const onPlainButton = new RegExp(
        `<button[^>]*onClick=\\{[^}]*\\b${name}\\b[^}]*\\}`, "s"
      ).test(src);
      if (onPlainButton) offenders.push(`${file}: ${name}() can reject but sits on a plain <button>`);
    }
  }

  assert.deepEqual(offenders, [],
    `handlers whose failures would vanish:\n  ${offenders.join("\n  ")}\n\n` +
    "Either catch inside the handler, or move the button to <ActionButton>.");
});

test("the check can actually detect the problem it is looking for", () => {
  // A test that cannot fail is worse than no test, and this one is pure static
  // analysis over source text -- so it is worth proving on a known-bad sample.
  const bad = `
    async function save() {
      await fetch("/x");
    }
    export default () => <button onClick={save}>Save</button>;
  `;
  assert.deepEqual(rejectingHandlers(bad), ["save"]);
  assert.ok(new RegExp(`<button[^>]*onClick=\\{[^}]*\\bsave\\b[^}]*\\}`, "s").test(bad));

  // ...and not fire on a handler that handles its own failure.
  const good = `
    async function save() {
      try { await fetch("/x"); } catch (e) { setError(e.message); }
    }
  `;
  assert.deepEqual(rejectingHandlers(good), []);

  // ...nor on one with no await at all.
  assert.deepEqual(rejectingHandlers(`async function noop() { return 1; }`), []);
});
