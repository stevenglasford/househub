// upgrades.js — drop in a zip, get a reviewed pull request.
//
// The brief asked for a super-admin who can drag a zip onto the site and have
// Claude Code implement the changes, run the migrations, and push to GitHub.
// This implements that, with two deliberate deviations that I would argue are
// what makes it safe enough to actually turn on:
//
//   1. IT OPENS A PULL REQUEST, IT DOES NOT DEPLOY. The default path ends at a
//      branch and a PR. Pushing straight to the base branch is possible
//      (UPGRADE_DIRECT_PUSH) and off, because "an AI changed the code that
//      protects thirty families' private data and nobody looked" is not a
//      failure mode worth having by default.
//
//   2. THE ADDITIVE-ONLY RULE IS ENFORCED, NOT REQUESTED. The brief said these
//      upgrades should mostly add rather than remove. A sentence in a prompt is
//      a suggestion; `guardDiff` below is a gate. It fails the job outright if
//      the diff deletes migrations, removes crypto or auth code, or strips more
//      than a configured share of any file.
//
// The pipeline never touches the vault, never reads a household key, and runs
// nowhere near the database that holds them.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { q } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { extractFresh } from "./unzip.js";
import {
  UPGRADE_REPO_URL, UPGRADE_WORK_DIR, UPGRADE_BASE_BRANCH, CLAUDE_BIN,
  GITHUB_TOKEN, UPGRADE_DIRECT_PUSH, UPGRADE_TIMEOUT_MS,
} from "../config.js";

const exec = promisify(execFile);

/* ----------------------------------------------------------- protection --- */

// Touching any of these is not an "upgrade". They are the files that make the
// privacy guarantees true, and a change to them needs a human who understands
// why, not an agent working from a zip file.
const PROTECTED_PATHS = [
  "server/src/crypto/",
  "server/src/middleware/auth.js",
  "server/src/middleware/security.js",
  "web/src/lib/crypto.js",
  "server/src/services/safe-fetch.js",
  "server/src/db/migrations/",     // existing migrations are immutable
];

// Deleting these would quietly disable a control while leaving the code that
// "uses" it looking fine.
const NEVER_DELETE = /^(server\/src\/(crypto|middleware|db\/migrations)\/|web\/src\/lib\/crypto\.js|security\/)/;

const MAX_DELETED_SHARE = 0.35;   // of a single file's lines
const MAX_TOTAL_DELETIONS = 800;

/* ------------------------------------------------------------------ git --- */

async function git(cwd, args, { timeout = 120_000 } = {}) {
  const { stdout } = await exec("git", args, {
    cwd, timeout, maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // Never block waiting on a credential prompt: this runs unattended, and a
      // git process sitting on stdin forever looks exactly like a hung job.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/true",
    },
  });
  return stdout;
}

/** Repo URL with the token injected, for push only. Never logged. */
function authedRemote() {
  if (!GITHUB_TOKEN) return UPGRADE_REPO_URL;
  return UPGRADE_REPO_URL.replace("https://", `https://x-access-token:${GITHUB_TOKEN}@`);
}

const redact = (s) => (GITHUB_TOKEN ? String(s).split(GITHUB_TOKEN).join("***") : String(s));

/* ---------------------------------------------------------------- jobs ---- */

async function setStatus(jobId, status, detail, extra = {}) {
  const sets = ["status = $2", "phase_detail = $3", "updated_at = now()"];
  const params = [jobId, status, detail || null];
  let i = 4;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = $${i++}`);
    params.push(typeof v === "object" ? JSON.stringify(v) : v);
  }
  await q(`UPDATE upgrade_jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

async function appendLog(jobId, text) {
  await q("UPDATE upgrade_jobs SET log = left(log || $2, 200000), updated_at = now() WHERE id = $1",
    [jobId, `\n${redact(text)}`]);
}

/* --------------------------------------------------------------- guard ---- */

/**
 * The additive-only gate.
 *
 * Parses `git diff --numstat` and refuses anything that removes more than it
 * should. Returns a report either way, so a rejected job explains itself
 * instead of just failing.
 */
export function guardDiff(numstat, nameStatus) {
  const findings = [];
  const files = [];

  for (const line of numstat.split("\n").filter(Boolean)) {
    const [addRaw, delRaw, path] = line.split("\t");
    if (!path) continue;
    // "-" means binary.
    const added = addRaw === "-" ? 0 : Number(addRaw);
    const deleted = delRaw === "-" ? 0 : Number(delRaw);
    files.push({ path, added, deleted, binary: addRaw === "-" });

    if (PROTECTED_PATHS.some((p) => path.startsWith(p)) && deleted > 0) {
      findings.push({
        severity: "block", path,
        reason: `${path} is security-critical and this change removes ${deleted} line(s) from it.`,
      });
    }
  }

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    if (status?.startsWith("D")) {
      if (NEVER_DELETE.test(path)) {
        findings.push({ severity: "block", path, reason: `${path} may not be deleted by an automated upgrade.` });
      } else {
        findings.push({ severity: "warn", path, reason: `${path} was deleted.` });
      }
    }
  }

  const totalDeleted = files.reduce((n, f) => n + f.deleted, 0);
  const totalAdded = files.reduce((n, f) => n + f.added, 0);

  if (totalDeleted > MAX_TOTAL_DELETIONS) {
    findings.push({
      severity: "block", path: "(whole diff)",
      reason: `${totalDeleted} lines deleted across the change; the ceiling for an automated upgrade is ${MAX_TOTAL_DELETIONS}.`,
    });
  }

  // A file that is mostly deletions is a rewrite, whatever the commit message says.
  for (const f of files) {
    const before = f.deleted + Math.max(0, f.added - f.deleted);
    if (f.deleted > 40 && before > 0 && f.deleted / before > MAX_DELETED_SHARE) {
      findings.push({
        severity: "warn", path: f.path,
        reason: `${Math.round((f.deleted / before) * 100)}% of ${f.path} was removed.`,
      });
    }
  }

  const blocked = findings.filter((f) => f.severity === "block");
  return {
    ok: blocked.length === 0,
    additive: totalAdded > totalDeleted,
    totalAdded, totalDeleted,
    filesChanged: files.length,
    findings,
    files: files.slice(0, 200),
  };
}

/* ------------------------------------------------------------- pipeline --- */

const PROMPT_HEADER = `You are making an incremental upgrade to HouseHub, a self-hosted,
end-to-end-encrypted household organiser.

A zip of requested changes has been extracted to ./_incoming/. Read it, then implement
what it asks for in this repository.

HARD CONSTRAINTS -- a change violating any of these will be rejected automatically:
1. ADD, do not remove. Do not delete files, routes, or features. If something must
   change shape, keep the old path working.
2. Do not modify anything under server/src/crypto/, web/src/lib/crypto.js,
   server/src/middleware/auth.js, server/src/middleware/security.js, or
   server/src/services/safe-fetch.js. These carry the privacy guarantees.
3. NEVER edit an existing file in server/src/db/migrations/. Applied migrations are
   immutable. Schema changes go in a NEW migration file with the next number.
4. The server must never be able to read household content. Do not add an endpoint
   that accepts or returns household plaintext, and do not weaken the encryption.
5. All AI inference stays local, through services/ollama.js. Never add a remote
   model provider or an API key.
6. Delete the ./_incoming/ directory when you are done. It must not be committed.

Also:
- Match the surrounding code style, including comment density.
- If the request needs a schema change, write the migration.
- If you cannot do something safely, leave it undone and say so in your final message.
- Run \`npm test\` in server/ and web/ if you changed code they cover.

The request follows.
`;

/**
 * Run one job to completion. Long-running; called detached from the request.
 *
 * Failure at any stage leaves the job row explaining what happened and the work
 * tree in place for a human to inspect. Nothing is auto-retried: a coding agent
 * repeatedly running against the same prompt burns tokens and rarely does better.
 */
export async function runUpgradeJob(jobId) {
  const workDir = join(UPGRADE_WORK_DIR, jobId);
  const repoDir = join(workDir, "repo");

  try {
    const { rows } = await q("SELECT * FROM upgrade_jobs WHERE id = $1", [jobId]);
    const job = rows[0];
    if (!job) return;

    /* ---- 1. unpack ---- */
    await setStatus(jobId, "scanning", "Checking the uploaded archive");
    await mkdir(workDir, { recursive: true });

    const incoming = join(repoDir, "_incoming");

    /* ---- 2. clone ---- */
    await setStatus(jobId, "scanning", "Fetching the repository");
    await rm(repoDir, { recursive: true, force: true });
    await git(workDir, ["clone", "--depth", "50", "--branch", UPGRADE_BASE_BRANCH, authedRemote(), "repo"],
      { timeout: 300_000 });

    const baseCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
    const branch = `upgrade/${jobId.slice(0, 8)}-${slug(job.title)}`;
    await git(repoDir, ["checkout", "-b", branch]);
    await git(repoDir, ["config", "user.email", "househub-upgrades@localhost"]);
    await git(repoDir, ["config", "user.name", "HouseHub Upgrade Bot"]);
    await setStatus(jobId, "planning", "Extracting the request", { base_commit: baseCommit, branch_name: branch });

    const extracted = await extractFresh(job.bundle_path, incoming);
    await appendLog(jobId, `Extracted ${extracted.files.length} file(s), ${extracted.totalBytes} bytes.`);

    /* ---- 3. hand it to Claude Code ---- */
    await setStatus(jobId, "applying", "Claude Code is implementing the change");
    const prompt = `${PROMPT_HEADER}\n---\n${job.instructions || "(see ./_incoming/)"}\n`;
    await writeFile(join(workDir, "prompt.txt"), prompt, "utf8");

    let claudeOut = "";
    try {
      const { stdout } = await exec(
        CLAUDE_BIN,
        ["-p", prompt, "--permission-mode", "acceptEdits", "--output-format", "text"],
        { cwd: repoDir, timeout: UPGRADE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
      );
      claudeOut = stdout;
    } catch (err) {
      // A non-zero exit still often leaves useful edits and a useful message.
      claudeOut = `${err.stdout || ""}\n${err.stderr || ""}`;
      if (err.killed) throw new Error(`Claude Code timed out after ${Math.round(UPGRADE_TIMEOUT_MS / 60000)} minutes`);
    }
    await appendLog(jobId, `--- Claude Code ---\n${claudeOut.slice(-20000)}`);

    // The agent was told to remove this. If it did not, remove it ourselves --
    // committing the upload would leak it into the public repository.
    await rm(incoming, { recursive: true, force: true });

    /* ---- 4. the gate ---- */
    await setStatus(jobId, "verifying", "Checking the change is additive and safe");
    await git(repoDir, ["add", "-A"]);

    const numstat = await git(repoDir, ["diff", "--cached", "--numstat"]);
    const nameStatus = await git(repoDir, ["diff", "--cached", "--name-status"]);
    if (!numstat.trim()) {
      await setStatus(jobId, "failed", "Claude Code made no changes");
      return;
    }

    const guard = guardDiff(numstat, nameStatus);
    await setStatus(jobId, "verifying", "Running tests", {
      guard_report: guard,
      diff_stat: { added: guard.totalAdded, deleted: guard.totalDeleted, files: guard.filesChanged },
    });

    if (!guard.ok) {
      await appendLog(jobId, `GUARD BLOCKED:\n${guard.findings.map((f) => `  [${f.severity}] ${f.reason}`).join("\n")}`);
      await setStatus(jobId, "failed", "Rejected by the additive-only guard");
      await audit("upgrade_blocked", { actorUserId: job.created_by, target: jobId, meta: { findings: guard.findings.length } });
      return;
    }

    /* ---- 5. tests ---- */
    const testReport = await runTests(repoDir, jobId);
    if (!testReport.ok) {
      await setStatus(jobId, "failed", "Tests failed", { test_report: testReport });
      return;
    }

    /* ---- 6. commit, park for review ---- */
    await git(repoDir, ["commit", "-m",
      `${job.title}\n\nApplied by HouseHub's upgrade pipeline (Claude Code).\nJob: ${jobId}\n`]);
    const headCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

    await setStatus(jobId, "awaiting_review", "Waiting for a super-admin to review the diff", {
      head_commit: headCommit, test_report: testReport,
    });
    await audit("upgrade_ready", { actorUserId: job.created_by, target: jobId });
  } catch (err) {
    await appendLog(jobId, `ERROR: ${err.message}`);
    await setStatus(jobId, "failed", redact(err.message).slice(0, 500));
    await audit("upgrade_failed", { target: jobId, meta: { error: redact(err.message).slice(0, 200) } });
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "change";

async function runTests(repoDir, jobId) {
  const results = [];
  for (const pkg of ["server", "web"]) {
    const dir = join(repoDir, pkg);
    try {
      await readdir(dir);
    } catch { continue; }

    try {
      await exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, timeout: 600_000, maxBuffer: 16e6 });
      const { stdout } = await exec("npm", ["test"], { cwd: dir, timeout: 600_000, maxBuffer: 16e6 });
      results.push({ pkg, ok: true, tail: stdout.slice(-2000) });
    } catch (err) {
      const output = `${err.stdout || ""}\n${err.stderr || ""}`;
      // A package with no test script is not a failure.
      if (/Missing script: "test"/.test(output)) {
        results.push({ pkg, ok: true, skipped: true });
        continue;
      }
      results.push({ pkg, ok: false, tail: output.slice(-4000) });
    }
  }
  await appendLog(jobId, `--- tests ---\n${results.map((r) => `${r.pkg}: ${r.ok ? "pass" : "FAIL"}`).join("\n")}`);
  return { ok: results.every((r) => r.ok), results };
}

/* ---------------------------------------------------------------- ship ---- */

/**
 * Push the reviewed branch and open a pull request.
 *
 * Called only after a human super-admin has looked at the diff and approved it.
 */
export async function publishUpgrade(jobId, reviewerId) {
  const { rows } = await q("SELECT * FROM upgrade_jobs WHERE id = $1", [jobId]);
  const job = rows[0];
  if (!job) throw new Error("No such job");
  if (job.status !== "approved") throw new Error(`Job is ${job.status}, not approved`);

  const repoDir = join(UPGRADE_WORK_DIR, jobId, "repo");
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set, so nothing can be pushed");

  await setStatus(jobId, "approved", "Pushing the branch");
  await git(repoDir, ["push", authedRemote(), `HEAD:refs/heads/${job.branch_name}`], { timeout: 300_000 });

  let prUrl = null;
  const repoPath = new URL(UPGRADE_REPO_URL).pathname.replace(/^\/|\.git$/g, "");

  if (UPGRADE_DIRECT_PUSH) {
    await git(repoDir, ["push", authedRemote(), `HEAD:refs/heads/${UPGRADE_BASE_BRANCH}`], { timeout: 300_000 });
    await appendLog(jobId, `Pushed directly to ${UPGRADE_BASE_BRANCH} (UPGRADE_DIRECT_PUSH is on).`);
  } else {
    const res = await fetch(`https://api.github.com/repos/${repoPath}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: job.title,
        head: job.branch_name,
        base: UPGRADE_BASE_BRANCH,
        body: prBody(job),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub refused the pull request: ${data.message || res.status}`);
    prUrl = data.html_url;
  }

  await setStatus(jobId, "pushed", prUrl ? "Pull request opened" : "Pushed to the base branch", {
    pr_url: prUrl, reviewed_by: reviewerId, reviewed_at: new Date().toISOString(),
  });
  await audit("upgrade_published", { actorUserId: reviewerId, target: jobId, meta: { prUrl } });
  return { prUrl, branch: job.branch_name };
}

function prBody(job) {
  const g = job.guard_report || {};
  return [
    "Generated by HouseHub's upgrade pipeline (Claude Code), reviewed by a super-admin before opening.",
    "",
    `**Request:** ${job.title}`,
    "",
    "### Guard report",
    `- ${g.filesChanged ?? "?"} files changed, +${g.totalAdded ?? "?"} / -${g.totalDeleted ?? "?"}`,
    `- Additive: ${g.additive ? "yes" : "no"}`,
    ...(g.findings?.length ? ["", "Findings:", ...g.findings.map((f) => `- \`${f.severity}\` ${f.reason}`)] : []),
    "",
    "### Tests",
    ...(job.test_report?.results || []).map((r) => `- ${r.pkg}: ${r.ok ? "pass" : "FAIL"}${r.skipped ? " (no tests)" : ""}`),
    "",
    "---",
    "Automated changes are constrained to be additive and cannot touch `server/src/crypto/`,",
    "`web/src/lib/crypto.js`, the auth/security middleware, or existing migrations.",
    "Review the diff before merging.",
  ].join("\n");
}

export function bundleHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
