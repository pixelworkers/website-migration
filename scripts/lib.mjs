// Shared helpers for the site-migration audit scripts.
// Dependency-free. Requires Node 18+ (built-in fetch). Tested on Node 22.
//
// Nothing here writes to a remote site, touches DNS, or mutates a target.
// Every network function is read-only over HTTP.
//
// Two classes of hostile input are assumed throughout, because the crawler
// follows data the audited site controls:
//
//   1. URLs that point somewhere the operator did not intend (sitemap <loc>,
//      <a href>, Location: headers). Every fetch goes through guard.mjs, which
//      refuses non-http(s) schemes and private/loopback/link-local/metadata
//      hosts, and re-checks each redirect hop. See scripts/guard.mjs.
//
//   2. HTML and XML shaped to blow up a parser. Every pattern below is either
//      linear or bounded: no lazy quantifier is allowed to scan to end-of-input
//      from each of n starting positions, and no body is buffered past
//      MAX_BODY_BYTES.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_BODY_BYTES,
  MAX_SITEMAPS,
  MAX_SITEMAP_URLS,
  allowHosts,
  assertFetchable,
  assertInsideCwd,
  guardedFetch,
  readCapped,
} from './guard.mjs';

export { allowHosts, assertFetchable, assertInsideCwd, MAX_BODY_BYTES };

const DEFAULT_TIMEOUT = 15000;
const USER_AGENT =
  'pixelworkers-site-migration/1.0 (+https://pixelworkers.org; read-only crawler)';

// Bounds for the HTML/XML extractors. Generous for real pages, fatal to the
// quadratic blowup a hostile page is trying to trigger.
const MAX_ATTR_SPAN = 2000; // chars of attribute soup scanned inside one tag
const MAX_TITLE = 2000;
const MAX_H1 = 8000;
const MAX_META = 4000;
const MAX_HREF = 4000;
const MAX_LOC = 2048;
const MAX_LINKS_PER_PAGE = 5000;

/** Normalize a possibly-relative href against a base URL. Returns null if unparseable. */
export function normalizeUrl(href, base) {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  try {
    const u = new URL(raw, base);
    // Only http(s) is ever a crawl target. This drops mailto:, tel:,
    // javascript:, data:, file:, gopher: and everything else in one rule
    // rather than denylisting the schemes someone thought of.
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
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return p + (u.search || '');
  } catch {
    return url;
  }
}

/**
 * Resolve `path` against `origin`, asserting the result stays on that origin.
 *
 * Needed because string concatenation does not survive hostile input:
 * `"https://oldsite.com" + "@evil.example.com/x"` is a URL whose host is
 * evil.example.com, and `"//evil.com/x"` (or its backslash variants, which the
 * URL parser normalizes) jumps origin outright. Throws rather than returning a
 * URL that points somewhere else.
 */
export function urlOnOrigin(origin, path) {
  const baseOrigin = new URL(origin).origin;
  const p = String(path ?? '');
  if (!p.startsWith('/')) {
    throw new Error(`path must start with "/" (got: ${JSON.stringify(p)})`);
  }
  if (/^\/[/\\]/.test(p)) {
    throw new Error(`refusing a protocol-relative path: ${JSON.stringify(p)}`);
  }
  let u;
  try {
    u = new URL(p, baseOrigin);
  } catch {
    throw new Error(`unparseable path: ${JSON.stringify(p)}`);
  }
  if (u.origin !== baseOrigin) {
    throw new Error(`path ${JSON.stringify(p)} resolves to ${u.origin}, not ${baseOrigin}`);
  }
  return u.toString();
}

/**
 * Fetch with a hard timeout, the SSRF guard, and a capped body.
 * Never throws — refusals and errors are returned on the object.
 */
export async function fetchText(url, { timeout = DEFAULT_TIMEOUT, method = 'GET', maxBytes = MAX_BODY_BYTES } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const { res, finalUrl } = await guardedFetch(url, {
      method,
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
    });
    const contentType = res.headers.get('content-type') || '';
    const isHtml = contentType.includes('html');
    let text = '';
    let bytes = 0;
    let truncated = false;
    if (method === 'GET' && isHtml) {
      ({ text, bytes, truncated } = await readCapped(res, maxBytes));
    } else {
      try {
        await res.arrayBuffer();
      } catch {
        /* nothing to drain */
      }
    }
    return {
      url,
      finalUrl,
      status: res.status,
      ok: res.ok,
      redirected: finalUrl !== url,
      contentType,
      bytes,
      truncated,
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
      truncated: false,
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

/**
 * Visit each `<name …>` tag in document order, passing the bounded tag text to
 * `fn`. Return false from `fn` to stop early.
 *
 * Index-based on purpose. The regex shape `<meta[^>]{0,N}name=` looks harmless
 * but is quadratic on a document full of unclosed tags: at every one of n
 * starting positions the engine fills `[^>]{0,N}` and then backtracks N times
 * hunting for a literal that is not there. Here each tag is located with
 * indexOf (linear overall) and only the tag's own bounded text is pattern
 * matched, so total work stays O(n).
 */
function eachTag(html, name, fn) {
  const lower = html.toLowerCase();
  const open = `<${name}`;
  let i = 0;
  while (i < html.length) {
    const s = lower.indexOf(open, i);
    if (s === -1) return;
    const after = s + open.length;
    const c = html[after];
    // `<metadata` is not `<meta`.
    if (c !== undefined && c !== '>' && c !== '/' && !/\s/.test(c)) {
      i = after;
      continue;
    }
    const gt = lower.indexOf('>', after);
    if (gt === -1) {
      // No closing bracket anywhere after this point: this is the last tag in
      // the document, however much text follows it. Look at a bounded window
      // and stop — there is nothing further to find.
      fn(html.slice(s, s + MAX_ATTR_SPAN), -1);
      return;
    }
    if (gt - s <= MAX_ATTR_SPAN && fn(html.slice(s, gt), gt + 1) === false) return;
    i = gt + 1;
  }
}

const ATTR_VALUE = (attr, max) =>
  new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]{0,${max}})"|'([^']{0,${max}})'|([^\\s"'>]{0,${max}}))`, 'i');

const RE_META_NAME_DESC = /\b(?:name|property)\s*=\s*["']?(?:description|og:description)["']?/i;
const RE_META_CONTENT = ATTR_VALUE('content', MAX_META);
const RE_LINK_REL_CANONICAL = /\brel\s*=\s*["']?canonical["']?/i;
const RE_LINK_HREF = ATTR_VALUE('href', MAX_HREF);
const RE_A_HREF = ATTR_VALUE('href', MAX_HREF);

function attrValue(re, tag) {
  const m = re.exec(tag);
  if (!m) return '';
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/**
 * Text inside the first <tag>…</tag>, found by index rather than by a lazy
 * regex. Linear in the length of the document and bounded by `maxLen`, so an
 * unclosed tag costs one scan instead of one scan per starting position.
 */
function tagText(html, tag, maxLen) {
  let start = -1;
  eachTag(html, tag, (_text, contentStart) => {
    start = contentStart;
    return false;
  });
  if (start < 0) return '';
  const window = html.slice(start, start + maxLen);
  const close = window.toLowerCase().indexOf(`</${tag}`);
  return close === -1 ? window : window.slice(0, close);
}

/**
 * Replace every <…> tag with a space, by index scan.
 *
 * `/<[^>]{0,N}>/g` is the obvious version and is quadratic on a document full
 * of unterminated tags: at each "<" the engine fills the class and backtracks N
 * times looking for a ">" that never arrives.
 */
function stripTags(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt === -1) return out + s.slice(i);
    out += s.slice(i, lt) + ' ';
    const gt = s.indexOf('>', lt);
    if (gt === -1) return out; // unterminated final tag: nothing after it is text
    i = gt + 1;
  }
}

/**
 * Remove <tag>…</tag> blocks (script, style) by index scan.
 * An unclosed block truncates the remainder rather than costing O(n²).
 */
function stripBlocks(html, tag) {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let i = 0;
  for (;;) {
    const s = lower.indexOf(open, i);
    if (s === -1) return out + html.slice(i);
    out += html.slice(i, s) + ' ';
    const gt = lower.indexOf('>', s);
    if (gt === -1) return out;
    const e = lower.indexOf(close, gt);
    if (e === -1) return out; // unclosed: everything after is inside the block
    i = e;
  }
}

/** Pull the SEO-relevant fields and links out of an HTML string. */
export function extract(html, base) {
  if (!html) {
    return { title: '', metaDescription: '', h1: '', canonical: '', wordCount: 0, links: [] };
  }
  // A <title> never contains markup, so [^<] both anchors the match and keeps
  // it linear — there is no lazy scan hunting for a </title> that never comes.
  const title = decodeEntities(firstMatch(new RegExp(`<title[^>]{0,${MAX_ATTR_SPAN}}>([^<]{0,${MAX_TITLE}})`, 'i'), html));

  // Attribute order is not fixed in the wild, so match the tag first and read
  // its attributes afterwards rather than encoding one order into a pattern.
  let metaRaw = '';
  eachTag(html, 'meta', (tag) => {
    if (!RE_META_NAME_DESC.test(tag)) return;
    const v = attrValue(RE_META_CONTENT, tag);
    if (v) {
      metaRaw = v;
      return false;
    }
  });
  const metaDescription = decodeEntities(metaRaw);

  const h1 = decodeEntities(stripTags(tagText(html, 'h1', MAX_H1)).replace(/\s+/g, ' ').trim());

  let canonical = '';
  eachTag(html, 'link', (tag) => {
    if (!RE_LINK_REL_CANONICAL.test(tag)) return;
    const v = attrValue(RE_LINK_HREF, tag);
    if (v) {
      canonical = v;
      return false;
    }
  });

  // crude but stable word count over visible body text
  const body = stripTags(stripBlocks(stripBlocks(html, 'script'), 'style'));
  const decodedBody = decodeEntities(body);
  let wordCount = 0;
  const wordRe = /\S+/g;
  while (wordRe.exec(decodedBody) !== null) wordCount++;

  const links = [];
  const seen = new Set();
  eachTag(html, 'a', (tag) => {
    const href = attrValue(RE_A_HREF, tag);
    if (!href) return;
    const abs = normalizeUrl(decodeEntities(href), base);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      links.push(abs);
      if (links.length >= MAX_LINKS_PER_PAGE) return false;
    }
  });
  return { title, metaDescription, h1, canonical, wordCount, links };
}

/** Parse a sitemap or sitemap-index XML into { sitemaps, urls }. */
export function parseSitemap(xml) {
  const locs = [];
  // A <loc> holds a URL, so [^<] is both correct and linear. No lazy scan for a
  // closing tag that a hostile sitemap can simply omit.
  const re = new RegExp(`<loc>\\s{0,32}([^<]{0,${MAX_LOC}})`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = decodeEntities(m[1].trim());
    if (v) locs.push(v);
    if (locs.length >= MAX_SITEMAP_URLS) break;
  }
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

/**
 * Resolve all page URLs from a site's sitemap(s). Returns [] if none found.
 *
 * Hardened against a hostile sitemap index: child sitemaps and page URLs are
 * both restricted to the target origin, and the number of sitemap documents
 * fetched is capped. Without that, one `<sitemapindex>` entry pointing at
 * http://169.254.169.254/ is enough to turn this into an SSRF probe.
 */
export async function getSitemapUrls(
  base,
  { timeout = DEFAULT_TIMEOUT, log = () => {}, maxSitemaps = MAX_SITEMAPS, maxUrls = MAX_SITEMAP_URLS } = {},
) {
  const origin = new URL(base).origin;
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const tried = new Set();
  const urls = new Set();
  let offOrigin = 0;
  let capped = false;

  const enqueue = (loc) => {
    let abs;
    try {
      abs = new URL(loc, origin).toString();
    } catch {
      return;
    }
    if (new URL(abs).origin !== origin) {
      offOrigin++;
      return;
    }
    if (tried.has(abs) || queue.includes(abs)) return;
    if (tried.size + queue.length >= maxSitemaps) {
      capped = true;
      return;
    }
    queue.push(abs);
  };

  const addUrl = (loc) => {
    let abs;
    try {
      abs = new URL(loc, origin).toString();
    } catch {
      return;
    }
    if (new URL(abs).origin !== origin) {
      offOrigin++;
      return;
    }
    if (urls.size < maxUrls) urls.add(abs);
  };

  while (queue.length) {
    const sm = queue.shift();
    if (tried.has(sm)) continue;
    tried.add(sm);
    if (tried.size > maxSitemaps) {
      capped = true;
      break;
    }
    const res = await fetchText(sm, { timeout });
    let xml = res.ok && res.text ? res.text : null;
    if (!xml) {
      // fetchText only returns a body for text/html; sitemaps are XML, so
      // re-fetch raw. Same guard, same cap.
      xml = await fetchRaw(sm, { timeout });
    }
    if (!xml) continue;
    const { sitemaps, urls: found } = parseSitemap(xml);
    sitemaps.forEach(enqueue);
    found.forEach(addUrl);
    if (found.length || sitemaps.length) {
      log(`  sitemap ${sm}: +${found.length} urls, +${sitemaps.length} child sitemaps`);
    }
  }

  if (offOrigin) {
    log(`  skipped ${offOrigin} off-origin sitemap entries (not on ${origin})`);
  }
  if (capped) {
    log(`  stopped after ${maxSitemaps} sitemap documents (cap)`);
  }
  if (urls.size >= maxUrls) {
    log(`  stopped at ${maxUrls} sitemap URLs (cap)`);
  }
  return [...urls];
}

/** Fetch raw text regardless of content-type (used for XML sitemaps). Capped and guarded. */
export async function fetchRaw(url, { timeout = DEFAULT_TIMEOUT, maxBytes = MAX_BODY_BYTES } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const { res } = await guardedFetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) {
      try {
        await res.arrayBuffer();
      } catch {
        /* nothing to drain */
      }
      return null;
    }
    const { text } = await readCapped(res, maxBytes);
    return text;
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
    for (;;) {
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
  if (!start) throw new Error(`not a crawlable http(s) URL: ${base}`);
  await assertFetchable(start);
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

/**
 * Write a report file, creating parent dirs.
 *
 * Two guards, because --out is an operator-supplied path that also ends up in
 * generated webserver config:
 *   - the resolved path must stay inside the working directory (symlinked
 *     parents are resolved first, so `out -> /etc` is caught);
 *   - an existing file is never clobbered unless `force` is set.
 */
export function writeOut(path, content, { force = false } = {}) {
  const abs = assertInsideCwd(path);
  if (!force && existsSync(abs)) {
    throw new Error(`refusing to overwrite ${path} — move it aside, pick another --out, or pass --force`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return path;
}

/**
 * Apply the shared CLI flags every script accepts:
 *   --allow-host <host[:port][,host…]>   vouch for a private/loopback target
 *   --force                               allow overwriting existing output
 * Returns { force } for the caller to thread into writeOut.
 */
export function applyCommonArgs(args, { log = () => {} } = {}) {
  if (args['allow-host'] && args['allow-host'] !== true) {
    const added = allowHosts(args['allow-host']);
    if (added.length) log(`Host policy: explicitly allowing ${added.join(', ')}`);
  }
  return { force: !!args.force };
}
