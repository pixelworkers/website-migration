<!-- PLACEHOLDER: Cathy rewrites this notice -->
<!--
     Top-of-README notice. Cathy owns the final copy — do not write it here.
     Brief: baseline coding knowledge is assumed to run this yourself, and
     "ask Pixelworkers for paid help at Pixelworkers.org" for anyone who'd
     rather not. Replace this whole comment block, keep the marker above until
     the copy lands.
-->

# site-migration

A [Claude Code](https://claude.com/claude-code) skill for migrating a website —
to a new platform, a new framework, a new domain, or a new host — **without
losing content, SEO, or uptime**.

Any source and any target: WordPress, Squarespace, Wix, Webflow, Shopify, a
hand-rolled PHP or Node app, or plain static files — into Next.js, a static
generator, another CMS, or your own server.

Maintained by [Pixelworkers](https://pixelworkers.org).

Most migrations go wrong in one of three ways: pages silently vanish, old links
start 404ing and tank search rankings, or someone flips DNS before the new site
is actually ready. This skill makes those outcomes hard to reach by accident. It
runs a phased, **verify-before-cutover** workflow on one principle:

> The old site stays live and untouched until the new site is proven, URL for
> URL, to be at least as good. DNS is the last step, never the first.

## What it migrates

| Source | Target | Path |
|---|---|---|
| Squarespace, Wix, Webflow, Shopify content | Next.js, Astro/Hugo/Eleventy, another CMS, your own server | A |
| WordPress | Next.js, a static generator, another CMS | A |
| WordPress | a new host, same stack | B |
| Static HTML, Jekyll/Hugo, hand-rolled PHP | anywhere | A or B |
| Laravel, Drupal, Joomla, custom PHP | a new server | B |
| Node app | a new server | B |
| Anything with no export at all | anywhere | A — the crawler is the migration |

`SKILL.md` carries a per-source export recipe for each of these (step A3) and a
per-stack data-layer recipe for each server move (step B5).

## Two paths

| | **A. Platform / domain change** | **B. Host-to-host move** |
|---|---|---|
| **The job** | The site is rebuilt, re-platformed, or re-domained. | The same site moves to a new box. |
| **Access needed** | HTTP only (plus whatever export the source offers). | Shell + usually SSH to both hosts, DB credentials. |
| **Tooling** | Read-only crawlers (`scripts/*.mjs`, Node 18+). | Dry-run-first shell helpers (`scripts/*.sh`, bash). |
| **Gate** | `parity.mjs` reports zero problems. | `verify.sh` passes against the new host by IP. |

They compose: a WordPress site moving to a new host *and* a new domain runs
Path B for the move and Path A's inventory/parity/redirects as the pre-cutover
gate. A Squarespace site becoming a self-hosted Next.js build runs Path A for
the content and the parity gate, and borrows Path B's provision/permissions/
verify-by-IP steps for the new box.

## Install

Clone into your Claude skills directory:

```bash
# Claude Code / Agent SDK (personal skills)
git clone https://github.com/pixelworkers/wordpress-migration.git \
  ~/.claude/skills/site-migration
```

Or vendor it into a project at `.claude/skills/site-migration/`. Claude
auto-loads the skill when a request looks like a site migration; you can also
invoke it by name, or just describe the job — *"migrate my Squarespace site to
self-hosted Next.js without losing SEO"*, *"move oldsite.com from cPanel to my
VPS"*.

Make the shell helpers executable (a clone usually preserves this):

```bash
chmod +x ~/.claude/skills/site-migration/scripts/*.sh
```

## What's in the box

| File | Purpose |
| --- | --- |
| `SKILL.md` | The workflow and safety doctrine Claude follows. |
| **Path A — read-only audit** | |
| `scripts/inventory.mjs` | Crawl the source site → complete URL inventory (JSON + CSV). |
| `scripts/parity.mjs` | Compare old vs new URL-by-URL; the cutover gate. |
| `scripts/redirects.mjs` | Generate 301 redirect configs (Caddy / nginx / Netlify / Next.js). |
| `scripts/linkcheck.mjs` | Crawl a site and report broken links. |
| `scripts/lib.mjs` | Shared, dependency-free HTTP + HTML helpers. |
| `scripts/guard.mjs` | The network and filesystem trust boundary. |
| **Path B — host-to-host** | |
| `scripts/preflight.sh` | Inventory, sanity report, go/no-go checklist. |
| `scripts/backup.sh` | Integrity-checked tar of the files (+ optional DB dump). |
| `scripts/db-dump.sh` | `mysqldump` wrapper; credentials never touch a command line. |
| `scripts/transfer.sh` | `rsync` wrapper; previews by default, refuses to delete. |
| `scripts/wp-search-replace.sh` | Serialized-safe URL rewrite via `wp search-replace`. |
| `scripts/fix-perms.sh` | Normalize permissions; refuses system roots. |
| `scripts/verify.sh` | HTTP status sweep old-vs-new, testing the new host by IP. |

## Quickstart

### Path A — a rebuild on a staging URL

Migrating `https://oldsite.com` to a rebuild staged at
`https://staging.newsite.com`. The commands are the same whether the source is
WordPress, Squarespace, Wix, Webflow, Shopify or hand-written HTML — only the
content export in step 1b differs:

```bash
# 1. Inventory the live source (read-only)
node scripts/inventory.mjs https://oldsite.com --out out

# 1b. Get the content out of the source platform. SKILL.md step A3 has the
#     recipe per source (WXR, ?format=json, collection CSVs, Admin API, or the
#     crawl when there is no export). Diff it against out/inventory.csv —
#     anything in the inventory and not in the export is content you'd lose.

# 2. Build the new site on its staging URL (your work).
#    Put noindex + robots Disallow + basic auth on staging — and remember to
#    take all three off at cutover. SKILL.md step A5 explains why.

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

### Path B — the same site on a new server

Works for WordPress, generic PHP (Laravel/Drupal/Joomla/custom), Node apps and
static files; `preflight.sh` detects which. Point Claude at the job in plain
language:

> Migrate `oldsite.com` on `user@oldhost:/var/www/site` to `user@newhost`,
> same domain. I have SSH to both and the DB credentials.

Claude will run the pre-flight, back up, transfer, rewrite URLs if the domain is
changing, fix permissions, verify against the new host by IP, and only then walk
you through the DNS cutover — pausing for your confirmation at the gates.

WordPress gets the scripted serialized-safe rewrite (`wp-search-replace.sh`).
The other stacks get a step-by-step recipe instead — Laravel's cached config and
storage symlink, Drupal's `trusted_host_patterns`, Joomla's absolute
`$log_path`, a Node app's native modules and process manager.

You can also run any script yourself; each prints `--help`:

```bash
scripts/preflight.sh --path /var/www/site --ssh user@oldhost --url https://oldsite.com
scripts/backup.sh    --path /var/www/site --out ./backups --ssh user@oldhost --with-db        # preview
scripts/backup.sh    --path /var/www/site --out ./backups --ssh user@oldhost --with-db --go   # take it
scripts/transfer.sh  --from user@oldhost:/var/www/site/ --to /var/www/site/        # preview
scripts/verify.sh    --old https://oldsite.com --new https://newsite.com --new-ip 203.0.113.9
```

## Safety

This skill is non-destructive by design.

- **The source is only ever read.** It is never moved, modified, or deleted.
- **Everything is backed up before any change,** and the skill tells you how to
  prove the backup restores.
- **Writes are dry-run by default.** `backup.sh`, `transfer.sh`,
  `wp-search-replace.sh`, and `fix-perms.sh` preview their changes and only act
  with an explicit `--go`. Without `--go` they write nothing at all — not even an
  output directory — and they say so rather than reporting success.
- **Destructive steps are gated, and they fail closed.** `transfer.sh` will not
  delete destination files unless you pass `--mirror` and confirm interactively.
  `wp-search-replace.sh --go` and `fix-perms.sh --go` ask before they write; with
  no terminal they refuse unless you also pass `--yes`, so an unattended run can
  never quietly rewrite a production database or recurse over a live doc root.
- **`fix-perms.sh` refuses system roots.** `--path /`, `/home`, `/usr`, `/var`,
  `/var/www` and friends are rejected; it wants a real site root like
  `/var/www/site`.
- **Your values are never shell code.** Every command is built as an argument
  list, not as a string. Paths, URLs, DB names and owners are passed as
  arguments; remote commands quote each value exactly once. A path containing a
  quote gets chmod'd, not executed.
- **Backups are proven, not assumed.** An archive is only reported as complete
  after it exists, its SHA-256 is written beside it, and `tar -t` has read it end
  to end. If any of that fails the partial file is removed and the script exits
  non-zero. A database dump is judged on `mysqldump`'s own exit status, not the
  compressor's, so a dump that dies halfway is a failure rather than a
  plausible-looking file.
- **Verification gates the cutover.** The skill will not flip DNS or delete the
  source until the verification sweep passes and you confirm it.
- **Secrets never touch the repo, the command line, or `ps`.** Database
  credentials are read from environment variables or an interactive prompt. The
  password reaches `mysqldump` through its process environment locally, and over
  SSH it is sent on stdin for the remote shell to read into its own environment —
  so it appears in neither host's `ps` output. It is never printed or committed,
  and `.gitignore` excludes env files, dumps and `wp-config.php`.

### The audit scripts treat the target site as hostile

They follow URLs the audited site supplies — sitemap entries, `<a href>`
targets, `Location:` headers — so a crawl is an instruction set written by
someone else. That makes them an SSRF and denial-of-service surface, and they
are built accordingly:

- **Only `http:` and `https:` are fetched.** `file:`, `gopher:`, `data:` and the
  rest are refused, not merely skipped as links.
- **Private destinations are refused** — loopback, RFC1918, link-local
  (including `169.254.169.254`), CGNAT, unique-local IPv6, and the cloud
  metadata hostnames. Encoded forms (`0x7f000001`, `2130706433`, `127.1`,
  `::ffff:127.0.0.1`) are caught, and hostnames are resolved so a public name
  pointing at an internal address is refused too.
- **Redirects are followed one hop at a time** with the same check on every hop,
  so a same-origin URL that 302s to a metadata endpoint goes nowhere.
- **Sitemap fan-out is origin-restricted and capped.** A `<sitemapindex>`
  pointing off-origin contributes nothing.
- **Response bodies are capped at 5 MB** and read incrementally, and every HTML
  and XML extractor is linear-time. A 560 KB page of malformed markup parses in
  milliseconds instead of stalling the run.
- **Generated redirect configs are validated**, so a path out of an untrusted
  `mapping.csv` cannot inject a directive into your Caddyfile or nginx config.
- **Reports stay inside the working directory** and an existing file is never
  overwritten without `--force`.

Testing against a staging site on loopback or a LAN IP? Name it explicitly:

```bash
node scripts/parity.mjs https://oldsite.com http://127.0.0.1:3000 \
  --inventory out/inventory.json --allow-host 127.0.0.1:3000 --out out
```

`--allow-host` (or `SITE_MIGRATION_ALLOW_HOSTS`) vouches for exactly the
`host` or `host:port` you name — allowing `127.0.0.1:3000` does not also open
`169.254.169.254`.

Credentials, server details, and the production database are yours. Review what
each script will do (they print their plan) before running with `--go`.

## Requirements

- **Path A:** Node.js 18 or newer (uses built-in `fetch`). Tested on 18, 20 and
  22. No npm install, no dependencies.
- **Path B, local / orchestrator:** `bash`, `rsync`, `curl`, `tar`, `ssh`,
  `gzip`, and one of `sha256sum` (most Linux) or `shasum` (macOS/BSD) for backup
  checksums.
- **On a WordPress destination:** [`wp-cli`](https://wp-cli.org/) for the
  serialized-safe URL rewrite.
- **On the database host:** `mysqldump` / `mysql` (the dump wrapper is
  MySQL/MariaDB; for PostgreSQL use `pg_dump` yourself — `SKILL.md` B5c says
  how).
- **Optional:** `wget`, if you mirror a static source that has no shell access.

## Tests

Scripts are POSIX-friendly bash and dependency-free Node. A `shellcheck` pass
and two behavioural suites run in CI on every push — on Linux (bash 5) and macOS
(bash 3.2, the oldest bash supported here), and on Node 18, 20 and 22.

```bash
tests/smoke.sh                                                               # bash helpers
shellcheck -x -s bash scripts/*.sh scripts/lib/common.sh tests/smoke.sh
node tests/node-smoke.mjs                                                    # audit scripts
```

`tests/smoke.sh` stubs `ssh`, `mysqldump` and `wp` to assert the things that
matter: that values are passed as arguments and never executed, that passwords
stay out of every `ps`-visible argv, that a dry run writes nothing and claims
nothing, that a real backup is checksummed and readable end to end, and that a
truncated dump is reported as a failure rather than a backup.

`tests/node-smoke.mjs` is the security regression suite for the audit scripts.
Every case in it was a real finding first: SSRF through a sitemap index, SSRF
through a redirect, quadratic blowup on malformed HTML, an unbounded response
body, an origin escape from a concatenated URL, config injection via a redirect
map, and a report written outside the working directory. It runs against
loopback servers it starts itself, so it needs no network. It also asserts that
`SKILL.md` still declares its full multi-platform scope and that every internal
anchor in it resolves.

Beyond those platforms, treat it as untested — read the script and run the
preview first.

## Why Pixelworkers open-sourced this

Moving a website used to be a line item you paid a specialist for. It isn't
anymore. A human working with a capable agent can do a careful, verifiable
migration in an afternoon, so the paid wrapper around these steps doesn't need
to exist. We'd rather publish the method than sell it. Use it, read it, improve
it.

Built by [Pixelworkers](https://pixelworkers.org).

## License

MIT © Pixelworkers. See [LICENSE](./LICENSE).
