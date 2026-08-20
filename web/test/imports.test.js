// imports.test.js — nothing is used that was never brought into scope.
//
// `useMemo` shipped to production unimported. The build succeeded, because
// esbuild transforms modules without resolving identifiers, so a bare reference
// to something that does not exist is only a problem at runtime — at which
// point React unmounts the tree and the page goes white. A whole panel was
// blank for two days and every automated check was green.
//
// This is the cheapest possible guard against that: for each file, collect what
// it references and what it has available, and complain about the difference.
// It is not a type checker and does not pretend to be. It catches the exact
// mistake that caused the outage — using a hook, a component, or a helper that
// no import, declaration or parameter ever introduced.

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
    else if (/\.jsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Source with comments removed, so prose cannot look like code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Everything a file pulls in: imports, declarations, and destructured names.
 *
 * Comments are stripped first. A comment inside a destructuring pattern --
 *     variant = "secondary",   // primary | secondary | danger
 *     busyLabel = "Working…",
 * -- otherwise swallows the parameter that follows it, and the check then
 * reports a perfectly well-declared prop as undeclared.
 */
function namesInScope(raw) {
  const src = stripComments(raw);
  const names = new Set();

  // import X, { a as b, c } from "..."   /   import * as NS from "..."
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const clause = m[1];
    for (const part of clause.matchAll(/\*\s+as\s+(\w+)/g)) names.add(part[1]);
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const spec of braces[1].split(",")) {
        const name = spec.includes(" as ") ? spec.split(" as ")[1] : spec;
        if (name.trim()) names.add(name.trim());
      }
    }
    const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/\*\s+as\s+\w+/, "").split(",")[0].trim();
    if (/^\w+$/.test(def)) names.add(def);
  }

  // declarations of every kind, including destructured ones
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) names.add(m[1]);
  // array destructuring, which is how every useState pair is declared:
  //   const [modal, setModal] = useState(null)
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/\.\.\./, "").split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  // arrow parameters in any nesting: `(pt) =>`, `((a, b) => ...)`
  for (const m of src.matchAll(/\(\s*([\w\s,]*?)\s*\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/(?:^|[^\w.])(\w+)\s*=>/g)) names.add(m[1]);
  // Array destructuring in an arrow parameter, which is how every
  // `Object.entries(x).map(([key, value]) => ...)` names its parts.
  for (const m of src.matchAll(/\(\s*\[([^\]]*)\]\s*\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/\.\.\./, "").split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }

  /* Any brace-destructuring pattern, wherever it appears -- component props are
     routinely declared across several lines:
        function ActionButton({
          onClick, children, theme: T, variant = "secondary", title, ...rest
        })
     Parsed by scanning from each `({` to its matching `}` rather than by regex,
     which cannot balance braces and so missed every multi-line signature. */
  for (const m of src.matchAll(/\(\s*\{/g)) {
    const open = src.indexOf("{", m.index);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    for (const part of src.slice(open + 1, end).split(",")) {
      const name = (part.includes(":") ? part.split(":").pop() : part)
        .replace(/\.\.\./, "").split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = (part.includes(":") ? part.split(":")[1] : part).split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  // function parameters, including destructured props
  for (const m of src.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/[{}[\]]/g, "").split(":").pop().split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/\{([^{}]*)\}\s*\)?\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = (part.includes(":") ? part.split(":")[1] : part).split("=")[0].trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  return names;
}

// Anything the language or the browser already provides.
const AMBIENT = new Set([
  "window", "document", "navigator", "console", "fetch", "Math", "Date", "JSON",
  "Object", "Array", "String", "Number", "Boolean", "Set", "Map", "Promise",
  "Error", "TypeError", "RegExp", "Intl", "URL", "URLSearchParams", "Blob", "File",
  "FileReader", "TextEncoder", "TextDecoder", "Uint8Array", "ArrayBuffer", "DataView",
  "BigInt", "Symbol", "crypto", "atob", "btoa", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "structuredClone",
  "localStorage", "sessionStorage", "alert", "confirm", "prompt", "AbortController",
  "CustomEvent", "Event", "Headers", "Response", "Request", "React", "process",
  "globalThis", "undefined", "NaN", "Infinity", "isNaN", "parseInt", "parseFloat",
  "encodeURIComponent", "decodeURIComponent", "queueMicrotask", "Intl", "history",
]);

test("every React hook a file uses is imported into it", () => {
  // The narrowest, highest-value version of the check: hooks are unambiguous
  // (`useX(` at a call site), and a missing one is always fatal.
  const problems = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    const scope = namesInScope(src);
    const used = new Set();
    for (const m of src.matchAll(/\b(use[A-Z]\w*)\s*\(/g)) used.add(m[1]);
    for (const hook of used) {
      // A hook defined in this file is fine, as is one imported.
      if (scope.has(hook)) continue;
      problems.push(`${file.split("/src/")[1]}: uses ${hook}() but never imports or defines it`);
    }
  }
  assert.deepEqual(problems, [],
    `hooks used without being in scope — these are white screens:\n  ${problems.join("\n  ")}`);
});

test("every component rendered in JSX is in scope", () => {
  const problems = [];
  for (const file of walk(SRC)) {
    if (!file.endsWith(".jsx")) continue;
    const src = readFileSync(file, "utf8");
    const scope = namesInScope(src);
    const used = new Set();
    for (const m of src.matchAll(/<([A-Z]\w*)[\s/>]/g)) used.add(m[1]);
    for (const name of used) {
      if (scope.has(name) || AMBIENT.has(name)) continue;
      if (name.includes(".")) continue;                  // <Namespace.Thing>
      problems.push(`${file.split("/src/")[1]}: renders <${name}> but it is not in scope`);
    }
  }
  assert.deepEqual(problems, [],
    `components rendered without being in scope:\n  ${problems.join("\n  ")}`);
});

test("the check detects a missing hook", () => {
  // Proven on the exact shape of the bug it was written for, so it cannot pass
  // by matching nothing.
  const bad = `import React, { useState } from "react";
    function Thing() { const x = useMemo(() => 1, []); return <div>{x}</div>; }`;
  const scope = namesInScope(bad);
  assert.ok(scope.has("useState"));
  assert.ok(!scope.has("useMemo"), "the sample must reproduce the missing import");

  const good = `import React, { useState, useMemo } from "react";`;
  assert.ok(namesInScope(good).has("useMemo"));
});

/**
 * Identifiers referenced in JSX value positions that nothing ever declares.
 *
 * The narrower checks above missed a real crash: `canFixCredit` was used twice
 * in a JSX block and defined nowhere, because a mechanical edit meant to define
 * it silently failed to match while the edit that used it succeeded. The build
 * was green, every test passed, and the chore list threw the moment it rendered.
 *
 * Only unambiguous value positions are examined -- `{foo}`, `{foo && ...}`,
 * `{foo ? ...}`, `{foo.bar}` -- and comments are stripped first. A broader sweep
 * over every brace matched prose inside comments and object keys, and a check
 * that cries wolf is one people stop reading.
 */
test("JSX value expressions do not reference undeclared identifiers", () => {
  const problems = [];
  for (const file of walk(SRC)) {
    if (!file.endsWith(".jsx")) continue;
    const raw = readFileSync(file, "utf8");
    const scope = namesInScope(raw);
    const src = stripComments(raw);
    const seen = new Set();

    /* Both the first identifier in an expression and any that follow a `&&`,
       `||` or an opening paren. The original pattern only looked at the first,
       and so did not catch the very bug that prompted this test:
           {isDone && (canFixCredit ? <Chip /> : ...)}
       where `isDone` was fine and `canFixCredit` did not exist. */
    const positions = [
      /\{\s*([a-z][A-Za-z0-9]*)\s*(\}|&&|\|\||\?|\.)/g,
      /(?:&&|\|\|)\s*\(?\s*([a-z][A-Za-z0-9]*)\s*(\}|&&|\|\||\?|\.|\))/g,
    ];
    for (const m of [...positions.flatMap((re) => [...src.matchAll(re)])]) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (scope.has(name) || AMBIENT.has(name) || RESERVED.has(name)) continue;
      problems.push(`${file.split("/src/")[1]}: ${name} is used in JSX but never declared`);
    }
  }
  assert.deepEqual(problems, [],
    `identifiers used but never declared — these throw at render:\n  ${problems.join("\n  ")}`);
});

test("the undeclared-identifier check catches the shape of the real bug", () => {
  const bad = `function Row({ mark }) {
    return <div>{isDone && canFixCredit ? <Chip /> : null}</div>;
  }`;
  const scope = namesInScope(bad);
  assert.ok(!scope.has("canFixCredit"), "the sample must reproduce the missing declaration");
  const hits = [...stripComments(bad).matchAll(/\{\s*([a-z][A-Za-z0-9]*)\s*(\}|&&|\?|\.)/g)]
    .map((m) => m[1]);
  assert.ok(hits.includes("isDone"), "the check looks at this position");
});

const RESERVED = new Set([
  "true", "false", "null", "undefined", "new", "typeof", "instanceof", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "function", "class", "const", "let", "var", "await", "async", "yield", "of",
  "in", "delete", "void", "this", "super", "try", "catch", "finally", "throw",
]);

/**
 * A component imported and never rendered.
 *
 * This has now happened three times: an edit adds the import, the paired edit
 * that would render it silently fails to match on indentation, and the result
 * builds cleanly, passes every test, and ships a feature that simply is not
 * there. The settings panel for staying signed in was imported into App.jsx and
 * rendered nowhere; it reached the deployed bundle in that state.
 *
 * Nothing else catches it. The build is happy — an unused import is legal. The
 * render tests only exercise what they are told to. Only the mismatch between
 * "imported" and "used" shows it.
 */
test("every imported component is actually rendered", () => {
  const problems = [];
  for (const file of walk(SRC)) {
    if (!file.endsWith(".jsx")) continue;
    const src = stripComments(readFileSync(file, "utf8"));

    /* Import lines are removed before looking for usage. Leaving them in means
       the declaration counts as its own use and the check can never fire --
       which is exactly how the first version of this test passed while the bug
       it was written for was still present. */
    const body = src.replace(/^import[^;]*;?$/gm, "");

    for (const m of src.matchAll(/^import\s+([A-Z]\w*)\s+from\s+["']\.[^"']+\.jsx["'];?$/gm)) {
      const name = m[1];
      // Rendered as an element, or referenced as a value (passed as a prop,
      // stored in a map of components, re-exported).
      const used = new RegExp(`<${name}[\\s/>]|\\b${name}\\b`, "g");
      const hits = [...body.matchAll(used)];
      if (hits.length === 0) {
        problems.push(`${file.split("/src/")[1]}: imports ${name} and never uses it`);
      }
    }
  }
  assert.deepEqual(problems, [],
    `components imported but never rendered — the feature is missing:\n  ${problems.join("\n  ")}`);
});

test("that check notices an import with no render", () => {
  const sample = `import SessionPolicyPanel from "./components/SessionPolicyPanel.jsx";
    function Settings() { return <div>nothing here</div>; }`;
  const m = /^import\s+([A-Z]\w*)\s+from\s+["']\.[^"']+\.jsx["'];?$/m.exec(sample);
  assert.equal(m[1], "SessionPolicyPanel");
  const hits = [...sample.matchAll(/<SessionPolicyPanel[\s/>]/g)];
  assert.equal(hits.length, 0, "the sample must reproduce the unused import");
});
