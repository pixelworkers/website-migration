# Symptom to cause

Sorted by how often it happens. Most of these are the same two faults wearing
different clothes: the web server is not routing to the application, or
something still holds the old host's address.

## Every URL except the homepage returns 404

The web server is not handing unmatched paths to the application.

- **Apache**: `.htaccess` did not copy — FTP clients skip dotfiles by default —
  or `AllowOverride All` is not set for the directory, or `mod_rewrite` is not
  enabled (`a2enmod rewrite`).
  ```bash
  ls -la /var/www/example.com/.htaccess
  apachectl -M | grep rewrite
  ```
- **nginx**: there is no `.htaccess` here, and nothing translated those rules.
  The `try_files` block is missing. See [PHP applications](./php-apps.md) § P-6,
  or `SKILL.md` WP-7 for WordPress.
- **Node/Next.js**: the proxy is serving the filesystem instead of proxying to
  the app, or the app is not running. `curl -sSI http://127.0.0.1:3000/` first —
  if that 404s too, it is the app, not the proxy.
- **Static site**: trailing-slash and index handling differs on the new server.
  See [Static sites](./static-sites.md) § S-3.
- WordPress, after fixing the server: `wp rewrite flush --hard`.

## The site redirects to the old domain

Something still holds the old URL and is sending visitors there.

1. The database or app config: `wp option get siteurl` / `wp option get home`,
   or the app's `APP_URL` / `NEXTAUTH_URL` / `PUBLIC_BASE_URL`.
2. A constant overriding the database:
   ```bash
   grep -nE 'WP_HOME|WP_SITEURL|APP_URL|BASE_URL' wp-config.php .env 2>/dev/null
   ```
3. A cached page or a caching drop-in from before the rewrite. Remove
   `wp-content/advanced-cache.php` and `object-cache.php`, clear the cache
   directory, clear the CDN.
4. A plugin that rewrites URLs at runtime (Really Simple SSL and similar).
   Deactivate, test, reactivate.
5. A `Redirect` or `RewriteRule` in `.htaccess` copied from the old host, or a
   Cloudflare Page Rule / Transform Rule that outlived the migration.
6. HSTS plus a redirect loop looks like this too. Check with
   `curl -sSIL https://example.com/ | grep -iE '^(HTTP|location)'`.

## Error establishing a database connection

The config still points at the old database.

- `DB_HOST` is frequently **not** `localhost` on a managed host — it may be an
  internal hostname that does not resolve on the new server. And `localhost` vs
  `127.0.0.1` is not cosmetic: the first may use a Unix socket path that does
  not exist here.
- The user exists but has no grant on the new host. Grant what the application
  actually uses, scoped to one database and one host — an app that never runs
  DDL has no reason to hold `DROP`:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'appuser'@'localhost';
  -- add CREATE, ALTER, INDEX, DROP only if the app runs its own migrations
  FLUSH PRIVILEGES;
  ```
- The password was reset during the move and the config was not updated.
- **MySQL 8 with an older client**: `caching_sha2_password` is the default and
  older PHP builds cannot speak it. Upgrade the client, or
  `ALTER USER 'appuser'@'localhost' IDENTIFIED WITH mysql_native_password BY '…';`
- PostgreSQL: `pg_hba.conf` rejects the connection method. The error names the
  method it tried — `scram-sha-256` vs `md5` vs `peer`.
- SELinux enforcing will block a local web server from opening a network socket
  to the database at all: `setsebool -P httpd_can_network_connect_db 1`.

## White screen, no error

PHP is failing fatally with display disabled. Find the real error rather than
guessing:

```bash
tail -50 /var/log/php*-fpm.log /var/log/nginx/error.log \
         /var/log/apache2/error.log 2>/dev/null
# WordPress, temporarily — and turn both back off afterwards
wp config set WP_DEBUG true --raw && wp config set WP_DEBUG_LOG true --raw
tail -50 wp-content/debug.log
```

Never enable `display_errors` on a live site. The stack traces include file
paths, database names and sometimes credentials, served to anyone who triggers
the error. Log to a file outside the document root and read it there.

Common causes: a PHP version mismatch, a missing extension (`php -m`), a cache
drop-in pointing at a Redis socket that does not exist, a plugin with a compiled
dependency, or `memory_limit` exhausted.

Node equivalent: the process is crash-looping. `journalctl -u example -n 100
--no-pager` or `pm2 logs example --lines 100`. Almost always a missing
environment variable or a native module that needs rebuilding — `npm ci`, not a
copied `node_modules`.

## Images and CSS 404 while pages load

- The uploads or assets directory did not finish copying. Compare counts, do not
  assume:
  ```bash
  ssh user@oldhost 'find /var/www/example.com/wp-content/uploads -type f | wc -l'
  find /var/www/example.com/wp-content/uploads -type f | wc -l
  ```
- The document root is one level off — the vhost points at the repo root when it
  should point at `public/`, or the other way round.
- Permissions: the web server user cannot read the files. See below.
- The URLs still point at the old domain, which no longer serves them.
  `parity.mjs` and `linkcheck.mjs` both report this specifically.
- Static build: hashed filenames changed and an HTML page cached for a year
  still references the old ones. Check `Cache-Control` on HTML —
  [Static sites](./static-sites.md) § S-5.
- Self-hosted `next/image` without `sharp` installed 500s on every image while
  the pages themselves are fine.

## Widgets gone, page builder content blank, theme options reset

Serialized data was corrupted — almost certainly by a SQL find-and-replace
instead of `wp search-replace --precise --recurse-objects`.

**There is no repair.** The byte-length prefixes no longer match the strings, so
`unserialize()` returns `false` and the application falls back to empty. Running
the replace again cannot undo it. Restore the database from the
pre-replacement dump and redo the rewrite correctly — see `SKILL.md` WP-6.

This is why the backup comes before the rewrite, and why the rewrite is never
raw SQL. The same trap exists in any PHP application that stores serialized
arrays or JSON in a text column.

## Uploads fail with a permissions error

The owner is wrong, not the mode. Find what PHP actually runs as and set it:

```bash
ps -o user= -C php-fpm 2>/dev/null | sort -u
ps -o user= -C nginx -C apache2 -C httpd 2>/dev/null | sort -u
chown -R www-data:www-data /var/www/example.com/wp-content/uploads
find /var/www/example.com/wp-content/uploads -type d -exec chmod 755 {} \;
find /var/www/example.com/wp-content/uploads -type f -exec chmod 644 {} \;
```

**Do not use 777.** It does not fix an ownership problem, and on a shared host it
lets every other account on the box read your database password out of
`wp-config.php` or `.env`. If `777` appears to fix something, the real fault is
ownership and you have just made the site writable by anyone with a shell.

SELinux: `chcon -R -t httpd_sys_rw_content_t <the writable directory>`.

SQLite "attempt to write a readonly database" on a file that is clearly
writable means the **directory** is not — SQLite needs to create its `-wal` and
journal files alongside. See [Databases](./databases.md) § SQLite.

## Large uploads or imports fail silently

Four limits, and the smallest one wins:

```
php.ini      upload_max_filesize, post_max_size, memory_limit, max_execution_time
nginx        client_max_body_size
Apache       LimitRequestBody
PHP-FPM      request_terminate_timeout
```

nginx returns `413`; PHP often returns nothing at all. Node behind a proxy:
`client_max_body_size` on the proxy *and* the framework's own body limit.

Raise `post_max_size` above `upload_max_filesize`, and `memory_limit` above
both, or a file that uploads cannot then be processed.

## A database import stops partway through

- `max_allowed_packet` on the target is smaller than a single row in the dump
  (common with post content or a BLOB). Raise it and re-import from the start —
  do not patch around a partial import.
- The dump itself is truncated. Check the tail:
  `tail -1 dump.sql` must read `-- Dump completed on …`.
- Disk full on the target. `df -h` before blaming the dump.
- PostgreSQL: `pg_restore` reports errors and **exits 0** by default. Always
  pass `--exit-on-error`, then trust the exit code.

Always compare row counts per table before believing an import — see
[Databases](./databases.md).

## The transfer is extremely slow

- Thousands of small files: stream one archive instead of rsyncing file by file.
  ```bash
  ssh user@oldhost "tar -czf - -C /var/www/example.com ." \
    | tar -xzf - -C /var/www/example.com/
  ```
- The source is throttling you. Use `--bwlimit` to stay under its limit rather
  than being cut off mid-transfer.
- CPU-bound on a small instance: `-z` compression can be the bottleneck rather
  than the network. Drop it on a fast link.
- An interrupted `rsync` resumes — run the same command again. It moves only
  what is missing.

## Certificate warnings after cutover

- The certificate was never issued for the new server, or was issued only for
  the apex and not `www`. Issue for both.
- A `CAA` record pinned to the old host's certificate authority blocks issuance
  with an error that never mentions DNS. `dig +short CAA example.com`.
- Cloudflare in "Flexible" SSL mode against a server that forces HTTPS produces
  a redirect loop. Use "Full (strict)".
- HSTS from the old site means browsers refuse plain HTTP, so a missing
  certificate is a hard failure rather than a warning.

See [DNS cutover](./dns-cutover.md).

## Some visitors see the old site, some the new

Normal during propagation, and precisely why the old host stays up. Poll several
resolvers to see who has caught up — [DNS cutover](./dns-cutover.md) § Watching
it land.

If it persists well past the TTL, stop blaming propagation and look for a second
`A` record, a stale `www` record pointing elsewhere, or an edit made in a zone
that is not the authoritative one.

## Login works, then immediately logs out

- Session or token secret changed during the move (`NEXTAUTH_SECRET`,
  `APP_KEY`, `AUTH_SECRET`, WordPress's `AUTH_KEY`/salt block). Every existing
  cookie is now invalid. Carry the original value across.
- Sessions were in Redis or in memory and the new instance is empty. Expected;
  tell the client rather than letting them find it.
- Cookie domain mismatch — a cookie set for `www.example.com` is not sent to
  `example.com`. Pick one canonical host and redirect the other.
- A load balancer with more than one app instance and no shared session store:
  each request lands somewhere different.

## Login is broken after a domain change

OAuth redirect URIs, webhook endpoints and referrer-restricted API keys all live
in other people's dashboards and all still name the old domain. See
[Node applications](./node-apps.md) § N-7.

## Scheduled jobs are not running

They do not move with files. Recreate the cron entries, systemd timers, queue
workers or pm2 processes on the target — and disable them on the source.

```bash
systemctl list-timers --all --no-pager
crontab -l
wp cron event list       # WordPress's own schedule
```

If `DISABLE_WP_CRON` is set, a system cron entry is driving it and that entry
needs recreating too. See [Sites that keep working](./live-site-windows.md) § W-6.

## Everything checks out but `parity.mjs` still reports problems

Read the report rather than overriding it.

- **Changed title / lost word count** on a re-platform is often legitimate —
  markup changed, the crawler counts differently. Judge those rows.
- **Missing** and **error** rows are never judgement calls. Something 200s on
  the old site and does not on the new one.
- A `3xx` to another host is reported and not followed, by design. If the old
  site redirected off-origin, that is a row to resolve deliberately, not a bug
  in the script.
- Staging behind basic auth or an IP allowlist will report every page as
  failing. Run the script from somewhere that can see the site.

The report being empty is the gate. Make it empty by fixing the site or by
recording an intentional 301 — never by raising the thresholds.
