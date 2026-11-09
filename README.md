# website-migration

> **Before you begin — a note from Pixelworkers**
>
> This is a developer tool. It assumes you're comfortable at the command line, and
> that you read a script before you run it. Followed as documented, it's
> non-destructive. But it's yours to drive — your servers, your data.
>
> If you'd rather not drive it, or you want a hand with any part of it, that's the
> work we do. Pixelworkers will do it with you, or for you — see how that works and
> what it costs at [pixelworkers.org](https://pixelworkers.org).

A [Claude Code](https://claude.com/claude-code) skill for migrating a website to
a new platform, framework, or host **without losing content, SEO, or uptime**.

Maintained by [Pixelworkers](https://pixelworkers.org).

Most migrations go wrong in one of three ways: pages silently vanish, old links
start 404ing and tank search rankings, or someone flips DNS before the new site
is actually ready. This skill makes those outcomes hard to reach by accident. It
runs a phased, **verify-before-cutover** workflow backed by four read-only audit
scripts, on one principle:

> The old site stays live and untouched until the new site is proven, URL for
> URL, to be at least as good. DNS is the last step, never the first.

## Install

The skill lives at the root of this repo, so the clone *is* the skill
directory — clone it straight into your skills directory and Claude Code
discovers it:

```bash
# user-scoped (available in every project)
git clone https://github.com/pixelworkers/website-migration.git \
  ~/.claude/skills/website-migration

# or project-scoped (this project only)
git clone https://github.com/pixelworkers/website-migration.git \
  .claude/skills/website-migration
```

Update it later with `git -C ~/.claude/skills/website-migration pull`.

Then just describe the migration to Claude Code — e.g. *"move my WordPress site
to a new host"* or *"migrate my Squarespace site to self-hosted Next.js without
losing SEO"* — and the skill activates.

## Moving a WordPress site to a new host

That is the common case, and it has its own step-by-step recipe in `SKILL.md`:
[WordPress → WordPress](./SKILL.md#wordpress--wordpress-moving-one-site-to-a-new-host).
Pre-flight inventory, back up the source first, `rsync` the files, `mysqldump`
the database, then the step everyone gets wrong — rewriting URLs with
`wp search-replace --precise --recurse-objects`, never a SQL `REPLACE()`, which
corrupts WordPress's serialized PHP and empties theme options and page-builder
layouts. Then verify on staging, issue SSL on the new host, and only then move
DNS, with the old host left running as the rollback.

## Moving something that isn't WordPress

The nine phases are the same for every stack; only the commands change. Each
platform has its own recipe at the same depth as the WordPress one:

| Moving | Recipe |
| --- | --- |
| Static / generated site (Astro, Hugo, Eleventy, Jekyll, a Vite SPA) | [`references/static-sites.md`](./references/static-sites.md) |
| PHP app — bespoke, Laravel, Symfony, Drupal, Joomla | [`references/php-apps.md`](./references/php-apps.md) |
| Node app — Next.js, Nuxt, Remix, SvelteKit, Express, Strapi | [`references/node-apps.md`](./references/node-apps.md) |
| PostgreSQL / SQLite / MongoDB / Redis | [`references/databases.md`](./references/databases.md) |
| Off Wix, Squarespace, Webflow, Shopify, or cPanel with no shell | [`references/managed-platforms.md`](./references/managed-platforms.md) |
| Off Vercel, Netlify or Cloudflare Pages onto your own server | [`references/managed-platforms.md`](./references/managed-platforms.md) § M-5 |
| Changing stack — WordPress → Next.js, Squarespace → Astro | [`references/replatform.md`](./references/replatform.md) |

Plus three that apply to every migration: [DNS and
certificates](./references/dns-cutover.md), [moving a site that's still taking
orders](./references/live-site-windows.md), and [symptom →
cause](./references/troubleshooting.md).

## What's in the box

| File | Purpose |
| --- | --- |
| `SKILL.md` | The workflow, the WordPress host-to-host recipe, and the safety doctrine Claude follows. |
| `references/` | Per-platform recipes — static, PHP/Laravel, Node, databases, managed platforms, re-platforming — plus DNS cutover, live-site windows, and troubleshooting. |
| `scripts/inventory.mjs` | Crawl the source site → complete URL inventory (JSON + CSV). |
| `scripts/parity.mjs` | Compare old vs new URL-by-URL; the cutover gate. |
| `scripts/redirects.mjs` | Generate 301 redirect configs (Caddy / nginx / Netlify / Next.js). |
| `scripts/linkcheck.mjs` | Crawl a site and report broken links. |
| `scripts/lib.mjs` | Shared, dependency-free HTTP + HTML helpers. |
| `tests/` | Regression tests for the SSRF guards and the parser bounds. `node --test tests/*.test.mjs`. |

## Requirements

- Node.js 18 or newer (uses built-in `fetch`). Tested on Node 20 and 22.
- No npm install. No dependencies. The scripts only issue HTTP `GET`/`HEAD`
  requests and write report files — they never mutate a target site.
- **The scripts are read-only and fetch only the origin you point them at:**
  every URL that arrives as remote data — a sitemap entry, an `<a href>`, a
  `Location` header, a path in an inventory file — is checked against that
  origin first, and every request is bounded by a timeout, a response-size cap,
  and page/depth limits.

## Tests

```bash
node --test tests/*.test.mjs
```

No install step; the tests use Node's built-in runner and spin up local HTTP
servers. They cover the two things this tooling is genuinely exposed to when
pointed at a site someone else controls:

- **SSRF through harvested URLs.** A hostile `sitemap.xml` listing off-origin
  `<loc>` entries, an off-origin child sitemap, an `<a href>` pointing at
  `169.254.169.254` or a LAN address, an inventory path carrying a host of its
  own. Each test asserts that a stand-in "metadata service" receives *zero*
  requests and that nothing off-origin reaches the report files.
- **Quadratic parsing.** Every hostile markup shape is built at the real 5 MB
  body cap (`'<script '` repeated, unclosed `<title>` repeated, half a megabyte
  of `name="description" `, bare `<` to the cap) and asserted to parse in well
  under a second, so a timing regression fails in CI rather than in front of a
  client's site.

CI runs the suite plus `node --check` on every script, on Linux and macOS.

## Worked example

Migrating `https://oldsite.com` to a rebuild staged at
`https://staging.newsite.com`:

```bash
# 1. Inventory the live source (read-only)
node scripts/inventory.mjs https://oldsite.com --out out
# re-running into the same --out? the scripts refuse to clobber; pass --force

# 2. Build the new site on its staging URL (your work).
#    Keep staging noindex the whole time it lives there — X-Robots-Tag header,
#    <meta name="robots">, robots.txt — and remove every one of them at cutover.
#    See "Rebuild on staging" in SKILL.md.

# 3. Prove parity — this is the gate. Resolve every problem it reports.
node scripts/parity.mjs https://oldsite.com https://staging.newsite.com \
  --inventory out/inventory.json --out out
cat out/parity-report.md

# 4. Catch broken links on the rebuild
node scripts/linkcheck.mjs https://staging.newsite.com --out out

# 5. Generate the 301 redirect map for your stack
node scripts/redirects.mjs --inventory out/inventory.json --out out --format caddy
# (changed URLs? feed a mapping.csv of old_path,new_path instead of --inventory)

# 6. Work the pre-cutover checklist in SKILL.md, then — only with sign-off —
#    point DNS at the new host and re-verify against the live domain.
```

`parity.mjs` and `linkcheck.mjs` exit non-zero while problems remain, so they
can gate a CI pipeline or a cutover script.

## Safety

The scripts are read-only over HTTP by design — `GET`/`HEAD` only, no shell-out,
no `eval`, no credentials, and no filesystem access outside the `--out`
directory.

Pointing an audit at a site you do not control means the site gets to choose
what URLs you see, so none of them are trusted as fetch targets:

- **Origin-restricted.** Sitemap `<loc>` entries, child sitemaps, `<a href>`
  targets, `Location` headers and inventory paths are all checked against the
  origin you named before any request. Off-origin entries are reported in the
  report files, never fetched. Paths are resolved with `new URL(path, origin)`
  and the result's origin is asserted, rather than concatenated onto a string.
- **No private addresses.** Loopback, RFC1918, CGNAT, link-local,
  `*.local`/`*.internal` and cloud instance-metadata endpoints
  (`169.254.169.254` and its equivalents) are refused on the strength of remote
  content — a hostile sitemap cannot make the auditing machine read its own IAM
  credentials. Auditing a local staging site still works; the origin you name is
  yours to name.
- **Linear parsers.** HTML and XML are walked with index scans instead of
  backtracking regexes, so markup crafted to make a parser go quadratic costs
  milliseconds, not minutes.
- **No accidental overwrites.** Output is confined to the working directory, and
  an existing file is left alone unless you pass `--force`.
- **Bounded everywhere else.** Requests time out at 15s, bodies are capped at
  5 MB, and crawls are bounded by `--max` pages and `--max-depth` levels. All
  the limits are in `LIMITS` at the top of `scripts/lib.mjs`.
- **Generated config is not injectable.** `redirects.mjs` emits config you
  paste into a web server, built from untrusted input — paths crawled off
  another site, or a CSV someone sent you. It accepts only rooted paths and
  `http(s)` destinations and rejects any pair carrying a character that could
  terminate the generated directive, listing what it dropped rather than
  passing it through silently.

Each of these has a regression test — see [Tests](#tests).

The workflow in `SKILL.md`
additionally requires a source backup, a staged (non-DNS) rebuild, proven
parity, a loaded redirect map, a low DNS TTL, a running old host through the
monitoring window, and explicit human confirmation before any irreversible step
(DNS change, source deletion, old-host decommission).

## License

MIT © Pixelworkers. See [LICENSE](./LICENSE).
