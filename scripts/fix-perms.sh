#!/usr/bin/env bash
# fix-perms.sh — set sane, secure file permissions on a migrated site.
#
# DRY-RUN BY DEFAULT: prints the find commands it would run. Pass --go to apply.
# --go also asks for confirmation (or requires --yes when there is no tty),
# because the chmod/chown is recursive and cannot be undone by this script.
#
# Defaults follow the common hardening baseline:
#   directories        755
#   files              644
#   wp-config.php      640  (readable by owner + web group only)
#   .env / .env.*      600
# Ownership (chown) is intentionally NOT changed by default — pass --owner
# user:group to set it explicitly, because the right owner is host-specific.
#
# --path must be an absolute site root with at least two components
# (e.g. /var/www/site). System roots such as /, /home, /usr, /var and /var/www
# are refused outright: a recursive chmod there would break the host.
#
# Usage:
#   fix-perms.sh --path /var/www/site               # preview
#   fix-perms.sh --path /var/www/site --go          # apply (asks to confirm)
#   fix-perms.sh --path /var/www/site --owner www-data:www-data --go
#
# Options:
#   --path DIR    Site root. Required. Absolute, no "..", not a system path.
#   --go          Apply changes (otherwise preview).
#   --yes         Skip the interactive confirmation (required for --go with no tty).
#   --owner U:G   Also chown -R to this owner (only with --go).
#   --ssh TARGET  Apply on a remote host over SSH.

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"

PATH_DIR=""; GO=0; OWNER=""; SSH_TARGET=""; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATH_DIR="${2:-}"; shift 2 ;;
    --go)   GO=1; shift ;;
    --yes)  ASSUME_YES=1; shift ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --ssh)  SSH_TARGET="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$PATH_DIR" ] || die "--path is required"
PATH_DIR="$(norm_path "$PATH_DIR")"
assert_safe_path "$PATH_DIR"

# chown targets are passed as argv, but a malformed owner is still worth
# catching early with a clear message.
if [ -n "$OWNER" ]; then
  case "$OWNER" in
    *[!A-Za-z0-9._:-]*|:*|*:) die "--owner must look like user or user:group (got: $OWNER)" ;;
  esac
fi

# shellcheck disable=SC2034  # consumed by common.sh rsh_dry()
if [ "$GO" = "1" ]; then DRY_RUN=0; else DRY_RUN=1; fi

if [ "$GO" = "1" ]; then
  warn "About to recursively chmod every file and directory under:"
  warn "  ${SSH_TARGET:+$SSH_TARGET:}$PATH_DIR"
  [ -n "$OWNER" ] && warn "  ...and chown -R to $OWNER"
  gate "Apply permission changes under $PATH_DIR?" "$ASSUME_YES"
fi

log "Normalizing permissions under $PATH_DIR (dirs 755, files 644)"
rsh_dry "$SSH_TARGET" 'find "$1" -type d -exec chmod 755 {} +' "$PATH_DIR"
rsh_dry "$SSH_TARGET" 'find "$1" -type f -exec chmod 644 {} +' "$PATH_DIR"

log "Tightening sensitive files"
rsh_dry "$SSH_TARGET" 'if [ -f "$1/wp-config.php" ]; then chmod 640 "$1/wp-config.php"; fi' "$PATH_DIR"
# -exec ... + instead of xargs: portable to macOS/BSD, and immune to spaces and
# newlines in filenames. The \( \) group is required so -type f applies to both
# -name branches.
rsh_dry "$SSH_TARGET" 'find "$1" -maxdepth 2 -type f \( -name ".env" -o -name ".env.*" \) -exec chmod 600 {} +' "$PATH_DIR"

if [ -n "$OWNER" ]; then
  log "Setting ownership to $OWNER"
  rsh_dry "$SSH_TARGET" 'chown -R "$2" "$1"' "$PATH_DIR" "$OWNER"
fi

if [ "$GO" != "1" ]; then
  echo
  log "Preview only — nothing was changed. Re-run with --go to apply."
else
  log "Permissions applied."
fi
