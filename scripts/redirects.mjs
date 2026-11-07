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
//
// Only generates config text on disk. Applies nothing.

import { readFileSync } from 'node:fs';
import { parseArgs, writeOut, toPathKey } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = args.out || 'out';
const format = (args.format || 'all').toLowerCase();
const code = String(args.code || 301);

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

const pairs = args.map ? pairsFromMap(args.map) : pairsFromInventory(args.inventory);
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
  const path = `${outDir}/${exts[fmt]}`;
  writeOut(path, generators[fmt]());
  console.log(`Wrote ${path} (${pairs.length} redirects)`);
}
