#!/usr/bin/env bash
# wp-search-replace.sh — serialized-data-SAFE URL rewrite for WordPress.
#
# WHY THIS EXISTS: WordPress stores PHP-serialized arrays in the database
# (widget settings, theme options, page-builder data). A raw SQL
# `UPDATE ... REPLACE(...)` corrupts them, because serialized strings encode
# their own byte length (e.g. s:19:"https://old.com/abc"). wp-cli's
# `wp search-replace` walks the data structure and fixes those lengths. This
# script wraps it; it will NOT run a raw SQL find/replace, ever.
#
# DRY-RUN BY DEFAULT (wp's own --dry-run). It reports how many rows WOULD change
# and writes nothing until you pass --go. With --go it confirms interactively;
# with no tty it refuses unless you also pass --yes, so an unattended run can
# never silently rewrite a live production database.
#
# Run this ON the destination host, after the DB is imported there, where both
# `wp` and the database are reachable.
#
# Usage:
#   wp-search-replace.sh --path /var/www/site --old https://old.com --new https://new.com
#   wp-search-replace.sh --path /var/www/site --old https://old.com --new https://new.com --go
#
# Options:
#   --path DIR   WordPress install dir (contains wp-config.php). Required.
#   --old URL    Old URL/string to replace. Required.
#   --new URL    New URL/string. Required.
#   --go         Execute the replacement (otherwise dry-run report only).
#   --yes        Skip the interactive confirmation (required for --go with no tty).
#   --ssh TARGET Run wp over SSH on the destination host.
#   --allow-root Pass --allow-root to wp (needed when running as root).
#
# Notes:
#   * --skip-columns=guid  : post GUIDs are permanent identifiers for feed
#     readers and must NOT be rewritten (WordPress guidance).
#   * --all-tables-with-prefix : covers custom plugin tables sharing the prefix.
#   * --precise + --recurse-objects : correct handling of nested serialized data.
#   * Always back up the DB first (db-dump.sh) — this is a one-way change.
#   * Every value you pass is handed to wp as a separate argument (and, over
#     SSH, shell-quoted exactly once), so a quote in a URL cannot become code.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"

PATH_DIR=""; OLD=""; NEW=""; GO=0; SSH_TARGET=""; ALLOW_ROOT=""; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATH_DIR="${2:-}"; shift 2 ;;
    --old)  OLD="${2:-}"; shift 2 ;;
    --new)  NEW="${2:-}"; shift 2 ;;
    --go)   GO=1; shift ;;
    --yes)  ASSUME_YES=1; shift ;;
    --ssh)  SSH_TARGET="${2:-}"; shift 2 ;;
    --allow-root) ALLOW_ROOT="--allow-root"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$PATH_DIR" ] || die "--path is required"
[ -n "$OLD" ] || die "--old is required"
[ -n "$NEW" ] || die "--new is required"
[ "$OLD" != "$NEW" ] || die "--old and --new are identical; nothing to do"

# wp flags as an array — never a word-split string.
WP_FLAGS=( "--path=$PATH_DIR" )
[ -n "$ALLOW_ROOT" ] && WP_FLAGS+=( "$ALLOW_ROOT" )
WP_FLAGS+=( --all-tables-with-prefix --precise --recurse-objects
            --skip-columns=guid --report-changed-only )

WP_PROBE=( wp option get siteurl "--path=$PATH_DIR" )
[ -n "$ALLOW_ROOT" ] && WP_PROBE+=( "$ALLOW_ROOT" )

[ -n "$SSH_TARGET" ] || need wp

# Sanity: confirm wp can see the install and DB before touching anything.
log "Checking wp-cli can reach the WordPress database..."
if ! rrun "$SSH_TARGET" "${WP_PROBE[@]}" >/dev/null 2>&1; then
  die "wp-cli cannot reach WordPress at $PATH_DIR (check wp-config.php, DB, and that wp is installed on the target)."
fi

CMD=( wp search-replace "$OLD" "$NEW" "${WP_FLAGS[@]}" )

if [ "$GO" != "1" ]; then
  log "DRY-RUN: reporting rows that WOULD change (no writes). Add --go to apply."
  rrun "$SSH_TARGET" "${CMD[@]}" --dry-run
  echo
  log "If the counts look right, re-run with --go. Make sure db-dump.sh ran first."
  exit 0
fi

warn "About to rewrite '$OLD' -> '$NEW' across the database (serialized-safe)."
warn "This is a one-way change. Confirm you have a fresh DB dump."
gate "Proceed with the live search-replace on ${SSH_TARGET:-this host}?" "$ASSUME_YES"

log "Running serialized-safe search-replace..."
rrun "$SSH_TARGET" "${CMD[@]}"

# Common follow-ups people forget.
log "Done. Recommended follow-ups on the destination:"
WP_BASE=( "--path=$PATH_DIR" )
[ -n "$ALLOW_ROOT" ] && WP_BASE+=( "$ALLOW_ROOT" )
dim "  $(_quote wp option update home "$NEW" "${WP_BASE[@]}")"
dim "  $(_quote wp option update siteurl "$NEW" "${WP_BASE[@]}")"
dim "  $(_quote wp cache flush "${WP_BASE[@]}")"
dim "  $(_quote wp rewrite flush "${WP_BASE[@]}")   # regenerate permalinks"
