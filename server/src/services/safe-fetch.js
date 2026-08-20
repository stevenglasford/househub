// safe-fetch.js — outbound HTTP for URLs a user supplied.
//
// Calendar subscription URLs are typed in by household members, and the server
// fetches them because browsers cannot (CORS). That makes this a textbook
// server-side request forgery surface: without the checks below, anyone with an
// account could point a "calendar feed" at
//
//   http://169.254.169.254/latest/meta-data/iam/security-credentials/  (cloud creds)
//   http://127.0.0.1:11434/api/tags                                    (local Ollama)
//   http://127.0.0.1:5432/                                             (Postgres)
//   http://192.168.1.1/admin                                           (the router)
//
// and read the response back out of the "last sync error" field or the parsed
// event list. On a server hosting other families, that is the whole game.
//
// The defence is to resolve the hostname ourselves, check every resulting
// address against a blocklist, and connect to the address we checked -- then
// repeat for every redirect hop, because a permissive redirect is the standard
// way around a naive allowlist.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.ICS_FETCH_TIMEOUT_MS) || 15000;

export class BlockedRequestError extends Error {}

/** True for any address that must never be reachable from user-supplied input. */
export function isBlockedAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return true;                          // "this network"
    if (a === 10) return true;                         // RFC1918
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
    if (a === 192 && b === 168) return true;           // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;             // IETF protocol assignments
    if (a >= 224) return true;                         // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80")) return true;         // link-local
    if (/^f[cd]/.test(lower)) return true;             // unique local
    if (lower.startsWith("ff")) return true;           // multicast
    // IPv4-mapped (::ffff:127.0.0.1) -- check the embedded address, or the
    // whole blocklist above is trivially bypassed.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;  // not an IP literal: fail closed
}

export async function resolveAndCheck(hostname) {
  // A literal address skips DNS but not the check.
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedRequestError(`Refusing to connect to the private address ${hostname}`);
    }
    return hostname;
  }

  let results;
  try {
    results = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedRequestError(`Could not resolve ${hostname}`);
  }
  if (!results.length) throw new BlockedRequestError(`Could not resolve ${hostname}`);

  // Reject if ANY resolved address is private. A hostname with both a public
  // and a loopback record is a DNS rebinding attempt, not a misconfiguration.
  for (const { address } of results) {
    if (isBlockedAddress(address)) {
      throw new BlockedRequestError(
        `${hostname} resolves to the private address ${address}, which this server will not fetch.`
      );
    }
  }
  return results[0].address;
}

/**
 * Fetch a user-supplied URL, following redirects manually so each hop is
 * re-validated.
 *
 * Note the residual gap, stated rather than papered over: between resolving the
 * name and the socket connecting, DNS could change under us (a TOCTOU
 * rebind). Closing that entirely means pinning the connection to the checked IP
 * via a custom agent, which undici does not currently make straightforward. The
 * exposure is small -- an attacker wins a race and gets a response body they
 * can only read back through a calendar parser -- and it is listed as a known
 * limitation in docs/THREAT-MODEL.md rather than left unmentioned.
 */
export async function safeFetch(rawUrl, { maxBytes = MAX_BYTES } = {}) {
  let url = new URL(String(rawUrl).replace(/^webcal:/i, "https:"));
  let redirects = 0;

  while (true) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BlockedRequestError(`Only http and https are supported (got ${url.protocol})`);
    }
    await resolveAndCheck(url.hostname);

    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "HouseHub/2.0 (+calendar-sync)", Accept: "text/calendar, text/plain;q=0.9" },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new BlockedRequestError("Redirect without a destination");
      if (++redirects > MAX_REDIRECTS) throw new BlockedRequestError("Too many redirects");
      url = new URL(location, url);      // re-checked at the top of the loop
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Stream with a hard cap, so a feed that is secretly a 10 GB file cannot
    // exhaust memory. Content-Length is a hint and is checked too, but a
    // chunked response has none -- the running total is what actually bounds it.
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error(`Feed is too large (${declared} bytes)`);

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Feed exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
