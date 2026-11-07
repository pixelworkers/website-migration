#!/usr/bin/env bash
# common.sh — shared helpers for the site-migration scripts.
# Source this from other scripts: . "$(dirname "$0")/lib/common.sh"
#
# Design rules enforced here:
#   - Loud, timestamped logging to stderr (stdout stays clean for data).
#   - DRY_RUN is honored by the run()/rsh_dry() wrappers: they print instead of
#     executing. Every mutating script must require an explicit --go.
#   - NO USER VALUE IS EVER CONCATENATED INTO A COMMAND STRING. Commands are
#     built as argv arrays; shell snippets take their values as positional
#     parameters ("$1", "$2", ...). For the remote side each value is passed
#     through shquote() exactly once, so a quote or semicolon in a path can
#     never be parsed as code.
#   - No secrets are ever echoed, and never placed in argv (visible in `ps`).
#     Password-bearing values travel through the process environment locally and
#     over stdin for remote execution.

set -euo pipefail

# ---- colors (disabled when not a tty) ---------------------------------------
if [ -t 2 ]; then
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_YEL=''; C_GRN=''; C_DIM=''; C_OFF=''
fi

_ts() { date '+%Y-%m-%d %H:%M:%S'; }

log()  { printf '%s %s[info]%s %s\n'  "$(_ts)" "$C_GRN" "$C_OFF" "$*" >&2; }
warn() { printf '%s %s[warn]%s %s\n'  "$(_ts)" "$C_YEL" "$C_OFF" "$*" >&2; }
err()  { printf '%s %s[err]%s %s\n'   "$(_ts)" "$C_RED" "$C_OFF" "$*" >&2; }
die()  { err "$*"; exit 1; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF" >&2; }

# DRY_RUN defaults to 1 (safe). Mutating scripts must require an explicit opt-in
# (e.g. --go) that sets DRY_RUN=0 before any destructive run().
: "${DRY_RUN:=1}"

# ---- quoting ----------------------------------------------------------------

# shquote ARG... — render the arguments as a single-quoted, space-separated
# string that any POSIX shell will tokenize back into exactly these arguments.
# This is the ONLY sanctioned way to put a value into a command string (i.e.
# when handing a command line to a remote shell via ssh). Pure bash, so values
# containing newlines survive intact.
shquote() {
  local a s out=''
  for a in "$@"; do
    s="$a"; out="$out '"
    while :; do
      case "$s" in
        *"'"*) out="$out${s%%\'*}'\\''"; s="${s#*\'}" ;;
        *)     out="$out$s'"; break ;;
      esac
    done
  done
  printf '%s' "${out# }"
}

# _quote — shell-safe rendering of a command for logs (quotes only when needed).
_quote() {
  local out='' a
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9_@%+=:,./-]*|'') out="$out $(shquote "$a")" ;;
      *) out="$out $a" ;;
    esac
  done
  printf '%s' "${out# }"
}

# run CMD...  — execute, or (when DRY_RUN=1) print what would run.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s %s[dry-run]%s %s\n' "$(_ts)" "$C_DIM" "$C_OFF" "$(_quote "$@")" >&2
    return 0
  fi
  "$@"
}

need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# confirm PROMPT — returns 0 on yes. Non-interactive (no tty) defaults to NO.
confirm() {
  local reply
  if [ ! -t 0 ]; then
    warn "no tty; refusing to assume yes for: $1"
    return 1
  fi
  printf '%s %s[confirm]%s %s [y/N] ' "$(_ts)" "$C_YEL" "$C_OFF" "$1" >&2
  read -r reply || return 1
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# gate PROMPT ASSUME_YES — interactive confirmation, or an explicit --yes when
# there is no tty. Fail-closed: no tty and no --yes means abort, never "assume
# yes because nobody is watching".
gate() {
  local prompt="$1" assume_yes="${2:-0}"
  if [ -t 0 ]; then
    confirm "$prompt" || die "aborted by user (nothing was changed)"
  elif [ "$assume_yes" = "1" ]; then
    warn "no tty; proceeding because --yes was given: $prompt"
  else
    die "no tty and --yes was not given — refusing to proceed unattended: $prompt"
  fi
}

# ---- remote/local execution --------------------------------------------------

# ssh_argv TARGET — build the ssh command into the global array SSH_ARGV.
# SSH_OPTS (e.g. "-i ~/.ssh/key -p 2222") is split on whitespace into argv with
# globbing disabled. It is never eval'd.
SSH_ARGV=()
ssh_argv() {
  local target="$1" had_noglob=''
  local opts; opts=()
  case "$-" in *f*) had_noglob=1 ;; esac
  if [ -n "${SSH_OPTS:-}" ]; then
    set -f
    # shellcheck disable=SC2206  # deliberate word split: SSH_OPTS carries flags
    opts=( $SSH_OPTS )
    [ -n "$had_noglob" ] || set +f
  fi
  SSH_ARGV=( ssh -o BatchMode=yes ${opts[@]+"${opts[@]}"} "$target" )
}

# rrun TARGET CMD... — run an argv command locally, or on TARGET over ssh.
# Locally the argv is executed directly (no shell, nothing to inject into).
# Remotely each element is shquote'd exactly once.
rrun() {
  local target="$1"; shift
  if [ -n "$target" ]; then
    ssh_argv "$target"
    "${SSH_ARGV[@]}" "$(shquote "$@")"
  else
    "$@"
  fi
}

# rsh TARGET SCRIPT [VALUE...] — run a POSIX shell SCRIPT locally or on TARGET.
# SCRIPT is a fixed literal written by us; it refers to caller-supplied values
# as "$1", "$2", ... which are passed as arguments, never spliced into the text.
# Usage: rsh "$SSH_TARGET" 'du -sk "$1" | cut -f1' "$PATH_DIR"
rsh() {
  local target="$1" script="$2"; shift 2
  if [ -n "$target" ]; then
    ssh_argv "$target"
    "${SSH_ARGV[@]}" "sh -c $(shquote "$script") sh $(shquote "$@")"
  else
    sh -c "$script" sh "$@"
  fi
}

# rsh_dry — like rsh, but honors DRY_RUN=1 by printing instead of executing.
rsh_dry() {
  local target="$1" script="$2"; shift 2
  if [ "${DRY_RUN:-1}" = "1" ]; then
    dim "[dry-run]${target:+ ssh $target} sh -c $(_quote "$script") sh $(_quote "$@")"
    return 0
  fi
  rsh "$target" "$script" "$@"
}

# ---- path safety -------------------------------------------------------------

# Paths this toolkit refuses to recurse over with chmod/chown/delete.
PROTECTED_PATHS='/ /Applications /Library /System /Users /Volumes /bin /boot /dev
/etc /home /lib /lib32 /lib64 /mnt /opt /private /proc /root /run /sbin /srv /sys
/tmp /usr /usr/local /var /var/lib /var/www /srv/www /www'

# norm_path PATH — strip trailing slashes (never reducing "/" to "").
norm_path() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p"
}

# assert_safe_path PATH — die unless PATH is a plausible per-site root. Guards
# against the "--path / --go nukes the box" class of accident.
assert_safe_path() {
  local p="$1" q
  [ -n "$p" ] || die "path is empty"
  case "$p" in
    -*)    die "refusing a path that starts with '-': $p" ;;
    *'..'*) die "refusing a path containing '..': $p — pass a resolved absolute path" ;;
    /*)    : ;;
    *)     die "path must be absolute (got: $p)" ;;
  esac
  for q in $PROTECTED_PATHS; do
    [ "$p" = "$q" ] && die "refusing to operate recursively on the system path: $p"
  done
  case "${p#/}" in
    */*) : ;;
    *)   die "refusing a top-level path: $p — pass a site root such as /var/www/site" ;;
  esac
  return 0
}

# ---- integrity ---------------------------------------------------------------

# sha256_file FILE — write FILE.sha256 beside FILE. Dies if no checksum tool
# exists (sha256sum on most Linux, shasum on macOS/BSD) rather than claiming a
# checksum was written.
sha256_file() {
  local f="$1" d b
  [ -f "$f" ] || die "cannot checksum a file that does not exist: $f"
  # pure-bash dirname/basename: the "no checksum tool" path must not depend on
  # anything external to report the failure.
  b="${f##*/}"; d="${f%/*}"
  [ "$d" = "$f" ] && d="."
  [ -n "$d" ] || d="/"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$d" && sha256sum "$b" > "$b.sha256" ) || die "sha256sum failed for $b"
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$d" && shasum -a 256 "$b" > "$b.sha256" ) || die "shasum failed for $b"
  else
    die "no sha256 tool found (need sha256sum or shasum) — refusing to report an unverified backup"
  fi
}

# human_size BYTES
human_size() {
  awk -v b="$1" 'BEGIN{
    split("B KB MB GB TB PB",u," "); i=1;
    while(b>=1024 && i<6){b/=1024;i++}
    printf("%.1f%s", b, u[i])
  }'
}
