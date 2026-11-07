---
name: site-migration
description: >-
  Migrate a website to a new host, platform, or framework without losing
  content, SEO, or uptime — including the plain WordPress host-to-host move.
  Use when the user wants to move, re-host, or re-platform a site — triggers
  include "move my WordPress site to a new host", "migrate WordPress to a new
  server", "transfer my site off cPanel/WP Engine/GoDaddy/Bluehost/SiteGround",
  "WordPress migration", "migrate my site", "move off
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

- **Moving a WordPress site to a new host, staying WordPress** — the most common
  case. Follow the general workflow below, and use the step-by-step recipe in
  [WordPress → WordPress: moving one site to a new host](#wordpress--wordpress-moving-one-site-to-a-new-host)
  for the concrete commands.
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
3. **Stand the new site up on a temporary URL, and keep it out of the index.**
   A staging subdomain or preview URL. The new site must be fully testable
   without any DNS change — and it must be `noindex` for as long as it lives
   there, or Google indexes the staging host and you end up competing with
   yourself. Removing that `noindex` is a step in the cutover, not an
   afterthought.
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

Moving a WordPress site to a new host? These phases still govern — the
WordPress-specific commands for each are in
[WordPress → WordPress](#wordpress--wordpress-moving-one-site-to-a-new-host)
below.

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

**Block search engines on the staging host, from the first deploy.** A staging
copy of a real site is a duplicate of it; if Google crawls it you get split
signals, the wrong host ranking, and a staging URL showing up in results that
outlives the migration. Do all three — any one of them alone has a hole:

```
X-Robots-Tag: noindex, nofollow        # response header, covers PDFs and assets too
<meta name="robots" content="noindex, nofollow">   # every page, in <head>
```

```
# robots.txt on the staging host only
User-agent: *
Disallow: /
```

- On WordPress staging: Settings → Reading → *Discourage search engines*, which
  sets both the meta tag and `robots.txt`. Verify it rather than trusting it.
- Put HTTP basic auth on staging as well where you can. It is the only one of
  these that a crawler cannot ignore, and it keeps the client's unfinished
  rebuild away from the public.
- `robots.txt` alone does **not** remove a URL already indexed, and `Disallow`
  blocks the crawl that would otherwise *see* your `noindex`. That is why the
  header and the meta tag matter more than the `robots.txt`.
- Keep canonical tags on staging pointing at the **final** production URLs, not
  at the staging host — see the parity check for `canonical points off-site`.

Write down, now, that this has to come off at cutover. Staging `noindex` that
ships to production is the single most common way a migrated site loses all its
traffic the week after it goes live.

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
- [ ] **Every place the staging `noindex` lives is written down** — response
      header, `<meta robots>`, `robots.txt`, WordPress *Discourage search
      engines*, CDN/host-level rule, basic auth — so the next item can be done
      without missing one
- [ ] Canonical tags on the rebuild point at the production URLs, not staging
- [ ] Old host will stay running 48–72h post-cutover
- [ ] Rollback steps written down; user has approved cutover

**At cutover, remove the staging `noindex`.** Go down that list and clear every
entry: the `X-Robots-Tag` header, the `<meta name="robots">` tag,
`Disallow: /` in `robots.txt`, WordPress *Discourage search engines*, any
host- or CDN-level rule, and basic auth. Then prove it on the live domain before
you call the migration done:

```bash
curl -sI https://realdomain.com/ | grep -i x-robots-tag        # expect nothing
curl -s  https://realdomain.com/ | grep -i 'name="robots"'     # expect nothing, or index,follow
curl -s  https://realdomain.com/robots.txt                     # expect no blanket Disallow: /
```

A site that goes live still carrying `noindex` looks completely fine to
everyone, including the client, right up until the traffic disappears a week
later. These three commands are the cheapest insurance in the whole migration.

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

- Re-run the three `curl` checks above against the live domain. Confirm no
  `noindex` survived cutover before anything else.
- Submit the new sitemap to Google Search Console; watch coverage + 404s for
  1–2 weeks. Use the URL Inspection tool on the homepage and one deep page —
  it reports indexability directly, and it is the check that catches a
  host-level `noindex` the `curl` greps missed.
- Monitor the live site (errors, Core Web Vitals, form submissions).
- Keep the old host and the rollback path available through the monitoring
  window.
- Only after the window is clean and the user approves: decommission the old
  host.

## WordPress → WordPress: moving one site to a new host

This is the most common migration there is: the site stays WordPress, only the
box underneath it changes. It is also where most of the damage happens, because
the WordPress database stores URLs and absolute paths **inside serialized PHP**,
and the obvious fix — a SQL find-and-replace — silently destroys them.

Work these steps in order. They are non-destructive: the source host is only
ever read, with one optional exception — briefly enabling maintenance mode on it
during the final sync at cutover (WP-11), which is one file and reversible.

> **The one rule that matters most:** rewrite URLs with `wp search-replace`.
> **Never** `UPDATE … SET … REPLACE()` in SQL. See [WP-6](#wp-6--urls-and-paths-serialized-safe).

### WP-1 · Pre-flight inventory

Record what you have before you touch anything. Run on the **source** host:

```bash
# WordPress, PHP, DB
wp core version                       # WP version
php -v && php -m                      # PHP version + loaded extensions
wp db query "SELECT VERSION()"        # MySQL/MariaDB version
wp db query "SELECT @@character_set_database, @@collation_database"
wp config get table_prefix            # table prefix (must match on the new host)
wp eval 'echo ABSPATH;'               # filesystem path baked into the install

# What is actually running
wp plugin list --fields=name,status,version
wp theme list  --fields=name,status,version
wp option get siteurl && wp option get home
wp core is-installed --network && echo "MULTISITE"   # multisite needs extra care

# Size of the job
du -sh . wp-content wp-content/uploads
wp db size --human-readable
```

No wp-cli on the source? Read `wp-config.php` for `DB_*`, `$table_prefix` and any
`WP_HOME`/`WP_SITEURL`/`WP_CONTENT_URL` constants, and get versions from
`wp-includes/version.php`, `phpinfo()` and `mysql --version`.

Also note, by hand:

- Web server (Apache / nginx / LiteSpeed) and whether `.htaccess` is in play.
- Anything in front of the origin: Cloudflare or another proxy, a CDN, a WAF.
- Object cache (`wp-content/object-cache.php` → Redis/Memcached) and page cache
  (`advanced-cache.php`), plus whichever plugin installed them.
- `mu-plugins/` — managed hosts (WP Engine, Kinsta, Pressable, SiteGround)
  install must-use plugins and host-only caching plugins that **will not work on
  the new host**. List them now; you will remove them in WP-5.
- Outbound mail: an SMTP plugin, or PHP `mail()` from the old IP. A new IP means
  new SPF/DKIM alignment — plan for it.
- Real cron entries (`crontab -l`) if `DISABLE_WP_CRON` is set.
- Licensed/keyed plugins that bind to a domain or IP and need reactivating.

**Destination must match or exceed the source:** same PHP major version to start
(upgrade *after* the move is verified, never during it), a MySQL/MariaDB version
at least as new, the same character set and collation (`utf8mb4` /
`utf8mb4_unicode_ci` on anything modern — importing a `utf8mb4` dump into a
`latin1` database mangles every accent and emoji), and every PHP extension the
site actually uses.

### WP-2 · Back up the source — before anything else

Non-negotiable, and it is the step that makes every later step safe.

```bash
# Database (wp-cli handles charset and locking correctly)
wp db export ~/backup-$(date +%F)-db.sql --single-transaction --default-character-set=utf8mb4
# no wp-cli:
mysqldump --single-transaction --quick --default-character-set=utf8mb4 \
  --routines --triggers --events -u DBUSER -p DBNAME > ~/backup-$(date +%F)-db.sql

# Files (the whole WordPress root)
tar -czf ~/backup-$(date +%F)-files.tar.gz -C /path/to/wordpress .

# Verify the dump is actually complete, not a truncated half-write
tail -1 ~/backup-*-db.sql      # must read: -- Dump completed on …
ls -lh ~/backup-*             # non-trivial sizes
sha256sum ~/backup-*          # record, re-check after transfer
```

Pull both off the source host to somewhere else. Then record the current DNS
zone — every A, AAAA, CNAME, MX, TXT record and its TTL — so a rollback is a
copy-paste, not a reconstruction.

From here on the source is **read-only**. Do not "clean it up first".

### WP-3 · Stand the new host up on a temporary URL

Create the database and user, install the matching PHP/MySQL, and get WordPress
answering on something that is **not** the live domain yet:

- a staging hostname you control (`staging.example.com`), or
- the host's own temporary URL, or
- **best: a `/etc/hosts` entry on your own machine** mapping the real domain to
  the new server's IP. The site runs under its real URL, so you need no URL
  rewrite at all now and no second one later — and the public DNS has not moved.

```bash
# on your machine, not the server
echo "203.0.113.10  example.com www.example.com" | sudo tee -a /etc/hosts
```

If you stage on a different hostname instead, you will run `wp search-replace`
twice (once to the staging URL, once back to the real one). That works, it is
just two chances to get it wrong.

### WP-4 · Move the files

`rsync` over SSH, preserving timestamps and permissions. Run it from the source
if the source has SSH out; otherwise pull to your machine and push up.

```bash
rsync -azP --delete \
  --no-owner --no-group \
  --exclude '.git' \
  --exclude 'wp-content/cache/' \
  --exclude 'wp-content/*-cache/' \
  --exclude 'wp-content/backups/' \
  --exclude 'wp-content/updraft/' \
  --exclude 'wp-content/uploads/backwpup*' \
  --exclude 'wp-config.php' \
  /path/to/wordpress/ user@newhost:/var/www/example.com/
```

- `-a` carries permissions, times and symlinks; `-z` compresses; `-P` makes it
  resumable, which matters on a multi-gigabyte `uploads/`.
- `--no-owner --no-group`: UIDs rarely match across hosts. You set ownership
  explicitly in WP-7.
- `--exclude wp-config.php` deliberately — the new host needs its own DB
  credentials. Copy it separately as a reference, then edit (WP-5).
- `--delete` makes repeat runs a true mirror. Safe here because the destination
  is new; think twice if anything else lives in that directory.
- Caches and plugin backup folders are excluded: they are large, stale, and
  regenerate.

No SSH on the source (managed host, SFTP only)? Pull with
`rsync -azP --no-owner --no-group user@oldhost:/path/ ./local/` or, if you only
have SFTP, `lftp -e 'mirror -c --parallel=4 /path ./local' sftp://user@oldhost`.
A single `tar` through SSH is far faster than per-file SFTP for sites with tens
of thousands of small uploads:

```bash
ssh user@oldhost "tar -czf - -C /path/to/wordpress ." | tar -xzf - -C /var/www/example.com/
```

### WP-5 · Move the database

```bash
# source (already exported in WP-2 — reuse that dump)
gzip -c ~/backup-$(date +%F)-db.sql > /tmp/db.sql.gz
scp /tmp/db.sql.gz user@newhost:/tmp/

# destination
gunzip /tmp/db.sql.gz
wp db create                     # or create it by hand with the right charset
wp db import /tmp/db.sql
# no wp-cli:
mysql --default-character-set=utf8mb4 -u DBUSER -p DBNAME < /tmp/db.sql
```

Then prove the import is complete, not partial:

```bash
# (swap wp_ for the site's real $table_prefix)
wp db query "SHOW TABLES" | wc -l                                  # table count
wp db query "SELECT COUNT(*) FROM wp_posts"                  # vs source
wp db query "SELECT COUNT(*) FROM wp_options"
wp db query "SELECT COUNT(*) FROM wp_users"
```

Compare each number against the same query on the source. A short table list
usually means the dump was truncated or `max_allowed_packet` cut the import —
raise it and re-import rather than patching around it.

Now write `wp-config.php` for the new host:

- `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST` (`localhost` vs `127.0.0.1`
  matters — the first may use a socket that does not exist on the new box).
- `$table_prefix` must match the dump exactly.
- Keep the existing `AUTH_KEY`/`SALT` block. Changing it logs every user out,
  which is survivable but surprising; keep it unless you want that.
- **Delete host-specific constants and `mu-plugins`** from the old provider:
  WP Engine / Kinsta / SiteGround / Pressable caching and "platform" plugins,
  `WP_CACHE` pointing at a dropped-in `advanced-cache.php`, `object-cache.php`
  for a Redis that is not running here. Left in place they cause white screens
  or a site that serves stale pages forever.
- `wp-config.php` holds live credentials: never commit it, never paste it.

### WP-6 · URLs and paths, serialized-safe

**Same domain, host change only** — the usual case — needs **no URL replace at
all**. The database already says `https://example.com`; that stays true. Only
run a replace if something changed:

```bash
# the filesystem path moved (e.g. /home/old/public_html → /var/www/example.com)
wp search-replace '/home/old/public_html' '/var/www/example.com' \
  --all-tables-with-prefix --precise --recurse-objects --dry-run
```

**Domain change, or a staging hostname:**

```bash
# ALWAYS dry-run first and read what it intends to touch
wp search-replace 'https://oldsite.com' 'https://newsite.com' \
  --all-tables-with-prefix --precise --recurse-objects \
  --skip-columns=guid --report-changed-only --dry-run

# then for real
wp search-replace 'https://oldsite.com' 'https://newsite.com' \
  --all-tables-with-prefix --precise --recurse-objects \
  --skip-columns=guid --report-changed-only
```

Also run the protocol-relative and escaped variants that real content contains:

```bash
wp search-replace '//oldsite.com' '//newsite.com' --all-tables-with-prefix --precise --recurse-objects --skip-columns=guid
# page builders (Elementor, Divi, WPBakery) store JSON inside serialized rows,
# with escaped slashes — this form is invisible to the plain replace above
wp search-replace 'https:\/\/oldsite.com' 'https:\/\/newsite.com' --all-tables-with-prefix --precise --recurse-objects --skip-columns=guid
wp elementor replace_urls https://oldsite.com https://newsite.com   # if Elementor is active
```

Why the flags:

- `--all-tables-with-prefix` — plugin tables hold URLs too; the default only
  touches core tables.
- `--precise` — forces PHP-side replacement so serialized data is unserialized,
  replaced, and re-serialized correctly, instead of a fast SQL path.
- `--recurse-objects` — descends into nested serialized arrays and objects.
- `--skip-columns=guid` — a post's `guid` is a permanent identifier for feed
  readers, not a link. Rewriting it re-delivers every old item as new.
- `--dry-run` / `--report-changed-only` — see the blast radius before committing.

#### Never do this

```sql
-- DESTRUCTIVE. Do not run this, no matter which tutorial shows it.
UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, 'oldsite.com', 'newsite.com');
```

WordPress stores arrays as serialized PHP with **byte lengths baked in**:

```
s:19:"https://oldsite.com"     →  s:19:"https://newsite.com"
                                     ↑ still says 19, the string is now 19 → lucky
s:19:"https://oldsite.com"     →  s:19:"https://a-much-longer-domain.com"
                                     ↑ length is a lie; PHP cannot unserialize it
```

When the length prefix no longer matches, `unserialize()` returns `false` and
WordPress silently falls back to empty. The result: theme options reset, widgets
vanish, page-builder layouts come back blank, ACF fields empty out — usually
discovered days later, after the backup rotation has eaten the good copy. The
corruption is in the data, so re-running the replace cannot undo it.

`wp search-replace --precise --recurse-objects` does the unserialize → replace →
re-serialize cycle properly. Use it. If wp-cli genuinely is not available,
install it (one phar, no root, no dependencies):

```bash
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
php wp-cli.phar --info && alias wp="php $PWD/wp-cli.phar"
```

Failing even that, the **Better Search Replace** plugin is serialization-aware
and acceptable. Raw SQL never is.

### WP-7 · Web server, ownership, permissions

**Apache / LiteSpeed** — `.htaccess` must exist in the WordPress root and the
vhost must allow it (`AllowOverride All`), or every URL but the homepage 404s:

```apache
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
```

**nginx** — there is no `.htaccess`; the rules live in the server block:

```nginx
location / { try_files $uri $uri/ /index.php?$args; }
location ~ \.php$ {
  include fastcgi_params;
  fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
  fastcgi_pass unix:/run/php/php8.2-fpm.sock;
}
client_max_body_size 64m;   # match php upload_max_filesize / post_max_size
```

Moving Apache → nginx? Any custom `.htaccess` rules (redirects, hotlink
protection, security blocks) must be hand-translated — they are otherwise
silently dropped. Generate the redirect half with `scripts/redirects.mjs
--format nginx`.

Ownership and permissions:

```bash
chown -R www-data:www-data /var/www/example.com          # or nginx:nginx / apache:apache
find /var/www/example.com -type d -exec chmod 755 {} \;
find /var/www/example.com -type f -exec chmod 644 {} \;
chmod 640 /var/www/example.com/wp-config.php
# uploads must be writable by PHP; nothing needs 777, ever
```

On RHEL/Rocky/Alma with SELinux enforcing, also:

```bash
chcon -R -t httpd_sys_rw_content_t /var/www/example.com/wp-content/uploads
```

### WP-8 · Flush rewrites, caches and cron

```bash
wp rewrite flush --hard
wp cache flush
wp transient delete --all
rm -f wp-content/advanced-cache.php wp-content/object-cache.php   # old host's drop-ins
wp cron event list            # anything stuck or wildly overdue?
wp plugin list --status=active
```

If `DISABLE_WP_CRON` is true, recreate the real cron entry on the new host:

```bash
*/5 * * * * cd /var/www/example.com && php wp-cron.php >/dev/null 2>&1
```

### WP-9 · Verify parity on staging — the gate

Run the audit scripts: the live old site against the staged new one.

```bash
node scripts/inventory.mjs https://example.com --out out
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory.json --out out
node scripts/linkcheck.mjs https://staging.example.com --out out
```

(Staged via `/etc/hosts` on the real domain instead? Point the new side at the
server by IP — `node scripts/parity.mjs https://example.com http://203.0.113.10`
— or run the scripts from the machine carrying the hosts entry.)

Resolve every row in `out/parity-report.md` before going further. Then the
WordPress-specific checks the HTTP crawl cannot see:

```bash
wp option get siteurl && wp option get home       # expected URL, no stray port/path
wp core verify-checksums                          # core files intact after transfer
wp plugin verify-checksums --all
wp db query "SELECT option_name FROM wp_options WHERE option_value LIKE '%oldsite.com%'"
# hardcoded URLs live in FILES too — search-replace never touches these
grep -rIl 'oldsite.com' wp-content/themes wp-content/plugins wp-content/mu-plugins
```

And by hand, in a browser: log into `/wp-admin`; load a media item and confirm
the image URL is the new one; open a page built with the page builder and
confirm the layout is intact (this is where serialization damage shows); submit
every form; run a test checkout if WooCommerce is live; check the search page,
the 404 page, the RSS feed, the SEO plugin's sitemap, scheduled posts, and any
members-only area. Confirm outbound email actually arrives from the new IP.

### WP-10 · SSL on the new host, before DNS

A Let's Encrypt HTTP-01 challenge cannot pass while DNS still points at the old
host. Get the certificate in place first, by one of:

- **DNS-01 validation** — the clean answer. `certbot --preferred-challenges dns`
  or an ACME client with your DNS provider's API. Issues a valid cert for the
  real domain with no traffic change at all.
- The new host's "pre-provision certificate" feature, where offered.
- **Behind Cloudflare?** Put a cert on the origin, then cut over by changing the
  **Cloudflare origin IP** rather than public DNS. It is instant, invisible to
  resolvers, and reverts in one click — the smoothest cutover available.

Confirm it before cutover:

```bash
curl -sSv --resolve example.com:443:203.0.113.10 https://example.com/ -o /dev/null
```

### WP-11 · Cutover

1. **Lower the TTL** on the A/AAAA records to 300s, at least one old-TTL period
   in advance (24h earlier if the TTL was 86400). Do nothing else yet.
2. **Final content sync**, so posts, orders and uploads from the gap are not
   lost. Optionally put the source in maintenance mode for these few minutes —
   the only moment you write to the source, and it is one file, reversible:
   ```bash
   # on the source, briefly
   wp maintenance-mode activate
   # re-sync the delta + a fresh DB dump, import on the new host (WP-4, WP-5)
   rsync -azP --no-owner --no-group /path/to/wordpress/wp-content/uploads/ \
     user@newhost:/var/www/example.com/wp-content/uploads/
   ```
   If you re-import the database here, you have replaced the rewritten copy with
   the source's — **re-run the WP-6 `search-replace` and WP-8 flushes after the
   import**, then re-check `wp option get siteurl`. A domain change makes this
   step easy to forget and the symptom (the new site redirecting to the old
   domain) looks like a DNS problem.
3. **Stop and get explicit confirmation from the user.** Then point DNS at the
   new server.
4. Verify immediately — both by IP and through DNS:
   ```bash
   dig +short example.com
   curl -sSI --resolve example.com:443:203.0.113.10 https://example.com/
   node scripts/linkcheck.mjs https://example.com --out out-prod
   node scripts/parity.mjs http://OLD.HOST.IP https://example.com \
     --inventory out/inventory.json --out out-prod
   ```
5. `wp maintenance-mode deactivate` on the source if you activated it — the old
   host stays live and serving as the rollback path.

**Rollback is: put the old IP back in DNS.** Nothing else. That is why the old
host stays untouched and running.

### WP-12 · After cutover

- Keep the old host running, unchanged, for 48–72h minimum. Resolvers cache.
- Watch for mixed-content warnings, 404s in Search Console, and form/email
  delivery (new IP → verify SPF, DKIM and DMARC alignment; an SMTP plugin pointed
  at a real mail service is the reliable fix).
- Re-check `wp cron event list` the next day — scheduled posts and WooCommerce
  jobs are the usual casualties.
- Only once the window is clean **and the user approves**: cancel the old host.
  Keep the WP-2 backups well past that date.

### A note on the migration plugins

**All-in-One WP Migration**, **Duplicator** and **Migrate Guru** are what most
people reach for, and for a small site — a few hundred megabytes, no unusual
plugins — they are genuinely fine and faster than this. Use them when that fits.

They fail predictably on real sites: All-in-One's free import cap (512 MB, and
lower if the host's PHP limits are lower) needs the paid extension to lift;
Duplicator's installer runs inside PHP, so a large archive hits
`max_execution_time` or memory limits mid-import and leaves a half-migrated
database; both depend on the destination's PHP being able to unpack gigabytes
within a request. When an import dies halfway, you are debugging someone else's
archive format instead of your site.

The scripted path above has no size limit, resumes where it stopped, never runs
inside a PHP request, moves files and database independently so a failure in one
does not corrupt the other, and leaves the source bit-for-bit untouched. For
anything client-facing, or anything over a gigabyte, use it.

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

They are read-only by construction and bounded on every axis, so pointing one at
a site you do not control is safe for you and for it:

- `GET`/`HEAD` only. No writes, no shell-out, no `eval`, no credentials, no
  filesystem access beyond the `--out` directory.
- **Only the origin you name is fetched.** Every URL that arrives as remote data
  — a sitemap `<loc>`, a child sitemap, an `<a href>`, a `Location` header, a
  path read out of an inventory file — is checked against that origin before any
  request. Off-origin entries are reported, never fetched. Same-host and
  www/apex redirects are followed, up to 5 hops.
- **Private addresses are refused outright.** Loopback, RFC1918, CGNAT,
  link-local, `*.local`/`*.internal`, and cloud instance-metadata endpoints
  (`169.254.169.254` and friends) are never fetched on the strength of remote
  content. A hostile sitemap cannot make the machine running an audit read its
  own metadata service. Auditing a genuinely local staging site still works: the
  origin you name is yours to name.
- **Nothing is overwritten by accident.** Output stays inside the working
  directory, and an existing file is left alone unless you pass `--force`.
- Every request has a 15s timeout; response bodies are capped at 5 MB; crawls
  stop at `--max` pages (ceiling 5000) and `--max-depth` levels (default 10).
- **The HTML and XML parsers are linear.** Markup is walked with index scans,
  not backtracking regexes, so a page crafted to make a parser go quadratic
  costs milliseconds instead of minutes.

The limits live in one place — `LIMITS` at the top of `scripts/lib.mjs`. Raise
them deliberately if a site genuinely needs it.

Run the test suite with `node --test tests/*.test.mjs`. It covers the two things
this tooling is actually exposed to — SSRF through URLs harvested off a remote
site, and quadratic parsing of hostile markup — with regression tests built at
the real 5 MB body cap and a hard time budget. CI runs it on Linux and macOS.
