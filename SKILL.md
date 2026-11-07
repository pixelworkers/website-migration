---
name: site-migration
description: >-
  Migrate a website to a new platform, framework, or host without losing
  content, SEO, or uptime. Use when the user wants to move, re-platform, or
  re-host a site — triggers include "migrate my site", "move off
  Wordpress/Wix/Squarespace/Vercel/Netlify", "re-platform to Next.js",
  "self-host this site", "port this site to a new stack", "move to a new
  server", "migrate without losing SEO", or "cut over to the new site".
  Runs a phased, verify-before-cutover workflow with read-only audit scripts.
license: MIT
---

# Site migration

Move a website from where it is to where it should be — a new framework, a new
host, a new CMS — while keeping every URL, every byte of content, and its search
ranking intact, and without any downtime.

Most migrations fail in one of three ways: pages silently disappear, old links
start 404ing (destroying SEO), or the team cuts over DNS before the new site is
actually ready. This skill exists to make those failures impossible to reach by
accident. It is built on one rule:

> **The old site stays live and untouched until the new site has been proven,
> URL for URL, to be at least as good. DNS is the last step, never the first.**

## When to use this

- Re-platforming (WordPress → Next.js, Wix/Squarespace → static, etc.)
- Re-hosting (managed platform → your own server, or server → server)
- Framework upgrades that change URLs or routing
- Consolidating several sites, or splitting one apart
- Any move where losing a URL, content, or ranking would hurt

If the user just wants a brand-new site with no predecessor, this is overkill —
build it directly. This skill earns its weight only when there is an existing
site whose value must be preserved.

## Safety doctrine — read before doing anything

These are hard constraints. Do not relax them without the user explicitly
saying so in the same session.

1. **Never touch the live site.** All audit scripts here are read-only (GET
   only). Do not log into, edit, or run destructive commands against the source
   site or its database. If you need a copy, export/snapshot — never mutate the
   original.
2. **Snapshot before you migrate.** Confirm a full backup of the source exists
   (files + database + DNS records as they stand today) before any content
   move. Write down the current DNS records so a rollback is a copy-paste away.
3. **Stand the new site up on a temporary URL.** A staging subdomain or preview
   URL. The new site must be fully testable without any DNS change.
4. **Prove parity before cutover.** Every URL the old site answered, the new one
   must answer — with equivalent content — or carry an intentional 301. Run
   `parity.mjs` and resolve every problem it reports. A non-empty problem list
   means not ready.
5. **A redirect map is mandatory**, not optional, whenever any URL changes.
   Generate it with `redirects.mjs` and load it into the new stack *before*
   cutover.
6. **Cutover is reversible.** Lower DNS TTL ahead of time (e.g. to 300s), keep
   the old host running for at least 48–72h after cutover, and know the exact
   steps to point DNS back.
7. **Confirm before irreversible steps.** Changing DNS, cancelling the old host,
   deleting source data — each one stops and asks the user, every time, even if
   an earlier step was approved.

## The workflow

Work the phases in order. Do not skip ahead to cutover.

### 1. Discover

Understand what you are moving and where it is going.

- What is the source stack (CMS/framework/host) and the target stack?
- What must be preserved: URLs? exact content? forms? redirects? analytics?
  integrations (payments, email, search)?
- Where will the new site live, and on what temporary URL will it be staged?
- What is the rollback plan and who signs off on cutover?

Capture the answers; they define "done" for every later phase.

### 2. Inventory the source

Build a complete, factual picture of the existing site — never guess at its
shape.

```bash
node scripts/inventory.mjs https://oldsite.com --out out
# no sitemap? crawl the links instead:
node scripts/inventory.mjs https://oldsite.com --crawl --max 1000 --out out
```

Produces `out/inventory.json` and `out/inventory.csv`: every URL with its
status, title, meta description, H1, canonical, and word count. This is your
source of truth and the input to parity and redirect generation. Also inventory
by hand what the crawler can't see: gated pages, forms, feeds, assets,
third-party embeds.

### 3. Plan the move

- Map old URLs → new URLs. If the structure is identical, you want identity
  redirects (handled for you). If it changes, produce a `mapping.csv` of
  `old_path,new_path`.
- Decide content migration method: export/import, scripted port, or manual.
- List integrations to re-wire (analytics IDs, form endpoints, payment keys,
  search, CDN) and schema/metadata to carry over.
- Define the parity bar: status match, title/H1 present, content not gutted.

### 4. Rebuild on staging

Build the new site on its temporary URL. Carry over content, templates,
metadata (titles, descriptions, canonical, Open Graph), and structured data.
Re-point integrations at test/staging credentials where possible. Nothing here
touches the live site.

### 5. Verify parity (the gate)

This is the step that separates a safe migration from a disaster.

```bash
node scripts/parity.mjs https://oldsite.com https://staging.newsite.com \
  --inventory out/inventory.json --out out
```

Reads `out/parity-report.md`. It lists every path that is missing, errors,
changed title, or lost significant content on the new site. **Resolve every row
— either fix the new site or record an intentional 301 — before continuing.**
The script exits non-zero while problems remain, so it can gate a pipeline.

Then check links on the rebuild:

```bash
node scripts/linkcheck.mjs https://staging.newsite.com --out out
```

Fix every broken internal link in `out/link-report.md`.

### 6. Generate the redirect map

```bash
# identity moves (same paths on the new host):
node scripts/redirects.mjs --inventory out/inventory.json --out out --format all
# changed URLs:
node scripts/redirects.mjs --map mapping.csv --out out --format caddy
```

Emits ready-to-paste 301 configs for Caddy, nginx, Netlify, and Next.js. Load
the right one into the new stack and confirm redirects resolve on staging before
cutover.

### 7. Pre-cutover checklist

Do not proceed until all are true:

- [ ] Full source backup exists (files + DB + current DNS records written down)
- [ ] `parity.mjs` reports zero unresolved problems
- [ ] `linkcheck.mjs` reports zero broken internal links
- [ ] Redirect map loaded into the new stack and spot-checked on staging
- [ ] Analytics/search console/forms/integrations verified on staging
- [ ] SSL ready for the real domain on the new host
- [ ] DNS TTL lowered (e.g. 300s) in advance
- [ ] Old host will stay running 48–72h post-cutover
- [ ] Rollback steps written down; user has approved cutover

### 8. Cutover

**Stop and get explicit confirmation from the user before this step.** Then
point DNS at the new host. Immediately verify the live domain:

```bash
node scripts/linkcheck.mjs https://realdomain.com --out out-prod
node scripts/parity.mjs https://oldsite.com https://realdomain.com \
  --inventory out/inventory.json --out out-prod
```

(Compare against the old host by IP/temporary URL if DNS has already moved.)

### 9. Post-cutover

- Submit the new sitemap to Google Search Console; watch coverage + 404s for
  1–2 weeks.
- Monitor the live site (errors, Core Web Vitals, form submissions).
- Keep the old host and the rollback path available through the monitoring
  window.
- Only after the window is clean and the user approves: decommission the old
  host.

## Scripts

All scripts are dependency-free Node (18+; built-in `fetch`) and strictly
read-only over HTTP. They write reports to `--out` (default `./out`).

| Script | Purpose |
| --- | --- |
| `scripts/inventory.mjs` | Crawl the source (sitemap or link crawl) → full URL inventory (JSON + CSV). |
| `scripts/parity.mjs` | Compare old vs new URL-by-URL; flag missing/changed/gutted pages. The cutover gate. |
| `scripts/redirects.mjs` | Generate 301 redirect configs (Caddy / nginx / Netlify / Next.js). |
| `scripts/linkcheck.mjs` | Crawl a site and report broken internal/external links. |

Run any with no args to see usage. See `README.md` for a full worked example.
