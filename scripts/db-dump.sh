#!/usr/bin/env bash
# db-dump.sh — safe mysqldump wrapper. READ-ONLY against the source database.
#
# Credentials come from the environment or flags — NEVER hardcoded, never
# printed, and never placed in a command line. The password reaches mysqldump
# through MYSQL_PWD in the process environment:
#   * locally, by setting it on the mysqldump invocation itself;
#   * over SSH, by sending it on ssh's stdin and having the remote shell read it
#     into its own environment before exec'ing mysqldump.
# It therefore appears in neither the local nor the remote `ps` output, and a
# password containing quotes, semicolons or $ is handled correctly.
#
# Environment (or use the matching flags):
#   DB_HOST   (default 127.0.0.1)
#   DB_PORT   (default 3306)
#   DB_NAME   (required)
#   DB_USER   (required)
#   DB_PASS   (required; read from env, prompted if a tty and unset)
#
# Usage:
#   DB_NAME=app DB_USER=app DB_PASS=... db-dump.sh --out dump.sql.gz
#   db-dump.sh --ssh user@host --db app --user app --out dump.sql.gz
#
# Options:
#   --out  FILE    Output path; .gz suffix enables gzip (recommended).
#   --ssh  TARGET  Run mysqldump on a remote host over SSH (DB stays local to it).
#   --db   NAME    Overrides DB_NAME.
#   --host HOST / --port N / --user NAME   Override the matching env var.
#
# There is no dry-run: the dump file IS this script's only output, so there is
# nothing to preview. It therefore ignores the shared DRY_RUN default rather
# than printing a plan and claiming a dump exists.
#
# mysqldump flags chosen: --single-transaction (consistent snapshot without
# locking InnoDB tables), --routines --triggers --events (don't lose stored
# programs), --default-character-set=utf8mb4, --no-tablespaces (avoids a perm
# requirement on managed hosts). This script never writes to the DB.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"
# shellcheck disable=SC2034  # consumed by common.sh run()/rsh_dry()
DRY_RUN=0   # deliberate: see the header note above.

OUT=""; SSH_TARGET=""
: "${DB_HOST:=127.0.0.1}"; : "${DB_PORT:=3306}"
: "${DB_NAME:=}"; : "${DB_USER:=}"; : "${DB_PASS:=}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out)  OUT="${2:-}"; shift 2 ;;
    --ssh)  SSH_TARGET="${2:-}"; shift 2 ;;
    --db)   DB_NAME="${2:-}"; shift 2 ;;
    --host) DB_HOST="${2:-}"; shift 2 ;;
    --port) DB_PORT="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$OUT" ]     || die "--out is required"
[ -n "$DB_NAME" ] || die "DB_NAME (or --db) is required"
[ -n "$DB_USER" ] || die "DB_USER (or --user) is required"
case "$DB_PORT" in ''|*[!0-9]*) die "--port must be numeric (got: $DB_PORT)" ;; esac
if [ -z "$DB_PASS" ]; then
  if [ -t 0 ]; then
    printf 'DB password for %s@%s: ' "$DB_USER" "$DB_HOST" >&2
    read -rs DB_PASS; echo >&2
  fi
  [ -n "$DB_PASS" ] || die "DB_PASS is empty — set it in the environment or run interactively"
fi
# The remote path carries the password as a single line on stdin, so a newline
# inside it would be truncated. Locally it goes straight into the environment,
# where newlines are fine.
if [ -n "$SSH_TARGET" ]; then
  case "$DB_PASS" in
    *$'\n'*) die "DB_PASS contains a newline, which cannot be sent safely over SSH — dump locally on that host instead" ;;
  esac
fi

# mysqldump's option parser has no "--" terminator, so reject leading dashes
# explicitly rather than letting a name be read as a flag.
case "$DB_NAME" in -*) die "DB_NAME must not start with '-' (got: $DB_NAME)" ;; esac
case "$DB_USER" in -*) die "DB_USER must not start with '-' (got: $DB_USER)" ;; esac
case "$DB_HOST" in -*) die "DB_HOST must not start with '-' (got: $DB_HOST)" ;; esac

# An array, not a string: a DB name or user containing a space is a single
# argument and can never word-split into extra mysqldump flags.
DUMP_ARGS=(
  --single-transaction --quick --routines --triggers --events
  --default-character-set=utf8mb4 --no-tablespaces
  "--host=$DB_HOST" "--port=$DB_PORT" "--user=$DB_USER"
  "$DB_NAME"
)

# Compression is chosen from a fixed set — never from user input.
case "$OUT" in
  *.gz) need gzip; COMPRESS_LOCAL=(gzip -c); COMPRESS_REMOTE='gzip -c' ;;
  *)    COMPRESS_LOCAL=(cat);                COMPRESS_REMOTE='cat' ;;
esac

OUT_DIR="$(dirname "$OUT")"
[ -d "$OUT_DIR" ] || die "output directory does not exist: $OUT_DIR"

log "Dumping database '$DB_NAME' from $DB_HOST (read-only) -> $OUT"

dump_failed=0
if [ -n "$SSH_TARGET" ]; then
  ssh_argv "$SSH_TARGET"
  # The password is the first (and only) line on stdin. The remote shell reads
  # it into MYSQL_PWD and exports it; it never appears in any argv.
  #
  # The exit status of `mysqldump | gzip` is gzip's, and gzip happily succeeds
  # on a dump that died halfway — so a truncated backup would be reported as a
  # good one. `set -o pipefail` would fix it, but ssh runs this under the
  # remote account's login shell and pipefail is not POSIX; a shell without it
  # would silently keep the old behaviour. So the status is captured explicitly
  # instead, which works in every POSIX shell: fd 4 carries mysqldump's exit
  # code out to the command substitution while fd 3 carries the compressed
  # stream through to ssh's stdout.
  printf '%s\n' "$DB_PASS" | "${SSH_ARGV[@]}" \
    "IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec 3>&1; \
     st=\$( { { mysqldump $(shquote "${DUMP_ARGS[@]}"); echo \$? >&4; } | $COMPRESS_REMOTE >&3; } 4>&1 ) || st=1; \
     exit \"\${st:-1}\"" \
    > "$OUT" || dump_failed=1
else
  need mysqldump
  MYSQL_PWD="$DB_PASS" mysqldump "${DUMP_ARGS[@]}" | "${COMPRESS_LOCAL[@]}" > "$OUT" || dump_failed=1
fi

if [ "$dump_failed" = "1" ]; then
  rm -f "$OUT"
  die "mysqldump failed — no usable dump was produced (removed the partial file)"
fi

[ -f "$OUT" ] || die "dump file was not created: $OUT"
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
[ "$SIZE" -gt 0 ] || { rm -f "$OUT"; die "dump is empty — check credentials and DB name"; }
sha256_file "$OUT"
log "Dump written: $(human_size "$SIZE") (sha256 in $(basename "$OUT").sha256)."
log "Restore test (on a SCRATCH database, never the source):"
case "$OUT" in
  *.gz) dim "  gunzip -c $(_quote "$OUT") | mysql -u USER -p SCRATCH_DB" ;;
  *)    dim "  mysql -u USER -p SCRATCH_DB < $(_quote "$OUT")" ;;
esac
