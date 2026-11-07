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
//   --force             overwrite existing files in <out>
//
// Only generates config text on disk. Applies nothing.
//
// The paths here come from a JSON/CSV file, so they are untrusted text that is
// about to become webserver configuration. Every pair is validated before it is
// emitted: each side must be a path that stays on its own origin, and must
// contain none of the characters that would end a directive and start a new one
// in a Caddyfile, an nginx server block, or a _redirects file.

import { readFileSync } from 'node:fs';
import { parseArgs, writeOut, toPathKey, urlOnOrigin, applyCommonArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { force } = applyCommonArgs(args, { log: (m) => console.log(m) });
const outDir = args.out || 'out';
const format = (args.format || 'all').toLowerCase();
const code = String(args.code || 301);

// Anything that could terminate a directive, open a block, start a comment, or
// break the line. Rejected rather than escaped: a redirect path has no business
// containing these, and silently mangling one would be worse than skipping it.
const CONFIG_METACHARS = /[\s{};#'"`\\$]/;

/** True when `p` is safe to emit into a generated config file. */
function validPath(p) {
  if (typeof p !== 'string' || !p.length) return false;
  if (p.length > 2048) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  if (CONFIG_METACHARS.test(p)) return false;
  try {
    urlOnOrigin('https://redirect-map.invalid', p);
  } catch {
    return false;
  }
  return true;
}

const skipped = [];

/** Keep only pairs where BOTH sides are safe; record the rest. */
function validate(pairs) {
  const good = [];
  for (const [from, to] of pairs) {
    if (!validPath(from) || !validPath(to)) {
      skipped.push([from, to]);
      continue;
    }
    good.push([from, to]);
  }
  return good;
}

function pairsFromInventory(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = data.pages || data;
  return pages
    .map((p) => p.path || toPathKey(p.url))
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((path) => [path, path]); // identity: same path on the new host
}

function pairsFromMap(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const pairs = [];
  for (const line of lines) {
    const [from, to] = line.split(',').map((s) => s.trim());
    if (!from || !to) continue;
    if (/^old_?path$/i.test(from)) continue; // skip header
    pairs.push([from, to]);
  }
  return pairs;
}

if (!args.inventory && !args.map) {
  console.error('Provide --inventory out/inventory.json or --map mapping.csv');
  process.exit(1);
}

const pairs = validate(args.map ? pairsFromMap(args.map) : pairsFromInventory(args.inventory));
if (skipped.length) {
  console.warn(`Skipped ${skipped.length} unsafe redirect pair(s) — a path must be an origin-relative`);
  console.warn('path with no whitespace, quotes, braces, semicolons, backslashes, "#" or "$":');
  for (const [f, t] of skipped.slice(0, 10)) console.warn(`  ${JSON.stringify(f)} -> ${JSON.stringify(t)}`);
}
if (!pairs.length) {
  console.error('No usable redirect pairs derived. Check the input file.');
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
  const path = `${outDir}/${exts[fmt]}`;
  writeOut(path, generators[fmt](), { force });
  console.log(`Wrote ${path} (${pairs.length} redirects${skipped.length ? `, ${skipped.length} skipped` : ''})`);
}
