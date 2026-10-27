#!/usr/bin/env bash
# Weekly restore drill (assets-restore-check.timer): fetch the newest backup from R2, restore it into a scratch
# file and check that it is usable — it decompresses, passes integrity_check, carries a schema version, and holds
# a snapshot from the last few days. Reports to the app (/api/heartbeat) like backup.sh. Never touches the live db.
#
# Uses the same /opt/assets/backup.env as backup.sh (S3_*, BACKUP_S3_BUCKET, HEARTBEAT_TOKEN).
set -euo pipefail

ASSETS_HOME=${ASSETS_HOME:-/opt/assets}
PREFIX=assets/
MAX_SNAPSHOT_AGE_DAYS=3

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
heartbeat() {
  if [ -n "${HEARTBEAT_TOKEN:-}" ]; then
    curl -fsS -m 10 --retry 3 -H "authorization: Bearer $HEARTBEAT_TOKEN" -H "content-type: application/json" \
      --data "$1" "${HEARTBEAT_URL:-http://127.0.0.1:3100/api/heartbeat}" >/dev/null || log "heartbeat not delivered"
  fi
}
# fail <reason>: the reason is our own fixed text, safe to embed in JSON
REASON=
fail() {
  REASON=$1
  log "$1"
  exit 1
}

TMP=$(mktemp -d)
finish() {
  local status=$?
  rm -rf "$TMP"
  if [ "$status" -eq 0 ]; then
    heartbeat '{"job":"restore-check","ok":true}'
  else
    heartbeat "{\"job\":\"restore-check\",\"ok\":false,\"message\":\"${REASON:-exit $status}\"}"
  fi
}
trap finish EXIT

latest=$(s3 "$BUCKET_URL?list-type=2&prefix=$PREFIX" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' |
  grep -E "^${PREFIX}assets-[0-9]{8}T[0-9]{6}Z\.db\.gz$" | sort -r | head -n 1) || true
[ -n "$latest" ] || fail "no backups under $PREFIX"

s3 "$BUCKET_URL/$latest" -o "$TMP/assets.db.gz" || fail "download of $latest failed"
gunzip "$TMP/assets.db.gz" || fail "$latest does not decompress"

check=$(sqlite3 "$TMP/assets.db" "PRAGMA integrity_check" 2>&1) || true
[ "$check" = ok ] || fail "integrity_check failed on $latest"

version=$(sqlite3 "$TMP/assets.db" "PRAGMA user_version")
[ "$version" -ge 1 ] || fail "$latest has no schema version"

newest=$(sqlite3 "$TMP/assets.db" "SELECT COALESCE(MAX(date), '') FROM snapshots") || fail "$latest has no snapshots table"
[ -n "$newest" ] || fail "$latest holds no snapshots"
age_days=$((($(date -u +%s) - $(date -u -d "$newest" +%s)) / 86400))
[ "$age_days" -le "$MAX_SNAPSHOT_AGE_DAYS" ] || fail "newest snapshot in $latest is $newest ($age_days days old)"

counts=$(sqlite3 "$TMP/assets.db" "SELECT (SELECT COUNT(*) FROM snapshots) || ' snapshots, ' ||
  ((SELECT COUNT(*) FROM cash_accounts) + (SELECT COUNT(*) FROM stock_holdings) + (SELECT COUNT(*) FROM crypto_holdings)
   + (SELECT COUNT(*) FROM futures_accounts) + (SELECT COUNT(*) FROM tw_futures_accounts) + (SELECT COUNT(*) FROM properties))
  || ' accounts/holdings'")
log "restore check ok: $latest, schema v$version, newest snapshot $newest, $counts"
