---
name: site-migration
description: >-
  Migrate a website without losing content, SEO, or uptime. Covers both shapes
  of the job: moving a site to a new platform/framework/domain (crawl the old
  site, prove URL-for-URL parity, generate the 301 map) and moving a site
  host-to-host (back up, dump the database, rsync, serialized-safe URL rewrite,
  fix permissions, verify by IP, cut DNS over with a rollback plan). Use when
  the user wants to move, re-platform, re-host, or re-domain a site — triggers
  include "migrate my site", "move off WordPress/Wix/Squarespace/Vercel",
  "re-platform to Next.js", "self-host this site", "move to a new server",
  "switch hosting", "cPanel to VPS", "transfer WordPress", "change the domain",
  "migrate without losing SEO", or "cut over to the new site". Runs a phased,
  verify-before-cutover workflow with read-only audit scripts and dry-run-first
  shell helpers.
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

## Two paths — pick one, or run both

| | **A. Platform / domain change** | **B. Host-to-host move** |
|---|---|---|
| **The job** | The site is being rebuilt, re-platformed, or re-domained. | The same site moves to a new box. |
| **Access needed** | HTTP only. | Shell + usually SSH to both hosts, DB credentials. |
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

### A3. Plan the move

- Map old URLs → new URLs. If the structure is identical, you want identity
  redirects (handled for you). If it changes, produce a `mapping.csv` of
  `old_path,new_path`.
- Decide content migration method: export/import, scripted port, or manual.
- List integrations to re-wire (analytics IDs, form endpoints, payment keys,
  search, CDN) and schema/metadata to carry over.
- Define the parity bar: status match, title/H1 present, content not gutted.

### A4. Rebuild on staging

Build the new site on its temporary URL. Carry over content, templates,
metadata (titles, descriptions, canonical, Open Graph), and structured data.
Re-point integrations at test/staging credentials where possible. Nothing here
touches the live site.

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
quietly disappears from search. Removing them at cutover is step A7's last
checkbox and step A8's first verification.

### A5. Verify parity (the gate)

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

### A6. Generate the redirect map

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

### A7. Pre-cutover checklist

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

### A8. Cutover

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

### A9. Post-cutover

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

Read the report back to the user. It prints the detected stack, size, WordPress
DB settings (never the password), runtime versions on the target, and a go/no-go
checklist. Use it to size the work and spot problems early (missing wp-cli, an
Apache `.htaccess` that needs an nginx translation, a huge uploads dir).

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
See A4 and the A7 checklist; the failure mode is identical.

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

### B5. Import the database and rewrite URLs

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
handles nested serialized objects. Run it only after the DB dump exists. For a
non-WordPress site with URLs baked into a DB or config, identify the storage
format first; only use a plain find/replace when you are certain nothing is
serialized.

Then update `wp-config.php` DB credentials for the new host, and translate
`.htaccess` rewrites to the destination webserver's config if the webserver
changed (Apache → nginx).

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
- **Mixed content** after an http→https move — the search-replace handles the DB;
  check hardcoded `http://` refs too.
- **Larger-than-RAM DB dumps** — `db-dump.sh` uses `--quick` to stream rather
  than buffer.
- **A staging site on loopback or a LAN IP** — the audit scripts refuse private
  addresses by default; name it with `--allow-host`.
