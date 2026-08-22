// ai-contract.test.js — the client and the AI route agree about the request shape.
//
// The reported fault was "The AI on the agenda gives the error: Unsupported
// field: prompt". Nothing was wrong with the model, the task, or the client. The
// route's context schema is `.strict()`, a new field was added to the client and
// the task definition but not to the schema, and every request was refused
// before it reached the model.
//
// Unit tests did not catch it because each half was correct on its own. What was
// missing was a test of the seam. So this does not check `prompt` specifically:
// it reads the context object out of every `session.generate(...)` call in the
// client and validates each one against the real schema. A field added to one
// side and not the other fails here, whichever field it is.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { contextSchema, generateSchema } from "../src/routes/ai.js";
import { KIND_NAMES } from "../src/services/checkin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_LIB = join(HERE, "..", "..", "web", "src", "lib");

/* Every generate() call the client makes: its kind, and the context keys it
   builds. Read from the source rather than maintained by hand, so a new call
   site is covered the day it is written. */
function clientCalls() {
  const calls = [];
  for (const file of readdirSync(CLIENT_LIB).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(CLIENT_LIB, file), "utf8");
    const re = /session\.generate\(\s*"([a-z_]+)"\s*,\s*(\{|[A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) {
      const [, kind, opener] = m;
      let keys = null;
      if (opener === "{") {
        // Balance braces to find the object literal, then take its top-level keys.
        let depth = 0, i = m.index + m[0].length - 1, end = i;
        for (; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(m.index + m[0].length, end);
        keys = [...body.matchAll(/(?:^|\n)\s{4}([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
      }
      calls.push({ file, kind, keys });
    }
  }
  return calls;
}

test("the client only asks for kinds the server accepts", () => {
  const calls = clientCalls();
  assert.ok(calls.length >= 4, `expected to find the generate() call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.ok(KIND_NAMES.includes(c.kind),
      `${c.file} asks for "${c.kind}", which the server does not accept`);
  }
});

test("REGRESSION: every context field the client sends is accepted", () => {
  /* The exact defect. With `prompt` missing from the schema this fails on the
     date_ideas call with the same message Ryan saw. */
  const offenders = [];
  for (const c of clientCalls()) {
    if (!c.keys) continue;   // context built elsewhere; covered by its own test
    const probe = Object.fromEntries(c.keys.map((k) => [k, sampleFor(k)]));
    const r = contextSchema.safeParse(probe);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.code === "unrecognized_keys");
      if (issue) offenders.push(`${c.file} → ${c.kind}: ${issue.keys.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [],
    `the client sends fields the route refuses:\n  ${offenders.join("\n  ")}`);
});

/* A plausible value per field, so only *unknown key* failures are reported and
   not type mismatches from a placeholder. */
function sampleFor(key) {
  switch (key) {
    case "count": return 5;
    case "householdSize": return 2;
    case "season": return "summer";
    case "budget": return "cheap";
    case "indoor": case "hasDependents": return true;
    case "existing": case "recentTopics": case "items": case "aisles": return [];
    case "signals": return {};
    default: return "x";
  }
}

test("the date-jar prompt is accepted end to end", () => {
  // Named explicitly as well, because it is the one that was broken and the
  // generic test above would go quiet if the call site were ever restructured.
  const body = {
    kind: "date_ideas",
    context: { jar: "cheap", season: "summer", prompt: "outdoors, under two hours", existing: [], householdSize: 2, count: 5 },
    audience: "private",
  };
  const r = generateSchema.safeParse(body);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
});

test("a prompt is capped rather than passed through at any length", () => {
  // It is household text going into a model prompt; unbounded input is how a
  // steer becomes an override.
  const ok = contextSchema.safeParse({ prompt: "a".repeat(400) });
  assert.equal(ok.success, true);
  const tooLong = contextSchema.safeParse({ prompt: "a".repeat(401) });
  assert.equal(tooLong.success, false);
});

test("a genuinely unknown field is still refused, and named", () => {
  // The strictness is deliberate; this test is here so a future fix for a
  // mismatch is not "loosen the schema".
  const r = contextSchema.safeParse({ smuggled: "x" });
  assert.equal(r.success, false);
  const issue = r.error.issues.find((i) => i.code === "unrecognized_keys");
  assert.ok(issue && issue.keys.includes("smuggled"));
});
