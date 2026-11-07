#!/usr/bin/env node
// inventory.mjs — build a complete, read-only inventory of a live site.
//
// Usage:
//   node scripts/inventory.mjs <baseUrl> [--out out] [--max 500] [--max-depth 10] [--concurrency 6] [--crawl]
//
//   <baseUrl>        e.g. https://oldsite.com
//   --out <dir>      output directory (default: ./out)
//   --max <n>        max pages to inventory (default: 500, hard ceiling 5000)
//   --max-depth <n>  max link depth when crawling (default: 10)
//   --concurrency    parallel requests (default: 6)
//   --crawl          force a link crawl even if a sitemap exists
//   --delay <ms>     politeness delay between requests (default: 0)
//   --force          overwrite existing files in <out> (default: refuse)
//
// Writes:
//   <out>/inventory.json   full per-URL records
//   <out>/inventory.csv    spreadsheet-friendly summary
//
// This script only issues GET requests. It never writes to the target site.
//
// Every URL fetched is either the one you passed on the command line or one
// that stayed on its origin: sitemap entries and crawled links are filtered by
// lib.mjs before any request, so a hostile sitemap cannot point the crawler at
// an internal address or a cloud metadata endpoint.

import {
  parseArgs,
  getSitemapUrls,
  crawl,
  fetchText,
  extract,
  pool,
  writeOut,
  toPathKey,
  filterRemoteUrls,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const base = args._[0];
if (!base) {
  console.error('Usage: node scripts/inventory.mjs <baseUrl> [--out out] [--max 500] [--max-depth 10] [--crawl] [--force]');
  process.exit(1);
}
let origin;
try {
  const u = new URL(base);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
  origin = u.origin;
} catch {
  console.error(`Not an http(s) URL: ${base}`);
  process.exit(1);
}
const outDir = args.out || 'out';
const force = !!args.force;
const max = Number(args.max || 500);
const maxDepth = Number(args['max-depth'] || 10);
const concurrency = Number(args.concurrency || 6);
const delayMs = Number(args.delay || 0);

function csvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

const records = [];

async function main() {
  console.log(`Inventorying ${base}`);
  let urls = [];

  if (!args.crawl) {
    console.log('Looking for sitemap…');
    const refused = [];
    urls = await getSitemapUrls(base, { log: (m) => console.log(m), refused });
    if (refused.length) {
      console.log(`Refused ${refused.length} sitemap entries that left ${origin} (not fetched):`);
      for (const r of refused.slice(0, 20)) console.log(`  ! ${r}`);
      if (refused.length > 20) console.log(`  … and ${refused.length - 20} more`);
    }
    if (urls.length) console.log(`Sitemap found: ${urls.length} URLs`);
  }

  if (!urls.length) {
    console.log('No sitemap (or --crawl set). Crawling links…');
    await crawl(base, {
      max,
      maxDepth,
      concurrency,
      delayMs,
      log: (m) => console.log(m),
      onPage: ({ url, result, extracted }) => {
        records.push(toRecord(url, result, extracted));
      },
    });
  } else {
    // Belt and braces: getSitemapUrls already dropped off-origin entries.
    urls = filterRemoteUrls(urls, origin).allowed.slice(0, max);
    await pool(urls, concurrency, async (url) => {
      const res = await fetchText(url);
      const extracted = res.text ? extract(res.text, url) : {};
      records.push(toRecord(url, res, extracted));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    });
  }

  records.sort((a, b) => a.url.localeCompare(b.url));

  const summary = {
    base,
    generatedAt: new Date().toISOString(),
    totalPages: records.length,
    source: urls.length ? 'sitemap' : 'crawl',
    statusCounts: countBy(records, (r) => String(r.status)),
    redirects: records.filter((r) => r.redirected).length,
    errors: records.filter((r) => r.error).length,
  };

  writeOut(`${outDir}/inventory.json`, JSON.stringify({ summary, pages: records }, null, 2), { force });

  const header = ['url', 'path', 'status', 'redirectedTo', 'title', 'metaDescription', 'h1', 'canonical', 'wordCount', 'ms', 'error'];
  const csv = [header.join(',')]
    .concat(
      records.map((r) =>
        [r.url, r.path, r.status, r.redirected ? r.finalUrl : '', r.title, r.metaDescription, r.h1, r.canonical, r.wordCount, r.ms, r.error || '']
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\n');
  writeOut(`${outDir}/inventory.csv`, csv, { force });

  console.log('');
  console.log(`Done. ${records.length} pages.`);
  console.log(`  status: ${JSON.stringify(summary.statusCounts)}`);
  console.log(`  redirects: ${summary.redirects}, errors: ${summary.errors}`);
  console.log(`  wrote ${outDir}/inventory.json and ${outDir}/inventory.csv`);
}

function toRecord(url, res, ex) {
  return {
    url,
    path: toPathKey(url),
    status: res.status,
    finalUrl: res.finalUrl,
    redirected: res.redirected,
    contentType: res.contentType,
    title: ex.title || '',
    metaDescription: ex.metaDescription || '',
    h1: ex.h1 || '',
    canonical: ex.canonical || '',
    wordCount: ex.wordCount || 0,
    bytes: res.bytes,
    ms: res.ms,
    error: res.error,
  };
}

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) {
    const k = fn(x);
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
