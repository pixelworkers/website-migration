// guard.mjs — the network and filesystem trust boundary for the audit scripts.
//
// The crawler follows data it was handed by the site it is auditing: sitemap
// <loc> entries, <a href> targets, and HTTP redirects. Any of those can point
// somewhere the operator never intended — a cloud metadata endpoint, a service
// on localhost, a box on the internal LAN. The scripts run on the operator's
// machine or CI runner, so "fetch whatever the target says" is a server-side
// request forgery primitive.
//
// Everything here exists to make that impossible by default:
//
//   * only http: and https: are ever fetched;
//   * private, loopback, link-local, CGNAT, multicast and reserved addresses
//     are refused, as are the well-known metadata hostnames;
//   * hostnames are resolved and the resolved addresses are checked too, so a
//     public name pointing at 127.0.0.1 is refused as well;
//   * redirects are followed manually, one hop at a time, with the same check
//     applied to every hop;
//   * response bodies are read incrementally and capped.
//
// Dependency-free: only node: builtins.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { resolve as resolvePath, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/** Hard cap on a single response body. Bigger pages are truncated, not buffered. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Hard cap on how many sitemap documents one run will fetch. */
export const MAX_SITEMAPS = 50;

/** Hard cap on how many URLs one sitemap tree may contribute. */
export const MAX_SITEMAP_URLS = 50_000;

/** Hard cap on redirect hops per request. */
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

// Hosts the operator has explicitly vouched for, as "host" or "host:port".
// Populated from --allow-host / SITE_MIGRATION_ALLOW_HOSTS. This is the ONLY
// way to reach a private address, and it is deliberately per-host rather than a
// blanket "allow private" switch: staging on 127.0.0.1:3000 must not also open
// the door to 169.254.169.254.
const allowedHosts = new Set();

/** Parse a comma/space separated allow-list into the policy. Returns the list added. */
export function allowHosts(spec) {
  const added = [];
  for (const raw of String(spec || '').split(/[\s,]+/)) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    allowedHosts.add(h);
    added.push(h);
  }
  return added;
}

if (process.env.SITE_MIGRATION_ALLOW_HOSTS) {
  allowHosts(process.env.SITE_MIGRATION_ALLOW_HOSTS);
}

/** Test seam: drop every explicitly allowed host. */
export function clearAllowedHosts() {
  allowedHosts.clear();
}

// Hostnames that are never fetched, allow-list aside. Cloud metadata services
// answer on plain HTTP with no authentication, which is what makes them the
// classic SSRF target.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// [network, prefix-length, label]
const V4_BLOCKS = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function classifyIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return 'unparseable address';
  for (const [net, bits, label] of V4_BLOCKS) {
    const base = ipv4ToInt(net);
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if (((n ^ base) & mask) === 0) return label;
  }
  return null;
}

/** Expand an IPv6 literal (no brackets, no zone) to eight 16-bit groups. */
function expandIPv6(ip) {
  let s = ip;
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct); // scoped addresses are link-local anyway
  let v4Tail = null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    v4Tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rear = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (rear === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - rear.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rear];
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return NaN;
    return parseInt(g, 16);
  });
  if (out.some(Number.isNaN)) return null;
  if (v4Tail) {
    out[6] = v4Tail[0];
    out[7] = v4Tail[1];
  }
  return out;
}

function classifyIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return 'unparseable address';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded v4.
  const topSixZero = g.slice(0, 5).every((x) => x === 0);
  if (topSixZero && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff].join('.');
    if (g.every((x) => x === 0)) return 'unspecified address';
    if (g[5] === 0 && g[6] === 0 && g[7] === 1) return 'loopback';
    const v4class = classifyIPv4(v4);
    if (v4class) return `IPv4-mapped ${v4class}`;
    return null;
  }
  // 64:ff9b::/96 — NAT64, embeds an IPv4 destination.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v4 = [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff].join('.');
    const v4class = classifyIPv4(v4);
    return v4class ? `NAT64-embedded ${v4class}` : null;
  }
  // 2002::/16 — 6to4, embeds an IPv4 address in the next 32 bits.
  if (g[0] === 0x2002) {
    const v4 = [(g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff].join('.');
    const v4class = classifyIPv4(v4);
    if (v4class) return `6to4-embedded ${v4class}`;
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local (fc00::/7)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/**
 * Why this address must not be fetched, or null when it is a normal public one.
 * Exported for the test suite.
 */
export function classifyAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return classifyIPv4(ip);
  if (v === 6) return classifyIPv6(ip);
  return 'not an IP address';
}

// ---------------------------------------------------------------------------
// URL admission
// ---------------------------------------------------------------------------

const resolveCache = new Map();

async function resolvedAddresses(hostname) {
  if (resolveCache.has(hostname)) return resolveCache.get(hostname);
  let addrs;
  try {
    const got = await lookup(hostname, { all: true, verbatim: true });
    addrs = got.map((g) => g.address);
  } catch {
    addrs = null; // unresolvable: let fetch report the real error
  }
  resolveCache.set(hostname, addrs);
  return addrs;
}

function hostKeys(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port ? `:${u.port}` : '';
  return { host, keys: [u.host.toLowerCase(), host, `${host}${port}`] };
}

/**
 * Throw unless `url` may be fetched. Checks the scheme, the literal host, and —
 * for names — every address the host resolves to.
 *
 * Returns the parsed URL on success so callers can use the normalized form.
 */
export async function assertFetchable(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    throw new Error(`refusing to fetch an unparseable URL: ${String(url)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`refusing a non-http(s) URL: ${u.protocol}//… (only http and https are fetched)`);
  }

  const { host, keys } = hostKeys(u);
  if (keys.some((k) => allowedHosts.has(k))) return u;

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`refusing a non-public host: ${host} (pass --allow-host ${host} if this is really your target)`);
  }

  if (isIP(host)) {
    const why = classifyAddress(host);
    if (why) {
      throw new Error(`refusing ${why} address ${host} (pass --allow-host ${host} if this is really your target)`);
    }
    return u;
  }

  const addrs = await resolvedAddresses(host);
  if (addrs) {
    for (const a of addrs) {
      const why = classifyAddress(a);
      if (why) {
        throw new Error(
          `refusing ${host}: it resolves to ${why} address ${a} ` +
            `(pass --allow-host ${host} if this is really your target)`,
        );
      }
    }
  }
  return u;
}

/** Non-throwing form: returns the refusal reason, or null when the URL is fine. */
export async function fetchRefusal(url) {
  try {
    await assertFetchable(url);
    return null;
  } catch (err) {
    return err.message;
  }
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() with the trust boundary applied:
 *   - every URL, including each redirect hop, goes through assertFetchable();
 *   - redirects are followed manually and counted;
 *   - the body is read incrementally and never exceeds `maxBytes`.
 *
 * Resolves to { res, finalUrl, hops } or throws.
 */
export async function guardedFetch(url, { method = 'GET', signal, headers = {}, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = (await assertFetchable(url)).toString();
  const hops = [];
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, { method, redirect: 'manual', signal, headers });
    if (!REDIRECT_STATUSES.has(res.status)) {
      return { res, finalUrl: current, hops };
    }
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current, hops };
    // Drain the redirect body so the socket can be reused.
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    let next;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new Error(`redirect to an unparseable Location: ${location}`);
    }
    if (i === maxRedirects) {
      throw new Error(`too many redirects (> ${maxRedirects}) starting at ${url}`);
    }
    // THE check Vivian's PoC turns on: a same-origin URL that 302s to
    // 169.254.169.254 is refused here, before the second request is made.
    await assertFetchable(next);
    hops.push(next);
    current = next;
  }
  throw new Error(`too many redirects (> ${maxRedirects}) starting at ${url}`);
}

/**
 * Read a response body with a hard byte cap, decoding as UTF-8.
 * Returns { text, bytes, truncated }. Never buffers more than `maxBytes`.
 */
export async function readCapped(res, maxBytes = MAX_BODY_BYTES) {
  if (!res.body) {
    return { text: '', bytes: 0, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, Math.max(0, remaining)));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream is already done */
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { text: buf.toString('utf8'), bytes, truncated };
}

// ---------------------------------------------------------------------------
// Output path safety
// ---------------------------------------------------------------------------

/**
 * Resolve an output path, refusing anything outside the current working
 * directory. Symlinked parents are resolved first, so `out -> /etc` is caught.
 */
export function assertInsideCwd(path) {
  const cwd = realpathSync(process.cwd());
  const abs = resolvePath(cwd, path);
  // Resolve the deepest existing ancestor so a symlinked directory cannot be
  // used to escape.
  let probe = abs;
  let real = null;
  for (;;) {
    try {
      real = realpathSync(probe) + abs.slice(probe.length);
      break;
    } catch {
      const parent = resolvePath(probe, '..');
      if (parent === probe) {
        real = abs;
        break;
      }
      probe = parent;
    }
  }
  if (real !== cwd && !real.startsWith(cwd + sep)) {
    throw new Error(`refusing to write outside the working directory: ${path} resolves to ${real}`);
  }
  return real;
}
