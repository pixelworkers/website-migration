#!/usr/bin/env node
// node-smoke.mjs — regression suite for the read-only audit scripts.
//
// Every case here is a security finding that was real before it was a test:
//
//   * SSRF via a cross-origin sitemap index fan-out
//   * SSRF via a redirect from a same-origin URL to an internal endpoint
//   * ReDoS in the title / H1 / meta / <loc> extractors
//   * unbounded response bodies
//   * origin escape from string-concatenated URLs
//   * output written outside the working directory
//
// Plus one non-security regression: the skill's declared scope. It is a general
// site-migration skill, and it has been narrowed to WordPress-only by accident
// once — so the frontmatter description, the "When to use this" list, and the
// per-source recipes are asserted here rather than trusted.
//
// No network: everything runs against loopback servers started here, and the
// loopback host policy is opened for exactly the port under test — which is
// also what proves a *different* loopback port is still refused.
//
// Run:  node tests/node-smoke.mjs

import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');

const { allowHosts, clearAllowedHosts, assertFetchable, classifyAddress, guardedFetch, readCapped } = await import(
  join(SCRIPTS, 'guard.mjs')
);
const { extract, parseSitemap, getSitemapUrls, fetchText, urlOnOrigin, writeOut } = await import(join(SCRIPTS, 'lib.mjs'));

let pass = 0;
let fail = 0;
const sec = (s) => console.log(`\n== ${s}`);
const ok = (m) => {
  pass++;
  console.log(`  \x1b[32mok\x1b[0m   ${m}`);
};
const bad = (m, extra) => {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`);
};
const assert = (cond, m, extra) => (cond ? ok(m) : bad(m, extra));

async function refuses(url, m) {
  try {
    await assertFetchable(url);
    bad(m, 'it was ALLOWED');
  } catch (e) {
    ok(`${m}  (${String(e.message).slice(0, 72)}…)`);
  }
}
async function allows(url, m) {
  try {
    await assertFetchable(url);
    ok(m);
  } catch (e) {
    bad(m, String(e.message));
  }
}

// ---------------------------------------------------------------------------
// 1. Address classification and URL admission
// ---------------------------------------------------------------------------
sec('the SSRF guard refuses non-public destinations');

for (const [ip, label] of [
  ['169.254.169.254', 'AWS/Azure metadata'],
  ['127.0.0.1', 'loopback'],
  ['127.1.2.3', 'loopback (rest of 127/8)'],
  ['10.1.2.3', '10/8'],
  ['172.16.0.1', '172.16/12'],
  ['172.31.255.254', '172.16/12 (top)'],
  ['192.168.1.1', '192.168/16'],
  ['100.64.0.1', 'CGNAT'],
  ['0.0.0.0', 'this-network'],
  ['224.0.0.1', 'multicast'],
  ['::1', 'IPv6 loopback'],
  ['fc00::1', 'fc00::/7'],
  ['fd12:3456::1', 'fd00::/8 inside fc00::/7'],
  ['fe80::1', 'link-local'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
]) {
  assert(classifyAddress(ip) !== null, `classifies ${ip} as non-public (${label})`, `got ${classifyAddress(ip)}`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
  assert(classifyAddress(ip) === null, `classifies ${ip} as public`, `got ${classifyAddress(ip)}`);
}
assert(classifyAddress('172.32.0.1') === null, 'classifies 172.32.0.1 as public (just past 172.16/12)');
assert(classifyAddress('11.0.0.1') === null, 'classifies 11.0.0.1 as public (just past 10/8)');

sec('assertFetchable: the metadata/loopback/scheme denials');
clearAllowedHosts();
await refuses('http://169.254.169.254/latest/meta-data/', 'refuses the AWS metadata endpoint');
await refuses('http://[fd00:ec2::254]/latest/meta-data/', 'refuses the IPv6 metadata endpoint');
await refuses('http://127.0.0.1:8080/', 'refuses loopback by IP');
await refuses('http://localhost:8080/', 'refuses localhost by name');
await refuses('http://[::1]:8080/', 'refuses IPv6 loopback');
await refuses('http://10.0.0.5/admin', 'refuses an RFC1918 LAN host');
await refuses('http://metadata.google.internal/computeMetadata/v1/', 'refuses the GCP metadata name');
await refuses('http://0x7f000001/', 'refuses hex-encoded loopback (0x7f000001)');
await refuses('http://2130706433/', 'refuses integer-encoded loopback');
await refuses('http://127.1/', 'refuses short-form loopback');
await refuses('file:///etc/passwd', 'refuses file:');
await refuses('gopher://127.0.0.1:25/', 'refuses gopher:');
await refuses('ftp://example.com/x', 'refuses ftp:');
await allows('https://example.com/', 'allows a normal public https URL');

sec('--allow-host is per host:port, not a blanket "allow private"');
clearAllowedHosts();
allowHosts('127.0.0.1:9999');
await allows('http://127.0.0.1:9999/staging', 'the vouched-for loopback port is allowed');
await refuses('http://127.0.0.1:9998/', 'a DIFFERENT loopback port is still refused');
await refuses('http://169.254.169.254/', 'the metadata endpoint is still refused');
clearAllowedHosts();

// ---------------------------------------------------------------------------
// 2. ReDoS — Vivian's 560KB hostile page
// ---------------------------------------------------------------------------
sec('ReDoS: a ~560KB hostile page parses in milliseconds, not seconds');

const BUDGET_MS = 1000;
function timed(label, html) {
  const t0 = Date.now();
  const out = extract(html, 'https://example.com/');
  const ms = Date.now() - t0;
  assert(ms < BUDGET_MS, `${label} (${Math.round(html.length / 1024)}KB) parsed in ${ms}ms < ${BUDGET_MS}ms`);
  return out;
}

timed('unclosed <title> tags', '<title>'.repeat(80_000));
timed('unclosed <title> with filler', '<title>x'.repeat(70_000));
timed('unclosed <h1> tags', '<h1>'.repeat(140_000));
timed('unclosed <script> tags', '<script>'.repeat(70_000));
timed('unclosed <style> tags', '<style>'.repeat(80_000));
timed('unterminated <meta name="description"', `<meta name="description" content="${'a'.repeat(560_000)}`);
timed('unterminated <a href="', `<a href="${'a'.repeat(560_000)}`);
timed('one giant unterminated tag', `<meta ${'a'.repeat(560_000)}`);
timed('many unterminated <meta tags', '<meta name=description '.repeat(25_000));
timed('many unterminated <a href tags', '<a href=x '.repeat(56_000));
timed('many unterminated <link rel tags', '<link rel=canonical '.repeat(28_000));
timed('many <metadata> near-misses', '<metadata '.repeat(56_000));
timed('alternating unclosed tags', '<title><h1><meta<a<link<script'.repeat(19_000));

{
  const t0 = Date.now();
  const { sitemaps, urls } = parseSitemap(`<sitemapindex>${'<loc>'.repeat(110_000)}`);
  const ms = Date.now() - t0;
  assert(ms < BUDGET_MS, `unclosed <loc> sitemap (~560KB) parsed in ${ms}ms < ${BUDGET_MS}ms`);
  assert(Array.isArray(sitemaps) && urls.length === 0, 'unclosed <loc> sitemap yields no page URLs');
}

sec('the extractors still extract');
{
  const html = `<html><head><title>Hello &amp; welcome</title>
    <meta name="description" content="A real description">
    <link rel="canonical" href="https://example.com/x"></head>
    <body><h1>Page <span>heading</span></h1><p>one two three</p>
    <script>var ignored = "words words words";</script>
    <a href="/a">A</a><a href="https://other.example/b">B</a>
    <a href="mailto:x@y.z">M</a><a href="javascript:alert(1)">J</a></body></html>`;
  const e = extract(html, 'https://example.com/page');
  assert(e.title === 'Hello & welcome', 'title extracted and entity-decoded', e.title);
  assert(e.metaDescription === 'A real description', 'meta description extracted', e.metaDescription);
  assert(e.h1 === 'Page heading', 'h1 extracted with inline tags flattened', e.h1);
  assert(e.canonical === 'https://example.com/x', 'canonical extracted', e.canonical);
  assert(e.wordCount > 0 && e.wordCount < 20, `word count excludes <script> (got ${e.wordCount})`);
  assert(e.links.includes('https://example.com/a'), 'relative link resolved');
  assert(e.links.includes('https://other.example/b'), 'absolute link kept');
  assert(!e.links.some((l) => l.startsWith('mailto:') || l.startsWith('javascript:')), 'mailto:/javascript: dropped');
}

// ---------------------------------------------------------------------------
// 3. Origin escape via string concatenation
// ---------------------------------------------------------------------------
sec('urlOnOrigin refuses paths that leave the origin');
for (const p of [
  '@evil.example.com/x',
  '//evil.example.com/x',
  '/\\evil.example.com/x',
  '\\/evil.example.com/x',
  'https://evil.example.com/x',
  '',
  'relative/path',
]) {
  let threw = false;
  try {
    urlOnOrigin('https://oldsite.com', p);
  } catch {
    threw = true;
  }
  assert(threw, `refuses ${JSON.stringify(p)}`);
}
assert(
  urlOnOrigin('https://oldsite.com', '/@evil.example.com/x') === 'https://oldsite.com/@evil.example.com/x',
  'an "@" inside a rooted path stays on the origin',
);
assert(urlOnOrigin('https://oldsite.com', '/a/b?c=d') === 'https://oldsite.com/a/b?c=d', 'a normal path resolves');

// ---------------------------------------------------------------------------
// 4. Live servers: sitemap fan-out, redirects, body cap
// ---------------------------------------------------------------------------

/** Start an http server on loopback; returns { origin, hits, close }. */
function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// A server that should NEVER be contacted. Standing in for 169.254.169.254:
// it is on loopback and deliberately NOT in the allow-list.
const sentinel = await serve((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><title>INTERNAL SECRET</title></html>');
});

const target = await serve((req, res) => {
  const xml = (b) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(b);
  };
  switch (req.url) {
    case '/sitemap.xml':
      // The hostile index: four children, three of them off-limits.
      return xml(
        `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
           <sitemap><loc>http://169.254.169.254/latest/meta-data/</loc></sitemap>
           <sitemap><loc>${sentinel.origin}/sitemap.xml</loc></sitemap>
           <sitemap><loc>https://evil.example.com/sitemap.xml</loc></sitemap>
           <sitemap><loc>http://127.0.0.1:${target.port}/sitemap-pages.xml</loc></sitemap>
         </sitemapindex>`,
      );
    case '/sitemap-pages.xml':
      return xml(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
           <url><loc>http://127.0.0.1:${target.port}/real-page</loc></url>
           <url><loc>http://169.254.169.254/latest/meta-data/iam/</loc></url>
           <url><loc>${sentinel.origin}/also-internal</loc></url>
         </urlset>`,
      );
    case '/redir-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    case '/redir-sentinel':
      res.writeHead(302, { location: `${sentinel.origin}/pwned` });
      return res.end();
    case '/redir-ok':
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/real-page` });
      return res.end();
    case '/redir-loop':
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/redir-loop` });
      return res.end();
    case '/huge': {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 192; i++) res.write(chunk); // 12MB
      return res.end();
    }
    case '/real-page':
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><title>Real page</title><body>hello</body></html>');
    default:
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><title>404</title></html>');
  }
});

clearAllowedHosts();
allowHosts(`127.0.0.1:${target.port}`); // the operator vouches for the target ONLY

sec('sitemap fan-out stays on the target origin');
{
  const urls = await getSitemapUrls(target.origin, { log: () => {} });
  assert(sentinel.hits.length === 0, 'the off-origin loopback sitemap was never requested', `hits: ${sentinel.hits}`);
  assert(
    urls.every((u) => u.startsWith(target.origin)),
    'every returned URL is on the target origin',
    urls.join(' '),
  );
  assert(
    !urls.some((u) => u.includes('169.254.169.254') || u.includes('evil.example.com')),
    'no metadata or off-origin URL survived into the result',
  );
  assert(urls.includes(`${target.origin}/real-page`), 'the legitimate same-origin page was still collected');
}

sec('redirects are checked hop by hop');
{
  const before = sentinel.hits.length;
  const r1 = await fetchText(`${target.origin}/redir-metadata`);
  assert(r1.status === 0 && /refusing/.test(r1.error || ''), 'a 302 to 169.254.169.254 is refused, not followed', r1.error);

  const r2 = await fetchText(`${target.origin}/redir-sentinel`);
  assert(r2.status === 0 && /refusing/.test(r2.error || ''), 'a 302 to another loopback port is refused', r2.error);
  assert(sentinel.hits.length === before, 'the sentinel server received no request from either redirect');

  const r3 = await fetchText(`${target.origin}/redir-ok`);
  assert(r3.status === 200 && /Real page/.test(r3.text), 'a legitimate same-origin redirect is still followed');
  assert(r3.redirected && r3.finalUrl.endsWith('/real-page'), 'finalUrl reports the hop, not the request URL', r3.finalUrl);

  const r4 = await fetchText(`${target.origin}/redir-loop`);
  assert(r4.status === 0 && /too many redirects/.test(r4.error || ''), 'a redirect loop terminates', r4.error);
}

sec('response bodies are capped');
{
  const r = await fetchText(`${target.origin}/huge`);
  assert(r.bytes <= 5 * 1024 * 1024, `12MB body truncated to ${Math.round(r.bytes / 1024 / 1024)}MB`, String(r.bytes));
  assert(r.truncated === true, 'the result is flagged as truncated');
  assert(r.text.length <= 5 * 1024 * 1024, 'the decoded text respects the cap');
}

sec('guardedFetch/readCapped directly');
{
  const { res } = await guardedFetch(`${target.origin}/huge`);
  const { bytes, truncated } = await readCapped(res, 1024);
  assert(bytes === 1024 && truncated, `readCapped honours a 1KB cap (got ${bytes})`);
}

await target.close();
await sentinel.close();
clearAllowedHosts();

// ---------------------------------------------------------------------------
// 5. Output path safety
// ---------------------------------------------------------------------------
sec('writeOut confines output to the working directory and never clobbers');
{
  const work = mkdtempSync(join(tmpdir(), 'wpmig-out-'));
  const outside = mkdtempSync(join(tmpdir(), 'wpmig-ext-'));
  const cwd = process.cwd();
  try {
    process.chdir(work);
    writeOut('out/report.json', '{}');
    ok('writes a file under the working directory');

    let threw = false;
    try {
      writeOut('out/report.json', '{"clobbered":true}');
    } catch {
      threw = true;
    }
    assert(threw, 'refuses to overwrite an existing report without --force');

    writeOut('out/report.json', '{"forced":true}', { force: true });
    ok('--force allows the overwrite');

    for (const p of [join(outside, 'escape.json'), '../escape.json', '/tmp/wpmig-escape.json']) {
      let t = false;
      try {
        writeOut(p, 'x');
      } catch {
        t = true;
      }
      assert(t, `refuses to write outside cwd: ${p}`);
    }

    symlinkSync(outside, join(work, 'linked'));
    let t = false;
    try {
      writeOut('linked/escape.json', 'x');
    } catch {
      t = true;
    }
    assert(t, 'refuses to write through a symlinked directory that escapes cwd');
  } finally {
    process.chdir(cwd);
    rmSync(work, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. redirects.mjs — untrusted paths never reach the generated config

// --- the skill's declared scope -------------------------------------------
// This skill is a general site-migration skill. The scope has been narrowed to
// WordPress-only once by accident, which makes it stop matching the requests it
// exists to handle, so the frontmatter is asserted rather than trusted.

sec("SKILL.md frontmatter declares the general, multi-platform scope");
{
  const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
  assert(!!fm, 'SKILL.md has YAML frontmatter');
  const desc = (/description:\s*>-\r?\n((?:[ \t]+.*\r?\n)+)/.exec(fm[1]) || [])[1] || '';
  const oneLine = desc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  assert(oneLine.length > 0, 'description is a folded block scalar we can read');
  // The Agent Skills frontmatter limit. Over it, the skill may fail to load.
  assert(oneLine.length <= 1024, `description is within 1024 chars (${oneLine.length})`);

  for (const t of [
    'WordPress',
    'Squarespace',
    'Wix',
    'Webflow',
    'Shopify',
    'Vercel',
    'Netlify',
    'Next.js',
    'PHP',
    'Node app',
    'static files',
    'port this site to a new stack',
    'self-host this site',
    'migrate without losing SEO',
  ]) {
    assert(oneLine.includes(t), `description still names "${t}"`);
  }

  const when = /\n## When to use this\n([\s\S]*?)\n## /.exec(skill);
  assert(!!when, 'SKILL.md still has a "When to use this" section');
  const scope = when ? when[1] : '';
  for (const t of ['Re-platforming', 'Re-hosting', 'Re-domaining', 'Next.js', 'Squarespace', 'Webflow']) {
    assert(scope.includes(t), `"When to use this" still covers ${t}`);
  }

  // Non-WordPress sources must have real recipes, not a redirect to the WP section.
  for (const h of [
    '#### From Squarespace',
    '#### From Wix',
    '#### From Webflow',
    '#### From Shopify',
    '#### From a static or hand-rolled site',
    '#### When there is no export at all',
    '#### B5b. Static site',
    '#### B5c. Generic PHP app (Laravel, Drupal, Joomla, custom)',
    '#### B5d. Node app',
  ]) {
    assert(skill.includes(h), `SKILL.md has the "${h.replace(/^#+ /, '')}" recipe`);
  }

  // Every internal anchor link has to resolve, or the index table is a dead end.
  const slug = (t) =>
    t
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/gu, '')
      .replace(/ /g, '-');
  const headings = new Set();
  let inFence = false;
  for (const line of skill.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) headings.add(slug(m[1]));
  }
  const dead = [...skill.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !headings.has(a));
  assert(dead.length === 0, 'every internal anchor in SKILL.md resolves', dead.join(', '));
}

// ---------------------------------------------------------------------------
sec('redirects.mjs rejects paths that would inject into a webserver config');
{
  const work = mkdtempSync(join(tmpdir(), 'wpmig-redir-'));
  try {
    mkdirSync(join(work, 'in'));
    writeFileSync(
      join(work, 'in', 'mapping.csv'),
      [
        'old_path,new_path',
        '/good,/also-good',
        '//evil.example.com/x,/y',
        '/a;}\nhttps://evil.example.com{,/y'.replace('\n', ''),
        '/q,/r"; }\nexample{'.replace('\n', ''),
        '/has space,/y',
        '/back\\slash,/y',
        '/dollar$var,/y',
      ].join('\n'),
    );
    const out = execFileSync(
      process.execPath,
      [join(SCRIPTS, 'redirects.mjs'), '--map', join(work, 'in', 'mapping.csv'), '--out', 'out', '--format', 'all'],
      { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert(/1 redirects/.test(out), 'only the one safe pair is emitted', out.trim().split('\n').pop());
    const caddy = execFileSync('cat', [join(work, 'out', 'Caddyfile.redirects')], { encoding: 'utf8' });
    assert(/redir \/good \/also-good permanent/.test(caddy), 'the safe pair is present in the Caddyfile');
    assert(!/evil\.example\.com/.test(caddy), 'no injected host reached the Caddyfile');
    assert(caddy.trim().split('\n').length === 2, 'the Caddyfile has exactly a comment and one directive');
    const nginx = execFileSync('cat', [join(work, 'out', 'redirects.nginx.conf')], { encoding: 'utf8' });
    assert(!/evil\.example\.com/.test(nginx), 'no injected host reached the nginx config');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

sec('every script still runs and refuses a non-public target');
{
  for (const s of ['inventory.mjs', 'linkcheck.mjs']) {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [join(SCRIPTS, s), 'http://169.254.169.254/'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      code = e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    assert(code !== 0 && /refusing/.test(out), `${s} exits non-zero on a metadata target`, out.slice(0, 120));
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [join(SCRIPTS, 'parity.mjs'), 'http://127.0.0.1/', 'http://10.0.0.1/'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert(code !== 0 && /refusing/.test(out), 'parity.mjs exits non-zero on private targets', out.slice(0, 120));
}

console.log('\n============================================================');
console.log(` ${pass} passed, ${fail} failed`);
console.log('============================================================');
process.exit(fail === 0 ? 0 : 1);
