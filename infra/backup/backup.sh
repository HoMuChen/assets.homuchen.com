#!/usr/bin/env bash
# Daily SQLite backup (assets-backup.timer): online .backup → integrity_check → gzip → R2, then prune.
# The `backup` bucket is shared by every service on the VM, one folder each; this script only touches assets/.
#
# Settings come from /opt/assets/backup.env (chmod 600), kept apart from the app's .env so the
# container never sees the R2 keys:
#   S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, BACKUP_S3_BUCKET
#   BACKUP_PING_URL   optional healthchecks.io URL (start / success / fail)
#
# Retention: the newest 14 backups, plus the newest of each of the last 12 months.
set -euo pipefail

ASSETS_HOME=${ASSETS_HOME:-/opt/assets}
DB=$ASSETS_HOME/data/assets.db
PREFIX=assets/
KEEP_DAILY=14
KEEP_MONTHLY=12

set -a
# shellcheck disable=SC1091
. "$ASSETS_HOME/backup.env"
set +a
: "${S3_ENDPOINT:?}" "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}" "${BACKUP_S3_BUCKET:?}"
BUCKET_URL=${S3_ENDPOINT%/}/$BACKUP_S3_BUCKET

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
s3() {
  curl -fsS -m 120 --retry 3 --aws-sigv4 "aws:amz:${S3_REGION:-auto}:s3" \
    --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$@"
}
ping() {
  if [ -n "${BACKUP_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 "$BACKUP_PING_URL$1" >/dev/null || true; fi
}

TMP=$(mktemp -d)
finish() {
  local status=$?
  rm -rf "$TMP"
  if [ "$status" -eq 0 ]; then ping ""; else
    log "backup failed (exit $status)"
    ping /fail
  fi
}
trap finish EXIT
ping /start

[ -f "$DB" ] || {
  log "$DB not found"
  exit 1
}
# .backup takes a consistent copy while the app keeps writing (WAL mode)
sqlite3 "$DB" ".backup '$TMP/assets.db'"
check=$(sqlite3 "$TMP/assets.db" "PRAGMA integrity_check")
[ "$check" = ok ] || {
  log "integrity_check: $check"
  exit 1
}
gzip -9 "$TMP/assets.db"

KEY=${PREFIX}assets-$(date -u +%Y%m%dT%H%M%SZ).db.gz
s3 -T "$TMP/assets.db.gz" "$BUCKET_URL/$KEY" -o /dev/null
log "uploaded $KEY ($(stat -c %s "$TMP/assets.db.gz") bytes)"

# Keys sort chronologically; only names this script writes are considered for deletion
mapfile -t keys < <(s3 "$BUCKET_URL?list-type=2&prefix=$PREFIX" | grep -o '<Key>[^<]*</Key>' |
  sed 's/<[^>]*>//g' | grep -E "^${PREFIX}assets-[0-9]{8}T[0-9]{6}Z\.db\.gz$" | sort -r)
declare -A keep=() months=()
for i in "${!keys[@]}"; do
  k=${keys[$i]}
  month=${k:${#PREFIX}+7:6}
  if [ "$i" -lt "$KEEP_DAILY" ]; then keep[$k]=1; fi
  if [ -z "${months[$month]:-}" ] && [ "${#months[@]}" -lt "$KEEP_MONTHLY" ]; then
    months[$month]=1
    keep[$k]=1
  fi
done
keep[$KEY]=1
removed=0
for k in "${keys[@]}"; do
  if [ -z "${keep[$k]:-}" ]; then
    s3 -X DELETE "$BUCKET_URL/$k" -o /dev/null
    removed=$((removed + 1))
  fi
done
log "kept ${#keep[@]}, removed $removed"
