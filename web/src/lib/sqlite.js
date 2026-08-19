// sqlite.js — a read-only SQLite file reader, in plain JavaScript.
//
// WHY THIS EXISTS
//
// The old HouseHub kept everything in a SQLite file. Importing that into the
// encrypted rewrite has to happen *in the browser*, because the browser is the
// only place the household key exists -- the server cannot seal a document it
// cannot read. So the browser has to be able to open a .db file.
//
// The usual answer is sql.js, a WASM build of SQLite. That is not available
// here: the Content-Security-Policy forbids `wasm-unsafe-eval`, and that policy
// is the control protecting the encryption keys (see middleware/security.js).
// Widening it so an import screen can run would be trading the app's central
// security property for a convenience.
//
// So this reads the file format directly. No dependencies, no eval, no network.
// Roughly 250 lines, because it only does what the import needs:
//
//   * open a database file from an ArrayBuffer
//   * list tables
//   * read every row of a table
//
// It does NOT implement SQL, indexes, writing, or WITHOUT ROWID tables. It does
// handle the things a real household database will actually contain: overflow
// pages (a calendar's .ics text is far bigger than one page), interior B-tree
// pages (any table past a few dozen rows), and every serial type.
//
// Format reference: https://www.sqlite.org/fileformat.html

const HEADER_MAGIC = "SQLite format 3\0";

export class SqliteError extends Error {}

/* ------------------------------------------------------------ varints --- */

/**
 * SQLite's big-endian variable-length integer: up to nine bytes, seven bits of
 * payload each, high bit meaning "another byte follows". The ninth byte, if it
 * gets that far, contributes all eight of its bits.
 */
function readVarint(view, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = view.getUint8(offset + i);
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, i + 1];
  }
  value = (value << 8n) | BigInt(view.getUint8(offset + 8));
  return [value, 9];
}

// Payload sizes and rowids comfortably fit a JS number; only stored integers
// can genuinely need 64 bits, and those are converted separately.
const num = (big) => Number(big);

/* ------------------------------------------------------------- records --- */

const textDecoder = new TextDecoder("utf-8");

/**
 * Decode one record ("row") from its serialised bytes.
 *
 * A record is a header of serial-type codes followed by the values themselves,
 * which is why the two halves are walked with separate cursors.
 */
function decodeRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [headerSizeBig, headerLenBytes] = readVarint(view, 0);
  const headerSize = num(headerSizeBig);

  const types = [];
  let cursor = headerLenBytes;
  while (cursor < headerSize) {
    const [type, used] = readVarint(view, cursor);
    types.push(num(type));
    cursor += used;
  }

  const values = [];
  let at = headerSize;
  for (const type of types) {
    if (type === 0) { values.push(null); continue; }
    if (type === 8) { values.push(0); continue; }
    if (type === 9) { values.push(1); continue; }
    if (type === 10 || type === 11) { values.push(null); continue; }  // reserved

    if (type >= 1 && type <= 6) {
      const width = [0, 1, 2, 3, 4, 6, 8][type];
      let signed = 0n;
      for (let i = 0; i < width; i++) signed = (signed << 8n) | BigInt(view.getUint8(at + i));
      // sign-extend
      const bits = BigInt(width * 8);
      if (signed >= 1n << (bits - 1n)) signed -= 1n << bits;
      // Only 8-byte integers can exceed what a JS number represents exactly.
      values.push(width === 8 && (signed > 9007199254740991n || signed < -9007199254740991n)
        ? signed
        : Number(signed));
      at += width;
      continue;
    }
    if (type === 7) { values.push(view.getFloat64(at)); at += 8; continue; }

    const length = (type - (type % 2 === 0 ? 12 : 13)) / 2;
    const slice = bytes.subarray(at, at + length);
    values.push(type % 2 === 0 ? new Uint8Array(slice) : textDecoder.decode(slice));
    at += length;
  }
  return values;
}

/* ----------------------------------------------------------- database --- */

/* ---------------------------------------------------------------- wal --- */

const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;

/**
 * SQLite's WAL checksum: a running pair of 32-bit words over 8-byte chunks.
 *
 * Worth implementing rather than skipping. The whole reason we read WAL files
 * is that somebody copied a database out from under a running server -- which
 * is also the way to end up with a half-written final frame. Replaying that
 * frame would produce a corrupt import that looks completely normal.
 */
function walChecksum(bytes, start, length, bigEndian, [seed0, seed1]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s0 = seed0 >>> 0, s1 = seed1 >>> 0;
  for (let i = start; i < start + length; i += 8) {
    const x0 = view.getUint32(i, !bigEndian);
    const x1 = view.getUint32(i + 4, !bigEndian);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Read a write-ahead log into { pages, dbSize }.
 *
 * Only frames belonging to the current WAL generation (matching salts) and
 * covered by a commit frame are applied -- an uncommitted transaction at the
 * end of the file is exactly as dead as it would be to SQLite itself.
 */
function replayWal(wal, expectedPageSize) {
  if (!wal || wal.length < 32) return null;
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);

  const magic = view.getUint32(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) {
    throw new SqliteError("That -wal file is not a SQLite write-ahead log");
  }
  const bigEndian = magic === WAL_MAGIC_BE;
  const pageSize = view.getUint32(8);
  if (pageSize !== expectedPageSize) {
    throw new SqliteError(
      `The -wal file has a page size of ${pageSize} but the database uses ${expectedPageSize}. ` +
      "They are not from the same database."
    );
  }
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);

  // The header's own checksum seeds the frame chain.
  let running = walChecksum(wal, 0, 24, bigEndian, [0, 0]);
  if (running[0] !== view.getUint32(24) || running[1] !== view.getUint32(28)) {
    throw new SqliteError("That -wal file's header is damaged; it was probably copied mid-write");
  }

  const frameSize = 24 + pageSize;
  const pending = new Map();
  const committed = new Map();
  let dbSize = 0;

  for (let at = 32; at + frameSize <= wal.length; at += frameSize) {
    // A frame from an older generation means the log wrapped; everything from
    // here on belongs to a previous life of this database.
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) break;

    const next = walChecksum(wal, at, 8, bigEndian, running);
    const full = walChecksum(wal, at + 24, pageSize, bigEndian, next);
    if (full[0] !== view.getUint32(at + 16) || full[1] !== view.getUint32(at + 20)) break;
    running = full;

    const pageNumber = view.getUint32(at);
    pending.set(pageNumber, wal.subarray(at + 24, at + 24 + pageSize));

    const sizeAfterCommit = view.getUint32(at + 4);
    if (sizeAfterCommit !== 0) {
      for (const [n, data] of pending) committed.set(n, data);
      pending.clear();
      dbSize = sizeAfterCommit;
    }
  }

  return committed.size ? { pages: committed, dbSize } : null;
}

export class SqliteDatabase {
  /**
   * @param buffer   the database file
   * @param options  { wal } — the matching -wal file, if one was copied too
   */
  constructor(buffer, { wal = null } = {}) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (this.bytes.length < 100) throw new SqliteError("Not a SQLite database: file is too short");

    const magic = String.fromCharCode(...this.bytes.subarray(0, 16));
    if (magic !== HEADER_MAGIC) {
      throw new SqliteError(
        "That is not a SQLite database. If you exported a data.json instead, use that file directly."
      );
    }

    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const declared = this.view.getUint16(16);
    // A page size of 1 means 65536, which does not fit the 16-bit field.
    this.pageSize = declared === 1 ? 65536 : declared;
    this.reservedPerPage = this.view.getUint8(20);
    this.usableSize = this.pageSize - this.reservedPerPage;

    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) {
      throw new SqliteError(`Unsupported page size ${this.pageSize}`);
    }
    this.pageCount = Math.floor(this.bytes.length / this.pageSize);

    /* Recent changes may live in a write-ahead log rather than in the database
       file. The old HouseHub ran in WAL mode, so a database copied while its
       server was still running has its most recent writes only in the -wal --
       and reading the main file alone returns an older household with no error
       and no missing-data warning. Silently importing last week's data is the
       worst outcome this tool has, so the log is replayed over the pages. */
    this.wal = replayWal(wal instanceof Uint8Array ? wal : (wal ? new Uint8Array(wal) : null), this.pageSize);
    if (this.wal) {
      this.pageCount = Math.max(this.pageCount, this.wal.dbSize);
    }

    // A WAL-mode file with no log supplied: the caller may be about to import
    // a stale copy without knowing it.
    this.writeVersion = this.view.getUint8(18);
    this.walMode = this.writeVersion === 2;
  }

  /** One page, 1-indexed as SQLite numbers them. The log wins where it has one. */
  page(number) {
    const fromLog = this.wal?.pages.get(number);
    if (fromLog) return fromLog;
    if (number < 1 || number > this.pageCount) {
      throw new SqliteError(`Page ${number} is outside this file (${this.pageCount} pages)`);
    }
    const start = (number - 1) * this.pageSize;
    if (start + this.pageSize > this.bytes.length) {
      throw new SqliteError(`Page ${number} is past the end of the file`);
    }
    return this.bytes.subarray(start, start + this.pageSize);
  }

  /**
   * Payload for one leaf cell, following overflow pages if the row is too big
   * to sit in a single page.
   *
   * This is not an edge case for us: an imported calendar's .ics text is often
   * tens of kilobytes, so every calendar row overflows.
   */
  #payload(page, offset, payloadSize) {
    const U = this.usableSize;
    const maxLocal = U - 35;
    const minLocal = Math.floor(((U - 12) * 32) / 255) - 23;

    let localSize = payloadSize;
    if (payloadSize > maxLocal) {
      localSize = minLocal + ((payloadSize - minLocal) % (U - 4));
      if (localSize > maxLocal) localSize = minLocal;
    }

    const out = new Uint8Array(payloadSize);
    out.set(page.subarray(offset, offset + localSize), 0);
    if (localSize === payloadSize) return out;

    const pageView = new DataView(page.buffer, page.byteOffset, page.byteLength);
    let next = pageView.getUint32(offset + localSize);
    let written = localSize;
    let guard = 0;

    while (next !== 0 && written < payloadSize) {
      if (++guard > this.pageCount + 1) throw new SqliteError("Overflow page chain loops");
      const ov = this.page(next);
      const ovView = new DataView(ov.buffer, ov.byteOffset, ov.byteLength);
      const chunk = Math.min(U - 4, payloadSize - written);
      out.set(ov.subarray(4, 4 + chunk), written);
      written += chunk;
      next = ovView.getUint32(0);
    }
    if (written !== payloadSize) throw new SqliteError("Truncated overflow chain");
    return out;
  }

  /** Walk a table B-tree from `root`, yielding decoded rows in rowid order. */
  #walk(root, rows, seen = new Set()) {
    if (seen.has(root)) throw new SqliteError("B-tree loops");
    seen.add(root);

    const page = this.page(root);
    // Page 1 carries the 100-byte file header before its own page header.
    const base = root === 1 ? 100 : 0;
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const type = view.getUint8(base);
    const cellCount = view.getUint16(base + 3);

    if (type === 0x05) {                       // interior table page
      const headerLen = 12;
      for (let i = 0; i < cellCount; i++) {
        const ptr = view.getUint16(base + headerLen + i * 2);
        this.#walk(view.getUint32(ptr), rows, seen);
      }
      this.#walk(view.getUint32(base + 8), rows, seen);   // rightmost child
      return rows;
    }

    if (type === 0x0d) {                       // leaf table page
      const headerLen = 8;
      for (let i = 0; i < cellCount; i++) {
        const ptr = view.getUint16(base + headerLen + i * 2);
        const [sizeBig, sizeLen] = readVarint(view, ptr);
        const [rowidBig, rowidLen] = readVarint(view, ptr + sizeLen);
        const payload = this.#payload(page, ptr + sizeLen + rowidLen, num(sizeBig));
        rows.push({ rowid: num(rowidBig), values: decodeRecord(payload) });
      }
      return rows;
    }

    if (type === 0x02 || type === 0x0a) {
      // Index pages. We only ever start from a table root, so reaching one means
      // the file is not shaped the way we assumed rather than that we should
      // quietly return nothing.
      throw new SqliteError("Expected a table B-tree but found an index page");
    }
    throw new SqliteError(`Unknown B-tree page type ${type} on page ${root}`);
  }

  /** Every table in the file: { name, rootPage, columns }. */
  tables() {
    if (this.#schema) return this.#schema;
    const rows = this.#walk(1, []);
    const out = [];
    for (const { values } of rows) {
      const [kind, name, , rootPage, sql] = values;
      if (kind !== "table" || typeof name !== "string") continue;
      if (name.startsWith("sqlite_")) continue;
      out.push({ name, rootPage: Number(rootPage), columns: columnsFromSql(sql) });
    }
    this.#schema = out;
    return out;
  }

  #schema = null;

  hasTable(name) {
    return this.tables().some((t) => t.name.toLowerCase() === String(name).toLowerCase());
  }

  /**
   * Every row of a table, as objects keyed by column name.
   *
   * An INTEGER PRIMARY KEY column is stored as NULL in the record and lives in
   * the rowid instead, so it is filled back in here. Without that, a table
   * declared `id INTEGER PRIMARY KEY` reads back as all-null ids.
   */
  rows(tableName) {
    const table = this.tables().find((t) => t.name.toLowerCase() === String(tableName).toLowerCase());
    if (!table) throw new SqliteError(`No table named ${tableName}`);

    const pkIndex = table.columns.findIndex((c) => c.isRowidAlias);
    return this.#walk(table.rootPage, []).map(({ rowid, values }) => {
      const row = {};
      table.columns.forEach((col, i) => { row[col.name] = values[i] ?? null; });
      if (pkIndex >= 0 && row[table.columns[pkIndex].name] === null) {
        row[table.columns[pkIndex].name] = rowid;
      }
      return row;
    });
  }
}

/**
 * Column names from a CREATE TABLE statement.
 *
 * A deliberately small parser, not a SQL one: it needs to survive the handful of
 * statements the old HouseHub actually wrote, and say so plainly rather than
 * guess if it meets something else.
 */
function columnsFromSql(sql) {
  if (typeof sql !== "string") return [];
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open === -1 || close <= open) return [];

  const body = sql.slice(open + 1, close);
  const parts = [];
  let depth = 0, current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);

  const CONSTRAINTS = /^(primary|unique|check|foreign|constraint)\b/i;
  const out = [];
  for (const raw of parts) {
    const def = raw.trim();
    if (!def || CONSTRAINTS.test(def)) continue;         // table-level constraint
    const name = (def.match(/^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]|^(\w+)/) || [])
      .slice(1).find(Boolean);
    if (!name) continue;
    out.push({
      name,
      // Only INTEGER PRIMARY KEY aliases the rowid. TEXT PRIMARY KEY does not.
      isRowidAlias: /\binteger\s+primary\s+key\b/i.test(def),
    });
  }
  return out;
}

/** Convenience: open from an ArrayBuffer, Uint8Array, or Node Buffer. */
export function openDatabase(buffer, options) {
  return new SqliteDatabase(buffer, options);
}
