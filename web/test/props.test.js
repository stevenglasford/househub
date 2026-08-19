// props.test.js — a handler prop that nobody passes is a dead button.
//
// The History button shipped doing nothing at all. `ToDosView` rendered
// `onClick={openHistory}` and declared `openHistory` in its props, but the one
// place that renders `ToDosView` never passed it -- the prop had been attached
// to `TodayView` by mistake, which ignores it. So `onClick` was `undefined`,
// clicking did nothing, and there was no error anywhere to notice.
//
// Nothing else catches this. The build is happy: the identifier is declared. The
// route audit is happy: no request is made. The handler-safety test is happy:
// there is no handler. It is only visible by comparing what a component asks for
// against what its callers actually give it.
//
// Scope is deliberately narrow -- handler-shaped props (onX / openX / gotoX)
// bound directly to an event, where a missing value is silently inert rather
// than merely absent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Components declared as `function Name({ a, b })`, with their prop names. */
function componentsIn(src) {
  const found = [];
  for (const m of src.matchAll(/(?:export default )?function ([A-Z]\w*)\s*\(\s*\{([^}]*)\}/g)) {
    const props = m[2]
      .split(",")
      .map((p) => p.split(":")[0].split("=")[0].trim())
      .filter((p) => /^\w+$/.test(p));
    found.push({ name: m[1], props, at: m.index });
  }
  return found;
}

/**
 * Prop names passed at a `<Name ... />` usage.
 *
 * The opening tag has to be scanned rather than matched with a regex. Props are
 * routinely arrow functions -- `openChore={(c) => setModal(...)}` -- and the `>`
 * in `=>` ends a naive match less than a line in, which reports almost every
 * prop in the file as missing. Brace depth is tracked, and only a `>` outside
 * any braces and not preceded by `=` closes the tag.
 */
function propsPassedTo(src, name) {
  const passed = new Set();
  let any = false;
  const opener = new RegExp(`<${name}[\\s/>]`, "g");

  for (const m of src.matchAll(opener)) {
    any = true;
    let depth = 0;
    let end = -1;
    for (let i = m.index + name.length + 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && src[i - 1] !== "=") { end = i; break; }
    }
    if (end === -1) continue;
    const attrs = src.slice(m.index, end);
    for (const p of attrs.matchAll(/(\w+)\s*=\s*[{"']/g)) passed.add(p[1]);
    if (/\{\.\.\./.test(attrs)) passed.add("*");   // spread: assume everything
  }
  return { passed, any };
}

// Props whose absence is silent rather than obvious: bound straight to an event
// handler, so `undefined` means "this button does nothing".
const HANDLER_PROP = /^(on[A-Z]|open[A-Z]|goto[A-Z]|set[A-Z]|toggle[A-Z])/;

test("every handler prop a component uses is passed by whoever renders it", () => {
  const files = walk(SRC);
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const problems = [];

  for (const [file, src] of sources) {
    for (const comp of componentsIn(src)) {
      const handlerProps = comp.props.filter((p) => HANDLER_PROP.test(p));
      if (!handlerProps.length) continue;

      // Where is it rendered? Usually the same file; check them all.
      let renderedAnywhere = false;
      const everPassed = new Set();
      for (const [, other] of sources) {
        const { passed, any } = propsPassedTo(other, comp.name);
        if (!any) continue;
        renderedAnywhere = true;
        for (const p of passed) everPassed.add(p);
      }
      if (!renderedAnywhere || everPassed.has("*")) continue;

      for (const prop of handlerProps) {
        // Only complain if the component actually depends on it.
        const used = new RegExp(`\\b${prop}\\b`, "g");
        const count = (src.match(used) || []).length;
        if (count < 2) continue;                    // declared but unused

        /* Optional by construction. A prop only ever invoked as `prop?.(...)`
           is designed to be absent -- ActionButton's onError, for instance --
           so its absence is a choice rather than a dead button. */
        const invocations = (src.match(new RegExp(`\\b${prop}\\s*\\(`, "g")) || []).length;
        const optional = (src.match(new RegExp(`\\b${prop}\\?\\.\\(`, "g")) || []).length;
        if (invocations === 0 && optional > 0) continue;
        if (optional > 0 && invocations === optional) continue;

        if (!everPassed.has(prop)) {
          problems.push(
            `${file.split("/src/")[1]}: <${comp.name}> uses ${prop} but no caller passes it`
          );
        }
      }
    }
  }

  assert.deepEqual(problems, [],
    `handler props that are always undefined — these are dead buttons:\n  ${problems.join("\n  ")}`);
});

test("the check can detect the bug it was written for", () => {
  // Proven on a sample, because a test over source text that silently matches
  // nothing would pass forever while catching nothing.
  const sample = `
    function ToDosView({ data, openHistory }) {
      return <button onClick={openHistory}>History</button>;
    }
    function App() {
      return <ToDosView data={d} />;
    }
  `;
  const comps = componentsIn(sample);
  const todos = comps.find((c) => c.name === "ToDosView");
  assert.ok(todos.props.includes("openHistory"));

  const { passed } = propsPassedTo(sample, "ToDosView");
  assert.ok(passed.has("data"));
  assert.ok(!passed.has("openHistory"), "the sample must reproduce the missing prop");
});
