#!/usr/bin/env bash
# verify.sh — post-migration verification sweep. READ-ONLY (only HTTP GET/HEAD).
#
# Confirms the destination serves the same pages as the source BEFORE you touch
# DNS. You can point at the new server by IP while still sending the production
# Host header (--new-ip), so you test the real vhost without a DNS change.
#
# What it checks:
#   1. HTTP status for every path on old vs new (mismatch = finding).
#   2. For WordPress/sitemapped sites, pulls paths from /sitemap.xml if --paths
#      is not given.
#   3. Scans each new-host page for asset references (src/href) and HEADs a
#      sample to catch broken images/CSS/JS.
#
# Usage:
#   verify.sh --old https://old.com --new https://new.com
#   verify.sh --old https://old.com --new https://site.com --new-ip 203.0.113.9 \
#             --paths paths.txt
#
# Options:
#   --old URL       Current/source base URL. Required.
#   --new URL       Destination base URL (the production hostname). Required.
#   --new-ip IP     Resolve --new's host to this IP (pre-DNS test via curl --resolve).
#   --paths FILE    File of URL paths (one per line, e.g. /about). Optional.
#   --limit N       Max asset HEAD checks per page (default 15).

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/common.sh"
need curl

OLD=""; NEW=""; NEW_IP=""; PATHS_FILE=""; ASSET_LIMIT=15
while [ $# -gt 0 ]; do
  case "$1" in
    --old) OLD="${2:-}"; shift 2 ;;
    --new) NEW="${2:-}"; shift 2 ;;
    --new-ip) NEW_IP="${2:-}"; shift 2 ;;
    --paths) PATHS_FILE="${2:-}"; shift 2 ;;
    --limit) ASSET_LIMIT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$OLD" ] || die "--old is required"
[ -n "$NEW" ] || die "--new is required"
OLD="${OLD%/}"; NEW="${NEW%/}"

# Host of --new, used for curl --resolve when --new-ip is set.
NEW_HOST="$(printf '%s' "$NEW" | sed -E 's#^https?://##; s#/.*##')"
NEW_PORT=443; case "$NEW" in http://*) NEW_PORT=80 ;; esac
RESOLVE=()
[ -n "$NEW_IP" ] && RESOLVE=(--resolve "${NEW_HOST}:${NEW_PORT}:${NEW_IP}")

# curl helpers
code() { curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 ${RESOLVE[@]+"${RESOLVE[@]}"} "$1"; }
code_old() { curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 "$1"; }
body() { curl -s -L --max-time 25 ${RESOLVE[@]+"${RESOLVE[@]}"} "$1"; }

# ---- build the path list ----------------------------------------------------
PATHS=()
if [ -n "$PATHS_FILE" ]; then
  while IFS= read -r line; do [ -n "$line" ] && PATHS+=("$line"); done < "$PATHS_FILE"
else
  log "No --paths given; trying $OLD/sitemap.xml"
  SM="$(body "$OLD/sitemap.xml" 2>/dev/null || true)"
  # Flatten sitemap index + urlset; strip to paths. Portable to bash 3.2.
  LOCS=()
  while IFS= read -r u; do [ -n "$u" ] && LOCS+=("$u"); done < <(
    printf '%s' "$SM" | grep -oE '<loc>[^<]+</loc>' | sed -E 's#</?loc>##g' | head -50 || true)
  if [ "${#LOCS[@]}" -eq 0 ]; then
    warn "No sitemap found; falling back to '/' only. Pass --paths for real coverage."
    PATHS=("/")
  else
    for u in "${LOCS[@]}"; do PATHS+=("/$(printf '%s' "$u" | sed -E 's#^https?://[^/]+/?##')"); done
  fi
fi

echo "============================================================"
echo " MIGRATION VERIFICATION SWEEP  ($(_ts))"
echo " old: $OLD"
echo " new: $NEW ${NEW_IP:+(forced IP $NEW_IP via Host header)}"
echo " paths: ${#PATHS[@]}"
echo "============================================================"

FAIL=0; MISMATCH=0
printf '%-40s %6s %6s  %s\n' "PATH" "OLD" "NEW" "RESULT"
for p in "${PATHS[@]}"; do
  p="/${p#/}"
  # curl -w always prints the status (000 on connect failure); keep exactly one.
  co="$(code_old "$OLD$p" 2>/dev/null || true)"; co="${co:-000}"
  cn="$(code "$NEW$p" 2>/dev/null || true)"; cn="${cn:-000}"
  res="ok"
  if [ "$cn" = "000" ] || [ "$cn" -ge 500 ] 2>/dev/null; then res="NEW DOWN"; FAIL=$((FAIL+1));
  elif [ "$co" != "$cn" ]; then res="MISMATCH"; MISMATCH=$((MISMATCH+1)); fi
  printf '%-40s %6s %6s  %s\n' "${p:0:40}" "$co" "$cn" "$res"
done

# ---- asset check on the homepage of the new host ----------------------------
echo
log "Checking assets referenced by $NEW/ (sample up to $ASSET_LIMIT)"
HTML="$(body "$NEW/" || true)"
ASSETS=()
while IFS= read -r a; do [ -n "$a" ] && ASSETS+=("$a"); done < <(printf '%s' "$HTML" \
  | grep -oE '(src|href)="[^"]+\.(css|js|png|jpg|jpeg|gif|svg|webp|woff2?)[^"]*"' \
  | sed -E 's/^(src|href)="//; s/"$//' | sort -u | head -n "$ASSET_LIMIT" || true)
ABROKEN=0
for a in ${ASSETS[@]+"${ASSETS[@]}"}; do
  case "$a" in
    http*) url="$a" ;;
    //*)   url="https:$a" ;;
    /*)    url="$NEW$a" ;;
    *)     url="$NEW/$a" ;;
  esac
  ac="$(curl -s -o /dev/null -w '%{http_code}' -I -L --max-time 15 ${RESOLVE[@]+"${RESOLVE[@]}"} "$url" || echo 000)"
  if [ "$ac" = "000" ] || [ "$ac" -ge 400 ] 2>/dev/null; then
    printf '  %sBROKEN%s %s -> %s\n' "$C_RED" "$C_OFF" "$ac" "$url" >&2
    ABROKEN=$((ABROKEN+1))
  fi
done
[ "$ABROKEN" -eq 0 ] && log "All sampled assets returned < 400."

echo
echo "============================================================"
echo " SUMMARY: ${#PATHS[@]} paths | $MISMATCH mismatches | $FAIL new-host failures | $ABROKEN broken assets"
echo "============================================================"
if [ "$FAIL" -gt 0 ] || [ "$ABROKEN" -gt 0 ]; then
  err "Verification FAILED. Do NOT cut over DNS. Keep the old host live and fix the findings."
  exit 2
fi
if [ "$MISMATCH" -gt 0 ]; then
  warn "Status mismatches found. Review them (redirects/404s) before cutover."
  exit 1
fi
log "Verification PASSED. Safe to proceed to the DNS cutover step."
