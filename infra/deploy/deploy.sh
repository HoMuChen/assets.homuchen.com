#!/usr/bin/env bash
# Deploy on the VM: pull → snapshot the SQLite file → switch → verify /api/health version → roll back on failure.
# Same flow as headquarter.homuchen.com's deploy.sh; the webhook receiver and the systemd timer only call this.
#
#   deploy.sh               follow :prod (moved only by the GitHub Deploy workflow); no-op if the digest is unchanged
#   deploy.sh sha-abc1234   deploy a specific build (manual rollback)
#
# ASSETS_HOME (default /opt/assets):
#   .env            app settings and secrets (chmod 600)
#   sinopac.env     SJ_API_KEY / SJ_SEC_KEY for the SinoPac sidecar only (chmod 600)
#   data/           SQLite database, mounted into the container at /data
#   app/            compose.prod.yml, extracted from the image on every deploy
#   state/current   running image (repo@sha256:...); state/previous is the last good one
#   state/failed    images that failed to deploy; skipped when following :prod unless ASSETS_FORCE=1
#   state/pre-deploy.db  copy of the database taken right before the last switch
#   releases.log    deploy history
set -euo pipefail

ASSETS_HOME=${ASSETS_HOME:-/opt/assets}
cd "$ASSETS_HOME"
REPO=${ASSETS_REPO:-ghcr.io/homuchen/assets}
WAIT_TIMEOUT=${ASSETS_WAIT_TIMEOUT:-120}
FOLLOW_TAG=prod
TAG=${1:-$FOLLOW_TAG}
APP_DIR=$ASSETS_HOME/app
STATE_DIR=$ASSETS_HOME/state
IMAGE=

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
record() { printf '%s %s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" >>"$ASSETS_HOME/releases.log"; }
compose() {
  ASSETS_IMAGE=$IMAGE docker compose -p assets --project-directory "$APP_DIR" -f "$APP_DIR/compose.prod.yml" "$@"
}

mkdir -p "$APP_DIR" "$STATE_DIR" "$ASSETS_HOME/data"
touch "$STATE_DIR/failed"
ln -sfn ../.env "$APP_DIR/.env"
# SinoPac sidecar keys; an empty file just leaves SinoPac sync unconfigured
[ -f "$ASSETS_HOME/sinopac.env" ] || install -m 0600 /dev/null "$ASSETS_HOME/sinopac.env"
ln -sfn ../sinopac.env "$APP_DIR/sinopac.env"

# One deploy at a time (webhook and timer can fire together)
LOCK=$STATE_DIR/deploy.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "another deploy (pid $pid) is running"
    exit 0
  fi
  log "removing stale lock"
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

resolve_digest() {
  docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$1" | grep -m1 "^$REPO@"
}

image_sha() {
  docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^GIT_SHA=//p'
}

install_files() {
  local cid
  cid=$(docker create "$1")
  docker cp -q "$cid:/app/infra/compose.prod.yml" "$STATE_DIR/compose.new"
  docker rm "$cid" >/dev/null
  cat "$STATE_DIR/compose.new" >"$APP_DIR/compose.prod.yml"
}

switch_to() {
  IMAGE=$1
  install_files "$IMAGE"
  compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" --remove-orphans
}

verify() {
  local version
  version=$(compose exec -T assets node -e \
    "fetch('http://localhost:3000/api/health').then(r=>r.json()).then(j=>console.log(j.version))") || return 1
  if [ "$version" != "$1" ]; then
    log "health reports version '$version', expected '$1'"
    return 1
  fi
}

docker pull -q "$REPO:$TAG" >/dev/null
TARGET=$(resolve_digest "$REPO:$TAG")
CURRENT=$(cat "$STATE_DIR/current" 2>/dev/null || true)
SHA=$(image_sha "$TARGET")

if [ "$TARGET" = "$CURRENT" ] && [ -z "${ASSETS_FORCE:-}" ]; then
  log "already running $SHA"
  exit 0
fi
if [ "$TAG" = "$FOLLOW_TAG" ] && [ -z "${ASSETS_FORCE:-}" ] && grep -qxF "$TARGET" "$STATE_DIR/failed"; then
  log "skipping $SHA: it failed before (run with ASSETS_FORCE=1 or an explicit tag to retry)"
  exit 0
fi

log "deploying $SHA ($TARGET)"
# The schema is created/extended at startup, so keep a copy to restore if a new version mangles the data
if [ -f "$ASSETS_HOME/data/assets.db" ]; then
  sqlite3 "$ASSETS_HOME/data/assets.db" ".backup '$STATE_DIR/pre-deploy.db'"
fi

if switch_to "$TARGET" && verify "$SHA"; then
  [ -n "$CURRENT" ] && echo "$CURRENT" >"$STATE_DIR/previous"
  echo "$TARGET" >"$STATE_DIR/current"
  record "$SHA" "$TARGET" ok
  docker image prune -f >/dev/null
  log "deployed $SHA"
  exit 0
fi

log "deploy of $SHA failed"
echo "$TARGET" >>"$STATE_DIR/failed"
record "$SHA" "$TARGET" failed
if [ -n "$CURRENT" ]; then
  PREV_SHA=$(image_sha "$CURRENT")
  log "rolling back to $PREV_SHA"
  if switch_to "$CURRENT" && verify "$PREV_SHA"; then
    record "$PREV_SHA" "$CURRENT" rolled-back
    log "rolled back to $PREV_SHA"
  else
    record "$PREV_SHA" "$CURRENT" rollback-failed
    log "ROLLBACK FAILED: check 'docker compose -p assets ps' and logs"
  fi
fi
exit 1
