# PHP applications (non-WordPress)

Bespoke PHP, CodeIgniter, Symfony, Drupal, Joomla, a Laravel app — anything
where PHP serves the request and a database holds the content, but none of
WordPress's conventions apply.

The good news: no serialized-PHP URL problem, so there is no
`wp search-replace` equivalent to get wrong. The bad news: the configuration is
wherever this particular application decided to put it, and the PHP version is
usually the thing that breaks.

Work the phases in `SKILL.md`. These are the PHP-specific commands for each.

## P-1 · Pre-flight: record the runtime exactly

```bash
# on the source
php -v                               # major.minor matters
php -m | sort                        # loaded extensions
php -i | grep -E '^(memory_limit|upload_max_filesize|post_max_size|max_execution_time|date.timezone)'
mysql --version || psql --version
du -sh .                             # size of the job
```

**Match the source's PHP major version on the target to start.** Code written
for 7.4 routinely fails on 8.x — `mysql_*` is gone, string-to-number comparison
changed, and passing `null` to a non-nullable internal parameter is now a
deprecation that floods the log. Get the site working on the version it already
ran on, verify parity, cut over, and upgrade afterwards as its own change.

Diff the extension lists rather than reading them:

```bash
ssh user@oldhost 'php -m | sort' > /tmp/src-ext
php -m | sort > /tmp/target-ext
diff /tmp/src-ext /tmp/target-ext
```

A missing `intl`, `gd`, `imagick`, `bcmath`, `soap`, `zip` or `pdo_pgsql` is a
white screen with nothing in the browser and one line in the PHP-FPM log.

Also note: the web server (Apache with `.htaccess`, or nginx where those rules
must be hand-translated), anything in front of the origin (Cloudflare, a CDN,
a WAF), cron entries (`crontab -l`), and any license key bound to the old domain
or IP.

## P-2 · Back up the source first

```bash
# name them once and reuse the variables — never re-type $(date +%F) in a later
# step, it re-evaluates to *today* and a migration spanning midnight then points
# at a dump that does not exist
DUMP=~/backup-$(date +%F)-db.sql
FILES=~/backup-$(date +%F)-files.tar.gz

tar -czf "$FILES" -C /var/www/example.com .

# Keep the password out of the command line: ps shows it to every user on the
# box, and your shell history keeps it forever.
umask 077
cat > ~/.my.cnf <<'CNF'
[client]
user=DBUSER
password=THE_PASSWORD
CNF
chmod 600 ~/.my.cnf
mysqldump --defaults-file="$HOME/.my.cnf" --single-transaction --quick \
  --default-character-set=utf8mb4 --routines --triggers --events \
  DBNAME > "$DUMP"
chmod 600 "$DUMP"            # the dump holds every user's password hash

# prove it is complete, not a truncated half-write
tail -1 "$DUMP"              # must read: -- Dump completed on …
grep -c 'CREATE TABLE' "$DUMP"
ls -lh "$DUMP" "$FILES"
sha256sum "$DUMP" "$FILES"   # GNU; on macOS/BSD: shasum -a 256
```

Pull both off the source host to somewhere that is neither host, and record the
current DNS zone — every record and TTL — so a rollback is a paste, not a
reconstruction. Not MySQL? See [Databases](./databases.md).

From here the source is read-only. Do not "clean it up first".

## P-3 · Move the files

```bash
rsync -azP --no-owner --no-group \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'storage/logs/' \
  --exclude 'var/cache/' \
  --exclude 'cache/' \
  --exclude 'tmp/' \
  --dry-run \
  /var/www/example.com/ user@newhost:/var/www/example.com/
# read the dry-run output, then run it again without --dry-run
```

- `--no-owner --no-group`: UIDs rarely match across hosts; you set ownership
  explicitly in P-6.
- `.env` and config files holding credentials are excluded deliberately — the
  target needs its own. Copy one as a reference by hand, then edit it.
- Caches are excluded: large, stale, and regenerated. A copied cache pointing at
  the old paths is a common cause of a white screen after a move.
- Add `--delete` only when the destination directory is genuinely new and you
  want a true mirror on repeat runs.

Tens of thousands of small files? A single stream beats per-file rsync:

```bash
ssh user@oldhost "tar -czf - -C /var/www/example.com ." \
  | tar -xzf - -C /var/www/example.com/
```

No shell on the source at all? See [Managed and closed
platforms](./managed-platforms.md).

## P-4 · Move the database, then prove the import

```bash
# transfer
gzip -c "$DUMP" > /tmp/db.sql.gz
scp /tmp/db.sql.gz user@newhost:/tmp/

# on the target — /tmp is world-readable and this file is full of password
# hashes and application secrets. Lock it down the moment it lands.
chmod 600 /tmp/db.sql.gz
gunzip /tmp/db.sql.gz && chmod 600 /tmp/db.sql
mysql --defaults-file="$HOME/.my.cnf" --default-character-set=utf8mb4 \
  -e "CREATE DATABASE DBNAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql --defaults-file="$HOME/.my.cnf" --default-character-set=utf8mb4 DBNAME < /tmp/db.sql
```

Match the source's character set and collation. Importing a `utf8mb4` dump into
a `latin1` database mangles every accent, quote and emoji in the content, and
the damage is in the data.

Compare row counts against the source table by table before trusting it:

```bash
mysql --defaults-file="$HOME/.my.cnf" -N -B DBNAME -e "
  SELECT CONCAT(table_name,'|',table_rows) FROM information_schema.tables
  WHERE table_schema = DATABASE() ORDER BY table_name;" > /tmp/target.counts
# run the same query on the source, then:
diff /tmp/source.counts /tmp/target.counts
```

`table_rows` is an estimate on InnoDB and can be out by a factor of two. Treat a
mismatch as a prompt to check the tables that matter with `SELECT COUNT(*)`,
not as proof of failure. A *missing* table is never an estimate — a short table
list usually means the dump was truncated or `max_allowed_packet` cut the
import. Raise it and re-import rather than patching around it.

Then delete the working copies on both hosts. The P-2 backup stays — that is the
rollback; the `/tmp` copies are plaintext secrets.

```bash
rm -f /tmp/db.sql /tmp/db.sql.gz    # on both hosts
```

## P-5 · Re-point the configuration

Find every hardcoded old value rather than guessing where config lives:

```bash
grep -rnI --exclude-dir=.git --exclude-dir=vendor --exclude-dir=node_modules \
  -E 'old\.example\.com|/home/olduser|/home/[a-z]+/public_html|localhost:3306' . \
  | head -40
```

Usual homes: `.env`, `config.php`, `includes/db.php`,
`application/config/database.php`, `config/database.yml`, `sites/default/settings.php`
(Drupal), `configuration.php` (Joomla).

What to change: DB name/user/password/host (`localhost` vs `127.0.0.1` matters —
the first may use a socket that does not exist on the new box), the app's own
base URL, absolute filesystem paths, mail transport, cache and session drivers
(a `redis` driver with no Redis running is a fatal error on the first request),
and any S3/bucket region.

Older PHP applications also store absolute upload paths **in the database**.
Check before you assume the files were the only place:

```bash
mysql --defaults-file="$HOME/.my.cnf" -N -B DBNAME -e \
  "SELECT table_name, column_name FROM information_schema.columns
   WHERE table_schema = DATABASE() AND data_type IN ('varchar','text','mediumtext','longtext');"
# then grep the dump itself, which is faster than querying column by column
grep -c '/home/olduser' "$DUMP"
```

If there are hits, fix them with a targeted `UPDATE` **on the target, after the
backup exists** — and only on plain text columns. If a column holds serialized
PHP or JSON, a SQL `REPLACE()` corrupts it exactly as it does in WordPress: the
byte-length prefix stops matching and `unserialize()` silently returns `false`.
Rewrite those in PHP, or in the application's own console, never in SQL.

Never commit or paste `.env` / `wp-config.php` / `settings.php`. They hold live
credentials.

## P-6 · Web server, ownership, permissions

**nginx** — the `.htaccess` rules have to be translated by hand; nothing reads
them here:

```nginx
server {
  root /var/www/example.com/public;        # note: public/, not the repo root
  index index.php index.html;

  location / { try_files $uri $uri/ /index.php?$query_string; }

  location ~ \.php$ {
    try_files $uri =404;      # never omit: with cgi.fix_pathinfo=1 this is the
                              # difference between serving PHP and letting an
                              # uploaded .jpg execute as PHP
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
  }

  # never serve the things that hold secrets or history
  location ~ /\.(?!well-known) { deny all; }
  location ~* /(composer\.(json|lock)|package\.json|\.env.*)$ { deny all; }

  client_max_body_size 64m;   # match php upload_max_filesize / post_max_size
}
```

Point the document root at the application's **public** directory
(`public/`, `web/`, `public_html/`). Pointing it one level up exposes `.env`,
`vendor/`, and the whole source tree to anyone who guesses a filename — the
single most common misconfiguration in a PHP move.

**Apache / LiteSpeed** — `.htaccess` must have copied (FTP clients skip
dotfiles) and the vhost must allow it with `AllowOverride All`, or every URL but
the homepage 404s.

```bash
chown -R root:www-data /var/www/example.com
find /var/www/example.com -type d -exec chmod 755 {} \;
find /var/www/example.com -type f -exec chmod 644 {} \;
chmod 640 /var/www/example.com/.env            # and chown it to the PHP user
# only the directories the app genuinely writes to get group write:
chown -R www-data:www-data /var/www/example.com/storage \
                           /var/www/example.com/public/uploads
find /var/www/example.com/storage -type d -exec chmod 775 {} \;
```

Nothing needs `777`, ever. It does not fix an ownership problem, and on a shared
host it lets every other account on the box read your database password.

Uploads must not be executable. If users upload files, serve that directory as
static content only:

```nginx
location ^~ /uploads/ {
  location ~ \.(php|phtml|phar|cgi|pl)$ { deny all; }
}
```

SELinux enforcing (RHEL/Rocky/Alma)?

```bash
chcon -R -t httpd_sys_rw_content_t /var/www/example.com/storage
```

## P-7 · Laravel specifics

```bash
composer install --no-dev --optimize-autoloader
php artisan storage:link        # a symlink does not survive a plain file copy
php artisan config:clear && php artisan cache:clear \
  && php artisan view:clear && php artisan route:clear
```

- **`APP_KEY` must be carried across unchanged.** Generate a fresh one and every
  encrypted column, every signed URL and every existing session becomes
  unreadable — permanently, for the encrypted data. Copy the value by hand into
  the target's `.env`; do not run `key:generate` on an existing application.
- Cached config is baked into `bootstrap/cache/config.php`. If you copied it
  from the old host it still holds the old credentials and overrides your new
  `.env`. Clear it (above), then re-cache after verifying:
  `php artisan config:cache && php artisan route:cache`.
- Migrations: check what would run before running it.
  ```bash
  php artisan migrate:status
  php artisan migrate --pretend          # read this output
  php artisan migrate --force            # only if the target DB is genuinely behind
  ```
  On a straight host-to-host move the schema came with the dump and **nothing
  should run**. A migration that wants to run here means the code and the
  database are from different points in time — stop and find out why.
- **Queue workers and the scheduler are processes, not files.** Recreate them:
  ```bash
  # the scheduler, as the app user
  * * * * * cd /var/www/example.com && php artisan schedule:run >> /dev/null 2>&1
  ```
  and a systemd unit or supervisor program for `php artisan queue:work`.
  Disable both **on the source** once the new host is live — two servers running
  the same nightly billing job against the same data is a real way to
  double-charge people.
- Horizon, Telescope, Scout and Pulse each need their backing service (Redis,
  Meilisearch, Algolia) present and re-keyed, or the first request fails.

Symfony is the same shape: `composer install`, `APP_SECRET` carried across,
`php bin/console cache:clear --env=prod`, document root at `public/`, and
`var/cache` + `var/log` writable by the PHP user and by nobody else.

## P-8 · Verify, then cut over

```bash
node scripts/inventory.mjs https://example.com --out out
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory.json --out out
node scripts/linkcheck.mjs https://staging.example.com --out out
```

Resolve every row in `out/parity-report.md`. Then by hand, because an HTTP crawl
cannot see any of it: log in, submit every form, run a test transaction if money
moves, check file upload *and* download, confirm the application log is being
written and is clean, confirm outbound mail actually arrives from the new IP
(new IP means new SPF/DKIM alignment), and load any admin area.

Certificates and DNS: [DNS cutover](./dns-cutover.md). Keeping the site writable
through the move: [Sites that keep working](./live-site-windows.md). Something
broken: [Troubleshooting](./troubleshooting.md).
