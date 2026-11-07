#!/usr/bin/env node
// parity.mjs — compare an old site against its rebuilt counterpart, page by page.
//
// The single most important pre-cutover gate: prove the new site answers every
// URL the old one did, with equivalent content, BEFORE you touch DNS.
//
// Usage:
//   node scripts/parity.mjs <oldBase> <newBase> [--inventory out/inventory.json] [--out out]
//
//   <oldBase>              e.g. https://oldsite.com (the live site today)
//   <newBase>             e.g. https://staging.newsite.com (the rebuild)
//   --inventory <file>    inventory.json from inventory.mjs (preferred source of paths)
//   --out <dir>           output dir (default: ./out)
//   --concurrency <n>     default 6
//   --word-drop <pct>     flag pages whose word count fell by more than pct (default 40)
//
// If --inventory is omitted, the old site's sitemap is used to derive paths.
//
// Writes:
//   <out>/parity-report.json
//   <out>/parity-report.md    human-readable, problems first
//
// Read-only over HTTP against both sites.

import { readFileSync } from 'node:fs';
import { parseArgs, getSitemapUrls, fetchText, extract, pool, writeOut, toPathKey } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const oldBase = args._[0];
const newBase = args._[1];
if (!oldBase || !newBase) {
  console.error('Usage: node scripts/parity.mjs <oldBase> <newBase> [--inventory out/inventory.json] [--out out]');
  process.exit(1);
}
const outDir = args.out || 'out';
const concurrency = Number(args.concurrency || 6);
const wordDropPct = Number(args['word-drop'] || 40);
const oldOrigin = new URL(oldBase).origin;
const newOrigin = new URL(newBase).origin;

async function paths() {
  if (args.inventory) {
    const data = JSON.parse(readFileSync(args.inventory, 'utf8'));
    const pages = data.pages || data;
    return [...new Set(pages.map((p) => p.path || toPathKey(p.url)))];
  }
  console.log('No --inventory; reading old site sitemap…');
  const urls = await getSitemapUrls(oldBase, { log: (m) => console.log(m) });
  if (!urls.length) {
    console.error('No inventory and no sitemap found. Run inventory.mjs on the old site first.');
    process.exit(1);
  }
  return [...new Set(urls.map(toPathKey))];
}

function page(res, ex) {
  return {
    status: res.status,
    finalUrl: res.finalUrl,
    // Set when the page 3xx'd to a different host; that redirect is reported,
    // not followed, so there is no content to compare.
    blockedRedirect: res.blockedRedirect || null,
    title: ex.title || '',
    h1: ex.h1 || '',
    canonical: ex.canonical || '',
    wordCount: ex.wordCount || 0,
    error: res.error,
  };
}

async function main() {
  const list = await paths();
  console.log(`Comparing ${list.length} paths: ${oldOrigin} → ${newOrigin}`);

  const rows = await pool(list, concurrency, async (path) => {
    const oldUrl = oldOrigin + path;
    const newUrl = newOrigin + path;
    const [o, n] = await Promise.all([fetchText(oldUrl), fetchText(newUrl)]);
    const oldP = page(o, o.text ? extract(o.text, oldUrl) : {});
    const newP = page(n, n.text ? extract(n.text, newUrl) : {});

    const issues = [];
    if (newP.status >= 400 || newP.status === 0) issues.push(`MISSING on new (status ${newP.status || 'error'})`);
    else if (oldP.status < 400 && newP.status !== oldP.status && !(oldP.status < 400 && newP.status < 400))
      issues.push(`status ${oldP.status} → ${newP.status}`);
    if (newP.blockedRedirect) issues.push(`new redirects off-host → ${newP.blockedRedirect}`);
    if (oldP.blockedRedirect) issues.push(`old redirects off-host → ${oldP.blockedRedirect}`);
    if (oldP.status < 300 && newP.status < 300) {
      if (oldP.title && newP.title && oldP.title !== newP.title) issues.push('title changed');
      if (oldP.title && !newP.title) issues.push('title missing on new');
      if (
        oldP.wordCount > 50 &&
        newP.wordCount < oldP.wordCount * (1 - wordDropPct / 100)
      )
        issues.push(`content dropped ${Math.round((1 - newP.wordCount / oldP.wordCount) * 100)}%`);
      if (newP.canonical && !newP.canonical.includes(new URL(newUrl).host) && !newP.canonical.includes(new URL(oldUrl).host))
        issues.push('canonical points off-site');
    }

    return { path, old: oldP, new: newP, issues, ok: issues.length === 0 };
  });

  const problems = rows.filter((r) => !r.ok);
  const summary = {
    oldBase,
    newBase,
    generatedAt: new Date().toISOString(),
    total: rows.length,
    passing: rows.length - problems.length,
    problems: problems.length,
    missing: rows.filter((r) => r.new.status >= 400 || r.new.status === 0).length,
  };

  writeOut(`${outDir}/parity-report.json`, JSON.stringify({ summary, rows }, null, 2));

  const md = [];
  md.push(`# Parity report`);
  md.push('');
  md.push(`- Old: \`${oldBase}\``);
  md.push(`- New: \`${newBase}\``);
  md.push(`- Generated: ${summary.generatedAt}`);
  md.push('');
  md.push(`**${summary.passing}/${summary.total} paths pass.** ${summary.problems} with issues, ${summary.missing} missing on the new site.`);
  md.push('');
  if (problems.length) {
    md.push(`## Problems (${problems.length})`);
    md.push('');
    md.push('| Path | Old | New | Issues |');
    md.push('| --- | --- | --- | --- |');
    for (const r of problems) {
      md.push(`| \`${r.path}\` | ${r.old.status} | ${r.new.status || r.new.error || 'err'} | ${r.issues.join('; ')} |`);
    }
    md.push('');
    md.push('> Resolve every row here — or add an intentional 301 to the redirect map — before cutover.');
  } else {
    md.push('## No problems found.');
    md.push('');
    md.push('Every inventoried path resolves on the new site with equivalent content. Safe to proceed to redirect-map review and cutover checks.');
  }
  md.push('');
  writeOut(`${outDir}/parity-report.md`, md.join('\n'));

  console.log('');
  console.log(`${summary.passing}/${summary.total} pass. ${summary.problems} problems, ${summary.missing} missing.`);
  console.log(`Wrote ${outDir}/parity-report.json and ${outDir}/parity-report.md`);
  if (problems.length) process.exitCode = 2; // non-zero = not cutover-ready
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
