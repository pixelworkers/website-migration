#!/usr/bin/env bash
# backup.sh — full, READ-ONLY backup of a site's files (and optionally its DB).
#
# Creates a timestamped tar.gz of the source directory. The source is only READ
# (tar opens files read-only); it is never modified, moved, or deleted. The DB
# dump is delegated to db-dump.sh so credentials come from the environment.
#
# PREVIEW BY DEFAULT: without --go this prints exactly what it would write and
# creates nothing — no output directory, no archive, no DB dump — and says so.
# Pass --go to actually take the backup. A backup is only ever reported as
# complete after the archive exists, its checksum is written, and `tar -t`
# has read it end to end.
#
# Usage:
#   backup.sh --path /var/www/site --out /backups                     # preview
#   backup.sh --path /var/www/site --out /backups --go                # take it
#   backup.sh --path /var/www/site --out /backups --ssh user@host --with-db --go
#
# Options:
#   --path DIR    Directory to back up (required).
#   --out  DIR    Where to write the archive (required; created with --go).
#   --go          Actually write the backup (otherwise preview only).
#   --ssh  TARGET Back up a directory that lives on a remote host, over SSH.
#   --with-db     Also run db-dump.sh (reads DB_* env vars; see that script).
#   --label NAME  Filename label (default: basename of --path).
#
# The archive is written locally even when --ssh is used (streamed over SSH),
# so your backup does not depend on the source host staying alive.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"

PATH_DIR=""; OUT=""; SSH_TARGET=""; WITH_DB=0; LABEL=""; GO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATH_DIR="${2:-}"; shift 2 ;;
    --out)  OUT="${2:-}"; shift 2 ;;
    --go)   GO=1; shift ;;
    --ssh)  SSH_TARGET="${2:-}"; shift 2 ;;
    --with-db) WITH_DB=1; shift ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$PATH_DIR" ] || die "--path is required"
[ -n "$OUT" ] || die "--out is required"
PATH_DIR="$(norm_path "$PATH_DIR")"
OUT="$(norm_path "$OUT")"
[ -n "$LABEL" ] || LABEL="$(basename "$PATH_DIR")"
case "$LABEL" in */*|'') die "--label must be a plain filename fragment (got: $LABEL)" ;; esac

need tar
# shellcheck disable=SC2034  # consumed by common.sh run()/rsh_dry()
if [ "$GO" = "1" ]; then DRY_RUN=0; else DRY_RUN=1; fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
ARCHIVE="$OUT/${LABEL}-files-${STAMP}.tar.gz"
DB_OUT="$OUT/${LABEL}-db-${STAMP}.sql.gz"
PARENT="$(dirname "$PATH_DIR")"
BASE="$(basename "$PATH_DIR")"

# ---- preview path: write absolutely nothing ---------------------------------
if [ "$DRY_RUN" = "1" ]; then
  log "PREVIEW ONLY — no backup will be taken. Add --go to write it."
  dim "  would create directory: $OUT"
  dim "  would write archive:    $ARCHIVE"
  dim "  would write checksum:   $ARCHIVE.sha256"
  if [ -n "$SSH_TARGET" ]; then
    ssh_argv "$SSH_TARGET"
    dim "  would run: $(_quote "${SSH_ARGV[@]}") $(_quote "$(shquote tar -czf - -C "$PARENT" "$BASE")") > $(_quote "$ARCHIVE")"
  else
    dim "  would run: $(_quote tar -czf - -C "$PARENT" "$BASE") > $(_quote "$ARCHIVE")"
  fi
  dim "  would verify: tar -tzf $(_quote "$ARCHIVE")"
  if [ "$WITH_DB" = "1" ]; then
    dim "  would run: $HERE/db-dump.sh${SSH_TARGET:+ --ssh $SSH_TARGET} --out $(_quote "$DB_OUT")"
  fi
  warn "Nothing was written. This is NOT a backup."
  exit 0
fi

# ---- real path ---------------------------------------------------------------
mkdir -p "$OUT" || die "cannot create output directory: $OUT"
[ -w "$OUT" ] || die "output directory is not writable: $OUT"

log "Backing up files -> $ARCHIVE"
# Stream a read-only tar (locally or from the remote host) into a local file, so
# the backup survives the source host. Values are passed as argv, never spliced
# into a command string.
if ! rrun "$SSH_TARGET" tar -czf - -C "$PARENT" "$BASE" > "$ARCHIVE"; then
  rm -f "$ARCHIVE"
  die "tar failed — no usable archive was produced (removed the partial file)"
fi

[ -s "$ARCHIVE" ] || { rm -f "$ARCHIVE"; die "archive is empty — backup FAILED"; }

SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
sha256_file "$ARCHIVE"
log "Files archive: $(human_size "$SIZE")  (sha256 written to $(basename "$ARCHIVE").sha256)"

# Integrity: list the archive to confirm it is readable end to end.
if tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  log "Archive integrity check passed (tar -t read it end to end)."
else
  die "Archive failed integrity check — do NOT trust this backup: $ARCHIVE"
fi

if [ "$WITH_DB" = "1" ]; then
  log "Dumping database via db-dump.sh (credentials from env)..."
  if [ -n "$SSH_TARGET" ]; then
    "$HERE/db-dump.sh" --ssh "$SSH_TARGET" --out "$DB_OUT" \
      || die "database dump FAILED — the file archive is good but the DB is not backed up"
  else
    "$HERE/db-dump.sh" --out "$DB_OUT" \
      || die "database dump FAILED — the file archive is good but the DB is not backed up"
  fi
fi

log "Backup complete. Source was only read, never modified."
log "Restore test (recommended before trusting it):"
dim "  mkdir -p /tmp/restore-check && tar -xzf $(_quote "$ARCHIVE") -C /tmp/restore-check && ls /tmp/restore-check"
