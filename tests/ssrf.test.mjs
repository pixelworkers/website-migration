// Remote-URL gate: nothing that came off a remote site gets fetched without
// being checked against the origin the operator named.
//
// The regression this file exists for: the earlier hardening filtered child
// sitemaps only, so page <loc> entries were still used verbatim. A hostile
// sitemap.xml could make the auditing machine GET
// http://169.254.169.254/latest/meta-data/iam/security-credentials/ and write
// the response title into inventory.json. `getSitemapUrls returns no off-origin
// page URLs` and `no request reaches the metadata service` cover that directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  getSitemapUrls,
  remoteUrlAllowed,
  filterRemoteUrls,
  isInternalHost,
  isMetadataHost,
  redirectAllowed,
  urlOnOrigin,
  safeRedirectPath,
  safeRedirectTarget,
  fetchText,
  fetchRaw,
  parseSitemap,
  LIMITS,
} from '../scripts/lib.mjs';

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('isInternalHost covers loopback, private, link-local and internal names', () => {
  for (const h of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.1',
    '192.168.1.1', '100.64.0.1', '169.254.169.254', '::1', '::', 'fc00::1', 'fd12:3456::1',
    'fe80::1', '[::1]', 'localhost', 'foo.localhost', 'printer.local', 'db.internal',
    'wiki.intranet', 'router.home.arpa', '',
  ]) {
    assert.equal(isInternalHost(h), true, `${h} should be internal`);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.167.1.1', '100.63.0.1', 'local.example.com']) {
    assert.equal(isInternalHost(h), false, `${h} should not be internal`);
  }
});

test('isMetadataHost covers the cloud metadata endpoints', () => {
  for (const h of [
    '169.254.169.254', '169.254.170.2', '100.100.100.200', 'metadata',
    'metadata.google.internal', 'metadata.goog', 'fd00:ec2::254', '[fd00:ec2::254]',
  ]) {
    assert.equal(isMetadataHost(h), true, `${h} should be a metadata host`);
  }
  for (const h of ['example.com', '127.0.0.1', '169.254.1.1', '']) {
    assert.equal(isMetadataHost(h), false, `${h} should not be a metadata host`);
  }
});

test('remoteUrlAllowed keeps remote-sourced URLs on the crawl origin', () => {
  const origin = 'https://example.com';
  assert.equal(remoteUrlAllowed('https://example.com/a', origin), true);
  assert.equal(remoteUrlAllowed('https://example.com:443/a', origin), true);
  // different host, scheme or port
  assert.equal(remoteUrlAllowed('https://evil.example/a', origin), false);
  assert.equal(remoteUrlAllowed('http://example.com/a', origin), false);
  assert.equal(remoteUrlAllowed('https://example.com:8443/a', origin), false);
  assert.equal(remoteUrlAllowed('https://www.example.com/a', origin), false);
  // the SSRF targets from the PoC
  assert.equal(remoteUrlAllowed('http://169.254.169.254/latest/meta-data/', origin), false);
  assert.equal(remoteUrlAllowed('http://127.0.0.1:8080/latest/meta-data/', origin), false);
  assert.equal(remoteUrlAllowed('http://[::1]/x', origin), false);
  assert.equal(remoteUrlAllowed('http://10.0.0.5/admin', origin), false);
  assert.equal(remoteUrlAllowed('http://192.168.1.1/', origin), false);
  assert.equal(remoteUrlAllowed('http://nas.local/', origin), false);
  // non-http(s) and junk
  assert.equal(remoteUrlAllowed('file:///etc/passwd', origin), false);
  assert.equal(remoteUrlAllowed('gopher://example.com/', origin), false);
  assert.equal(remoteUrlAllowed('not a url', origin), false);
  assert.equal(remoteUrlAllowed('', origin), false);
  assert.equal(remoteUrlAllowed(null, origin), false);
});

test('remoteUrlAllowed with sameOriginOnly:false still refuses private hosts', () => {
  const origin = 'https://example.com';
  const off = { sameOriginOnly: false };
  assert.equal(remoteUrlAllowed('https://cdn.other.example/x', origin, off), true);
  assert.equal(remoteUrlAllowed('http://169.254.169.254/', origin, off), false);
  assert.equal(remoteUrlAllowed('http://127.0.0.1:9000/', origin, off), false);
  assert.equal(remoteUrlAllowed('http://10.1.2.3/', origin, off), false);

  // Auditing loopback with --external must not turn a link on the page into a
  // port scan of the operator's own machine.
  const loopback = 'http://127.0.0.1:3000';
  assert.equal(remoteUrlAllowed('http://127.0.0.1:3000/a', loopback, off), true);
  assert.equal(remoteUrlAllowed('http://127.0.0.1:9000/a', loopback, off), false);
  assert.equal(remoteUrlAllowed('http://localhost:3000/a', loopback, off), false);
  assert.equal(remoteUrlAllowed('http://10.1.2.3/a', loopback, off), false);
  assert.equal(remoteUrlAllowed('https://cdn.other.example/x', loopback, off), true);
});

test('remoteUrlAllowed does not break a legitimate localhost staging audit', () => {
  // The operator pointed the tool at loopback themselves; same-origin links
  // there are not an escalation. Leaving that origin still is not allowed.
  const origin = 'http://127.0.0.1:3000';
  assert.equal(remoteUrlAllowed('http://127.0.0.1:3000/about', origin), true);
  assert.equal(remoteUrlAllowed('http://127.0.0.1:9999/other', origin), false);
  assert.equal(remoteUrlAllowed('http://169.254.169.254/', origin), false);
  assert.equal(remoteUrlAllowed('http://10.0.0.1/', origin), false);
});

test('filterRemoteUrls reports what it refused instead of dropping it silently', () => {
  const { allowed, refused } = filterRemoteUrls(
    ['https://example.com/a', 'http://169.254.169.254/x', 'https://evil.example/y'],
    'https://example.com',
  );
  assert.deepEqual(allowed, ['https://example.com/a']);
  assert.deepEqual(refused, ['http://169.254.169.254/x', 'https://evil.example/y']);
});

test('redirectAllowed refuses a metadata host even from a metadata-ish origin', () => {
  assert.equal(redirectAllowed('https://example.com/a', 'https://example.com/b'), true);
  assert.equal(redirectAllowed('https://example.com/a', 'https://www.example.com/b'), true);
  assert.equal(redirectAllowed('https://example.com/a', 'http://169.254.169.254/'), false);
  assert.equal(redirectAllowed('http://169.254.169.254/a', 'http://169.254.169.254/b'), false);
  assert.equal(redirectAllowed('https://example.com/a', 'https://evil.example/b'), false);
  assert.equal(redirectAllowed('https://example.com/a', 'file:///etc/passwd'), false);
});

test('fetchText and fetchRaw refuse a metadata target outright', async () => {
  const r = await fetchText('http://169.254.169.254/latest/meta-data/');
  assert.equal(r.status, 0);
  assert.match(r.error, /metadata/i);
  assert.equal(await fetchRaw('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(await fetchRaw('http://metadata.google.internal/'), null);
});

test('getSitemapUrls refuses off-origin page URLs and never fetches them', async () => {
  // Stands in for the instance metadata service. If anything requests it, the
  // SSRF is live.
  const hits = [];
  const victim = await listen((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>LEAKED-IAM-CREDENTIALS</title></head></html>');
  });

  const hostile = await listen((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset>
        <url><loc>${victim.origin}/latest/meta-data/iam/security-credentials/</loc></url>
        <url><loc>http://169.254.169.254/latest/meta-data/</loc></url>
        <url><loc>http://[::1]/x</loc></url>
        <url><loc>https://attacker.example.net/collect?x=1</loc></url>
        <url><loc>file:///etc/passwd</loc></url>
        <url><loc>SELF/ok</loc></url>
      </urlset>`.replace('SELF', `http://127.0.0.1:${hostileRef.port}`));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('nope');
  });
  const hostileRef = hostile; // referenced above once the handler actually runs

  try {
    const refused = [];
    const urls = await getSitemapUrls(hostile.origin, { log: () => {}, refused });
    assert.deepEqual(hits, [], `the metadata stand-in was requested: ${JSON.stringify(hits)}`);
    for (const u of urls) {
      assert.ok(
        u.startsWith(`${hostile.origin}/`),
        `getSitemapUrls returned an off-origin URL: ${u}`,
      );
    }
    // The one same-origin entry still comes through — the guard restricts, it
    // does not break sitemap reading.
    assert.deepEqual(urls, [`${hostile.origin}/ok`]);
    assert.deepEqual(refused, [
      `${victim.origin}/latest/meta-data/iam/security-credentials/`,
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'https://attacker.example.net/collect?x=1',
      'file:///etc/passwd',
    ]);
  } finally {
    await hostile.close();
    await victim.close();
  }
});

test('getSitemapUrls refuses an off-origin child sitemap', async () => {
  const hits = [];
  const other = await listen((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<urlset><url><loc>http://169.254.169.254/</loc></url></urlset>');
  });
  const site = await listen((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<sitemapindex><sitemap><loc>${other.origin}/sitemap.xml</loc></sitemap></sitemapindex>`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('nope');
  });
  try {
    const refused = [];
    const urls = await getSitemapUrls(site.origin, { log: () => {}, refused });
    assert.deepEqual(urls, []);
    assert.deepEqual(refused, [`${other.origin}/sitemap.xml`]);
    assert.deepEqual(hits, []);
  } finally {
    await site.close();
    await other.close();
  }
});

test('getSitemapUrls refuses a metadata host passed on the command line', async () => {
  await assert.rejects(
    () => getSitemapUrls('http://169.254.169.254/'),
    /metadata/i,
  );
});

test('parseSitemap returns raw untrusted strings, bounded in count and length', () => {
  const r = parseSitemap('<urlset><url><loc>https://a.example/1</loc></url><url><loc> https://a.example/2 </loc></url></urlset>');
  assert.deepEqual(r.urls, ['https://a.example/1', 'https://a.example/2']);
  assert.deepEqual(r.sitemaps, []);

  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://a.example/s.xml</loc></sitemap></sitemapindex>');
  assert.deepEqual(idx.sitemaps, ['https://a.example/s.xml']);
  assert.deepEqual(idx.urls, []);

  assert.equal(parseSitemap('<urlset><url><loc>https://a.example/?x=1&amp;y=2</loc></url></urlset>').urls[0],
    'https://a.example/?x=1&y=2');

  const many = '<urlset>' + '<url><loc>https://a.example/p</loc></url>'.repeat(200) + '</urlset>';
  assert.equal(parseSitemap(many, { maxUrls: 10 }).urls.length, 10);

  const huge = `<urlset><url><loc>${'a'.repeat(LIMITS.maxFieldBytes * 4)}</loc></url></urlset>`;
  assert.ok(parseSitemap(huge).urls[0].length <= LIMITS.maxFieldBytes);

  for (const bad of ['', null, undefined, 42]) {
    assert.deepEqual(parseSitemap(bad), { sitemaps: [], urls: [] });
  }
});

test('parseSitemap is bounded on hostile XML', () => {
  const CAP = LIMITS.maxBytes;
  for (const unit of ['<loc>', '<loc', '<', '<loc></loc>']) {
    const xml = unit.repeat(Math.floor(CAP / unit.length));
    const started = process.hrtime.bigint();
    parseSitemap(xml);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `parseSitemap took ${ms.toFixed(0)}ms on ${CAP / 1048576}MB of ${unit}`);
  }
});

test('urlOnOrigin resolves a path without letting it change the host', () => {
  assert.equal(urlOnOrigin('https://new.example', '/a/b?x=1'), 'https://new.example/a/b?x=1');
  assert.equal(urlOnOrigin('https://new.example/ignored/path', '/a'), 'https://new.example/a');
  // the attacks string concat would have allowed
  assert.equal(urlOnOrigin('https://new.example', 'https://evil.example/x'), null);
  assert.equal(urlOnOrigin('https://new.example', '//evil.example/x'), null);
  assert.equal(urlOnOrigin('https://new.example', 'http://169.254.169.254/'), null);
  assert.equal(urlOnOrigin('https://new.example', '/a\nHost: evil'), null);
  assert.equal(urlOnOrigin('https://new.example', '/a\r\nx'), null);
  assert.equal(urlOnOrigin('https://new.example', '/a\0b'), null);
  assert.equal(urlOnOrigin('not a url', '/a'), null);
  assert.equal(urlOnOrigin('https://new.example', 42), null);
  // `..` cannot climb above the origin — URL resolution clamps it
  assert.equal(urlOnOrigin('https://new.example', '/../../etc'), 'https://new.example/etc');
});

test('safeRedirectPath refuses anything that could inject a config directive', () => {
  assert.equal(safeRedirectPath('/about'), '/about');
  assert.equal(safeRedirectPath('/a/b?x=1'), '/a/b?x=1');
  assert.equal(safeRedirectPath('about'), '/about');
  for (const bad of [
    '/a\nredir /x /y',
    '/a\r\nreturn 301 http://evil',
    '/a\0b',
    '/a }\nhandle /* { respond "pwned"',
    'https://evil.example/x',
    '//evil.example/x',
    '/a b',
    "/a;b { return 301 http://evil.example; }",
    "/a'b",
    '',
    '   ',
    null,
    42,
  ]) {
    assert.equal(safeRedirectPath(bad), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test('safeRedirectTarget allows a path or an absolute http(s) URL, nothing else', () => {
  assert.equal(safeRedirectTarget('/new'), '/new');
  assert.equal(safeRedirectTarget('https://new.example/x'), 'https://new.example/x');
  assert.equal(safeRedirectTarget('http://new.example/x'), 'http://new.example/x');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '/a\nx', '{block}', '/a;b', "/a'b", '', null]) {
    assert.equal(safeRedirectTarget(bad), null, `${JSON.stringify(bad)} should be refused`);
  }
});
