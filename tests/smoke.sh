#!/usr/bin/env bash
# smoke.sh — behavioural tests for the site-migration helper scripts.
#
# No network, no real SSH, no real database: `ssh`, `mysqldump` and `wp` are
# replaced by stubs on PATH that record exactly the argv they received, which is
# how the shell-injection and secret-handling tests assert what they assert.
#
# Run from anywhere:  tests/smoke.sh
# Exits 0 only if every check passes.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/scripts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sm-smoke.XXXXXX")"
BIN="$WORK/bin"; mkdir -p "$BIN"
# The canary: if any value we pass is ever evaluated as shell code, this file
# appears. Nothing in this suite should ever create it.
CANARY="$WORK/PWNED"
# The payload shape from the security review, parameterised on the canary path.
PAYLOAD="';id>$CANARY;'"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
sec() { printf '\n== %s\n' "$1"; }

# expect MSG TEST-ARG...     — passes when `test TEST-ARG...` succeeds.
expect()  { local m="$1"; shift; if test "$@"; then ok "$m"; else bad "$m"; fi; }
# refute MSG TEST-ARG...     — passes when `test TEST-ARG...` fails.
refute()  { local m="$1"; shift; if test "$@"; then bad "$m"; else ok "$m"; fi; }
# succeeds MSG CMD...        — passes when CMD exits 0 (output discarded).
succeeds() { local m="$1"; shift; if "$@" </dev/null >/dev/null 2>&1; then ok "$m"; else bad "$m"; fi; }
# fails MSG CMD...           — passes when CMD exits non-zero.
fails()    { local m="$1"; shift; if "$@" </dev/null >/dev/null 2>&1; then bad "$m"; else ok "$m"; fi; }
# no_canary MSG              — passes while no value has ever been executed.
no_canary() { refute "$1" -e "$CANARY"; }
# try CMD...                 — run CMD in a subshell, so a helper calling die()
#                              (which exits) cannot take the harness with it.
try() { ( "$@" ); }
# has MSG PATTERN TEXT       — passes when TEXT matches the ERE PATTERN.
has()   { local m="$1" p="$2"; if printf '%s\n' "$3" | grep -Eq "$p"; then ok "$m"; else bad "$m"; fi; }
# hasnt MSG PATTERN TEXT     — passes when TEXT does NOT match PATTERN.
hasnt() { local m="$1" p="$2"; if printf '%s\n' "$3" | grep -Eq "$p"; then bad "$m"; else ok "$m"; fi; }

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---- stubs -------------------------------------------------------------------
cat > "$BIN/ssh" <<'EOF'
#!/bin/sh
# Records its argv and the command string, then runs that string through the
# local shell — exactly what a real remote shell does with it.
: > "$STUB_DIR/ssh-argv"
for a in "$@"; do printf 'ARG=[%s]\n' "$a" >> "$STUB_DIR/ssh-argv"; last="$a"; done
printf '%s\n' "$last" > "$STUB_DIR/ssh-cmd"
exec sh -c "$last"
EOF

cat > "$BIN/mysqldump" <<'EOF'
#!/bin/sh
{ printf 'ARGC=%s\n' "$#"
  for a in "$@"; do printf 'ARG=[%s]\n' "$a"; done
  printf 'MYSQL_PWD_ENV=[%s]\n' "${MYSQL_PWD:-<unset>}"
} > "$STUB_DIR/dump-argv"
# STUB_DUMP_FAIL reproduces the real failure that matters: mysqldump dies part
# way through, having already written valid-looking output. gzip downstream
# still exits 0, so only a pipeline-aware caller notices.
if [ -n "${STUB_DUMP_FAIL:-}" ]; then
  printf -- '-- partial dump, connection lost\n'
  exit 3
fi
echo "-- fake dump"
EOF

cat > "$BIN/wp" <<'EOF'
#!/bin/sh
: > "$STUB_DIR/wp-argv"
for a in "$@"; do printf 'ARG=[%s]\n' "$a" >> "$STUB_DIR/wp-argv"; done
case "$1 $2" in "option get") echo "https://old.example"; exit 0 ;; esac
echo "stub wp ran"
EOF

chmod +x "$BIN/ssh" "$BIN/mysqldump" "$BIN/wp"
STUB_DIR="$WORK"; export STUB_DIR
PATH="$BIN:$PATH"; export PATH

echo "site-migration smoke tests"
echo "  workdir: $WORK"
echo "  bash:    $BASH_VERSION"
echo "  uname:   $(uname -s)"

# ---- 1. quoting --------------------------------------------------------------
sec "shquote round-trips every value through a real shell"
# shellcheck source=scripts/lib/common.sh
. "$S/lib/common.sh"
# common.sh sets -e for the scripts that source it; the harness must survive an
# expected non-zero exit.
set +e
for v in "x'y" "a b" "plain" "" "a'b'c" '$(id)' '`id`' 'semi;colon' '*glob*' "tab	sep"; do
  expect "round-trip: [$v]" "$(eval "printf '%s' $(shquote "$v")")" = "$v"
done
eval "set -- $(shquote "a b" "c'd" "e;f")"
expect "3 arguments stay separate" "$#" = 3
expect "argument 1 is literal" "$1" = "a b"
expect "argument 2 is literal" "$2" = "c'd"
expect "argument 3 is literal" "$3" = "e;f"

# ---- 2. path guard -----------------------------------------------------------
sec "assert_safe_path refuses system roots and relative paths"
for p in / /home /usr /var /var/www /etc /Users relative ../etc /var/www/../..; do
  fails "refuses $p" try assert_safe_path "$p"
done
succeeds "accepts /var/www/site" try assert_safe_path /var/www/site
expect "norm_path strips trailing slashes" "$(norm_path /var/www/site///)" = /var/www/site
expect "norm_path keeps /" "$(norm_path /)" = /

# ---- 3. fix-perms: injection regression + real work -------------------------
sec "fix-perms.sh (shell-injection regression + correct modes)"
SITE="$WORK/site$PAYLOAD"
mkdir -p "$SITE/sub"
: > "$SITE/sub/file with space.txt"; : > "$SITE/wp-config.php"
: > "$SITE/.env"; : > "$SITE/.env.local"
chmod 777 "$SITE/sub/file with space.txt" "$SITE/wp-config.php" "$SITE/.env" "$SITE/.env.local"
chmod 700 "$SITE/sub"
# shellcheck disable=SC2012  # single quoted path, not a glob or a listing parse
perms() { ls -ld "$1" | cut -c1-10; }

# The reviewed PoC shape: --go on a --path carrying a quote-escape payload.
"$S/fix-perms.sh" --path "$WORK/x$PAYLOAD" --go </dev/null >/dev/null 2>&1
no_canary "PoC: --go on an injected --path executes nothing"

succeeds "--go --yes still does its job on a path containing a single quote" \
  "$S/fix-perms.sh" --path "$SITE" --go --yes
no_canary "PoC: --go --yes on an injected --path executes nothing"
expect "directories -> 755"          "$(perms "$SITE/sub")" = "drwxr-xr-x"
expect "files -> 644 (with spaces)"  "$(perms "$SITE/sub/file with space.txt")" = "-rw-r--r--"
expect "wp-config.php -> 640"        "$(perms "$SITE/wp-config.php")" = "-rw-r-----"
expect ".env -> 600"                 "$(perms "$SITE/.env")" = "-rw-------"
expect ".env.* -> 600 (portable find, no xargs -r)" "$(perms "$SITE/.env.local")" = "-rw-------"

sec "fix-perms.sh gates"
fails "refuses --path / even with --go --yes" "$S/fix-perms.sh" --path / --go --yes
out="$("$S/fix-perms.sh" --path "$SITE" --go </dev/null 2>&1)"
has "--go with no tty and no --yes refuses" 'no tty and --yes was not given' "$out"
chmod 777 "$SITE/sub/file with space.txt"
"$S/fix-perms.sh" --path "$SITE" </dev/null >/dev/null 2>&1
expect "dry-run changes nothing on disk" "$(perms "$SITE/sub/file with space.txt")" = "-rwxrwxrwx"
fails "rejects a malformed --owner" "$S/fix-perms.sh" --path "$SITE" --owner 'root; id' --go --yes

# ---- 4. backup without --go --------------------------------------------------
sec "backup.sh without --go writes nothing and claims nothing"
OUTDIR="$WORK/backups"
out="$("$S/backup.sh" --path "$SITE" --out "$OUTDIR" --with-db </dev/null 2>&1)"
refute "output directory is NOT created" -d "$OUTDIR"
has "says plainly that nothing was written" 'NOT a backup' "$out"
hasnt "never claims success" '[Bb]ackup complete' "$out"
fails "produced no artifact at all" \
  sh -c 'find "$1" \( -name "*.tar.gz" -o -name "*.sql.gz" \) | grep -q .' sh "$WORK"

# ---- 5. backup --go ----------------------------------------------------------
sec "backup.sh --go writes an integrity-checked archive"
out="$("$S/backup.sh" --path "$SITE" --out "$OUTDIR" --go </dev/null 2>&1)"
expect "exits 0" "$?" = 0
ARC="$(find "$OUTDIR" -name '*.tar.gz' | head -1)"
expect "writes a non-empty archive" -s "$ARC"
expect "writes the .sha256 beside it" -s "$ARC.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  succeeds "the recorded checksum verifies (sha256sum)" \
    sh -c 'cd "$1" && sha256sum -c "$2"' sh "$OUTDIR" "$(basename "$ARC").sha256"
else
  succeeds "the recorded checksum verifies (shasum)" \
    sh -c 'cd "$1" && shasum -a 256 -c "$2"' sh "$OUTDIR" "$(basename "$ARC").sha256"
fi
succeeds "archive reads end to end (tar -t)" tar -tzf "$ARC"
succeeds "archive contains the site's files" \
  sh -c 'tar -tzf "$1" | grep -q wp-config.php' sh "$ARC"
has "reports the integrity check" 'integrity check passed' "$out"
no_canary "no injection via --path"

sec "backup.sh --go --ssh (stub ssh)"
OUT2="$WORK/backups-ssh"
succeeds "exits 0 over ssh" "$S/backup.sh" --path "$SITE" --out "$OUT2" --ssh fake@host --go
ARC2="$(find "$OUT2" -name '*.tar.gz' | head -1)"
succeeds "streamed archive is valid" tar -tzf "$ARC2"
succeeds "ssh got tar as quoted argv, not a spliced string" grep -q "^'tar' " "$WORK/ssh-cmd"
no_canary "no injection through the ssh command string"

sec "SSH_OPTS is split into argv, never eval'd"
OUT3="$WORK/backups-opts"
succeeds "honours SSH_OPTS flags" \
  env "SSH_OPTS=-i $WORK/key -p 2222" "$S/backup.sh" --path "$SITE" --out "$OUT3" --ssh fake@host --go
succeeds "flags reach ssh as separate arguments" grep -qF 'ARG=[-p]' "$WORK/ssh-argv"
succeeds "flag values reach ssh intact" grep -qF 'ARG=[2222]' "$WORK/ssh-argv"
env "SSH_OPTS=-i $WORK/key; id > $CANARY" "$S/backup.sh" --path "$SITE" \
  --out "$WORK/backups-opts2" --ssh fake@host --go </dev/null >/dev/null 2>&1
no_canary "a payload in SSH_OPTS is argv, not code"

sec "backup.sh --go failure path"
out="$("$S/backup.sh" --path "$WORK/does-not-exist/site" --out "$WORK/bk-fail" --go </dev/null 2>&1)"
expect "non-zero exit when tar fails" "$?" != 0
hasnt "never claims success after a failure" '[Bb]ackup complete' "$out"
fails "removes the partial archive" \
  sh -c 'find "$1" -name "*.tar.gz" 2>/dev/null | grep -q .' sh "$WORK/bk-fail"

# ---- 6. db-dump --------------------------------------------------------------
sec "db-dump.sh (local): secrets and flag injection"
DBDIR="$WORK/db"; mkdir -p "$DBDIR"
rm -f "$WORK/dump-argv"
succeeds "exits 0" env "DB_NAME=my db$PAYLOAD" "DB_USER=u ser" "DB_PASS=p'a\$s;w\`d" \
  "$S/db-dump.sh" --out "$DBDIR/x.sql.gz"
no_canary "a DB name carrying a payload executes nothing"
succeeds "DUMP_ARGS is an array: exactly 11 args, no word-splitting" \
  grep -q 'ARGC=11' "$WORK/dump-argv"
succeeds "DB name with spaces arrives as ONE argument" \
  grep -qF "ARG=[my db$PAYLOAD]" "$WORK/dump-argv"
succeeds "DB user with a space arrives as ONE argument" \
  grep -qF 'ARG=[--user=u ser]' "$WORK/dump-argv"
succeeds "password arrives via the environment, intact" \
  grep -qF "MYSQL_PWD_ENV=[p'a\$s;w\`d]" "$WORK/dump-argv"
fails "password never in mysqldump argv" grep -q 'ARG=.*p.a.s.w' "$WORK/dump-argv"
expect "writes a .sha256" -s "$DBDIR/x.sql.gz.sha256"
fails "refuses a DB name that would read as a flag" \
  env DB_NAME=--all-databases DB_USER=u DB_PASS=p "$S/db-dump.sh" --out "$DBDIR/y.sql"

sec "db-dump.sh --ssh (stub ssh): the password must not reach any argv"
rm -f "$WORK/dump-argv"
succeeds "exits 0 over ssh" env DB_NAME=app DB_USER=app "DB_PASS=p'a\$s;w\`d" \
  "$S/db-dump.sh" --ssh fake@host --out "$DBDIR/r.sql.gz"
fails "password absent from ssh argv (so absent from ps)" grep -q "p'a" "$WORK/ssh-argv"
fails "no MYSQL_PWD= assignment in the remote command line" grep -q 'MYSQL_PWD=' "$WORK/ssh-argv"
succeeds "remote reads the password from stdin" grep -q 'IFS= read -r MYSQL_PWD' "$WORK/ssh-cmd"
succeeds "remote mysqldump still received the right password" \
  grep -qF "MYSQL_PWD_ENV=[p'a\$s;w\`d]" "$WORK/dump-argv"
expect "dump file written over ssh" -s "$DBDIR/r.sql.gz"

sec "db-dump.sh: a truncated dump is a failure, not a backup"
# The remote side runs `mysqldump | gzip` under the account's login shell. The
# pipeline's status is gzip's, and gzip succeeds on a half-written dump, so
# without an explicit status capture a truncated backup is reported as good.
rm -f "$DBDIR/trunc-ssh.sql.gz"
out="$(env DB_NAME=app DB_USER=app DB_PASS=pw STUB_DUMP_FAIL=1 \
  "$S/db-dump.sh" --ssh fake@host --out "$DBDIR/trunc-ssh.sql.gz" </dev/null 2>&1)"
expect "ssh + gzip: exits non-zero when mysqldump dies mid-stream" "$?" != 0
has "ssh + gzip: says the dump failed" 'mysqldump failed' "$out"
refute "ssh + gzip: the partial .gz was removed" -e "$DBDIR/trunc-ssh.sql.gz"
refute "ssh + gzip: no checksum written for a failed dump" -e "$DBDIR/trunc-ssh.sql.gz.sha256"

rm -f "$DBDIR/trunc-ssh.sql"
out="$(env DB_NAME=app DB_USER=app DB_PASS=pw STUB_DUMP_FAIL=1 \
  "$S/db-dump.sh" --ssh fake@host --out "$DBDIR/trunc-ssh.sql" </dev/null 2>&1)"
expect "ssh, uncompressed: exits non-zero too" "$?" != 0
refute "ssh, uncompressed: the partial file was removed" -e "$DBDIR/trunc-ssh.sql"

rm -f "$DBDIR/trunc-local.sql.gz"
out="$(env DB_NAME=app DB_USER=app DB_PASS=pw STUB_DUMP_FAIL=1 \
  "$S/db-dump.sh" --out "$DBDIR/trunc-local.sql.gz" </dev/null 2>&1)"
expect "local + gzip: exits non-zero when mysqldump dies mid-stream" "$?" != 0
refute "local + gzip: the partial .gz was removed" -e "$DBDIR/trunc-local.sql.gz"

# And the happy path still works, so the status plumbing did not break it.
rm -f "$DBDIR/good.sql.gz"
succeeds "a healthy remote dump still exits 0" \
  env DB_NAME=app DB_USER=app DB_PASS=pw "$S/db-dump.sh" --ssh fake@host --out "$DBDIR/good.sql.gz"
expect "a healthy remote dump is non-empty" -s "$DBDIR/good.sql.gz"
succeeds "a healthy remote dump decompresses to the stub output" \
  sh -c 'gunzip -c "$1" | grep -q "fake dump"' sh "$DBDIR/good.sql.gz"

# ---- 7. wp-search-replace ----------------------------------------------------
sec "wp-search-replace.sh"
out="$("$S/wp-search-replace.sh" --path /var/www/site --old https://a.test --new https://b.test </dev/null 2>&1)"
succeeds "default run passes wp --dry-run" grep -q 'ARG=\[--dry-run\]' "$WORK/wp-argv"
has "default run says it is a dry run" 'DRY-RUN' "$out"
rm -f "$WORK/wp-argv"
out="$("$S/wp-search-replace.sh" --path /var/www/site --old https://a.test --new https://b.test --go </dev/null 2>&1)"
has "--go with no tty and no --yes REFUSES (no silent prod rewrite)" 'no tty and --yes was not given' "$out"
fails "did not run search-replace when the gate failed" \
  grep -q 'ARG=\[search-replace\]' "$WORK/wp-argv"
rm -f "$WORK/wp-argv"
succeeds "--go --yes proceeds" "$S/wp-search-replace.sh" --path /var/www/site \
  --old "https://a.test$PAYLOAD" --new https://b.test --go --yes
no_canary "a payload in --old executes nothing"
succeeds "--old reaches wp as one literal argument" \
  grep -qF "ARG=[https://a.test$PAYLOAD]" "$WORK/wp-argv"
succeeds "keeps --skip-columns=guid" grep -q 'ARG=\[--skip-columns=guid\]' "$WORK/wp-argv"
succeeds "keeps --all-tables-with-prefix" grep -q 'ARG=\[--all-tables-with-prefix\]' "$WORK/wp-argv"
fails "--go drops --dry-run" grep -q 'ARG=\[--dry-run\]' "$WORK/wp-argv"
fails "refuses identical --old/--new" "$S/wp-search-replace.sh" --path /var/www/site --old same --new same
fails "never offers a raw SQL find/replace (wp search-replace only)" \
  grep -Eq '(^|[^a-z-])(mysql|wp[[:space:]]+db[[:space:]]+query)[[:space:]]' "$S/wp-search-replace.sh"

# ---- 8. preflight ------------------------------------------------------------
sec "preflight.sh (read-only)"
WPDIR="$WORK/wpsite$PAYLOAD"; mkdir -p "$WPDIR/wp-content/uploads"
cat > "$WPDIR/wp-config.php" <<'EOF'
<?php
define('DB_NAME', 'mydb');
define('DB_USER', 'myuser');
define('DB_PASSWORD', 'sup3rs3cret');
define('DB_HOST', 'localhost');
$table_prefix = 'wp7_';
EOF
: > "$WPDIR/.htaccess"; echo x > "$WPDIR/wp-content/uploads/a.jpg"
before="$(find "$WPDIR" | sort)"
out="$("$S/preflight.sh" --path "$WPDIR" </dev/null 2>&1)"
expect "exits 0" "$?" = 0
no_canary "a payload in --path executes nothing"
has "detects the WordPress stack" 'STACK: wordpress' "$out"
has "reports DB_NAME" 'DB_NAME=mydb' "$out"
has "reports the table prefix" 'TABLE_PREFIX=wp7_' "$out"
hasnt "never prints the DB password" 'sup3rs3cret' "$out"
hasnt "no stray shell errors in the report" 'command not found' "$out"
expect "modified nothing" "$before" = "$(find "$WPDIR" | sort)"

# ---- 9. interface hygiene ----------------------------------------------------
sec "interface hygiene"
for f in "$S"/*.sh; do
  succeeds "$(basename "$f") --help exits 0" "$f" --help
done
for f in "$S"/*.sh; do
  fails "$(basename "$f") rejects an unknown flag" "$f" --not-a-real-flag
done

if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  sec "committed file modes"
  for f in $(git -C "$ROOT" ls-files 'scripts/*.sh' | grep -v '^scripts/lib/'); do
    m="$(git -C "$ROOT" ls-files -s "$f" | cut -d' ' -f1)"
    expect "$f committed executable (got $m)" "$m" = 100755
  done
  m="$(git -C "$ROOT" ls-files -s scripts/lib/common.sh | cut -d' ' -f1)"
  expect "scripts/lib/common.sh committed 100644 — sourced, not run (got $m)" "$m" = 100644
fi

# ---- 10. checksum helper -----------------------------------------------------
sec "sha256_file"
: > "$WORK/chk"
succeeds "writes a checksum with whichever tool exists" try sha256_file "$WORK/chk"
expect "the checksum file is non-empty" -s "$WORK/chk.sha256"
mkdir -p "$WORK/empty-bin"
# shellcheck disable=SC2123  # intentional: prove the no-tool branch fails loudly
fails "fails loudly when neither sha256sum nor shasum exists" \
  env -i "PATH=$WORK/empty-bin" "BASH_ENV=" bash -c \
  ". '$S/lib/common.sh'; sha256_file '$WORK/chk'"

# ---- result ------------------------------------------------------------------
printf '\n============================================================\n'
printf ' %s passed, %s failed\n' "$PASS" "$FAIL"
printf '============================================================\n'
[ "$FAIL" -eq 0 ]
