// End-to-end: run the four CLI scripts against local servers and assert on what
// they wrote. This is the test that would have caught the live SSRF — it drives
// inventory.mjs exactly the way Vivian's PoC did.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function run(script, argv, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(SCRIPTS, script), ...argv],
      { cwd, timeout: 60000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }),
    );
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const html = (title, body = '') =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta name="description" content="desc of ${title}">` +
  `</head><body><h1>${title}</h1><p>some body words here for the count</p>${body}</body></html>`;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wpm-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('inventory.mjs does not fetch off-origin sitemap entries (the live SSRF)', async () => {
  const victimHits = [];
  const victim = await listen((req, res) => {
    victimHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('LEAKED-IAM-CREDENTIALS'));
  });

  let origin = '';
  const site = await listen((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset>
        <url><loc>${victim.origin}/latest/meta-data/iam/security-credentials/</loc></url>
        <url><loc>http://169.254.169.254/latest/meta-data/</loc></url>
        <url><loc>${origin}/real-page</loc></url>
      </urlset>`);
      return;
    }
    res.writeHead(req.url === '/real-page' ? 200 : 404, { 'content-type': 'text/html' });
    res.end(req.url === '/real-page' ? html('Real page') : html('404'));
  });
  origin = site.origin;

  try {
    const r = await run('inventory.mjs', [site.origin, '--out', 'out'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(victimHits, [], `the metadata stand-in was fetched: ${JSON.stringify(victimHits)}`);
    assert.match(r.stdout, /Refused 2 sitemap entries/);

    const inv = JSON.parse(readFileSync(join(dir, 'out/inventory.json'), 'utf8'));
    assert.deepEqual(inv.pages.map((p) => p.url), [`${site.origin}/real-page`]);
    const written = readFileSync(join(dir, 'out/inventory.json'), 'utf8') +
      readFileSync(join(dir, 'out/inventory.csv'), 'utf8');
    assert.doesNotMatch(written, /LEAKED-IAM-CREDENTIALS/);
    assert.doesNotMatch(written, /169\.254\.169\.254/);
  } finally {
    await site.close();
    await victim.close();
  }
});

test('inventory.mjs + parity.mjs + redirects.mjs run clean against a real pair of sites', async () => {
  let oldOrigin = '';
  const pages = { '/': 'Home', '/about': 'About', '/blog': 'Blog' };
  const oldSite = await listen((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        '<?xml version="1.0"?><urlset>' +
          Object.keys(pages).map((p) => `<url><loc>${oldOrigin}${p}</loc></url>`).join('') +
          '</urlset>',
      );
      return;
    }
    const title = pages[req.url.replace(/\?.*/, '')];
    res.writeHead(title ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html(title || 'Not found'));
  });
  oldOrigin = oldSite.origin;
  const newSite = await listen((req, res) => {
    const title = pages[req.url.replace(/\?.*/, '')];
    res.writeHead(title ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html(title || 'Not found'));
  });

  try {
    const inv = await run('inventory.mjs', [oldSite.origin, '--out', 'out'], dir);
    assert.equal(inv.code, 0, inv.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'out/inventory.json'), 'utf8')).pages.length, 3);

    const par = await run(
      'parity.mjs',
      [oldSite.origin, newSite.origin, '--inventory', 'out/inventory.json', '--out', 'out-parity'],
      dir,
    );
    assert.equal(par.code, 0, par.stdout + par.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'out-parity/parity-report.json'), 'utf8'));
    assert.equal(report.summary.problems, 0);
    assert.equal(report.summary.total, 3);

    const red = await run(
      'redirects.mjs',
      ['--inventory', 'out/inventory.json', '--out', 'out-red', '--format', 'all'],
      dir,
    );
    assert.equal(red.code, 0, red.stderr);
    const caddy = readFileSync(join(dir, 'out-red/Caddyfile.redirects'), 'utf8');
    assert.match(caddy, /redir \/about \/about permanent/);
    assert.ok(existsSync(join(dir, 'out-red/_redirects')));
    assert.ok(existsSync(join(dir, 'out-red/redirects.nginx.conf')));
    assert.ok(existsSync(join(dir, 'out-red/redirects.next.js')));
  } finally {
    await oldSite.close();
    await newSite.close();
  }
});

test('parity.mjs refuses an inventory path that tries to retarget the host', async () => {
  const victimHits = [];
  const victim = await listen((req, res) => {
    victimHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('LEAKED'));
  });
  const site = await listen((req, res) => {
    res.writeHead(req.url === '/ok' ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html(req.url === '/ok' ? 'Ok' : 'Not found'));
  });
  try {
    writeFileSync(
      join(dir, 'inv.json'),
      JSON.stringify({
        pages: [
          { url: `${site.origin}/ok`, path: '/ok' },
          { url: 'x', path: `${victim.origin}/steal` },
          { url: 'x', path: '//169.254.169.254/latest/meta-data/' },
        ],
      }),
    );
    const r = await run(
      'parity.mjs',
      [site.origin, site.origin, '--inventory', 'inv.json', '--out', 'out'],
      dir,
    );
    assert.deepEqual(victimHits, [], `off-origin path was fetched: ${JSON.stringify(victimHits)}`);
    assert.match(r.stdout, /Skipped 2 entries/);
    const report = JSON.parse(readFileSync(join(dir, 'out/parity-report.json'), 'utf8'));
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.skipped, 2);
  } finally {
    await site.close();
    await victim.close();
  }
});

test('linkcheck.mjs reports a link to an internal address instead of requesting it', async () => {
  const victimHits = [];
  const victim = await listen((req, res) => {
    victimHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('LEAKED'));
  });
  let origin = '';
  const site = await listen((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        html('Home',
          `<a href="${origin}/good">good</a>` +
          `<a href="http://169.254.169.254/latest/meta-data/">meta</a>` +
          `<a href="http://10.1.2.3/admin">lan</a>` +
          `<a href="${victim.origin}/steal">victim</a>`),
      );
      return;
    }
    res.writeHead(req.url === '/good' ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html(req.url === '/good' ? 'Good' : 'Not found'));
  });
  origin = site.origin;
  try {
    const r = await run('linkcheck.mjs', [site.origin, '--out', 'out', '--external'], dir);
    assert.deepEqual(victimHits, [], `an internal link was fetched: ${JSON.stringify(victimHits)}`);
    const report = JSON.parse(readFileSync(join(dir, 'out/link-report.json'), 'utf8'));
    const refused = report.refusedLinks.map((x) => x.link).sort();
    assert.deepEqual(refused, [
      'http://10.1.2.3/admin',
      `${victim.origin}/steal`,
      'http://169.254.169.254/latest/meta-data/',
    ].sort());
    assert.equal(report.summary.broken, 0, JSON.stringify(report.broken));
    assert.match(readFileSync(join(dir, 'out/link-report.md'), 'utf8'), /Links not requested \(3\)/);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await site.close();
    await victim.close();
  }
});

test('scripts refuse to clobber a previous run and accept --force', async () => {
  const site = await listen((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('no');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('Home'));
  });
  try {
    const first = await run('inventory.mjs', [site.origin, '--out', 'out'], dir);
    assert.equal(first.code, 0, first.stderr);
    const second = await run('inventory.mjs', [site.origin, '--out', 'out'], dir);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /refusing to overwrite/);
    const third = await run('inventory.mjs', [site.origin, '--out', 'out', '--force'], dir);
    assert.equal(third.code, 0, third.stderr);
  } finally {
    await site.close();
  }
});

test('redirects.mjs drops a mapping row that would inject a config directive', async () => {
  writeFileSync(
    join(dir, 'mapping.csv'),
    [
      'old_path,new_path',
      '/a,/b',
      '/c,https://new.example/c',
      '/d\nredir /x /y,/e',
      'https://evil.example/f,/g',
      '/h,javascript:alert(1)',
    ].join('\n'),
  );
  const r = await run('redirects.mjs', ['--map', 'mapping.csv', '--out', 'out', '--format', 'caddy'], dir);
  assert.equal(r.code, 2, 'bad input rows should set a non-zero exit code');
  assert.match(r.stderr, /Dropped 3 unusable pair/);
  const caddy = readFileSync(join(dir, 'out/Caddyfile.redirects'), 'utf8');
  assert.match(caddy, /redir \/a \/b permanent/);
  assert.match(caddy, /redir \/c https:\/\/new\.example\/c permanent/);
  assert.doesNotMatch(caddy, /redir \/x \/y/);
  assert.doesNotMatch(caddy, /evil\.example/);
  assert.doesNotMatch(caddy, /javascript:/);
  assert.equal(caddy.trim().split('\n').length, 3); // comment + 2 rules
});

test('scripts reject a non-http(s) target instead of crawling it', async () => {
  for (const script of ['inventory.mjs', 'linkcheck.mjs']) {
    const r = await run(script, ['file:///etc/passwd', '--out', 'out'], dir);
    assert.equal(r.code, 1, `${script} should refuse file://`);
    assert.match(r.stderr, /not an http\(s\) URL/i);
  }
  const p = await run('parity.mjs', ['file:///etc', 'https://example.com', '--out', 'out'], dir);
  assert.equal(p.code, 1);
  assert.match(p.stderr, /not an http\(s\) URL/i);
});
