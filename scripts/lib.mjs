// Shared helpers for the site-migration scripts.
// Dependency-free. Requires Node 18+ (built-in fetch). Tested on Node 22.
//
// Nothing here writes to disk, touches DNS, or mutates a remote site.
// Every function is read-only over HTTP.

const DEFAULT_TIMEOUT = 15000;
const USER_AGENT =
  'pixelworkers-site-migration/1.0 (+https://pixelworkers.org; read-only crawler)';

/**
 * Hard safety limits. Every network and parsing path is bounded so a hostile or
 * broken site cannot hang, flood, or blow up memory on the machine running an
 * audit. Raise them deliberately; the defaults are sized for real sites.
 */
export const LIMITS = {
  timeout: DEFAULT_TIMEOUT, // ms, whole request incl. redirects + body read
  maxRedirects: 5, // hops followed per request
  maxBytes: 5 * 1024 * 1024, // response body cap (5 MB); excess is discarded
  headScanBytes: 512 * 1024, // bytes of HTML scanned for <head> metadata
  maxLinksPerPage: 2000, // links harvested from a single page
  maxPages: 5000, // ceiling on --max, whatever the caller passes
  maxDepth: 10, // BFS levels from the start URL
  maxSitemaps: 50, // sitemap documents fetched per site
  maxSitemapUrls: 50000, // URLs taken from sitemaps per site
};

function hostOf(u) {
  // URL.hostname keeps brackets on IPv6 literals; strip them for comparison.
  return u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function portOf(u) {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

function isPrivateIp(host) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  return false;
}

/** True for loopback, private-range, link-local and non-routable internal names. */
export function isInternalHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (/(^|\.)(localhost|local|internal|intranet|home\.arpa)$/.test(h)) return true;
  return isPrivateIp(h);
}

/**
 * SSRF guard for redirects. A 3xx is followed only when it stays on the host you
 * pointed the script at — same host, or the www/apex twin of it, on the standard
 * port for its scheme. A redirect to any other host (an internal address, a
 * metadata endpoint, a third-party domain) is reported, never fetched.
 */
export function redirectAllowed(fromUrl, toUrl) {
  let a;
  let b;
  try {
    a = new URL(fromUrl);
    b = new URL(toUrl);
  } catch {
    return false;
  }
  if (b.protocol !== 'http:' && b.protocol !== 'https:') return false;
  const ah = hostOf(a);
  const bh = hostOf(b);
  if (ah.replace(/^www\./, '') !== bh.replace(/^www\./, '')) return false;
  if (!isInternalHost(ah) && isInternalHost(bh)) return false;
  // Same host on a different port may be an unrelated internal service.
  if (portOf(a) !== portOf(b) && (a.port || b.port)) return false;
  return true;
}

/** Normalize a possibly-relative href against a base URL. Returns null if unparseable. */
export function normalizeUrl(href, base) {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** True when two URLs share scheme+host+port. */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Strip the origin, returning a path+query key usable across two hosts. */
export function toPathKey(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/\/+$/, '') || '/';
    return p + (u.search || '');
  } catch {
    return url;
  }
}

/** Read a response body, stopping hard at `maxBytes`. Returns decoded text. */
async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.byteLength) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Fetch with a hard timeout, a bounded number of same-host redirects and a
 * capped body. Never throws — errors are returned on the object.
 *
 * Redirects are resolved manually (`redirect: 'manual'`) so a 3xx that points
 * off-host is refused rather than followed; the refused target is returned as
 * `blockedRedirect` and the 3xx is reported as the final status.
 */
export async function fetchText(
  url,
  { timeout = LIMITS.timeout, method = 'GET', maxBytes = LIMITS.maxBytes } = {},
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  const base = {
    url,
    finalUrl: url,
    status: 0,
    ok: false,
    redirected: false,
    blockedRedirect: null,
    truncated: false,
    contentType: '',
    bytes: 0,
    text: '',
    ms: 0,
    error: null,
  };
  let current = url;
  let hops = 0;
  try {
    while (true) {
      const res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      });
      const contentType = res.headers.get('content-type') || '';

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        const next = loc ? normalizeUrl(loc, current) : null;
        try {
          await res.arrayBuffer(); // drain so the socket is released
        } catch {
          /* ignore */
        }
        if (next && hops < LIMITS.maxRedirects && redirectAllowed(current, next)) {
          hops++;
          current = next;
          continue;
        }
        return {
          ...base,
          finalUrl: current,
          status: res.status,
          // A 3xx with a usable Location is a working redirect we chose not to
          // follow — not a broken URL.
          ok: !!next,
          redirected: hops > 0,
          blockedRedirect: next,
          contentType,
          ms: Date.now() - started,
          error: next
            ? null
            : `redirect ${res.status} with no usable Location header`,
        };
      }

      const isHtml = contentType.includes('html');
      let text = '';
      let truncated = false;
      if (method === 'GET' && isHtml) {
        ({ text, truncated } = await readCapped(res, maxBytes));
      } else {
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
      }
      return {
        ...base,
        finalUrl: current,
        status: res.status,
        ok: res.ok,
        redirected: hops > 0,
        truncated,
        contentType,
        bytes: text.length,
        text,
        ms: Date.now() - started,
      };
    }
  } catch (err) {
    return {
      ...base,
      finalUrl: current,
      redirected: hops > 0,
      ms: Date.now() - started,
      error: err.name === 'AbortError' ? `timeout after ${timeout}ms` : String(err.message || err),
    };
  } finally {
    clearTimeout(t);
  }
}

function firstMatch(re, html) {
  const m = re.exec(html);
  return m ? m[1].trim() : '';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Pull the SEO-relevant fields and links out of an HTML string.
 *
 * The `<head>` patterns run against the first `headScanBytes` only. That is
 * where the metadata lives, and it keeps the two-part meta patterns (`[^>]+`
 * followed by `[^>]*`) off a multi-megabyte string, where a pathological tag
 * could make them backtrack quadratically.
 */
export function extract(html, base, { headScanBytes = LIMITS.headScanBytes, maxLinks = LIMITS.maxLinksPerPage } = {}) {
  if (!html) {
    return { title: '', metaDescription: '', h1: '', canonical: '', wordCount: 0, links: [] };
  }
  const head = html.length > headScanBytes ? html.slice(0, headScanBytes) : html;
  const title = decodeEntities(firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, head));
  const metaDescription = decodeEntities(
    firstMatch(
      /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i,
      head,
    ) ||
      firstMatch(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i,
        head,
      ),
  );
  const h1 = decodeEntities(
    firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
  );
  const canonical = firstMatch(
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    head,
  );

  // crude but stable word count over visible body text
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const wordCount = (decodeEntities(body).match(/\S+/g) || []).length;

  const links = [];
  const seen = new Set();
  const hrefRe = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const abs = normalizeUrl(m[1], base);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      links.push(abs);
      if (links.length >= maxLinks) break;
    }
  }
  return { title, metaDescription, h1, canonical, wordCount, links };
}

/** Parse a sitemap or sitemap-index XML into { sitemaps, urls }. */
export function parseSitemap(xml) {
  const locs = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(decodeEntities(m[1].trim()));
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

/**
 * Resolve all page URLs from a site's sitemap(s). Returns [] if none found.
 * Bounded by LIMITS.maxSitemaps / LIMITS.maxSitemapUrls so a sitemap index that
 * loops or fans out endlessly cannot run away.
 */
export async function getSitemapUrls(base, { timeout = LIMITS.timeout, log = () => {} } = {}) {
  const origin = new URL(base).origin;
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const tried = new Set();
  const urls = new Set();
  while (queue.length) {
    if (tried.size >= LIMITS.maxSitemaps) {
      log(`  sitemap limit reached (${LIMITS.maxSitemaps} documents) — stopping`);
      break;
    }
    if (urls.size >= LIMITS.maxSitemapUrls) {
      log(`  sitemap URL limit reached (${LIMITS.maxSitemapUrls}) — stopping`);
      break;
    }
    const sm = queue.shift();
    if (tried.has(sm)) continue;
    tried.add(sm);
    const res = await fetchText(sm, { timeout });
    if (!res.ok || !res.text) {
      // fetchText only returns text for html; sitemaps are xml, so re-fetch raw
      const raw = await fetchRaw(sm, { timeout });
      if (!raw) continue;
      const { sitemaps, urls: found } = parseSitemap(raw);
      // Only follow child sitemaps that stay on the origin we were pointed at.
      sitemaps.filter((s) => sameOrigin(s, origin)).forEach((s) => queue.push(s));
      found.forEach((u) => urls.add(u));
      if (found.length || sitemaps.length) log(`  sitemap ${sm}: +${found.length} urls, +${sitemaps.length} child sitemaps`);
      continue;
    }
    const { sitemaps, urls: found } = parseSitemap(res.text);
    // Only follow child sitemaps that stay on the origin we were pointed at.
    sitemaps.filter((s) => sameOrigin(s, origin)).forEach((s) => queue.push(s));
    found.forEach((u) => urls.add(u));
  }
  return [...urls];
}

/**
 * Fetch raw text regardless of content-type (used for XML sitemaps).
 * Same redirect and size guards as fetchText.
 */
export async function fetchRaw(url, { timeout = LIMITS.timeout, maxBytes = LIMITS.maxBytes } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let current = url;
  let hops = 0;
  try {
    while (true) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': USER_AGENT },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        const next = loc ? normalizeUrl(loc, current) : null;
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        if (next && hops < LIMITS.maxRedirects && redirectAllowed(current, next)) {
          hops++;
          current = next;
          continue;
        }
        return null;
      }
      if (!res.ok) {
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        return null;
      }
      const { text } = await readCapped(res, maxBytes);
      return text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Run `worker` over `items` with bounded concurrency. Preserves input order in results. */
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

/**
 * Same-origin BFS crawl starting at `base`.
 * Calls onPage({ url, result, extracted }) for every HTML page fetched.
 * Returns the list of visited URLs.
 *
 * Bounded twice over: `max` pages (clamped to LIMITS.maxPages) and `maxDepth`
 * BFS levels. Only links on the same origin as the start URL are ever queued,
 * so an infinite calendar or a hostile link farm cannot run the crawl away.
 */
export async function crawl(
  base,
  {
    max = 500,
    maxDepth = LIMITS.maxDepth,
    concurrency = 6,
    timeout = LIMITS.timeout,
    delayMs = 0,
    onPage = () => {},
    log = () => {},
  } = {},
) {
  const start = normalizeUrl(base, base);
  if (!start) throw new Error(`crawl: ${base} is not an http(s) URL`);
  const pageCap = Math.min(Math.max(1, Number(max) || 1), LIMITS.maxPages);
  if (pageCap < max) log(`  --max ${max} exceeds the ${LIMITS.maxPages}-page safety ceiling; using ${pageCap}`);
  const depthCap = Math.max(1, Number(maxDepth) || LIMITS.maxDepth);
  const visited = new Set();
  let frontier = [start];
  let depth = 0;
  while (frontier.length && visited.size < pageCap && depth < depthCap) {
    const batch = [];
    for (const u of frontier) {
      if (visited.size + batch.length >= pageCap) break;
      if (!visited.has(u)) batch.push(u);
    }
    if (!batch.length) break;
    batch.forEach((u) => visited.add(u));
    const nextSet = new Set();
    await pool(batch, concurrency, async (url) => {
      const res = await fetchText(url, { timeout });
      const extracted = res.text ? extract(res.text, url) : { links: [] };
      onPage({ url, result: res, extracted });
      for (const link of extracted.links || []) {
        if (sameOrigin(link, start) && !visited.has(link)) nextSet.add(link);
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    });
    depth++;
    log(`  crawled ${visited.size} pages (depth ${depth}/${depthCap})…`);
    frontier = [...nextSet];
  }
  if (frontier.length && depth >= depthCap) {
    log(`  depth limit ${depthCap} reached; ${frontier.length} URLs left unvisited (raise --max-depth to go further)`);
  }
  return [...visited];
}

/** Minimal argv parser: --key value, --flag (boolean), and positional args. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nx = argv[i + 1];
      if (nx === undefined || nx.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = nx;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a file, creating parent dirs. */
export function writeOut(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
