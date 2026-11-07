// Parser bounds: the hostile HTML shapes that made the old extract path go
// quadratic, plus the correctness cases that must survive the rewrite.
//
// The old code took 17.5s on 640KB of `'<script '` and 70s on 1.28MB; at the
// 5MB body cap that is ~18 minutes of blocked event loop per page. Every shape
// below is built at the real 5MB cap and must finish well inside a second.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, LIMITS } from '../scripts/lib.mjs';

const CAP = LIMITS.maxBytes; // 5 MB — what readCapped will actually hand us
const BUDGET_MS = 1000;

function timeExtract(html) {
  const started = process.hrtime.bigint();
  const out = extract(html, 'https://example.com/');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { out, ms };
}

function fill(unit, bytes = CAP) {
  return unit.repeat(Math.floor(bytes / unit.length));
}

// Each entry is one of Vivian's shapes, or a near neighbour of it.
const HOSTILE = [
  ['unclosed <script  x N (the 70s case)', fill('<script ')],
  ['unclosed <script> x N', fill('<script>')],
  ['<script> with an unterminated body', '<script>' + 'a'.repeat(CAP - 8)],
  ['<style  x N', fill('<style ')],
  ['unclosed <title> x N', fill('<title>')],
  ['<title with no close bracket x N', fill('<title')],
  ['name="description" x N (the 14.35s case)', '<meta ' + fill('name="description" ', CAP - 6)],
  ['<meta with no close bracket x N', fill('<meta')],
  ['content="..." with no name x N', fill('<meta content="x" ')],
  ['<h1> x N', fill('<h1>')],
  ['<h1 with no close bracket x N', fill('<h1')],
  ['<a  x N', fill('<a ')],
  ['<a href=" unterminated x N', fill('<a href="x ')],
  ['<link rel= x N', fill('<link rel="x" ')],
  ['bare < x N', '<'.repeat(CAP)],
  ['1000 "<" then ">" x N', fill('<'.repeat(1000) + '>')],
  ['one giant attribute value', '<meta name="description" content="' + 'a'.repeat(CAP - 40)],
  ['deeply repeated empty tags', fill('<b></b>')],
  ['script open/close pairs x N', fill('<script></script>')],
];

for (const [label, html] of HOSTILE) {
  test(`extract() is bounded: ${label}`, () => {
    const { ms } = timeExtract(html);
    assert.ok(
      ms < BUDGET_MS,
      `extract() took ${ms.toFixed(0)}ms on ${(html.length / 1048576).toFixed(2)}MB of ${label} (budget ${BUDGET_MS}ms)`,
    );
  });
}

test('extract() stays bounded across every hostile shape in sequence', () => {
  const started = process.hrtime.bigint();
  for (const [, html] of HOSTILE) extract(html, 'https://example.com/');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < BUDGET_MS * HOSTILE.length, `whole suite took ${ms.toFixed(0)}ms`);
});

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>  Dogs &amp; Cats | Example  </title>
<meta name="viewport" content="width=device-width">
<meta name="description" content="A page about dogs &amp; cats.">
<link rel="stylesheet" href="/a.css">
<link rel="canonical" href="https://example.com/pets/">
<style>.x{content:"</h1>"}</style>
</head><body>
<script>var a = "<h1>fake</h1>"; if (1 < 2) {}</script>
<h1 class="t">Dogs <em>and</em> Cats</h1>
<p>Hello world.</p>
<a href="/about">About</a><a href='https://other.example/x'>Ext</a>
<a href="/about">dupe</a><a href="mailto:a@b.c">mail</a><a href="#frag">frag</a>
<a href="/q?a=1&amp;b=2">entity href</a>
</body></html>`;

test('extract() still reads the fields it is supposed to read', () => {
  const r = extract(PAGE, 'https://example.com/pets/');
  assert.equal(r.title, 'Dogs & Cats | Example');
  assert.equal(r.metaDescription, 'A page about dogs & cats.');
  assert.equal(r.h1, 'Dogs and Cats');
  assert.equal(r.canonical, 'https://example.com/pets/');
  assert.ok(r.wordCount > 5);
});

test('extract() takes h1 from markup, not from a script or style body', () => {
  assert.equal(extract(PAGE, 'https://example.com/').h1, 'Dogs and Cats');
  assert.equal(
    extract('<script>var x = "<h1>injected</h1>";</script><h1>real</h1>', 'https://example.com/').h1,
    'real',
  );
});

test('extract() harvests, absolutizes and de-duplicates links', () => {
  const r = extract(PAGE, 'https://example.com/pets/');
  assert.deepEqual(r.links, [
    'https://example.com/about',
    'https://other.example/x',
    'https://example.com/q?a=1&b=2',
  ]);
});

test('extract() drops mailto/tel/javascript/data and bare fragments', () => {
  const r = extract(
    '<a href="mailto:a@b.c">m</a><a href="tel:+1">t</a><a href="javascript:alert(1)">j</a>' +
      '<a href="data:text/html,x">d</a><a href="#top">f</a><a href="/ok">ok</a>',
    'https://example.com/',
  );
  assert.deepEqual(r.links, ['https://example.com/ok']);
});

test('extract() honours maxLinks', () => {
  const html = Array.from({ length: 50 }, (_, i) => `<a href="/p${i}">x</a>`).join('');
  assert.equal(extract(html, 'https://example.com/', { maxLinks: 10 }).links.length, 10);
});

test('extract() drops script and style bodies from the word count', () => {
  const withScript = extract(
    '<body><script>' + 'word '.repeat(500) + '</script><p>one two three</p></body>',
    'https://example.com/',
  );
  assert.equal(withScript.wordCount, 3);
});

test('extract() tolerates an empty, missing or non-string body', () => {
  for (const bad of ['', null, undefined, 0, {}, []]) {
    const r = extract(bad, 'https://example.com/');
    assert.deepEqual(r, {
      title: '',
      metaDescription: '',
      h1: '',
      canonical: '',
      wordCount: 0,
      links: [],
    });
  }
});

test('extract() reads head metadata only from the head slice', () => {
  const html = 'x'.repeat(2000) + '<title>late</title>';
  assert.equal(extract(html, 'https://example.com/', { headScanBytes: 100 }).title, '');
  assert.equal(extract(html, 'https://example.com/', { headScanBytes: 1 << 20 }).title, 'late');
});

test('extract() truncates an absurd field instead of returning megabytes', () => {
  const r = extract('<title>' + 'a'.repeat(CAP) + '</title>', 'https://example.com/');
  assert.ok(r.title.length <= LIMITS.maxFieldBytes, `title was ${r.title.length} bytes`);
});

test('extract() handles a reversed meta tag (content before name)', () => {
  const r = extract(
    '<head><meta content="reversed" name="description"></head>',
    'https://example.com/',
  );
  assert.equal(r.metaDescription, 'reversed');
});

test('extract() reads canonical from a multi-valued rel', () => {
  const r = extract(
    '<head><link rel="alternate canonical" href="https://example.com/c"></head>',
    'https://example.com/',
  );
  assert.equal(r.canonical, 'https://example.com/c');
});
