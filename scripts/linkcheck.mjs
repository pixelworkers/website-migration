#!/usr/bin/env node
// linkcheck.mjs — crawl a site and report broken links (internal and external).
//
// Run this against the REBUILD before cutover to catch dead links introduced by
// the migration, then again against production after cutover as a smoke test.
//
// Usage:
//   node scripts/linkcheck.mjs <baseUrl> [--out out] [--max 500] [--max-depth 10] [--concurrency 8] [--external]
//
//   <baseUrl>          site to crawl, e.g. https://staging.newsite.com
//   --max <n>          max pages to crawl (default 500, hard ceiling 5000)
//   --max-depth <n>    max link depth from the start URL (default 10)
//   --concurrency <n>  default 8
//   --external         also check off-site links (slower; default: internal only)
//   --out <dir>        output dir (default ./out)
//   --force            overwrite existing files in <out> (default: refuse)
//
// Writes:
//   <out>/link-report.json
//   <out>/link-report.md
//
// Read-only over HTTP.
//
// Links are harvested from fetched HTML, i.e. they are remote data. Every one
// goes through lib.mjs's remote-URL gate before it is requested, so an
// `<a href>` on a crawled page cannot make this machine fetch an internal
// address or a cloud metadata endpoint — including with `--external`, where
// off-site hosts are allowed but private ones still are not.

import { parseArgs, crawl, fetchText, pool, writeOut, sameOrigin, remoteUrlAllowed } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const base = args._[0];
if (!base) {
  console.error('Usage: node scripts/linkcheck.mjs <baseUrl> [--max 500] [--max-depth 10] [--external] [--force]');
  process.exit(1);
}
try {
  const u = new URL(base);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
} catch {
  console.error(`Not an http(s) URL: ${base}`);
  process.exit(1);
}
const outDir = args.out || 'out';
const force = !!args.force;
const max = Number(args.max || 500);
const maxDepth = Number(args['max-depth'] || 10);
const concurrency = Number(args.concurrency || 8);
const checkExternal = !!args.external;

// link (absolute) -> Set of pages that reference it
const refs = new Map();
// links we refused to request, and why — reported, never fetched
const refusedLinks = new Map();

async function main() {
  console.log(`Crawling ${base} (max ${max} pages)…`);
  const visited = await crawl(base, {
    max,
    maxDepth,
    concurrency,
    log: (m) => console.log(m),
    onPage: ({ url, extracted }) => {
      for (const link of extracted.links || []) {
        if (!checkExternal && !sameOrigin(link, base)) continue;
        // `--external` widens the origin rule, never the private-network one.
        if (!remoteUrlAllowed(link, base, { sameOriginOnly: !checkExternal })) {
          if (!refusedLinks.has(link)) refusedLinks.set(link, new Set());
          refusedLinks.get(link).add(url);
          continue;
        }
        if (!refs.has(link)) refs.set(link, new Set());
        refs.get(link).add(url);
      }
    },
  });

  const links = [...refs.keys()];
  console.log(`Checking ${links.length} unique links from ${visited.length} pages…`);

  const checked = await pool(links, concurrency, async (link) => {
    let res = await fetchText(link, { method: 'HEAD', timeout: 12000 });
    // Some servers reject HEAD — retry with GET before calling it broken.
    if (res.status === 405 || res.status === 501 || res.status === 0) {
      res = await fetchText(link, { method: 'GET', timeout: 15000 });
    }
    return {
      link,
      status: res.status,
      ok: res.ok,
      error: res.error,
      // A 3xx pointing at another host is reported, not followed (SSRF guard).
      blockedRedirect: res.blockedRedirect || null,
      internal: sameOrigin(link, base),
      referencedBy: [...refs.get(link)].slice(0, 10),
      refCount: refs.get(link).size,
    };
  });

  const broken = checked.filter((c) => !c.ok).sort((a, b) => b.refCount - a.refCount);
  const offHost = checked.filter((c) => c.blockedRedirect);
  const refused = [...refusedLinks.entries()].map(([link, pages]) => ({
    link,
    referencedBy: [...pages].slice(0, 10),
    refCount: pages.size,
  }));
  const summary = {
    base,
    generatedAt: new Date().toISOString(),
    pagesCrawled: visited.length,
    linksChecked: checked.length,
    broken: broken.length,
    brokenInternal: broken.filter((b) => b.internal).length,
    offHostRedirects: offHost.length,
    refusedLinks: refused.length,
  };

  writeOut(
    `${outDir}/link-report.json`,
    JSON.stringify({ summary, broken, offHostRedirects: offHost, refusedLinks: refused }, null, 2),
    { force },
  );

  const md = [];
  md.push('# Link report');
  md.push('');
  md.push(`- Site: \`${base}\``);
  md.push(`- Generated: ${summary.generatedAt}`);
  md.push(`- Pages crawled: ${summary.pagesCrawled}`);
  md.push(`- Links checked: ${summary.linksChecked}${checkExternal ? ' (incl. external)' : ' (internal only)'}`);
  md.push('');
  if (broken.length) {
    md.push(`## Broken links (${broken.length}, ${summary.brokenInternal} internal)`);
    md.push('');
    md.push('| Link | Status | Refs | First referenced by |');
    md.push('| --- | --- | --- | --- |');
    for (const b of broken) {
      md.push(`| \`${b.link}\` | ${b.status || b.error || 'err'} | ${b.refCount} | \`${b.referencedBy[0] || ''}\` |`);
    }
  } else {
    md.push('## No broken links found.');
  }
  md.push('');
  if (offHost.length) {
    md.push(`## Redirects to another host (${offHost.length}, not followed)`);
    md.push('');
    md.push('These returned a 3xx pointing off the host being checked. They are');
    md.push('reported rather than followed; confirm each target is intended.');
    md.push('');
    md.push('| Link | Status | Redirects to |');
    md.push('| --- | --- | --- |');
    for (const o of offHost) md.push(`| \`${o.link}\` | ${o.status} | \`${o.blockedRedirect}\` |`);
    md.push('');
  }
  if (refused.length) {
    md.push(`## Links not requested (${refused.length})`);
    md.push('');
    md.push('These point at a private, loopback, link-local or cloud-metadata');
    md.push('address. They are reported rather than fetched — a link on a crawled');
    md.push('page must not be able to make the auditing machine probe its own');
    md.push('network. Check whether the site should be linking there at all.');
    md.push('');
    md.push('| Link | Refs | First referenced by |');
    md.push('| --- | --- | --- |');
    for (const r of refused) md.push(`| \`${r.link}\` | ${r.refCount} | \`${r.referencedBy[0] || ''}\` |`);
    md.push('');
  }
  writeOut(`${outDir}/link-report.md`, md.join('\n'), { force });

  console.log('');
  console.log(`${broken.length} broken (${summary.brokenInternal} internal) of ${checked.length} links.`);
  console.log(`Wrote ${outDir}/link-report.json and ${outDir}/link-report.md`);
  if (summary.brokenInternal > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
