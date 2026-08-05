// safe-fetch.test.js — the SSRF blocklist.
//
// Every case here is a real attack against a server that fetches user-supplied
// calendar URLs on behalf of a household.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress, safeFetch, BlockedRequestError } from "../src/services/safe-fetch.js";

test("blocks loopback", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("blocks the cloud metadata endpoint", () => {
  // The single highest-value SSRF target: on AWS/GCP/Azure this address hands
  // out instance credentials to anything that can make an HTTP request.
  assert.equal(isBlockedAddress("169.254.169.254"), true);
});

test("blocks RFC1918 and CGNAT ranges", () => {
  for (const ip of ["10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("allows ordinary public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("blocks IPv6 link-local, unique-local and multicast", () => {
  for (const ip of ["fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("blocks IPv4-mapped IPv6 loopback", () => {
  // ::ffff:127.0.0.1 is loopback wearing an IPv6 costume. A blocklist that only
  // string-matches IPv6 prefixes waves it straight through.
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:169.254.169.254"), true);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

test("fails closed on anything that is not an address", () => {
  for (const junk of ["", "localhost", "not-an-ip", "999.999.999.999"]) {
    assert.equal(isBlockedAddress(junk), true, junk);
  }
});

test("refuses non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://example.com/f"]) {
    await assert.rejects(() => safeFetch(url), BlockedRequestError, url);
  }
});

test("refuses a literal private address in the URL", async () => {
  await assert.rejects(() => safeFetch("http://127.0.0.1:11434/api/tags"), BlockedRequestError);
  await assert.rejects(() => safeFetch("http://169.254.169.254/latest/meta-data/"), BlockedRequestError);
  await assert.rejects(() => safeFetch("http://[::1]:5432/"), BlockedRequestError);
});

test("refuses a hostname that resolves to loopback", async () => {
  // localhost is the obvious one, but any attacker-controlled domain can have
  // an A record pointing at 127.0.0.1 -- which is why the check is on the
  // resolved address rather than on the name.
  await assert.rejects(() => safeFetch("http://localhost:5432/"), BlockedRequestError);
});
