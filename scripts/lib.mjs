// Shared helpers for the site-migration scripts.
// Dependency-free. Requires Node 18+ (built-in fetch). Tested on Node 22.
//
// Nothing here writes to disk, touches DNS, or mutates a remote site.
// Every function is read-only over HTTP.

const DEFAULT_TIMEOUT = 15000;
const USER_AGENT =
  'pixelworkers-site-migration/1.0 (+https://pixelworkers.org; read-only crawler)';

/** Normalize a possibly-relative href against a base URL. Returns null if unparseable. */
export function normalizeUrl(href, base) {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
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

/** Fetch with a hard timeout. Never throws — errors are returned on the object. */
export async function fetchText(url, { timeout = DEFAULT_TIMEOUT, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    });
    const contentType = res.headers.get('content-type') || '';
    const isHtml = contentType.includes('html');
    const text = method === 'GET' && isHtml ? await res.text() : '';
    return {
      url,
      finalUrl: res.url,
      status: res.status,
      ok: res.ok,
      redirected: res.url !== url,
      contentType,
      bytes: text.length,
      text,
      ms: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      redirected: false,
      contentType: '',
      bytes: 0,
      text: '',
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

/** Pull the SEO-relevant fields and links out of an HTML string. */
export function extract(html, base) {
  if (!html) {
    return { title: '', metaDescription: '', h1: '', canonical: '', wordCount: 0, links: [] };
  }
  const title = decodeEntities(firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html));
  const metaDescription = decodeEntities(
    firstMatch(
      /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i,
      html,
    ) ||
      firstMatch(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i,
        html,
      ),
  );
  const h1 = decodeEntities(
    firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
  );
  const canonical = firstMatch(
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    html,
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

/** Resolve all page URLs from a site's sitemap(s). Returns [] if none found. */
export async function getSitemapUrls(base, { timeout = DEFAULT_TIMEOUT, log = () => {} } = {}) {
  const origin = new URL(base).origin;
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const tried = new Set();
  const urls = new Set();
  while (queue.length) {
    const sm = queue.shift();
    if (tried.has(sm)) continue;
    tried.add(sm);
    const res = await fetchText(sm, { timeout });
    if (!res.ok || !res.text) {
      // fetchText only returns text for html; sitemaps are xml, so re-fetch raw
      const raw = await fetchRaw(sm, { timeout });
      if (!raw) continue;
      const { sitemaps, urls: found } = parseSitemap(raw);
      sitemaps.forEach((s) => queue.push(s));
      found.forEach((u) => urls.add(u));
      if (found.length || sitemaps.length) log(`  sitemap ${sm}: +${found.length} urls, +${sitemaps.length} child sitemaps`);
      continue;
    }
    const { sitemaps, urls: found } = parseSitemap(res.text);
    sitemaps.forEach((s) => queue.push(s));
    found.forEach((u) => urls.add(u));
  }
  return [...urls];
}

/** Fetch raw text regardless of content-type (used for XML sitemaps). */
export async function fetchRaw(url, { timeout = DEFAULT_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.text();
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
 */
export async function crawl(
  base,
  { max = 500, concurrency = 6, timeout = DEFAULT_TIMEOUT, delayMs = 0, onPage = () => {}, log = () => {} } = {},
) {
  const start = normalizeUrl(base, base);
  const visited = new Set();
  let frontier = [start];
  while (frontier.length && visited.size < max) {
    const batch = [];
    for (const u of frontier) {
      if (visited.size + batch.length >= max) break;
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
    log(`  crawled ${visited.size} pages…`);
    frontier = [...nextSet];
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
