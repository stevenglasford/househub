// unzip.test.js — archive attacks against the upgrade pipeline.
//
// Fixtures are generated at run time rather than checked in, because a
// repository full of deliberately malicious zip files trips every scanner
// between here and a contributor's laptop. Python builds them because it can
// write arbitrary entry names and unix modes, which a well-behaved zip library
// will not let you do -- that being rather the point.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFresh, UnsafeArchiveError } from "../src/services/unzip.js";

let dir;
let havePython = true;

const BUILD = `
import zipfile, sys, os
d = sys.argv[1]
with zipfile.ZipFile(d + "/slip.zip", "w") as z:
    z.writestr("../../../../tmp/hh-pwned.txt", "owned")
with zipfile.ZipFile(d + "/abs.zip", "w") as z:
    z.writestr("/etc/cron.d/hh-evil", "owned")
zi = zipfile.ZipInfo("link"); zi.external_attr = (0xA1FF << 16)
with zipfile.ZipFile(d + "/link.zip", "w") as z:
    z.writestr(zi, "/")
with zipfile.ZipFile(d + "/bomb.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("big.bin", b"\\0" * (200 * 1024 * 1024))
with zipfile.ZipFile(d + "/bslash.zip", "w") as z:
    z.writestr("..\\\\..\\\\..\\\\hh-evil.txt", "owned")
with zipfile.ZipFile(d + "/flood.zip", "w") as z:
    for i in range(6000):
        z.writestr("f%d.txt" % i, "x")
with zipfile.ZipFile(d + "/ok.zip", "w") as z:
    z.writestr("feature/README.md", "# add a feature")
    z.writestr("feature/src/thing.js", "export const x = 1;")
`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hh-unzip-"));
  try {
    execFileSync("python3", ["-c", BUILD, dir], { stdio: "pipe" });
  } catch {
    havePython = false;
  }
});

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const blocks = (name, pattern) => test(`blocks ${name}`, async (t) => {
  if (!havePython) return t.skip("python3 unavailable to build fixtures");
  await assert.rejects(
    () => extractFresh(join(dir, `${name}.zip`), join(dir, "out", name)),
    (err) => {
      // yauzl rejects some of these before our own checks run. Either is fine --
      // what must never happen is a successful extraction.
      assert.match(err.message, pattern);
      return true;
    }
  );
});

blocks("slip", /relative path|traversal/i);
blocks("abs", /absolute path/i);
blocks("link", /symlink/i);
blocks("bomb", /limit|bomb/i);
blocks("bslash", /relative path|traversal|absolute/i);
blocks("flood", /entries/i);

test("nothing escaped the extraction root", async (t) => {
  if (!havePython) return t.skip("python3 unavailable");
  // The blocked archives above targeted these exact paths.
  assert.equal(existsSync("/tmp/hh-pwned.txt"), false);
  assert.equal(existsSync("/etc/cron.d/hh-evil"), false);
});

test("a benign archive extracts intact", async (t) => {
  if (!havePython) return t.skip("python3 unavailable");
  const out = join(dir, "out", "ok");
  const result = await extractFresh(join(dir, "ok.zip"), out);
  assert.equal(result.files.length, 2);
  assert.equal(await readFile(join(out, "feature/README.md"), "utf8"), "# add a feature");
});

test("UnsafeArchiveError is exported for callers to distinguish", () => {
  assert.ok(new UnsafeArchiveError("x") instanceof Error);
});
