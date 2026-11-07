#!/usr/bin/env node
// redirects.mjs — generate a 301 redirect map in the format your new stack needs.
//
// A migration without a redirect map silently torches SEO: every old inbound
// link and every indexed URL 404s. This emits the same mapping for Caddy,
// nginx, Netlify, and Next.js so you can drop it straight into the new config.
//
// Usage:
//   node scripts/redirects.mjs --inventory out/inventory.json [--out out] [--format all]
//   node scripts/redirects.mjs --map mapping.csv [--out out] [--format caddy]
//
//   --inventory <file>  inventory.json — produces identity redirects (old path → same path)
//   --map <file>        CSV of "old_path,new_path" (one per line, header optional)
//   --format            all | caddy | nginx | netlify | next   (default: all)
//   --out <dir>         output dir (default: ./out)
//   --code              301 (permanent, default) or 302
//   --force             overwrite existing files in <out> (default: refuse)
//
// Only generates config text on disk. Applies nothing.
//
// Both sides of every pair are normalized before they are emitted. The paths
// come from an inventory of a crawled site or a user-supplied CSV, and the
// output is pasted verbatim into a Caddyfile / nginx conf / `_redirects`, so a
// path carrying a newline, a brace, or a host of its own is dropped rather than
// written — a crawled page must not be able to inject a config directive.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, writeOut, toPathKey, safeRedirectPath, safeRedirectTarget } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = args.out || 'out';
const format = (args.format || 'all').toLowerCase();
const code = String(args.code || 301);
const force = !!args.force;
const dropped = [];

/** Keep a pair only if both sides normalize to something safe to emit. */
function clean(from, to) {
  const f = safeRedirectPath(from);
  const t = safeRedirectTarget(to);
  if (!f || !t) {
    dropped.push(`${JSON.stringify(String(from))} -> ${JSON.stringify(String(to))}`);
    return null;
  }
  return [f, t];
}

function dedupe(pairs) {
  const seen = new Set();
  const out = [];
  for (const [f, t] of pairs) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push([f, t]);
  }
  return out;
}

function pairsFromInventory(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = data.pages || data;
  if (!Array.isArray(pages)) throw new Error(`${file}: expected an array of pages`);
  return dedupe(
    pages
      .map((p) => (p && (p.path || (p.url && toPathKey(p.url)))) || '')
      .map((path) => clean(path, path)) // identity: same path on the new host
      .filter(Boolean),
  );
}

function pairsFromMap(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const pairs = [];
  for (const line of lines) {
    const [from, to] = line.split(',').map((s) => s.trim());
    if (!from || !to) continue;
    if (/^old_?path$/i.test(from)) continue; // skip header
    const pair = clean(from, to);
    if (pair) pairs.push(pair);
  }
  return dedupe(pairs);
}

if (!args.inventory && !args.map) {
  console.error('Provide --inventory out/inventory.json or --map mapping.csv');
  process.exit(1);
}

let pairs;
try {
  pairs = args.map ? pairsFromMap(args.map) : pairsFromInventory(args.inventory);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
if (dropped.length) {
  console.error(`Dropped ${dropped.length} unusable pair(s) — a redirect path must be a plain path with no host, whitespace, braces or newlines:`);
  for (const d of dropped.slice(0, 20)) console.error(`  ! ${d}`);
  if (dropped.length > 20) console.error(`  … and ${dropped.length - 20} more`);
}
if (!pairs.length) {
  console.error('No redirect pairs derived. Check the input file.');
  process.exit(1);
}

const nginxCode = code === '302' ? '302' : '301';
const generators = {
  caddy: () =>
    `# Caddy — add inside your site block. ${pairs.length} redirects.\n` +
    pairs.map(([f, t]) => `redir ${f} ${t} ${code === '302' ? '302' : 'permanent'}`).join('\n') +
    '\n',
  nginx: () =>
    `# nginx — add inside your server block. ${pairs.length} redirects.\n` +
    pairs.map(([f, t]) => `location = ${f} { return ${nginxCode} ${t}; }`).join('\n') +
    '\n',
  netlify: () =>
    `# Netlify _redirects — ${pairs.length} rules\n` +
    pairs.map(([f, t]) => `${f} ${t} ${code}!`).join('\n') +
    '\n',
  next: () =>
    'module.exports = {\n  async redirects() {\n    return ' +
    JSON.stringify(
      pairs.map(([f, t]) => ({ source: f, destination: t, permanent: code !== '302' })),
      null,
      6,
    ).replace(/\n/g, '\n    ') +
    ';\n  },\n};\n',
};

const exts = { caddy: 'Caddyfile.redirects', nginx: 'redirects.nginx.conf', netlify: '_redirects', next: 'redirects.next.js' };

const targets = format === 'all' ? Object.keys(generators) : [format];
for (const fmt of targets) {
  if (!generators[fmt]) {
    console.error(`Unknown format: ${fmt}. Use all|caddy|nginx|netlify|next.`);
    process.exit(1);
  }
  try {
    const written = writeOut(join(outDir, exts[fmt]), generators[fmt](), { force });
    console.log(`Wrote ${written} (${pairs.length} redirects)`);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
if (dropped.length) process.exitCode = 2; // non-zero: the input had bad rows
