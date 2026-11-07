# Sites that keep working while you move them

The database you copy is a snapshot. Anything written to the source after the
dump — an order, a comment, a form submission, a new post, a password change —
exists only on the old host and is gone after cutover.

For a brochure site nobody edits, this does not matter. For a shop, it is the
whole problem.

This is platform-agnostic. The commands differ by stack
([WordPress](../SKILL.md#wordpress--wordpress-moving-one-site-to-a-new-host),
[PHP](./php-apps.md), [Node](./node-apps.md)); the shape of the decision does
not.

## W-1 · Work out which case you are in

| Situation | Approach |
| --- | --- |
| Static or rarely-edited site | Copy once, verify, cut over. No window needed. |
| CMS with occasional edits | Ask the client not to publish during the window. Cut over the same day as the final copy. |
| Shop, booking system, membership, anything with logins | A maintenance window, or a final database pass immediately before cutover. |
| High-volume transactional | Its own project, planned with the owner. Not a one-session job. |

Ask the question explicitly rather than inferring it: *between the dump and the
cutover, who writes to this site, and what happens if that write is lost?* The
answer decides everything below.

## W-2 · Split the slow part from the part that changes

Files are large and mostly static. The database is small and changes constantly.
Move them on different schedules and the window shrinks to minutes.

```bash
# days before: the bulk copy, while the site runs normally.
# --bwlimit keeps the first pass from saturating the source's connection and
# making the live site slow while you work.
rsync -azP --no-owner --no-group --bwlimit=5000 \
  /var/www/example.com/ user@newhost:/var/www/example.com/

# at cutover: only what changed since — usually seconds
rsync -azP --no-owner --no-group \
  /var/www/example.com/ user@newhost:/var/www/example.com/
```

`rsync` is resumable and incremental: run the same command again after an
interruption and it moves only what is missing. That is what makes a short
window possible on a large site — by cutover the only file changes are a handful
of new uploads.

If you add `--delete` for a true mirror, run it with `--dry-run` first and read
the list. `--delete` against the wrong target directory removes files that were
never yours.

## W-3 · The maintenance window — the honest option

Twenty minutes of a visible "back shortly" page is better than silently losing
three orders. Tell the client the window in advance, pick the quietest hour
their analytics actually show, and avoid Friday afternoons.

1. **Put the source into maintenance mode.** This is the one and only write to
   the source, and it is reversible.
   - WordPress: `wp maintenance-mode activate`
   - Laravel: `php artisan down --retry=60`
   - Anything else: a holding page, or a `503` in the web server with a
     `Retry-After` header so crawlers come back rather than de-indexing.
   ```nginx
   # nginx, on the source, for the duration
   location / { return 503; }
   error_page 503 /maintenance.html;
   location = /maintenance.html { root /var/www/maintenance; internal; }
   add_header Retry-After 1800 always;
   ```
   A `503` is the correct status. A `200` on a holding page tells Google the
   page's content is now "back shortly", and that is what it indexes.
2. **Final file pass** — `rsync` again, fast.
3. **Fresh database dump and restore.** This is the one that counts; the earlier
   one was a rehearsal.
4. **Re-run anything that rewrites the database.** A fresh import has replaced
   your rewritten copy with the source's. For WordPress that means the WP-6
   `search-replace` and the WP-8 flushes, then re-checking
   `wp option get siteurl`. Skipping this is the single most common cutover
   mistake, and the symptom — the new site redirecting to the old domain — looks
   exactly like a DNS problem.
5. **Verify.** `parity.mjs` against the staged target, zero unresolved rows, or
   stop and fix.
6. **Cut DNS over** — with explicit confirmation from the user first.
7. **Take maintenance mode off the *source*.** It keeps serving the old site to
   anyone still on a stale DNS answer, which is exactly what you want. The
   source is the rollback; leaving it in maintenance mode disables it.

## W-4 · Without a window

Harder, and it needs care about what "seamless" means. You cannot have both
hosts writing to two separate databases and also have a clean rollback — one of
them will have writes the other does not.

The approach that works is to let both hosts share **one** database for the
cutover period: the old host's.

1. **Give the target access to the source database over an SSH tunnel**, not
   over the public internet.
   ```bash
   # on the target, as a systemd unit or under autossh so it survives a drop
   ssh -N -L 127.0.0.1:3307:127.0.0.1:3306 dbtunnel@oldhost
   ```
   The app on the target then points at `127.0.0.1:3307`. The database port is
   never exposed, the traffic is encrypted, and there is no new grant to
   remember to revoke. Give `dbtunnel` a forced command or
   `PermitOpen 127.0.0.1:3306` in `sshd_config` so that key can do nothing but
   forward that one port.

   If a tunnel genuinely is not possible, a direct grant is the fallback — and
   it is a database exposed to a network, so it is scoped tightly and removed
   the same day:
   ```sql
   -- on the source: one user, one host, one database, TLS required
   CREATE USER 'migrate'@'203.0.113.10' IDENTIFIED BY '…' REQUIRE SSL;
   GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'migrate'@'203.0.113.10';
   FLUSH PRIVILEGES;
   ```
   Plus a firewall rule allowing 3306 **from that one address** and nowhere
   else. Never `'migrate'@'%'`, never `bind-address = 0.0.0.0` without a
   firewall in front, and no `GRANT ALL`.
2. **Point the target at it** and verify the target reads and writes real data.
   Both hosts now share one dataset, so no write is lost regardless of which
   server a visitor reaches.
3. **Cut DNS over.** Traffic drains from old to new across the TTL.
4. **Wait until the old host sees no traffic** — check its access log, do not
   guess:
   ```bash
   tail -n 2000 /var/log/nginx/access.log | awk '{print $4}' | tail -5
   ```
5. **Move the database home.** Brief maintenance mode, final dump, restore on
   the target, point the target at its own local database, restart.
6. **Remove the tunnel and revoke the grant**, the same day:
   ```sql
   DROP USER 'migrate'@'203.0.113.10';
   FLUSH PRIVILEGES;
   ```
   A forgotten migration grant is a credential with write access to production
   that nobody owns and nobody rotates. Close it.

The cost: through step 3 the database is still on the old host, so latency is
higher and the old server is still load-bearing — if it falls over, so does the
new site. The benefit: no lost writes and no visible downtime. Only worth the
complexity when the site genuinely cannot stop taking orders.

## W-5 · Mail the site sends

Form notifications, order confirmations and password resets go out through
whatever the site is configured to use, and after a move that configuration is
usually wrong in a way that produces **no error at all**.

- If it used the old host's local `sendmail`, there is no working mail path on
  the target until one is configured. Messages vanish silently.
- If it used SMTP with an API key, the key may be domain-restricted and need the
  new domain or sending identity added.
- **SPF lists the hosts allowed to send for the domain.** A new sending server
  needs adding, or the mail that does go out lands in spam. Check DKIM signing
  and DMARC alignment at the same time.

```bash
dig +short TXT example.com | grep -i spf
dig +short TXT _dmarc.example.com
```

Test it properly: submit a real form on the live site after cutover and confirm
the message arrives in a real inbox. Every time. It is the most commonly broken
thing that nobody checks, and the client finds it before you do.

## W-6 · Scheduled work

Cron entries, systemd timers, pm2 processes, queue workers and WordPress's own
`wp_cron` events do not travel with files.

```bash
# on the source, record what exists
crontab -l
sudo ls -la /etc/cron.d/ && sudo cat /etc/cron.d/* 2>/dev/null
systemctl list-timers --all --no-pager
pm2 jlist 2>/dev/null | jq -r '.[].name'
wp cron event list 2>/dev/null
```

Recreate them on the target, and **disable them on the source** once the new
host is live. Two servers running the same nightly billing job against the same
data is a real way to double-charge people — and during a shared-database window
(W-4) they are pointed at the *same* rows.

Order matters: disable on the source **before** enabling on the target, and keep
a note of what you disabled so a rollback restores it.

## W-7 · Queues and in-flight work

A job sitting in a queue is pending work, not cache. It will not be in the
database dump if the queue lives in Redis or a broker.

Drain before the final sync: stop accepting new jobs, let the workers finish,
confirm the queue is empty, *then* stop the workers. See
[Databases](./databases.md) § Redis.

The same applies to anything with a multi-step flow in progress — a checkout
mid-payment, a multi-page form, an upload in flight. A maintenance window with a
`503` and a `Retry-After` is the only honest way to handle those; a silent
cutover drops them.
