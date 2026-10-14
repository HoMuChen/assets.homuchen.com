#!/usr/bin/env bash
# Run by the Deploy workflow after it moves :prod: ping the VM, then wait for /api/health to report this version.
# A failed or rolled-back deploy never reports the new version, so this times out and the run goes red.
#
# Usage: DEPLOY_WEBHOOK_SECRET=... notify.sh https://assets.homuchen.com <short-sha>
set -euo pipefail

URL=${1%/}
SHA=$2
TIMEOUT=${DEPLOY_WAIT_SECONDS:-300}
: "${DEPLOY_WEBHOOK_SECRET:?DEPLOY_WEBHOOK_SECRET is required}"

# The body carries no version: the VM always follows :prod, so a replay only triggers a harmless check
body=$(printf '{"event":"image-pushed","run":"%s"}' "${GITHUB_RUN_ID:-manual}")
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$DEPLOY_WEBHOOK_SECRET" | sed 's/^.* //')
curl -fsS -m 10 --retry 3 -X POST \
  -H "content-type: application/json" \
  -H "X-Hub-Signature-256: sha256=$sig" \
  --data "$body" "$URL/_deploy"

version=
deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  version=$(curl -fsS -m 5 "$URL/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
  if [ "$version" = "$SHA" ]; then
    echo "live: $SHA"
    exit 0
  fi
  sleep 5
done
echo "timed out after ${TIMEOUT}s: /api/health reports '${version:-unreachable}', expected '$SHA'." >&2
echo "The deploy failed or was rolled back; on the VM run: journalctl -u assets-deploy -n 100" >&2
exit 1
