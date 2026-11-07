---
name: site-migration
description: >-
  Migrate a website to a new platform, framework, domain, or host without
  losing content, SEO, or uptime. Any source and any target — WordPress,
  Squarespace, Wix, Webflow, Shopify, a hand-rolled PHP or Node app, or plain
  static files — into Next.js, a static generator, another CMS, or your own
  server. Export the old content, rebuild, prove URL-for-URL parity, generate
  the 301 map; or back up, dump the database, rsync, rewrite URLs and cut DNS
  over with a rollback plan. Use when the user wants to move, re-platform,
  re-host or re-domain a site — triggers include "migrate my site", "move off
  WordPress/Wix/Squarespace/Webflow/Shopify/Vercel/Netlify", "re-platform to
  Next.js", "self-host this site", "port this site to a new stack", "move to a
  new server", "switch hosting", "cPanel to VPS", "transfer WordPress", "change
  the domain", "migrate without losing SEO", or "cut over to the new site".
license: MIT
---

# Site migration

Move a website from where it is to where it should be — a new framework, a new
host, a new domain — while keeping every URL, every byte of content, and its
search ranking intact, and without downtime.

Most migrations fail in one of three ways: pages silently disappear, old links
start 404ing (destroying SEO), or someone cuts DNS over before the new site is
actually ready. This skill exists to make those failures hard to reach by
accident. It is built on one rule:

> **The old site stays live and untouched until the new site has been proven,
> URL for URL, to be at least as good. DNS is the last step, never the first.**

## When to use this

- **Re-platforming** — WordPress → Next.js, Squarespace/Wix/Webflow → static or
  a framework, Shopify content → your own stack, one CMS → another, a
  hand-rolled site → something maintainable.
- **Re-hosting** — managed platform → your own server, or server → server
  (cPanel → VPS, one VPS → another, on-prem → cloud).
- **Re-domaining** — the same site answering on a new hostname.
- Framework or major-version upgrades that change URLs or routing.
- Consolidating several sites into one, or splitting one apart.
- Any move where losing a URL, a page, or a search ranking would hurt.

## Two paths — pick one, or run both

| | **A. Platform / domain change** | **B. Host-to-host move** |
|---|---|---|
| **The job** | The site is being rebuilt, re-platformed, or re-domained. | The same site moves to a new box. |
| **Typical shape** | Squarespace/Wix/Webflow/Shopify/WordPress → Next.js, a static generator, another CMS. Or the same stack on a new domain. | WordPress, PHP app, Node app or static files → a new server. |
| **Access needed** | HTTP only (plus whatever export the source offers). | Shell + usually SSH to both hosts, DB credentials. |
| **Tooling** | `scripts/*.mjs` — read-only crawlers (Node 18+). | `scripts/*.sh` — dry-run-first shell helpers (bash). |
| **Gate** | `parity.mjs` reports zero problems. | `verify.sh` passes against the new host by IP. |
| **Go to** | [Path A](#path-a--platform-or-domain-change) | [Path B](#path-b--host-to-host-move) |

They compose. A WordPress site moving to a new host **and** a new domain runs
Path B for the move and Path A's `inventory.mjs` / `parity.mjs` /
`redirects.mjs` as the pre-cutover gate. When in doubt, inventory first: it is
read-only and it tells you what you are actually dealing with.

If the user just wants a brand-new site with no predecessor, this is overkill —
build it directly. This skill earns its weight only when there is an existing
site whose value must be preserved.

### Where the site is now — jump to the right recipe

The phases are the same for every source. What differs is how you get the
content out and what breaks on the way. Pick the row that matches:

| Source | Path | Content comes out via | Recipe |
|---|---|---|---|
| WordPress → new host, same stack | B | `mysqldump` + `rsync` | [B — host-to-host](#path-b--host-to-host-move) (most common case, fully scripted) |
| WordPress → Next.js / static / another CMS | A | WXR export + REST API + `wp-content/uploads` | [A3 · WordPress](#from-wordpress) |
| Squarespace → anything | A | WXR export + `?format=json` + Commerce CSV | [A3 · Squarespace](#from-squarespace) |
| Wix → anything | A | Blog export + CMS/Store CSVs + crawl | [A3 · Wix](#from-wix) |
| Webflow → anything | A | Code export (ZIP) + per-collection CSV | [A3 · Webflow](#from-webflow) |
| Shopify content/blog → anything | A | Admin API / `.atom` / `products.json` | [A3 · Shopify](#from-shopify) |
| Static HTML, Jekyll/Hugo, hand-rolled | A or B | the files themselves | [A3 · static](#from-a-static-or-hand-rolled-site) |
| PHP app (Laravel, Drupal, Joomla, custom) → new host | B | dump + `rsync` + config rewrite | [B5 · generic PHP](#b5c-generic-php-app-laravel-drupal-joomla-custom) |
| Node app → new host | B | repo + build + process manager | [B5 · Node](#b5d-node-app) |
| Anything else with no export | A | the crawler — `inventory.mjs` is always available | [A3 · no export](#when-there-is-no-export-at-all) |

A re-platform that also changes host runs A for the content and the parity gate,
and borrows B's steps for standing the new box up.

## Safety doctrine — read before doing anything

Hard constraints. Do not relax them without the user explicitly saying so in the
same session.

1. **Never mutate the source.** Every audit script is read-only (GET/HEAD). The
   shell helpers only ever read the old host. It stays live and serving traffic
   until the new one passes verification.
2. **Back up before any change,** and prove the backup restores before trusting
   it. A backup you have not restored is a guess.
3. **Dry-run first.** `backup.sh`, `transfer.sh`, `wp-search-replace.sh` and
   `fix-perms.sh` preview by default and only write when given `--go`. Without
   `--go` they create nothing — **if a script did not run, do not tell the user
   it did.**
4. **Stand the new site up on a temporary URL or test it by IP.** The new site
   must be fully testable without any DNS change.
5. **Prove parity before cutover.** Every URL the old site answered, the new one
   must answer — with equivalent content — or carry an intentional 301. A
   non-empty problem list means not ready.
6. **A redirect map is mandatory**, not optional, whenever any URL changes.
   Generate it and load it into the new stack *before* cutover.
7. **Cutover is reversible.** Lower DNS TTL ahead of time (300s), keep the old
   host running 48–72h after cutover, and write the rollback steps down first.
8. **Confirm before irreversible steps.** Changing DNS, cancelling the old host,
   deleting source data — each one stops and asks the user, every time, even if
   an earlier step was approved.
9. **Secrets stay out of the repo, out of logs, and out of `ps`.** Read DB
   credentials from environment variables or prompts. Never paste them into
   chat, commit them, or echo them, and never put a password on a command line
   (local or remote) — `db-dump.sh` already handles this correctly; don't
   hand-roll a `mysqldump` call around it.
10. **Never build a shell command by pasting a value into a string.** Every
    script takes its values as arguments. If you need a one-off command, use the
    same discipline: argv, not string concatenation. A client's path or URL may
    legitimately contain a quote.

If the user asks you to flip DNS or delete the source *before* verification has
passed, stop and say why. Confirm the checks passed, in writing, first.

## The scripts

### Read-only audit (Node 18+, no dependencies)

| Script | Purpose |
| --- | --- |
| `scripts/inventory.mjs` | Crawl the source (sitemap or link crawl) → full URL inventory (JSON + CSV). |
| `scripts/parity.mjs` | Compare old vs new URL-by-URL; flag missing/changed/gutted pages. The cutover gate. |
| `scripts/redirects.mjs` | Generate 301 redirect configs (Caddy / nginx / Netlify / Next.js). |
| `scripts/linkcheck.mjs` | Crawl a site and report broken internal/external links. |
| `scripts/lib.mjs`, `scripts/guard.mjs` | Shared HTTP/HTML helpers and the network trust boundary. |

`parity.mjs` and `linkcheck.mjs` exit non-zero while problems remain, so they can
gate a CI pipeline or a cutover script.

**These scripts follow URLs the audited site supplies** — sitemap entries,
`<a href>` targets, `Location:` headers — so they treat the target as hostile:

- Only `http:` and `https:` are ever fetched.
- Private, loopback, link-local, CGNAT and cloud-metadata destinations are
  refused, including after a redirect and including hostnames that *resolve* to
  one. A sitemap index pointing at `http://169.254.169.254/` gets skipped, not
  fetched.
- Child sitemaps and sitemap URLs are restricted to the target's own origin and
  capped in number.
- Response bodies are capped at 5 MB and parsing is linear-time, so a
  deliberately malformed page cannot stall the run.
- Reports are written inside the working directory only, and an existing file is
  never overwritten without `--force`.

If the new site really is on loopback or a private address — a staging build on
`127.0.0.1:3000`, a new box reachable only by LAN IP — name it explicitly:

```bash
node scripts/parity.mjs https://oldsite.com http://127.0.0.1:3000 \
  --inventory out/inventory.json --allow-host 127.0.0.1:3000 --out out
```

`--allow-host` takes `host` or `host:port` (comma-separated for several), and
`SITE_MIGRATION_ALLOW_HOSTS` does the same from the environment. It vouches for
exactly what you name — allowing `127.0.0.1:3000` does not also open
`169.254.169.254`.

### Host-to-host helpers (bash)

All live in `scripts/`, print `--help`, take `--ssh user@host` to operate on a
remote box, and are dry-run-by-default for anything that writes.

| Script | Does | Writes? |
|---|---|---|
| `preflight.sh` | Inventory + sanity report + go/no-go checklist | read-only |
| `backup.sh` | tar.gz of files (+ optional DB dump), integrity-checked | read-only on source; writes the archive on `--go` |
| `db-dump.sh` | `mysqldump` wrapper (consistent snapshot, creds from env) | read-only on DB |
| `transfer.sh` | `rsync` wrapper, dry-run until `--go`, refuses `--delete` unless confirmed | writes to destination |
| `wp-search-replace.sh` | Serialized-safe URL rewrite via `wp search-replace` | writes to destination DB (on `--go`) |
| `fix-perms.sh` | Normalize dirs 755 / files 644, tighten wp-config/.env | writes to destination (on `--go`) |
| `verify.sh` | HTTP status sweep old-vs-new + broken-asset check | read-only |

---

## Path A — platform or domain change

Work the phases in order. Do not skip ahead to cutover.

### A1. Discover

- What is the source stack (CMS/framework/host) and the target stack?
- What must be preserved: URLs? exact content? forms? redirects? analytics?
  integrations (payments, email, search)?
- Where will the new site live, and on what temporary URL will it be staged?
- What is the rollback plan and who signs off on cutover?

Capture the answers; they define "done" for every later phase.

### A2. Inventory the source

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

### A3. Export the content from the source platform

Two things come out of every source: the **content** (text, media, metadata,
taxonomy) and the **URL set** (step A2 already has that). Get the content out
before you build anything, so the rebuild is driven by real data rather than by
what you can see on screen.

Rules that apply to every source below:

- **Never trust the platform's export to be complete.** Diff it against
  `out/inventory.csv`. Every URL in the inventory must map to something in the
  export, a planned rebuild-by-hand item, or a deliberate 301. Anything left
  over is content you are about to lose.
- **Media is almost never in the export** — the export references the old CDN.
  Download every asset and re-host it, or the new site breaks the day the old
  account lapses. The inventory's link data plus a crawl of `<img src>` /
  `srcset` gives you the list.
- **Carry the metadata, not just the prose.** Title, meta description, canonical,
  Open Graph, structured data, publish date, author, categories/tags, and the
  slug. Parity checks titles and H1s; search rankings care about the rest.
- **Keep the old slugs where you can.** An identity URL needs no redirect, and
  no redirect is always safer than a correct one.
- **Export before you cancel anything.** Several platforms cut off export the
  moment the plan lapses.

#### From WordPress

The richest source; three ways out, and you usually want two of them.

```bash
mkdir -p export

# 1. Content as WXR (Tools -> Export -> All content), or over wp-cli:
wp export --dir=./export --skip_comments=false        # on the source, or via --ssh

# 2. The REST API — easier to script against than WXR, and paginated:
curl -s 'https://oldsite.com/wp-json/wp/v2/posts?per_page=100&page=1&_embed' > export/posts-1.json
curl -s 'https://oldsite.com/wp-json/wp/v2/pages?per_page=100&_embed'        > export/pages.json
curl -s 'https://oldsite.com/wp-json/wp/v2/categories?per_page=100'          > export/categories.json
curl -s 'https://oldsite.com/wp-json/wp/v2/media?per_page=100&page=1'        > export/media-1.json

# 3. Media files — the uploads tree, straight off disk if you have shell:
rsync -azh user@oldhost:/var/www/site/wp-content/uploads/ ./export/uploads/
```

`_embed` pulls the featured image, author and terms into the same response, which
is what a static rebuild actually needs. Read `X-WP-TotalPages` from the response
headers rather than guessing the page count.

Things that live outside the posts table and get forgotten:

- **SEO plugin metadata** (Yoast, Rank Math) is in `postmeta`, not in the post
  body. With Yoast active the REST response carries `yoast_head_json`; otherwise
  pull `_yoast_wpseo_title` / `_yoast_wpseo_metadesc` from the DB, or just take
  the rendered `<title>` and meta description from `out/inventory.json` — which
  is the ground truth anyway.
- **Existing redirects.** If the Redirection plugin or Yoast's redirect manager
  is in use, export its rules and merge them into your new redirect map. Dropping
  them re-breaks links that were already fixed once.
- **Forms** (Contact Form 7, Gravity, WPForms) have no equivalent on a static
  target — pick the new endpoint in A4 and list the forms to rewire.
- **Feeds**: `/feed/`, `/comments/feed/`, per-category feeds. Subscribers and
  aggregators still hit them; serve them or 301 them.
- **The sitemap path changes.** Core serves `/wp-sitemap.xml`, Yoast serves
  `/sitemap_index.xml`. Whichever the old site used, keep answering on it.
- **`?p=123` and `?page_id=`** short links are in the wild. A rule mapping post
  ID → new path costs little.
- **Comments.** WXR contains them. Decide explicitly: port to a hosted comment
  system, render them as static HTML, or drop them and say so.

If the destination is also WordPress, you are on [Path B](#path-b--host-to-host-move)
instead — don't re-platform a site that is only changing boxes.

#### From Squarespace

Export is partial by design. Take all three sources and expect to rebuild the
rest by hand.

1. **The WXR export** — Settings → Import/Export → Export → WordPress. It gives
   you one blog page's posts, basic pages, and text/image blocks.
2. **Per-page JSON** — appending `?format=json-pretty` to any Squarespace URL
   returns that page's underlying content as JSON, and `?format=main-content`
   returns just the rendered content HTML. This is the reliable way to get the
   pages the WXR skips. Drive it from the inventory:

   ```bash
   # Fetch the JSON behind every URL the inventory found.
   mkdir -p export/json
   node -e 'const {pages}=require("./out/inventory.json");for(const p of pages)if(p.status===200)console.log(p.url)' \
   | while IFS= read -r u; do
       out=export/json/$(printf '%s' "$u" | sed 's|[^A-Za-z0-9._-]|_|g').json
       curl -fsS --max-time 30 "${u}?format=json-pretty" -o "$out" || echo "MISS $u"
     done
   ```

   Review the `MISS` lines — those are pages that need a manual pass.
3. **Commerce** — products export separately as CSV (Commerce → Inventory →
   Export). Orders and customers export separately again, and they are not
   content: if the store is moving, that is a commerce migration on top of this
   one, with its own data and its own cutover.

What the export does **not** carry, and must be rebuilt: more than one blog page,
gallery/album/event/portfolio pages, index and cover pages, folders, form blocks,
audio and video blocks, custom CSS, and every style and layout choice. Verify
each of these against the inventory before you call the export complete.

Media sits on `images.squarespace-cdn.com` / `static1.squarespace.com` and the
export points at it. Download it: Squarespace image URLs take a `?format=2500w`
(or `original`) suffix, so request the largest rendition rather than the
thumbnail the page happened to use.

URL shape to preserve: `/blog/<slug>`, `/<page-slug>`, collection items under
their collection path. Squarespace serves a real `/sitemap.xml` — use it for the
inventory rather than crawling.

#### From Wix

The hardest export, because there is no full-site export. Plan on a crawl-driven
rebuild.

- **Blog** — the Blog dashboard has a post export that produces a
  WordPress-compatible XML. Check whether it is present on the account before you
  promise it; if it is not, fall back to the crawl.
- **CMS / Content Manager collections** — each collection exports to CSV from the
  Content Manager. Do this per collection; there is no bulk export.
- **Wix Stores** — products export to CSV from the Store dashboard.
- **Pages** — no export. The content comes out of the crawl.

Wix renders client-side, so `<a href>` crawling under-reports badly. Use the
sitemaps instead — Wix publishes `/sitemap.xml` as an index with child sitemaps
(typically `/pages-sitemap.xml`, `/blog-posts-sitemap.xml`,
`/store-products-sitemap.xml`):

```bash
node scripts/inventory.mjs https://oldsite.com --out out     # follows the sitemap index
```

If a page's text still comes back empty, the content is injected by JS and you
need a rendering fetch for that page — the audit scripts deliberately do not
execute JavaScript. Render those pages with a headless browser and save the HTML
into `export/` by hand, or copy them out of the editor.

URL shape: blog posts live at `/post/<slug>`, store products at
`/product-page/<slug>`. Wix also leaves `?lang=` and `#!`-era legacy URLs around
— check the inventory for them and redirect rather than dropping them.

Media is on `static.wixstatic.com`. There is no bulk download; collect the asset
URLs from the crawl and fetch them.

#### From Webflow

The cleanest managed export, and the one trap is CMS content.

1. **Code export** — Project settings → General → Export Code (needs a paid site
   plan) gives a ZIP of static HTML, CSS, JS and assets for the designed pages.
2. **CMS collections** — the code export does **not** include collection items or
   collection-page content. Export each collection to CSV from the Collections
   panel, and keep the `slug` column — it is your URL.
3. **Rebuild the dynamic pages** from CSV + the collection page template in the
   exported HTML.

What breaks on export: Webflow-hosted forms (they post to Webflow and stop
working the moment you leave — pick a new endpoint), Webflow Ecommerce, user
accounts, and any Webflow-hosted search. Interactions/animations survive as the
exported JS.

URL shape: collection items live at `/<collection-slug>/<item-slug>`. Keep both
segments and you need no redirects at all for the CMS half of the site.

#### From Shopify

Usually a *partial* migration: the blog and pages move, the store stays. Decide
that explicitly before you touch anything, because moving checkout is a different
project with money in it.

Public read-only endpoints, no app or token needed:

```bash
mkdir -p export
curl -s 'https://shop.example.com/blogs/news.atom'                 > export/blog-news.atom
curl -s 'https://shop.example.com/products.json?limit=250&page=1'  > export/products-1.json
curl -s 'https://shop.example.com/collections/all/products.json?limit=250' > export/collections-all.json
curl -s 'https://shop.example.com/sitemap.xml'                     > export/sitemap.xml
```

Page the product endpoint until it returns an empty `products` array. If `page=`
stops advancing on the store, switch to the Admin API and paginate with the
`Link` header instead.

For complete article bodies, authors and metafields, use the Admin API with a
custom app's access token (`/admin/api/<version>/blogs.json`, then
`/admin/api/<version>/blogs/<id>/articles.json`) — the `.atom` feed is capped and
summarised. Products, customers and orders also export to CSV from the admin;
blog articles do not.

URL shape to preserve: `/products/<handle>`, `/collections/<handle>`,
`/pages/<handle>`, `/blogs/<blog>/<article>`. Shopify also serves every product
under `/collections/<c>/products/<handle>` — those duplicates are in the
inventory and need redirects to the canonical path.

If the store stays on Shopify, the split is the thing to get right: the new site
answers for the content paths, and `/products/*`, `/collections/*`, `/cart`,
`/checkout` and `/account` must keep resolving to Shopify. Write that split into
the redirect map in A7 and test both halves before cutover.

#### From a static or hand-rolled site

Plain HTML, Jekyll, Hugo, an old PHP include-based site: the files *are* the
export.

```bash
mkdir -p export
rsync -azh user@oldhost:/var/www/site/ ./export/site/     # with shell access
# or, without shell access, mirror what is published:
wget --mirror --page-requisites --adjust-extension --no-parent https://oldsite.com/
```

Then grep for what is baked in rather than templated:

```bash
grep -rIl -e 'https://oldsite.com' -e 'http://oldsite.com' export/site/ | head -50
```

The live-URL inventory is still the authority — a file on disk that nothing links
to and no URL serves is not content, and a URL served by a rewrite rule has no
file at all. Reconcile the two lists before you decide what to rebuild.

If it is moving to a new server unchanged, this is [Path B](#path-b--host-to-host-move),
not a re-platform.

#### When there is no export at all

Some sources — a builder with the export removed, a locked CMS, an abandoned
account with only front-end access — give you nothing. The crawl is the
migration:

```bash
node scripts/inventory.mjs https://oldsite.com --crawl --max 2000 --out out
```

`out/inventory.json` already holds the title, meta description, H1, canonical and
word count per URL. Fetch each page once more for its body, convert the main
content region to Markdown or your target's format, and treat `inventory.csv` as
the work list — one row, one page, checked off when rebuilt.

This is also the honest fallback for *any* source whose export turns out to be
incomplete. You always have the crawl.

### A4. Plan the move

- Map old URLs → new URLs. If the structure is identical, you want identity
  redirects (handled for you). If it changes, produce a `mapping.csv` of
  `old_path,new_path`.
- **Settle the URL policy before you build**, not after. Three decisions cause
  most post-migration damage, and all three are cheap now and expensive later:
  - **Trailing slashes.** Pick one form and make the other 301 to it, once. If
    the old site served `/about/` and the new one serves `/about`, every inbound
    link takes a redirect, and a tool that generates both will chain them. In
    Next.js this is `trailingSlash` in `next.config`; on S3/CloudFront and in
    Caddy's `file_server` it is implicit — know which way yours goes.
  - **Case.** A source on Windows/IIS was case-insensitive; a Linux target is
    not. Check the inventory for mixed-case paths and lowercase-redirect them.
  - **Index files.** `/dir/index.html` vs `/dir/` vs `/dir` — settle on one and
    redirect the others.
- Decide the content migration method per content type: export/import, scripted
  port, or manual rebuild. The A3 export tells you which is realistic.
- List integrations to re-wire (analytics IDs, form endpoints, payment keys,
  search, CDN) and schema/metadata to carry over.
- List the URLs that are **not** pages and still have to answer: `robots.txt`,
  `sitemap.xml` (at the old path), RSS/Atom feeds, `favicon.ico`, `/.well-known/*`,
  verification files for Search Console and ad platforms, `ads.txt`, and any PDF
  or image that earned links.
- Define the parity bar: status match, title/H1 present, content not gutted.

### A5. Rebuild on staging

Build the new site on its temporary URL. Carry over content, templates,
metadata (titles, descriptions, canonical, Open Graph), and structured data.
Re-point integrations at test/staging credentials where possible. Nothing here
touches the live site.

**Target-stack notes.** The phases do not change with the target; these are the
things that reliably get missed:

- **Next.js / React framework.** Set `trailingSlash` to match A4's decision.
  Port the redirect map into `next.config` `redirects()` (or the generated
  `redirects.next.js` from A7) and remember those are *application* redirects —
  a path your app never serves, like an old PDF, needs the rule at the
  webserver/CDN instead. Generate `sitemap.xml` and `robots.txt` as routes, not
  as forgotten static files. Carry per-page metadata through the metadata API
  rather than a single layout default — a site where every page shares one title
  passes "title present" and still loses rankings. If the old site had feeds,
  add feed routes. Images: a local `/public` copy or a configured remote host,
  but decide, because `next/image` will reject an unconfigured domain at runtime
  and only on the pages that use it.
- **Static generator (Astro, Hugo, Eleventy, Jekyll).** Slugs come from
  filenames — confirm they reproduce the old paths exactly, including dated
  prefixes like `/2019/04/post-name/`. Draft/future-dated content silently
  disappears from a build; diff the built output's file list against the
  inventory. Redirects are not a static-site feature: they live in the host's
  config, so A7's output goes to Caddy/nginx/Netlify, not into the site.
- **Another CMS.** Import first into a throwaway instance, check the slug and
  taxonomy mapping, then import for real. Watch for the CMS rewriting slugs on
  collision (`post-name-2`) — that is a silent URL change.
- **Your own server.** You also want Path B's B3 (provision), B6 (permissions)
  and B7 (verify by IP) — a re-platform that lands on a new box is both paths.

**Keep the staging URL out of the index.** A staging copy that gets crawled
competes with the live site for the same content and can outrank or cannibalise
it, and the URL leaks to anyone reading search results. Before you put anything
on it, do all three:

- Serve `X-Robots-Tag: noindex, nofollow` on every response from the staging
  host (a header, not a meta tag — it covers PDFs, feeds and assets too).
- Serve a `robots.txt` of `User-agent: *` / `Disallow: /` on the staging host
  only.
- Put HTTP basic auth in front of it. This is the one that actually works:
  `noindex` is a request, and a link from anywhere gets the URL crawled anyway.

Confirm it is working — `curl -sI https://staging.newsite.com | grep -i
x-robots-tag` — and **write the removal into the cutover checklist**. These
blocks are per-host, so if the rebuild is later promoted onto the production
host, or the config is copied across, a live site ships with `noindex` and
quietly disappears from search. Removing them at cutover is step A8's last
checkbox and step A9's first verification.

### A6. Verify parity (the gate)

This is the step that separates a safe migration from a disaster.

```bash
node scripts/parity.mjs https://oldsite.com https://staging.newsite.com \
  --inventory out/inventory.json --out out
```

Read `out/parity-report.md`. It lists every path that is missing, errors,
changed title, or lost significant content on the new site. **Resolve every row
— either fix the new site or record an intentional 301 — before continuing.**
The script exits non-zero while problems remain, so it can gate a pipeline.

Then check links on the rebuild:

```bash
node scripts/linkcheck.mjs https://staging.newsite.com --out out
```

Fix every broken internal link in `out/link-report.md`.

If staging is behind basic auth, give the scripts the credentials in the URL
(`https://user:pass@staging.newsite.com`) or lift the auth for the source IP
while the sweep runs — do not remove it wholesale.

### A7. Generate the redirect map

```bash
# identity moves (same paths on the new host):
node scripts/redirects.mjs --inventory out/inventory.json --out out --format all
# changed URLs:
node scripts/redirects.mjs --map mapping.csv --out out --format caddy
```

Emits ready-to-paste 301 configs for Caddy, nginx, Netlify, and Next.js. Load
the right one into the new stack and confirm redirects resolve on staging before
cutover.

Paths that could inject into the generated config — whitespace, quotes, braces,
semicolons, `#`, `$`, backslashes, or anything that leaves the origin — are
skipped and reported rather than emitted. If the count of skipped pairs is not
zero, look at why before you ship the config.

### A8. Pre-cutover checklist

Do not proceed until all are true:

- [ ] Full source backup exists (files + DB + current DNS records written down)
- [ ] `parity.mjs` reports zero unresolved problems
- [ ] `linkcheck.mjs` reports zero broken internal links
- [ ] `redirects.mjs` reported zero skipped pairs
- [ ] Redirect map loaded into the new stack and spot-checked on staging
- [ ] Analytics/search console/forms/integrations verified on staging
- [ ] SSL ready for the real domain on the new host
- [ ] DNS TTL lowered (e.g. 300s) in advance
- [ ] Old host will stay running 48–72h post-cutover
- [ ] Rollback steps written down; user has approved cutover
- [ ] **Staging's `noindex` / `Disallow` / basic auth are removed from the
      production host** — and confirmed absent, not just deleted from a config
      file. A live site serving `X-Robots-Tag: noindex` drops out of search
      within days and the cause is not obvious from the page.

### A9. Cutover

**Stop and get explicit confirmation from the user before this step.** Then
point DNS at the new host. Immediately verify the live domain:

```bash
# The first thing to check: the staging index block is gone.
curl -sI https://realdomain.com | grep -i -e x-robots-tag -e www-authenticate   # expect no output
curl -s  https://realdomain.com/robots.txt                                      # expect the real one

node scripts/linkcheck.mjs https://realdomain.com --out out-prod
node scripts/parity.mjs https://oldsite.com https://realdomain.com \
  --inventory out/inventory.json --out out-prod
```

(Compare against the old host by IP/temporary URL if DNS has already moved.)

### A10. Post-cutover

- Submit the new sitemap to Google Search Console; watch coverage + 404s for
  1–2 weeks. Use the URL Inspection tool on the homepage to confirm Google sees
  it as indexable.
- Monitor the live site (errors, Core Web Vitals, form submissions).
- Keep the old host and the rollback path available through the monitoring
  window.
- Take the staging host down, or leave its `noindex` + auth in place. Do not
  leave an indexable duplicate of the site running.
- Only after the window is clean and the user approves: decommission the old
  host.

---

## Path B — host-to-host move

The same site, a new box. Steps B1–B4 and B6–B9 are stack-agnostic — back up,
provision, transfer, fix permissions, verify by IP, cut DNS, keep rollback
ready. Only [B5](#b5-move-the-data-layer-and-rewrite-urls) branches by stack,
and it covers WordPress, static, generic PHP (Laravel/Drupal/Joomla/custom) and
Node. WordPress is the most common case and the only one with a scripted
serialized-safe URL rewrite; the others are documented step by step.

### B0. Understand the migration

Ask the user (or confirm from context) the things that change the plan:

- **Stack**: WordPress, generic PHP, static, Node, something else.
- **What's moving**: host only (same domain), domain only (same host), or both.
- **Access**: SSH to source? to destination? DB credentials available?
- **Size**: a 300 MB blog and a 40 GB media library are different jobs.

Then run the inventory — do not guess:

```bash
scripts/preflight.sh --path /var/www/site --ssh user@oldhost --url https://oldsite.com
```

Read the report back to the user. It prints the detected stack (`wordpress`,
`node`, `php` or `static`), size, WordPress DB settings when relevant (never the
password), runtime versions on the target, and a go/no-go checklist. Use it to
size the work and spot problems early (missing wp-cli, an Apache `.htaccess`
that needs an nginx translation, a huge uploads dir). The `STACK:` line tells
you which [B5](#b5-move-the-data-layer-and-rewrite-urls) subsection you are
following.

### B1. Lower DNS TTL (do this first, before anything else)

Cutover is only as fast as the old TTL. At least 24–48h before you intend to cut
over, have the user lower the record's TTL to 300s at the DNS provider. This
costs nothing and makes rollback fast later. Note the original TTL so you can
restore it after the migration settles.

### B2. Back up the source (files + database)

```bash
# Files (+ DB in one go). DB creds come from the environment, never the CLI.
export DB_NAME=... DB_USER=... DB_PASS=...     # set in the shell, not in chat
scripts/backup.sh --path /var/www/site --out ./backups --ssh user@oldhost --with-db        # preview
scripts/backup.sh --path /var/www/site --out ./backups --ssh user@oldhost --with-db --go   # take it
```

**`--go` is required or you get no backup.** Without it the script prints the
plan and writes nothing — not even the output directory. Run the preview, then
run it again with `--go`, and read the confirmation before you move on.

`backup.sh --go` streams a read-only tar from the source to a **local** archive
(so the backup survives even if the source host dies), writes a sha256 beside
it, and only reports completion after `tar -t` has read the archive end to end.
If any of that fails it removes the partial file and exits non-zero. For the DB
it calls `db-dump.sh`, which uses `--single-transaction` for a consistent
snapshot without locking the site, and which checks `mysqldump`'s own exit
status rather than the compressor's — so a dump that dies halfway is reported as
a failure and the partial file is deleted, instead of sitting there looking like
a backup.

**Prove the backup.** Extract the tar to a scratch dir and restore the SQL dump
into a throwaway database. A backup you have not restored is a guess.

### B3. Provision the destination

Before transferring: the destination needs the runtime (matching PHP/Node
version from the pre-flight report), a database created and empty, a webserver
vhost pointing at the doc root, and TLS ready (Caddy/Let's Encrypt/etc.). You can
request a cert for the real hostname ahead of DNS by using DNS-01, or test over a
temporary hostname/IP first (see B6).

If you expose the destination on a temporary public hostname while you work,
give it the same treatment as a staging site: `X-Robots-Tag: noindex, nofollow`,
a `Disallow: /` robots.txt, and basic auth — and remove all three at cutover.
See A5 and the A8 checklist; the failure mode is identical.

### B4. Transfer the files

```bash
scripts/transfer.sh --from user@oldhost:/var/www/site/ --to /var/www/site/        # preview
scripts/transfer.sh --from user@oldhost:/var/www/site/ --to /var/www/site/ --go   # execute
```

Preview first; read the file list; then `--go`. The wrapper uses
`rsync -azh --partial` (resumable), excludes VCS/OS cruft, and **refuses to
delete** destination files unless you pass `--mirror` and confirm. For very large
media libraries, run it more than once — rsync only moves the delta, so the
final pass right before cutover is quick.

After it finishes, compare file counts between source and destination.

### B5. Move the data layer and rewrite URLs

What this step means depends on the stack. Find yours below. `preflight.sh`
already told you which one it is (`STACK:` in its report — `wordpress`, `node`,
`php` or `static`).

The rule that spans all of them: **identify the storage format before you
rewrite anything.** A blind `REPLACE()` over a column holding PHP-serialized
data, JSON, or a base64 blob corrupts it, and the corruption shows up weeks
later in one widget.

#### B5a. WordPress (the common case)

Import the dump on the destination (into the empty DB you created):

```bash
gunzip -c backups/site-db-*.sql.gz | mysql -u USER -p NEW_DB     # on the destination
```

**If the domain is changing, rewrite URLs the safe way.** WordPress stores
PHP-serialized data in the DB; a raw SQL `REPLACE()` corrupts it. Use the
wrapper, which runs `wp search-replace` (serialized-aware):

```bash
scripts/wp-search-replace.sh --path /var/www/site \
  --old https://oldsite.com --new https://newsite.com --ssh user@newhost          # dry-run report
scripts/wp-search-replace.sh --path /var/www/site \
  --old https://oldsite.com --new https://newsite.com --ssh user@newhost --go      # apply
```

`--go` asks for confirmation. With no terminal it refuses outright unless you
also pass `--yes` — so never add `--yes` to get past a prompt you haven't read.
Confirm the DB dump exists first.

It skips post GUIDs (they must not change), covers custom plugin tables, and
handles nested serialized objects. Run it only after the DB dump exists.

Then update `wp-config.php` DB credentials for the new host, keep the existing
salts and keys (replacing them logs every user out), and translate `.htaccess`
rewrites to the destination webserver's config if the webserver changed
(Apache → nginx).

#### B5b. Static site

There is no data layer. The whole step is: find the absolute URLs that were
baked in rather than templated, and fix them.

```bash
grep -rIl -e 'https://oldsite.com' -e 'http://oldsite.com' /var/www/site/ | head -50
```

Check HTML, CSS (`url()`), JS, JSON, and any sitemap or feed shipped as a file.
Then confirm the webserver's rewrite rules came across — a static site is mostly
its `try_files` / `file_server` config, and that lives outside the doc root.
Translate `.htaccess` if the webserver changed.

#### B5c. Generic PHP app (Laravel, Drupal, Joomla, custom)

Dump and import the same way as WordPress — `db-dump.sh` is a `mysqldump`
wrapper and works for any MySQL/MariaDB database. **For PostgreSQL it does not
apply**: use `pg_dump -Fc` yourself, with the same discipline — credentials from
`PGPASSWORD` in the environment or `~/.pgpass`, never on the command line, and
check `pg_dump`'s own exit status rather than the compressor's.

There is no `wp search-replace` equivalent, so handle URLs per framework:

- **Laravel.** URLs normally come from `APP_URL` in `.env`, so the rewrite is one
  config line, not a DB sweep. On the destination: copy `.env` and update
  `APP_URL` + DB credentials, `composer install --no-dev --optimize-autoloader`,
  then `php artisan config:clear && php artisan cache:clear && php artisan
  view:clear` — a cached config file pins the *old* values and ignores your
  edit, which is the single most common "I changed it and nothing happened" on a
  Laravel move. Re-create the public storage symlink (`php artisan storage:link`
  — it is a symlink, so it may not survive the transfer), make `storage/` and
  `bootstrap/cache/` writable by the webserver user, re-install the scheduler
  cron entry and any queue workers (supervisor/systemd units live outside the
  doc root and will not be in the tar). Never `php artisan migrate` as part of a
  host move — the schema already came over in the dump.
- **Drupal.** `settings.php` holds the DB credentials; `$settings['trusted_host_patterns']`
  holds the hostnames Drupal will answer for, and a new domain missing from it
  returns a bare 400 that looks like a webserver fault. `sites/default/files`
  must be writable, and `sites/default/settings.php` should go back to 444.
  Rebuild caches after the move (`drush cr`). Drupal keeps serialized PHP in
  config and block tables — rewrite URLs through `drush sql:query` with targeted
  statements on known-text columns, not a global replace.
- **Joomla.** `configuration.php` holds `$host`/`$db`/`$user`/`$password` *and*
  `$log_path` / `$tmp_path` as absolute paths — if the doc root moved, those two
  point at nothing and the site fails in ways that have nothing to do with the
  database. Joomla stores component params as JSON; replace inside them with
  care.
- **Custom app.** Read its config file and find where the canonical hostname
  lives. Then `grep -rIl` the codebase for the old origin, as in B5b, because a
  hand-rolled app usually has a few hardcoded ones too.

For a DB-stored URL with no framework helper, rewrite column by column on known
text columns, after taking the backup:

```sql
-- Inspect first. Never run a global replace across every column.
SELECT id, LEFT(body, 200) FROM articles WHERE body LIKE '%oldsite.com%' LIMIT 20;
UPDATE articles SET body = REPLACE(body, 'https://oldsite.com', 'https://newsite.com')
 WHERE body LIKE '%oldsite.com%';
```

Check for JSON and serialized columns first (`SHOW COLUMNS`, and eyeball the
values) and leave those to a script that parses, edits and re-encodes them.

#### B5d. Node app

The data layer is whatever the app uses; the move is mostly runtime and process
management, which the file transfer does not carry.

- **Runtime version.** Match the source's major version from the pre-flight
  report. A different major breaks native modules.
- **Dependencies.** Do not rely on the transferred `node_modules` — native
  modules are compiled for the source's architecture and libc. Transfer the
  source plus the lockfile and run `npm ci --omit=dev` (or the project's
  equivalent) on the destination, then the build.
- **Environment.** `.env` or the process manager's env block holds the DB URL,
  secrets and the public base URL. `.gitignore` excludes env files for good
  reason, so they are not in the repo — copy them deliberately and update the
  hostname.
- **Process manager.** pm2 ecosystem files, systemd units and their enablement
  live outside the doc root and are not in the backup tar. Re-create them,
  confirm the service restarts on boot (`systemctl enable`, `pm2 save`), and
  check the port matches what the new vhost proxies to.
- **Reverse proxy.** The new vhost needs the proxy pass, plus the WebSocket
  upgrade headers if the app uses them — a missing `Upgrade`/`Connection` pair
  shows up as "the page loads but nothing is live".
- **State on disk.** Uploads, a SQLite file, a session store, generated caches:
  these are often outside the repo path you tarred. Find them in the config and
  move them separately, with the right ownership.
- **Databases.** MongoDB is `mongodump`/`mongorestore`; Postgres is `pg_dump`;
  Redis is usually a cache you can let rebuild — but confirm it is not being
  used as the session or queue store before you discard it.

### B6. Fix permissions

```bash
scripts/fix-perms.sh --path /var/www/site --ssh user@newhost                       # preview
scripts/fix-perms.sh --path /var/www/site --owner www-data:www-data --ssh user@newhost --go
```

Directories 755, files 644, `wp-config.php` 640, `.env` 600. Set ownership to the
webserver user explicitly — the right owner is host-specific.

`--path` must be a real site root: `/`, `/home`, `/usr`, `/var`, `/var/www` and
other system paths are refused, because the chmod/chown is recursive. `--go`
confirms first (or needs `--yes` with no terminal).

### B7. Verify on the new host BEFORE touching DNS

Point at the new server by IP while sending the production Host header, so you
test the real vhost without any DNS change:

```bash
scripts/verify.sh --old https://oldsite.com --new https://newsite.com \
  --new-ip 203.0.113.9 --paths paths.txt
```

It sweeps HTTP status old-vs-new across your paths (or the sitemap), checks for
broken assets, and exits non-zero on any new-host failure or broken asset. Also
do a human spot-check: load the homepage and a few key pages against the new IP
(hosts-file override or `curl --resolve`), log in to the admin, submit a form,
check images.

For a domain change, add Path A's parity gate on top — `verify.sh` proves the
new host serves the site, `parity.mjs` proves it serves *every URL the old one
did*:

```bash
node scripts/inventory.mjs https://oldsite.com --out out          # before cutover
node scripts/parity.mjs https://oldsite.com https://newsite.com --inventory out/inventory.json --out out
node scripts/redirects.mjs --inventory out/inventory.json --out out --format all
```

**Gate:** do not proceed to cutover until `verify.sh` passes and you have
eyeballed the site. If it fails, fix on the destination; the old host is still
serving real users.

### B8. Cut over DNS

Only after B7 passes:

1. Do a final quick `rsync` and a fresh DB dump/import if the source changed
   since the backup (catch posts/orders created during the migration).
2. Remove any staging `noindex` header, `Disallow: /` robots.txt and basic auth
   from the new host, and confirm with `curl -sI` that they are gone.
3. Update the DNS record to the new host's IP. With TTL at 300s, propagation is
   minutes.
4. Watch the new host's logs and re-run `verify.sh` against the live hostname
   (no `--new-ip` now).

### B9. Keep rollback ready

- **Keep the old host live and untouched** for at least 24–72h. Rollback is just
  pointing DNS back; with the low TTL it is fast.
- Once the new host is confirmed stable, restore the original DNS TTL and only
  then consider decommissioning the source.
- **Never delete the source** as part of the migration. Deletion is a separate,
  later, explicitly-confirmed decision.

## Rollback plan (write this down before cutover)

> If the new host misbehaves after cutover: repoint the DNS record back to the
> old host's IP (TTL 300s → live in minutes). The old host was never modified and
> is still serving. Investigate on the new host out of band, then retry the
> cutover.

## Tests

Two suites, both run in CI on every push:

```bash
tests/smoke.sh                                                               # bash helpers
shellcheck -x -s bash scripts/*.sh scripts/lib/common.sh tests/smoke.sh
node tests/node-smoke.mjs                                                    # audit scripts
```

`tests/smoke.sh` stubs `ssh`, `mysqldump` and `wp` and asserts that values are
passed as arguments rather than executed, that passwords never appear in any
argv, that a dry run writes nothing and claims nothing, that a real backup is
checksummed and readable, and that a truncated dump is reported as a failure.

`tests/node-smoke.mjs` is the security regression suite for the audit scripts:
SSRF via sitemap fan-out and via redirects, ReDoS on a 560 KB malformed page,
the response-body cap, origin escape from concatenated URLs, config injection
through a redirect map, and output written outside the working directory. It
uses loopback servers, so it needs no network.

It also asserts this file's declared scope — that the frontmatter description
fits the 1024-character limit and still names every platform the skill covers,
that "When to use this" still lists re-platforming/re-hosting/re-domaining, that
each non-WordPress source and stack still has its own recipe, and that every
internal anchor resolves. The scope was narrowed to WordPress-only by accident
once; the test is there so it cannot happen quietly again.

Run both after changing any script.

## Edge cases to watch

- **Staging left indexable, or production shipped with `noindex`.** Both are
  silent and both cost traffic. Check the header on both hosts at cutover.
- **Hardcoded absolute URLs** in theme files or JS, not just the DB — grep the
  codebase after transfer.
- **Email/SMTP, cron (wp-cron or system cron), and API webhooks** that reference
  the old host.
- **CDN / caching layers** (Cloudflare, Varnish) that need purging post-cutover.
- **`wp-config.php` salts and keys** — keep them, or all users get logged out.
  The same applies to any app's session secret (`APP_KEY`, `SECRET_KEY_BASE`,
  `NEXTAUTH_SECRET`): change it and every signed-in user is signed out.
- **Trailing-slash and case mismatches** between the old and new routing. The
  commonest cause of a migration that looks fine and bleeds traffic — see A4.
- **A managed-platform export that was incomplete.** Squarespace skips most page
  types, Webflow's code export skips CMS items, Wix has no page export at all.
  Diff the export against `out/inventory.csv` rather than trusting it.
- **Assets still served from the old platform's CDN** (`static.wixstatic.com`,
  `images.squarespace-cdn.com`, `cdn.shopify.com`). The new site works right up
  until the old account lapses. Re-host every asset.
- **A JS-rendered source**, where the crawler sees an empty page. The audit
  scripts do not execute JavaScript, by design. Use the sitemap for the URL set
  and render those specific pages another way for the content.
- **Symlinks that did not survive the transfer** — Laravel's `public/storage`,
  a shared uploads mount, a `current` release link.
- **Cached framework config pinning old values** (`php artisan config:cache`, an
  opcache, a build-time env inline). Clear it and re-verify, don't assume.
- **Process managers, cron entries and systemd units live outside the doc root**
  and are not in the backup tar. Re-create them on the destination.
- **Mixed content** after an http→https move — the search-replace handles the DB;
  check hardcoded `http://` refs too.
- **Larger-than-RAM DB dumps** — `db-dump.sh` uses `--quick` to stream rather
  than buffer.
- **A staging site on loopback or a LAN IP** — the audit scripts refuse private
  addresses by default; name it with `--allow-host`.
