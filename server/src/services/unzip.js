// unzip.js — extracting an archive that arrived over the internet.
//
// The super-admin upgrade flow takes a zip and hands its contents to a coding
// agent with write access to a git checkout. Every classic archive attack is in
// scope, and each is refused explicitly below rather than trusted to the zip
// library:
//
//   Zip slip      entry named ../../etc/cron.d/x escapes the extraction root
//   Absolute path entry named /etc/passwd
//   Symlink       entry that is a link to /, so later writes land outside
//   Zip bomb      1 KB archive that expands to 40 GB
//   Entry flood   millions of empty entries to exhaust inodes
//   Name tricks   backslash separators, NUL bytes, unicode traversal
//
// The rule throughout: resolve the final path and prove it is inside the root.
// Never trust the name in the header.

import yauzl from "yauzl";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const DEFAULTS = {
  maxEntries: 5000,
  maxTotalBytes: 250 * 1024 * 1024,
  maxEntryBytes: 50 * 1024 * 1024,
  // Refuse an archive whose declared expansion is wildly out of proportion to
  // its compressed size -- the signature of a bomb.
  maxCompressionRatio: 200,
};

export class UnsafeArchiveError extends Error {}

/** True if `child` really sits under `root` after both are fully resolved. */
function isInside(root, child) {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

function checkEntryName(name) {
  if (!name) throw new UnsafeArchiveError("Archive contains an entry with no name");
  if (name.includes("\0")) throw new UnsafeArchiveError("Archive entry name contains a NUL byte");
  // Windows-style separators would sidestep a POSIX-only traversal check.
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new UnsafeArchiveError(`Archive contains an absolute path: ${name}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new UnsafeArchiveError(`Archive contains a path traversal: ${name}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new UnsafeArchiveError(`Archive contains a drive-letter path: ${name}`);
  }
  return normalized;
}

/**
 * Extract `zipPath` into `destDir`, which must already be empty.
 * Returns { files, totalBytes }.
 */
export function extractZip(zipPath, destDir, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new UnsafeArchiveError(`Could not read the archive: ${err.message}`));

      if (zip.entryCount > opts.maxEntries) {
        zip.close();
        return reject(new UnsafeArchiveError(
          `Archive has ${zip.entryCount} entries; the limit is ${opts.maxEntries}.`
        ));
      }

      let totalBytes = 0;
      const files = [];
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; zip.close(); reject(e); } };

      zip.on("error", (e) => fail(new UnsafeArchiveError(`Archive error: ${e.message}`)));

      zip.on("entry", async (entry) => {
        try {
          const name = checkEntryName(entry.fileName);
          const target = join(destDir, name);
          if (!isInside(destDir, target)) {
            throw new UnsafeArchiveError(`Archive entry escapes the extraction directory: ${entry.fileName}`);
          }

          // Directory entries end in a slash.
          if (/\/$/.test(name)) {
            await mkdir(target, { recursive: true });
            return zip.readEntry();
          }

          // External attributes carry the unix mode in the high 16 bits.
          // 0xA000 is S_IFLNK. A symlink is the tidiest way to make a later,
          // apparently-safe write land anywhere on the filesystem.
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0xf000) === 0xa000) {
            throw new UnsafeArchiveError(`Archive contains a symlink, which is not allowed: ${entry.fileName}`);
          }

          if (entry.uncompressedSize > opts.maxEntryBytes) {
            throw new UnsafeArchiveError(
              `${entry.fileName} expands to ${entry.uncompressedSize} bytes; the per-file limit is ${opts.maxEntryBytes}.`
            );
          }
          if (entry.compressedSize > 0) {
            const ratio = entry.uncompressedSize / entry.compressedSize;
            if (ratio > opts.maxCompressionRatio && entry.uncompressedSize > 1_000_000) {
              throw new UnsafeArchiveError(
                `${entry.fileName} has a compression ratio of ${Math.round(ratio)}:1, which looks like a zip bomb.`
              );
            }
          }

          totalBytes += entry.uncompressedSize;
          if (totalBytes > opts.maxTotalBytes) {
            throw new UnsafeArchiveError(
              `Archive expands past the ${Math.round(opts.maxTotalBytes / 1024 / 1024)} MB total limit.`
            );
          }

          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s)))
          );

          // The declared size is a claim in a header an attacker wrote. Count
          // what actually arrives and stop if it exceeds the promise.
          let written = 0;
          stream.on("data", (chunk) => {
            written += chunk.length;
            if (written > opts.maxEntryBytes) stream.destroy(new UnsafeArchiveError(
              `${entry.fileName} is larger than its header declared.`
            ));
          });

          // Mode 0o644 regardless of what the archive asked for: nothing
          // extracted from an upload has any business being executable.
          await pipeline(stream, createWriteStream(target, { mode: 0o644 }));
          files.push(name);
          zip.readEntry();
        } catch (e) {
          fail(e instanceof UnsafeArchiveError ? e : new UnsafeArchiveError(e.message));
        }
      });

      zip.on("end", () => {
        if (!settled) { settled = true; resolvePromise({ files, totalBytes }); }
      });

      zip.readEntry();
    });
  });
}

/** Extract into a directory, removing it first so leftovers cannot leak between jobs. */
export async function extractFresh(zipPath, destDir, options) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  return extractZip(zipPath, destDir, options);
}
