# Re-platforming: a different stack, the same URLs

WordPress → Next.js. Squarespace → Astro. A bespoke PHP site → a headless CMS.
Moving the *platform*, not the box.

Everything in a host-to-host move still applies, and one thing dominates it:
**nothing in the new stack reproduces the old URLs by accident.** A host move
that goes wrong 404s loudly and you fix it in ten minutes. A re-platform that
goes wrong looks beautiful, answers 200 on every page a human clicks, and
quietly drops the 300 old URLs that carried the site's search traffic. The loss
shows up six weeks later in Search Console.

So the order of work is inverted from what feels natural: **establish the URL
contract first, build second.**

## R-1 · Freeze the URL contract before writing any code

The inventory is the contract. Take it on the live site, archive the file, and
treat it as the spec the rebuild must satisfy.

```bash
node scripts/inventory.mjs https://example.com --out out
# no usable sitemap on the old platform?
node scripts/inventory.mjs https://example.com --crawl --max 1000 --out out
cp out/inventory.json out/inventory-frozen.json      # the contract; do not regenerate
```

`inventory.csv` gives you every URL with its status, title, meta description,
H1, canonical and word count — in a spreadsheet, which is the right place to do
the mapping with a human.

Add, by hand, what an HTTP crawl cannot see — and on a re-platform this list is
where the work actually hides:

- **Paginated archives**: `/blog/page/2/`, `/category/x/page/3/`. Dozens of real,
  indexed URLs that most rebuilds simply do not generate.
- **Taxonomy pages**: category, tag, author archives. Each one is a URL with
  links pointing at it.
- **Feeds**: `/feed/`, `/rss.xml`, `/atom.xml`, per-category feeds. Subscribers
  and aggregators hold these; a 404 is a silent unsubscribe.
- **Sitemaps and robots**: `/sitemap.xml`, `/sitemap_index.xml`,
  `/robots.txt`. Search Console holds the sitemap URL on file.
- **Attachment and media URLs** — `/wp-content/uploads/2023/07/photo.jpg` is
  linked from other people's sites. See R-4.
- Search results pages, the 404 page itself, `/favicon.ico`, `/.well-known/*`,
  and anything with a query string that returns different content.

```bash
# sanity-check the long tail of things the crawler skipped
for p in /feed/ /sitemap.xml /sitemap_index.xml /robots.txt /blog/page/2/; do
  printf '%-24s ' "$p"
  curl -o /dev/null -sS -w '%{http_code}\n' "https://example.com$p"
done
```

## R-2 · Decide: reproduce the paths, or map them

**Reproducing the old paths is almost always the right answer.** It costs a
routing decision in the new stack and buys you zero redirects, zero lost link
equity, and a parity run that passes on the first try.

```
WordPress  /2023/07/my-post/        →  Next.js  app/[year]/[month]/[slug]/page.tsx
WordPress  /category/news/          →  app/category/[slug]/page.tsx
WordPress  /blog/page/2/            →  app/blog/page/[page]/page.tsx
Squarespace /blog/2024/3/14/title   →  app/blog/[y]/[m]/[d]/[slug]/page.tsx
```

"Modernising the URL structure" during a re-platform is two risky changes at
once. Do the platform move with the URLs intact, verify, cut over, and change
the structure later as its own project with its own redirect map — if it is
still worth doing by then.

If the paths genuinely must change, every old URL needs a 301:

```bash
# mapping.csv — old_path,new_path — built from inventory.csv in a spreadsheet
node scripts/redirects.mjs --map mapping.csv --out out --format all
```

Check the map covers the contract completely, rather than hoping:

```bash
# every 200 URL in the frozen inventory must appear in mapping.csv
node -e '
const fs = require("fs");
const inv = JSON.parse(fs.readFileSync("out/inventory-frozen.json", "utf8"));
const mapped = new Set(
  fs.readFileSync("mapping.csv", "utf8").split("\n")
    .map((l) => l.split(",")[0].trim()).filter(Boolean));
const missing = inv.pages
  .filter((p) => p.status === 200 && !mapped.has(p.path))
  .map((p) => p.path);
console.log(missing.length
  ? "UNMAPPED (" + missing.length + "):\n" + missing.join("\n")
  : "every 200 path is mapped");
'
```

Keep the redirects as data (a generated config, a `redirects()` array, a table)
rather than hand-written `if` statements. You will regenerate them more than
once.

## R-3 · Get the content out as content, not as HTML

Scraping rendered HTML gives you a copy of the old site's markup, wrapped
around the content, in a new stack. It works and you will regret it at the first
design change.

| Source | Export route |
| --- | --- |
| WordPress | `wp export` (WXR), or the REST API: `/wp-json/wp/v2/posts?per_page=100&page=N` |
| Ghost | Settings → Labs → Export JSON |
| Drupal / Joomla | database dump, or JSON:API / a view rendered as JSON |
| Squarespace | Settings → Import/Export → WordPress WXR |
| Webflow | CMS → CSV per collection |
| Shopify | Admin CSV export, or the Admin API |
| Closed builder | no export — see [Managed platforms](./managed-platforms.md) |

```bash
# WordPress REST, paged — note the Link/X-WP-TotalPages header tells you when to stop
curl -sS "https://example.com/wp-json/wp/v2/posts?per_page=100&page=1&_embed" \
  -o out/posts-1.json
jq '. | length' out/posts-1.json
```

Convert to the new stack's content model — MDX files, a headless CMS import, a
database table — with a script you keep, so the import is repeatable when you
find the first field you got wrong. Carry across: title, slug, publish date
(including the timezone), author, excerpt, categories/tags, the featured image,
and every SEO field the old plugin stored (meta title, meta description,
canonical, OG image, `noindex` flags — a page the old site deliberately kept out
of the index should not reappear in it).

Two things that are always wrong on the first pass: **inline HTML inside
content** (shortcodes, embeds, page-builder markup, `<figure>` wrappers) and
**internal links**, which still point at the old absolute URLs. Rewrite links to
be relative or to the new base, and check what the converter dropped:

```bash
grep -rno 'https\?://example\.com[^")[:space:]]*' content/ | wc -l
grep -rn '\[/\?[a-z_]*\]' content/ | head -20      # leftover shortcodes
```

## R-4 · Media: rehost it, and keep the old paths working

Images are linked from other people's sites, from social posts, and from email
archives. `/wp-content/uploads/2023/07/photo.jpg` is a real URL with real
inbound links.

```bash
# pull the media library wholesale, into its own directory
rsync -azP --no-owner --no-group \
  user@oldhost:/var/www/example.com/wp-content/uploads/ ./public/uploads/
# or, with no shell on the source, from the mirror in managed-platforms.md § M-2

find ./public/uploads -type f | wc -l     # compare with the source's count
du -sh ./public/uploads
```

Either serve them at the same paths on the new stack — a static route or a
rewrite to `public/uploads`, cheapest and safest — or redirect the old media
paths to the new ones in the same map as everything else.

Resized variants matter: WordPress generates `photo-300x200.jpg` and the old
pages reference those filenames specifically. Copy the whole directory, not
just the originals.

Then make sure the new stack can actually serve them: self-hosted `next/image`
needs `sharp` installed and a writable cache directory, or every image 500s —
see [Node applications](./node-apps.md) § M-5.

## R-5 · Carry the head, not just the body

A re-platform is where metadata quietly disappears, because the new stack has
its own opinions and no data to fill them with. `inventory.csv` holds the old
title, description and canonical for every URL — use it as the check.

Per page, verify the new stack emits: `<title>`, meta description, canonical,
`og:title`/`og:description`/`og:image`, Twitter card tags, `hreflang` if the
site is multilingual, and the same `robots` directives.

Site-wide: `robots.txt` (including any `Disallow` that was deliberate), a
sitemap at the URL Search Console has on file, the structured data the old
site emitted (`Article`, `Product`, `LocalBusiness`, `BreadcrumbList` — Google
has it indexed), and the analytics and tag-manager IDs.

```bash
# compare the head of the same URL on both hosts
for h in https://example.com https://staging.example.com; do
  echo "--- $h"
  curl -sS "$h/about" | sed -n '/<head>/,/<\/head>/p' \
    | grep -Ei '<title|name="description|rel="canonical|property="og:|name="robots' 
done
```

Then the thing that is only a re-platform problem: **a staging site must not be
indexed, and must not stay blocked after cutover.** Password-protect staging or
send `X-Robots-Tag: noindex` from the server — not from the application's own
config, because shipping that config to production is how a site launches
invisible to Google.

```bash
curl -sSI https://example.com/ | grep -i 'x-robots-tag'   # must be empty in production
curl -sS  https://example.com/robots.txt                   # must not Disallow: /
```

## R-6 · The functionality that was a plugin

On the old platform, features were plugins or built-in. In the new stack they
are integrations somebody has to choose, build and test. Inventory them
explicitly during R-1, because each one is a decision and not a port:

- **Forms** — and where submissions go. There is no database behind a static
  rebuild. Pick the endpoint, submit a real test entry, confirm the
  notification arrives, and confirm spam protection works.
- **Search** — the old CMS had it for free. Now it is an index (Pagefind,
  Algolia, Meilisearch) or it does not exist.
- **Comments** — migrate them, move to a hosted service, or remove them. All
  three are fine; silently losing them is not.
- **Commerce and memberships** — gated content, logins, subscriptions, saved
  carts. If money or accounts are involved, this is its own project. Do not
  fold it into a re-platform.
- **Redirects already in place** on the old platform, from previous moves. They
  are rules someone added for a reason and they do not export themselves. Get
  them out of the old `.htaccess`, SEO plugin, or platform dashboard and fold
  them into the new map.
- **Scheduled and transactional email** — order confirmations, password resets,
  digest sends.

## R-7 · Prove it, then cut over

```bash
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory-frozen.json --out out
node scripts/linkcheck.mjs https://staging.example.com --out out
```

On a re-platform, expect `parity.mjs` to report a long list on the first run —
that is the point. Resolve every row: fix the rebuild, or record an intentional
301 and re-run. The report is empty before you touch DNS, or you are not ready.

Titles will differ slightly and word counts will shift as markup changes; read
those rows and judge them. **Missing** and **erroring** rows are not
judgement calls.

Confirm the redirect map is actually loaded on staging before cutover, not just
generated:

```bash
while IFS=, read -r old new; do
  [ "$old" = "old_path" ] && continue
  code=$(curl -o /dev/null -sS -w '%{http_code}' "https://staging.example.com$old")
  [ "$code" = "301" ] || echo "NOT REDIRECTING: $old -> $code"
done < mapping.csv
```

Then the standard cutover: certificate first, TTL lowered, explicit
confirmation, DNS last — [DNS cutover](./dns-cutover.md). Keep the old platform
running through the monitoring window; it is the rollback.

## R-8 · After cutover, watch the thing a re-platform breaks

Submit the new sitemap in Search Console and then actually watch it, for longer
than a host move needs:

- **Coverage and 404s, weekly for a month.** A re-platform's missed URLs appear
  in Search Console's 404 report before they appear in your traffic. Each one
  gets a 301, not a shrug.
- **Rankings per URL, not in aggregate.** Site-wide traffic can look flat while
  the twenty pages that earned it have quietly dropped.
- **Core Web Vitals.** Different stack, different numbers — usually better, but
  measure rather than assume.
- **Internal links** on the live site: `node scripts/linkcheck.mjs
  https://example.com --out out-prod`.

Keep `out/inventory-frozen.json` permanently. It is the only record of what the
site used to be, and the only way to answer "did we lose a page?" six months
later.
