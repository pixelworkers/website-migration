// Shared helpers for the site-migration scripts.
// Dependency-free. Requires Node 18+ (built-in fetch). Tested on Node 22.
//
// Nothing here writes to a remote site, touches DNS, or mutates anything.
// Every network function is read-only over HTTP.
//
// Two classes of hostile input are assumed throughout, because both are
// reachable by pointing an audit at a site you do not control:
//
//  1. URLs that arrive as *remote data* (sitemap <loc> entries, <a href>
//     targets, Location headers, inventory files). None of these are trusted
//     as fetch targets — see `remoteUrlAllowed`.
//  2. HTML/XML crafted to make a parser backtrack. Nothing in the extract path
//     uses an unbounded `[\s\S]*?` or an unbounded negated class followed by a
//     literal; markup is walked with index scans instead. See `eachTag`.

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
  bodyScanBytes: 5 * 1024 * 1024, // bytes scanned for h1 / links / word count
  maxTagBytes: 8 * 1024, // a "<" with no ">" inside this is not markup
  maxFieldBytes: 4 * 1024, // cap on a single extracted field (title, loc, …)
  h1WindowBytes: 8 * 1024, // bytes after <h1> searched for its text
  maxAttrsPerTag: 64, // attributes parsed from one tag
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
 * Cloud instance-metadata endpoints. These hand out IAM credentials to anything
 * that can issue a plain GET from inside the instance, so they are refused
 * outright — not just when a redirect or a sitemap points at them, but even if
 * someone passes one on the command line. No site audit ever needs them.
 */
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / Azure / GCP / DigitalOcean / Oracle IMDS
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // EC2 IMDS over IPv6
  'metadata', // GCP short name
  'metadata.google.internal',
  'metadata.goog',
]);

/** True for a cloud instance-metadata address or hostname. */
export function isMetadataHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  return METADATA_HOSTS.has(h) || /(^|\.)metadata\.(google\.internal|goog)$/.test(h);
}

/**
 * Gate for any URL that arrived as remote data — a sitemap `<loc>`, an `<a>`
 * target, a path read out of an inventory file. Such a URL is attacker-chosen
 * whenever the audited site is not yours, so it is checked against the origin
 * that was given on the command line before it is ever fetched.
 *
 *  - must be http(s)
 *  - must stay on the crawl origin (scheme + host + port), unless the caller
 *    explicitly opts out (`sameOriginOnly: false`, for off-site link checking)
 *  - must never be a cloud metadata endpoint
 *  - if it is a private/loopback/link-local host, it must *be* the origin the
 *    operator named. Auditing `http://localhost:8080` still works, because a
 *    same-origin link there is the site itself — but remote content cannot
 *    reach a different private host, or a sibling port on the same one, even
 *    with `sameOriginOnly: false`.
 */
export function remoteUrlAllowed(url, origin, { sameOriginOnly = true } = {}) {
  let u;
  let o;
  try {
    u = new URL(String(url));
    o = new URL(String(origin));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (isMetadataHost(hostOf(u))) return false;
  if (sameOriginOnly && u.origin !== o.origin) return false;
  if (isInternalHost(hostOf(u)) && u.origin !== o.origin) return false;
  return true;
}

/**
 * Split remote-sourced URLs into the ones safe to fetch and the ones refused.
 * Callers report `refused` rather than dropping it silently — a sitemap that
 * points off-origin is a finding about the site, not noise.
 */
export function filterRemoteUrls(urls, origin, opts = {}) {
  const allowed = [];
  const refused = [];
  for (const u of urls || []) {
    if (remoteUrlAllowed(u, origin, opts)) allowed.push(u);
    else refused.push(u);
  }
  return { allowed, refused };
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
  if (isMetadataHost(hostOf(b))) return false;
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

/**
 * Resolve a path harvested from remote data onto an origin you chose, instead of
 * concatenating the two strings. String concat trusts the path: `//evil.com/x`
 * or `https://evil.com/x` pasted into an inventory file would silently retarget
 * the request at another host. Returns null when the path does not land on
 * `origin`.
 */
export function urlOnOrigin(origin, path) {
  let o;
  try {
    o = new URL(String(origin));
  } catch {
    return null;
  }
  if (typeof path !== 'string' || /[\r\n\0]/.test(path)) return null;
  let u;
  try {
    u = new URL(path, o.origin);
  } catch {
    return null;
  }
  if (u.origin !== o.origin) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.toString();
}

/**
 * Normalize a redirect-map source path. The output is pasted verbatim into a
 * Caddyfile / nginx conf / `_redirects`, so anything carrying a newline, a NUL,
 * or an off-origin host is dropped rather than emitted — a path harvested off a
 * crawled site must not be able to inject a config directive.
 */
const REDIRECT_BASE = 'https://redirect-map.invalid';

export function safeRedirectPath(path) {
  if (typeof path !== 'string') return null;
  const raw = path.trim();
  if (!raw || /[\s\r\n\0{}]/.test(raw)) return null;
  let u;
  try {
    u = new URL(raw, REDIRECT_BASE);
  } catch {
    return null;
  }
  if (u.origin !== REDIRECT_BASE) return null; // absolute or protocol-relative
  return u.pathname + u.search;
}

/**
 * Normalize a redirect-map target: either a path on the new site or an absolute
 * http(s) URL. Same injection rules as the source side.
 */
export function safeRedirectTarget(target) {
  if (typeof target !== 'string') return null;
  const raw = target.trim();
  if (!raw || /[\s\r\n\0{}]/.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.toString();
    } catch {
      return null;
    }
  }
  return safeRedirectPath(raw);
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

/** Last-resort check at the fetch boundary: a metadata endpoint is never fetched. */
function fetchTargetRefusal(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `not a URL: ${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `refused non-http(s) URL: ${url}`;
  if (isMetadataHost(hostOf(u))) return `refused cloud metadata host: ${u.hostname}`;
  return null;
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
  const refusal = fetchTargetRefusal(url);
  if (refusal) return { ...base, error: refusal };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
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
 * Walk the tags of a markup string using index scans only.
 *
 * This is the whole anti-ReDoS story. A pattern like `<meta[^>]+name="x"` looks
 * innocent and is quadratic: on `'<meta '` repeated, every one of the N start
 * positions drags `[^>]+` across the rest of the string. Index scans cannot do
 * that — `indexOf('<')` and `indexOf('>')` never revisit a character, so one
 * pass is O(n) no matter how the input is shaped.
 *
 * A `<` with no `>` within `maxTagBytes` is not markup; the span is skipped
 * rather than captured, and an unterminated final `<` simply ends the walk.
 *
 * Yields { raw, start, end }: the text between the angle brackets, and their
 * indices in `html`.
 */
function* eachTag(html, { maxTagBytes = LIMITS.maxTagBytes, skipRawText = false } = {}) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) return;
    const raw = gt - lt - 1 <= maxTagBytes ? html.slice(lt + 1, gt) : null;
    if (raw !== null) yield { raw, start: lt, end: gt };
    i = gt + 1;
    // `<script>` and `<style>` bodies are CDATA, not markup: a `<h1>` or an
    // `<a href>` inside one is a string literal, not an element.
    if (skipRawText && raw !== null) {
      const name = tagName(raw);
      if (name === 'script' || name === 'style') {
        const after = indexAfterClose(html, name, i);
        if (after < 0) return; // unterminated block — nothing after it is markup
        i = after;
      }
    }
  }
}

/** Tag name of a tag body ('meta charset="x"' -> 'meta', '/h1' -> '/h1'). */
function tagName(raw) {
  const m = /^\/?[a-zA-Z][a-zA-Z0-9:-]{0,30}/.exec(raw);
  return m ? m[0].toLowerCase() : '';
}

// Runs only against one tag body, which `eachTag` has already bounded to
// maxTagBytes, and every branch is a negated class anchored after the `=`.
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]{0,60})\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s"'>]{0,4096}))/g;

/** Parse the attributes of a single (bounded) tag body into a plain object. */
function tagAttrs(raw) {
  const out = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let m;
  let n = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
    if (++n >= LIMITS.maxAttrsPerTag) break;
  }
  return out;
}

// Bounded close-tag patterns. The `[^>]{0,200}` tail cannot cross a `>`, so a
// failed candidate costs at most ~200 characters, and each successful call
// advances past its match — no span is scanned twice.
const CLOSE_RE = {
  script: /<\/script\b[^>]{0,200}>/gi,
  style: /<\/style\b[^>]{0,200}>/gi,
};

function indexAfterClose(html, name, from) {
  const re = CLOSE_RE[name];
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index + m[0].length : -1;
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Visible text of a markup string: tags dropped, `<script>` and `<style>`
 * bodies dropped with them. Index-scan based for the same reason as `eachTag`
 * — `/<script[\s\S]*?<\/script>/g` and even `/<[^>]+>/g` go quadratic on a
 * string full of unterminated `<`.
 */
function visibleText(html) {
  const parts = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      parts.push(html.slice(i));
      break;
    }
    if (lt > i) parts.push(html.slice(i, lt));
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break; // unterminated tag — nothing after it is markup
    const name = tagName(html.slice(lt + 1, lt + 12));
    if (name === 'script' || name === 'style') {
      const after = indexAfterClose(html, name, gt + 1);
      if (after < 0) break; // unterminated block — drop the remainder
      parts.push(' ');
      i = after;
      continue;
    }
    parts.push(' ');
    i = gt + 1;
  }
  return parts.join('');
}

function field(s) {
  return collapse(decodeEntities(String(s || '').slice(0, LIMITS.maxFieldBytes)));
}

/**
 * Pull the SEO-relevant fields and links out of an HTML string.
 *
 * Bounded three ways:
 *  - `<head>` fields (title, meta description, canonical) are read from the
 *    first `headScanBytes` only; that is where metadata lives.
 *  - h1, links and the word count are read from the first `bodyScanBytes`.
 *  - every field is truncated to `maxFieldBytes`.
 *
 * All parsing is linear in the input length — see `eachTag`. Hostile shapes
 * ('<script ' repeated to the body cap, unclosed '<title>' repeated, half a
 * megabyte of `name="description" `) complete in milliseconds.
 */
export function extract(
  html,
  base,
  {
    headScanBytes = LIMITS.headScanBytes,
    bodyScanBytes = LIMITS.bodyScanBytes,
    maxLinks = LIMITS.maxLinksPerPage,
  } = {},
) {
  const empty = { title: '', metaDescription: '', h1: '', canonical: '', wordCount: 0, links: [] };
  if (!html || typeof html !== 'string') return empty;

  const head = html.length > headScanBytes ? html.slice(0, headScanBytes) : html;
  const body = html.length > bodyScanBytes ? html.slice(0, bodyScanBytes) : html;

  // Sentinels, not truthiness: an empty `<title></title>` must count as "found"
  // or every one of a million repeated `<title>` tags re-runs the slice below.
  let title = null;
  let metaDescription = '';
  let canonical = '';
  for (const tag of eachTag(head, { skipRawText: true })) {
    const name = tagName(tag.raw);
    if (name === 'title') {
      if (title === null) {
        const stop = head.indexOf('<', tag.end + 1);
        title = field(head.slice(tag.end + 1, stop < 0 ? head.length : stop));
      }
      continue;
    }
    if (name === 'meta') {
      if (metaDescription) continue;
      const a = tagAttrs(tag.raw);
      const n = (a.name || a.property || '').toLowerCase();
      if (n === 'description' && a.content) metaDescription = field(a.content);
      continue;
    }
    if (name === 'link') {
      if (canonical) continue;
      const a = tagAttrs(tag.raw);
      if ((a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href) {
        canonical = field(a.href);
      }
      continue;
    }
    // Metadata never appears after </head>; stop as soon as the body opens.
    if (name === 'body') break;
  }

  let h1 = null;
  const links = [];
  const seen = new Set();
  for (const tag of eachTag(body, { skipRawText: true })) {
    const name = tagName(tag.raw);
    if (name === 'h1') {
      if (h1 === null) {
        const win = body.slice(tag.end + 1, tag.end + 1 + LIMITS.h1WindowBytes);
        const close = win.search(/<\/h1\b/i); // bounded string, safe to regex
        h1 = field(visibleText(close < 0 ? win : win.slice(0, close)));
      }
      continue;
    }
    if (name === 'a' && links.length < maxLinks) {
      const href = tagAttrs(tag.raw).href;
      if (!href) continue;
      const abs = normalizeUrl(decodeEntities(href), base);
      if (abs && !seen.has(abs)) {
        seen.add(abs);
        links.push(abs);
      }
    }
  }

  const wordCount = (decodeEntities(visibleText(body)).match(/\S+/g) || []).length;
  return { title: title || '', metaDescription, h1: h1 || '', canonical, wordCount, links };
}

/**
 * Parse a sitemap or sitemap-index XML into { sitemaps, urls }.
 *
 * `<loc>` bodies are read with the same index scan as the HTML extractor. The
 * old `/<loc>\s*([\s\S]*?)\s*<\/loc>/gi` is quadratic on a document full of
 * unclosed `<loc>` tags.
 *
 * Returns raw, untrusted strings. Callers must put them through
 * `remoteUrlAllowed` before fetching anything.
 */
export function parseSitemap(xml, { maxUrls = LIMITS.maxSitemapUrls } = {}) {
  if (!xml || typeof xml !== 'string') return { sitemaps: [], urls: [] };
  const locs = [];
  for (const tag of eachTag(xml)) {
    if (tagName(tag.raw) !== 'loc') continue;
    const stop = xml.indexOf('<', tag.end + 1);
    const text = xml.slice(tag.end + 1, stop < 0 ? xml.length : stop);
    const loc = decodeEntities(text.slice(0, LIMITS.maxFieldBytes)).trim();
    if (loc) locs.push(loc);
    if (locs.length >= maxUrls) break;
  }
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

/**
 * Resolve all page URLs from a site's sitemap(s). Returns [] if none found.
 *
 * Everything a sitemap hands back is attacker-controlled when the audited site
 * is not yours, so *both* kinds of entry are origin-restricted to the crawl
 * origin before use: child sitemaps before they are queued, and page URLs
 * before they are returned to a caller that will fetch them.
 *
 * Refused entries are reported through `log`, and pushed onto the `refused`
 * array if the caller passes one — they are a finding about the site, not noise
 * to swallow.
 *
 * Bounded by LIMITS.maxSitemaps / LIMITS.maxSitemapUrls so a sitemap index that
 * loops or fans out endlessly cannot run away.
 */
export async function getSitemapUrls(
  base,
  { timeout = LIMITS.timeout, log = () => {}, refused = [] } = {},
) {
  const origin = new URL(base).origin;
  if (isMetadataHost(new URL(origin).hostname)) {
    throw new Error(`refusing to crawl cloud metadata host ${new URL(origin).hostname}`);
  }
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const tried = new Set();
  const urls = new Set();
  const seenRefused = new Set();

  const take = (sm, { sitemaps, urls: found }) => {
    const child = filterRemoteUrls(sitemaps, origin);
    const page = filterRemoteUrls(found, origin);
    child.allowed.forEach((s) => queue.push(s));
    page.allowed.forEach((u) => urls.add(u));
    for (const r of [...child.refused, ...page.refused]) {
      if (seenRefused.has(r)) continue;
      seenRefused.add(r);
      refused.push(r);
    }
    if (page.allowed.length || child.allowed.length) {
      log(`  sitemap ${sm}: +${page.allowed.length} urls, +${child.allowed.length} child sitemaps`);
    }
    const dropped = child.refused.length + page.refused.length;
    if (dropped) {
      log(`  sitemap ${sm}: refused ${dropped} off-origin entr${dropped === 1 ? 'y' : 'ies'} (not fetched)`);
    }
  };

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
      take(sm, parseSitemap(raw));
      continue;
    }
    take(sm, parseSitemap(res.text));
  }

  return [...urls];
}

/**
 * Fetch raw text regardless of content-type (used for XML sitemaps).
 * Same redirect and size guards as fetchText.
 */
export async function fetchRaw(url, { timeout = LIMITS.timeout, maxBytes = LIMITS.maxBytes } = {}) {
  if (fetchTargetRefusal(url)) return null;
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
 * BFS levels. Links come out of fetched HTML, so every one goes through
 * `remoteUrlAllowed` against the start origin before it is queued — an
 * infinite calendar, a hostile link farm, or an `<a href>` pointing at an
 * internal address cannot run the crawl away or off the site.
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
  const refusal = fetchTargetRefusal(start);
  if (refusal) throw new Error(`crawl: ${refusal}`);
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
        if (!visited.has(link) && remoteUrlAllowed(link, start)) nextSet.add(link);
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

import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

function assertInsideCwd(root, target, label) {
  const rel = relative(root, target);
  if (!rel || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write outside the working directory: ${label}`);
  }
  return rel;
}

/**
 * Write a file, creating parent dirs. Two guards, because `--out` is a string
 * off the command line and the filenames under it are derived from a crawled
 * site:
 *
 *  - the resolved target must stay inside the current working directory, after
 *    symlinks are resolved — no absolute path, no `../..` escape, no `--out`
 *    pointing at a symlink into /etc
 *  - an existing file is never clobbered; pass `{ force: true }` (the scripts
 *    expose this as `--force`) to overwrite a previous run's output
 */
export function writeOut(path, content, { force = false } = {}) {
  const root = realpathSync(process.cwd());
  const target = resolve(root, String(path));
  const rel = assertInsideCwd(root, target, String(path));
  if (existsSync(target) && !force) {
    throw new Error(
      `refusing to overwrite ${rel} — move it aside, pick another --out, or pass --force`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  // Re-check after mkdir: a pre-existing symlinked --out dir resolves only now.
  const realDir = realpathSync(dirname(target));
  assertInsideCwd(root, resolve(realDir, 'x'), String(path));
  writeFileSync(target, content);
  return rel;
}
