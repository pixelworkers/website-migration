# Databases other than MySQL

The shape is always the same — dump, transfer, restore, **count rows and
compare** — and the details differ enough to lose data if you assume.

Two rules that apply to every engine on this page:

1. **A dump is a credential file.** It holds every user's password hash,
   session tokens, API keys stored in a settings table, and often customer PII.
   `chmod 600` it the moment it exists, keep it out of `/tmp` and out of any
   web-served directory, and delete the working copies once the row counts
   match. Only the backup you took before starting survives, somewhere that is
   neither host.
2. **Never put a password on the command line.** `ps` shows it to every account
   on the box and your shell history keeps it. Each engine below has a file for
   this; use it.

## PostgreSQL

### Credentials, without leaking them

```bash
umask 077
cat >> ~/.pgpass <<'PGPASS'
# host:port:database:user:password
db.internal:5432:appdb:appuser:THE_PASSWORD
PGPASS
chmod 600 ~/.pgpass          # libpq silently ignores it with any looser mode
```

### Dump

```bash
DUMP=~/backup-$(date +%F)-appdb.dump      # name it once; reuse the variable
pg_dump --host=db.internal --username=appuser --dbname=appdb \
  --format=custom --no-owner --no-privileges --verbose --file="$DUMP"
chmod 600 "$DUMP"
```

- `--format=custom` is compressed, restorable in parallel, and lets you restore
  selected tables. Plain SQL (`--format=plain`) is only worth it when you need
  to read or edit the dump.
- `--no-owner --no-privileges`: role names rarely match across servers, and
  without these the restore fails on the first `ALTER … OWNER TO` for a role
  that does not exist here.
- Globals — roles and their passwords — are **not** in a database dump. If the
  app's role has to exist on the target, dump them separately and treat the
  output as a secret:
  ```bash
  pg_dumpall --host=db.internal --username=postgres --globals-only --no-role-passwords \
    > ~/globals.sql     # --no-role-passwords: set new passwords on the target instead
  chmod 600 ~/globals.sql
  ```

Check the dump is complete before you trust it:

```bash
ls -lh "$DUMP"
pg_restore --list "$DUMP" | grep -c 'TABLE DATA'
```

### Restore

```bash
# target: create the role and database with the right encoding and locale first
psql --username=postgres -c "CREATE ROLE appuser LOGIN;"
# Set the password interactively. \password prompts and sends it hashed, so it
# never reaches your shell history or the server log, which is what
# CREATE ROLE … PASSWORD '…' does instead.
psql --username=postgres        # at the prompt:  \password appuser   then  \q
createdb --username=postgres --owner=appuser \
  --encoding=UTF8 --lc-collate=C --lc-ctype=C appdb

pg_restore --username=postgres --dbname=appdb --no-owner --role=appuser \
  --jobs=4 --exit-on-error --verbose "$DUMP"
```

`--exit-on-error` matters: by default `pg_restore` reports errors and carries
on, leaving a database that is *mostly* there and a process that exited 0.

**Match the major version, or go forwards only.** A dump from PostgreSQL 16
will not restore into 15. Going up a major version is fine; going down means
dumping as plain SQL from the newer server and fixing what the older one
rejects. Check both before you start: `psql -c 'SELECT version()'`.

Match the collation too. A different `lc_collate` changes index ordering, which
changes query results for anything sorted — subtly, with no error.

### Verify

```bash
# on both servers, then diff the two files
psql --dbname=appdb -At -c "
  SELECT relname || '|' || n_live_tup FROM pg_stat_user_tables ORDER BY relname;" \
  > ~/counts-target.txt
diff ~/counts-source.txt ~/counts-target.txt
```

`n_live_tup` is an estimate. After a restore, `ANALYZE;` first, then compare —
and check the tables that matter with `SELECT COUNT(*)`.

Then the three things a row count does not cover:

```bash
psql --dbname=appdb -c "\\dx"        # extensions: pgvector, postgis, uuid-ossp,
                                     # pg_trgm must be installed on the target
psql --dbname=appdb -At -c "
  SELECT sequencename, last_value FROM pg_sequences ORDER BY 1;"
psql --dbname=appdb -At -c "
  SELECT conname FROM pg_constraint WHERE NOT convalidated;"
```

A missing extension fails the restore of the table that uses it and nothing
else. A sequence left at 1 means the next insert collides with row 1 — the
classic "duplicate key" that appears an hour after a migration nobody suspects.

## SQLite

A file — which makes it trivial and also the easiest to corrupt, because
copying a database mid-write gives you a torn page and a file that opens fine
until the first query that touches it.

```bash
# the right way: let SQLite write the copy, with the app still running
sqlite3 /srv/app/data.db ".backup '/tmp/data-backup.db'"
chmod 600 /tmp/data-backup.db
sqlite3 /tmp/data-backup.db 'PRAGMA integrity_check;'   # must print: ok
```

Do not `cp` a live database. If you must, stop the app first — and remember WAL
mode leaves `data.db-wal` and `data.db-shm` beside the file; copying only
`data.db` silently loses the most recent writes.

```bash
# transfer, then verify on the target
scp /tmp/data-backup.db user@newhost:/srv/example.com/data.db
sqlite3 /srv/example.com/data.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
sqlite3 /srv/example.com/data.db \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Permissions are the gotcha: SQLite needs write access to the **directory**, not
just the file, to create the `-wal` and journal files. A read-only directory
produces "attempt to write a readonly database" on a file that is `664`.

```bash
chown appuser:appuser /srv/example.com /srv/example.com/data.db
chmod 750 /srv/example.com && chmod 640 /srv/example.com/data.db
```

And never put the file under the document root. A SQLite database in
`public/data.db` is downloadable by anyone who guesses the name.

## MongoDB

```bash
# dump — credentials via a config file, not the command line
umask 077
cat > ~/mongo-src.yaml <<'YAML'
uri: "mongodb://appuser@db.internal:27017/appdb?authSource=admin"
password: "THE_PASSWORD"
YAML
chmod 600 ~/mongo-src.yaml

mongodump --config="$HOME/mongo-src.yaml" --gzip --archive="$HOME/appdb.archive.gz"
chmod 600 ~/appdb.archive.gz
```

`--archive` plus `--gzip` gives one file instead of a directory tree, which
transfers and checksums cleanly.

```bash
# restore
mongorestore --config="$HOME/mongo-dst.yaml" --gzip \
  --archive="$HOME/appdb.archive.gz" --drop --numInsertionWorkersPerCollection=4
```

`--drop` replaces each collection as it restores. On a new target that is what
you want; against anything with data in it, it is destructive — check which you
are pointing at, every time.

Verify per collection, not in aggregate:

```bash
# --password with no value prompts, so the credential stays off the command line
# (and therefore out of `ps` and your history)
mongosh "mongodb://db.internal:27017/appdb" --username appuser --password \
  --quiet --eval '
  db.getCollectionNames().sort().forEach(c =>
    print(c + "|" + db.getCollection(c).countDocuments()))' > counts-target.txt
diff counts-source.txt counts-target.txt
```

Then check the indexes came across — `mongodump` carries them, a hand-written
import script usually does not, and a missing index is a site that works
perfectly until it is slow:

```bash
mongosh "mongodb://db.internal:27017/appdb" --username appuser --password \
  --quiet --eval '
  db.getCollectionNames().forEach(c =>
    printjson({c: c, idx: db.getCollection(c).getIndexes().map(i => i.name)}))'
```

## Redis and other caches

A cache does not need migrating — it needs warming. Point the app at an empty
Redis on the target and let it refill.

Two exceptions, both worth checking before you discard it:

- **Sessions in Redis.** An empty instance logs every user out at cutover.
  Survivable, and worth telling the client rather than having them discover it.
- **Queues in Redis** (Sidekiq, BullMQ, Laravel queues, Celery). Those are
  pending jobs, not cache. Drain the queue on the source before the final
  sync — let the workers finish, confirm the queue is empty, *then* stop them —
  or those jobs are lost.

```bash
# REDISCLI_AUTH is read from the environment, so the password is not an argument
export REDISCLI_AUTH
read -rs REDISCLI_AUTH
redis-cli -h 127.0.0.1 -p 6379 INFO keyspace
redis-cli -h 127.0.0.1 -p 6379 LLEN some_queue
unset REDISCLI_AUTH
```

If you genuinely must move the data, `BGSAVE` then copy `dump.rdb` with the
service stopped. Never expose Redis to the internet to do it: it has no
meaningful authentication by default, and an open instance is a remote code
execution waiting to happen. Bind it to `127.0.0.1`, or tunnel over SSH.

## Moving between engines

MySQL → PostgreSQL, or either → SQLite, is a **port**, not a migration. The
schema, the types (`TINYINT(1)` vs `boolean`, `DATETIME` vs `timestamptz`,
`AUTO_INCREMENT` vs `GENERATED … AS IDENTITY`), zero dates, the collation and
every query the application writes by hand all have to change.

Do it with the application's own migration tooling against an empty target
database, import the data as a separate scripted pass, and verify with row
counts per table plus a spot check of anything involving a date, a decimal, or
a boolean. It belongs in its own session with its own plan — not inside a host
move.
