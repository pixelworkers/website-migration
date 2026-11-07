#!/usr/bin/env bash
# transfer.sh — rsync wrapper with safe defaults for moving files between hosts.
#
# DRY-RUN BY DEFAULT. It shows exactly what would change and makes no writes
# until you pass --go. --delete (mirror) is refused unless you additionally
# pass --mirror AND confirm interactively, because it can remove files on the
# destination.
#
# Usage:
#   transfer.sh --from user@old:/var/www/site/ --to /var/www/site/        # preview
#   transfer.sh --from user@old:/var/www/site/ --to /var/www/site/ --go   # execute
#
# Options:
#   --from SRC   rsync source (trailing slash = contents). Required.
#   --to   DST   rsync destination. Required.
#   --go         Actually transfer (otherwise dry-run preview only).
#   --mirror     Allow --delete so DST exactly matches SRC (dangerous; confirmed).
#   --exclude P  Add an rsync exclude pattern (repeatable). Sensible defaults
#                already exclude VCS dirs and OS cruft.
#
# Source is only READ by rsync. The old host is never modified by this script.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"

FROM=""; TO=""; GO=0; MIRROR=0
EXCLUDES=(--exclude='.git/' --exclude='.svn/' --exclude='.DS_Store' --exclude='node_modules/' --exclude='*.log')
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --to)   TO="${2:-}"; shift 2 ;;
    --go)   GO=1; shift ;;
    --mirror) MIRROR=1; shift ;;
    --exclude) EXCLUDES+=(--exclude="${2:-}"); shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$FROM" ] || die "--from is required"
[ -n "$TO" ]   || die "--to is required"
need rsync

# -a archive (perms/times/symlinks), -z compress, -h human, --partial resume.
# We intentionally do NOT pass --delete unless --mirror is set and confirmed.
RSYNC_ARGS=(-azh --partial "${EXCLUDES[@]}")
# Progress flag differs by rsync version: --info=progress2 is rsync 3.1+, older
# rsync/openrsync only have --progress. Pick what this rsync supports.
if rsync --info=progress2 --version >/dev/null 2>&1; then
  RSYNC_ARGS+=(--info=progress2)
elif rsync --progress --version >/dev/null 2>&1; then
  RSYNC_ARGS+=(--progress)
fi

if [ "$MIRROR" = "1" ]; then
  warn "--mirror requested: rsync --delete will REMOVE files on the destination"
  warn "that are not present in the source: $TO"
  if confirm "Enable --delete (mirror) on $TO?"; then
    RSYNC_ARGS+=(--delete)
  else
    die "mirror not confirmed — aborting (nothing was transferred)"
  fi
fi

if [ "$GO" != "1" ]; then
  log "DRY-RUN preview (no changes). Add --go to execute."
  rsync --dry-run --stats "${RSYNC_ARGS[@]}" "$FROM" "$TO" || true
  echo
  log "Review the list above. Re-run with --go when it looks right."
  exit 0
fi

log "Transferring: $FROM  ->  $TO"
rsync "${RSYNC_ARGS[@]}" "$FROM" "$TO"
log "Transfer complete. Verify counts next:"
dim "  find <src> -type f | wc -l   # compare against the destination"
