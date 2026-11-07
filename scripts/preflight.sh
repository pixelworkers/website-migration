#!/usr/bin/env bash
# preflight.sh — READ-ONLY inventory and sanity report for a site to migrate.
#
# Detects the stack (WordPress / generic PHP / static / Node), measures size,
# finds the DB connection details, and prints a report plus a go/no-go summary.
# Touches nothing. Safe to run against production.
#
# Every inspection runs as a fixed shell snippet that receives --path and --ssh
# values as positional arguments ("$1"), never spliced into a command string, so
# a path containing a quote or semicolon is inspected, not executed.
#
# Usage:
#   preflight.sh --path /var/www/site [--ssh user@host] [--url https://site.com]
#
# Options:
#   --path DIR     Document root / project directory to inspect (required).
#   --ssh  TARGET  Run the inspection over SSH on TARGET (e.g. user@host).
#   --url  URL     Public URL to probe for live HTTP status (optional).
#
# Exit code is always 0 for a successful inspection; findings are in the report.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"

PATH_DIR=""; SSH_TARGET=""; URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATH_DIR="${2:-}"; shift 2 ;;
    --ssh)  SSH_TARGET="${2:-}"; shift 2 ;;
    --url)  URL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$PATH_DIR" ] || die "--path is required"
PATH_DIR="$(norm_path "$PATH_DIR")"

# rx SCRIPT [VALUE...] — run a read-only shell snippet locally or on --ssh.
rx() { rsh "$SSH_TARGET" "$@"; }

log "Inventory target: ${SSH_TARGET:+$SSH_TARGET:}$PATH_DIR"

rx 'test -d "$1"' "$PATH_DIR" || die "path not found or not a directory: $PATH_DIR"

echo "============================================================"
echo " SITE MIGRATION — PRE-FLIGHT REPORT"
echo " generated: $(_ts)"
echo " target:    ${SSH_TARGET:+$SSH_TARGET:}$PATH_DIR"
echo "============================================================"

# ---- stack detection --------------------------------------------------------
STACK="unknown"
if rx 'test -f "$1/wp-config.php"' "$PATH_DIR"; then STACK="wordpress"
elif rx 'test -f "$1/package.json"' "$PATH_DIR"; then STACK="node"
elif rx 'ls "$1"/*.php >/dev/null 2>&1' "$PATH_DIR"; then STACK="php"
elif rx 'test -f "$1/index.html"' "$PATH_DIR"; then STACK="static"
fi
echo
echo "STACK: $STACK"

# ---- size and file count ----------------------------------------------------
SIZE_BYTES="$(rx 'du -sb "$1" 2>/dev/null | cut -f1' "$PATH_DIR" || echo 0)"
# macOS/BSD du has no -b; fall back to -sk (KB) * 1024.
if [ -z "$SIZE_BYTES" ] || [ "$SIZE_BYTES" = "0" ]; then
  SIZE_KB="$(rx 'du -sk "$1" 2>/dev/null | cut -f1' "$PATH_DIR" || echo 0)"
  SIZE_BYTES=$(( ${SIZE_KB:-0} * 1024 ))
fi
FILE_COUNT="$(rx 'find "$1" -type f 2>/dev/null | wc -l' "$PATH_DIR" | tr -d ' ')"
echo "SIZE: $(human_size "$SIZE_BYTES") across ${FILE_COUNT} files"
if [ "$SIZE_BYTES" -gt $(( 5 * 1024 * 1024 * 1024 )) ] 2>/dev/null; then
  echo "NOTE: large site (>5GB). Plan a staged rsync and expect a longer uploads sync."
fi

# ---- WordPress specifics ----------------------------------------------------
if [ "$STACK" = "wordpress" ]; then
  echo
  echo "--- WordPress ---"
  # Extract DB settings WITHOUT printing the password. Fetch the raw matching
  # lines, then parse locally (avoids fragile sed escaping through ssh).
  WPRAW="$(rx 'grep -E "$2" "$1/wp-config.php" 2>/dev/null' "$PATH_DIR" 'DB_(NAME|USER|HOST)|table_prefix' || true)"
  for key in DB_NAME DB_USER DB_HOST; do
    val="$(printf '%s\n' "$WPRAW" | sed -nE "s/.*'$key'[[:space:]]*,[[:space:]]*'([^']*)'.*/\\1/p" | head -1)"
    echo "  $key=${val:-<not found>}"
  done
  if rx 'grep -q DB_PASSWORD "$1/wp-config.php"' "$PATH_DIR"; then
    echo "  DB_PASSWORD=<present in wp-config.php, not shown>"
  else
    echo "  DB_PASSWORD=<not found — check wp-config.php>"
  fi
  TABLE_PREFIX="$(printf '%s\n' "$WPRAW" | sed -nE "s/.*table_prefix[[:space:]]*=[[:space:]]*'([^']*)'.*/\\1/p" | head -1)"
  echo "  TABLE_PREFIX=${TABLE_PREFIX:-wp_ (default, confirm)}"
  if rx 'command -v wp >/dev/null 2>&1' "$PATH_DIR"; then
    echo "  wp-cli: available ($(rx 'wp --version --path="$1" --allow-root 2>/dev/null | head -1' "$PATH_DIR" || true))"
  else
    echo "  wp-cli: NOT installed on target — required for serialized-safe URL rewrite."
  fi
  UPLOADS="$(rx 'du -sk "$1/wp-content/uploads" 2>/dev/null | cut -f1' "$PATH_DIR" || echo 0)"
  echo "  uploads: $(human_size $(( ${UPLOADS:-0} * 1024 )))"
  if rx 'test -f "$1/.htaccess"' "$PATH_DIR"; then
    echo "  .htaccess: present (Apache rewrites — port to nginx if needed)"
  else
    echo "  .htaccess: none"
  fi
fi

# ---- generic DB hints -------------------------------------------------------
if [ "$STACK" != "wordpress" ]; then
  echo
  echo "--- config / env ---"
  for f in .env .env.local config.php wp-config.php database.yml; do
    rx 'test -f "$1/$2"' "$PATH_DIR" "$f" \
      && echo "  found: $f (contains config/secrets — migrate out of band, never commit)"
  done
fi

# ---- runtime versions on target --------------------------------------------
echo
echo "--- target runtime ---"
echo "  php:    $(rx 'php -v 2>/dev/null | head -1' || echo 'n/a')"
echo "  mysql:  $(rx 'mysql --version 2>/dev/null' || echo 'n/a')"
echo "  node:   $(rx 'node -v 2>/dev/null' || echo 'n/a')"
# nginx/httpd print their version to stderr, so 2>&1 is required — but keep
# "command not found" out of the report when they are simply absent.
echo "  nginx:  $(rx 'command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | head -1 || echo n/a')"
echo "  apache: $(rx 'for b in httpd apache2; do command -v "$b" >/dev/null 2>&1 && { "$b" -v 2>&1 | head -1; exit 0; }; done; echo n/a')"

# ---- live URL probe ---------------------------------------------------------
if [ -n "$URL" ]; then
  echo
  echo "--- live probe ---"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "$URL" || echo 000)"
  echo "  $URL -> HTTP $CODE"
fi

echo
echo "============================================================"
echo " GO / NO-GO CHECKLIST (verify each before cutover)"
echo "============================================================"
cat <<'EOF'
  [ ] Source backup taken and its restore verified (backup.sh --go)
  [ ] Database dumped and the dump restores cleanly on a scratch DB (db-dump.sh)
  [ ] DNS TTL lowered to 300s at least 24-48h before cutover
  [ ] Destination host provisioned: runtime + webserver vhost + TLS ready
  [ ] Files transferred and counts match source (transfer.sh)
  [ ] URLs rewritten serialized-safe on the destination (wp-search-replace.sh)
  [ ] File permissions corrected on destination (fix-perms.sh)
  [ ] Destination passes the verification sweep on a temporary hostname (verify.sh)
  [ ] Rollback plan written: old host stays live + online until checks pass
EOF
log "Pre-flight complete. Nothing was modified."
