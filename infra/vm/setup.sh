#!/usr/bin/env bash
# assets on the shared VM (Ubuntu 24.04, run as root, safe to rerun). Run homuchen-edge's setup.sh first:
# it provides Docker, webhook, sqlite3, the firewall, and the edge Caddy this installs a site into.
#
#   rsync -a --delete infra/ root@<vm>:/root/assets-infra/
#   ssh root@<vm> /root/assets-infra/vm/setup.sh
#
# Reuses the VM's `deploy` user (already in the docker group and logged in to GHCR for HQ).
set -euo pipefail

INFRA_DIR=$(cd "$(dirname "$0")/.." && pwd)
ASSETS_HOME=/opt/assets

log() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || {
  echo "run as root" >&2
  exit 1
}
for cmd in docker caddy webhook sqlite3; do
  command -v "$cmd" >/dev/null || {
    echo "$cmd not found: run homuchen-edge/setup.sh first" >&2
    exit 1
  }
done
id deploy >/dev/null 2>&1 || {
  echo "user deploy not found (created by HQ's setup.sh)" >&2
  exit 1
}

log "users and directories"
id assets-hook >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin assets-hook
install -d -m 0750 -o deploy -g deploy "$ASSETS_HOME" "$ASSETS_HOME/app" "$ASSETS_HOME/state"
# The container runs as uid 1000 (node), which is also deploy's uid on this VM
install -d -m 0750 -o deploy -g deploy "$ASSETS_HOME/data"
install -d -m 0755 /etc/assets

log "scripts and settings"
install -m 0755 -o deploy -g deploy "$INFRA_DIR/deploy/deploy.sh" "$ASSETS_HOME/deploy.sh"
install -m 0755 -o deploy -g deploy "$INFRA_DIR/backup/backup.sh" "$ASSETS_HOME/backup.sh"
for f in .env:env.production.example backup.env:backup.env.example; do
  if [ ! -f "$ASSETS_HOME/${f%%:*}" ]; then
    install -m 0600 -o deploy -g deploy "$INFRA_DIR/vm/${f#*:}" "$ASSETS_HOME/${f%%:*}"
    echo "created $ASSETS_HOME/${f%%:*} from the template; fill it in"
  fi
done

log "deploy receiver"
install -m 0644 "$INFRA_DIR/deploy/hooks.json" /etc/assets/hooks.json
if [ ! -f /etc/assets/deploy-webhook.env ]; then
  printf 'DEPLOY_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >/etc/assets/deploy-webhook.env
  echo "generated /etc/assets/deploy-webhook.env; copy the secret into the GitHub secret DEPLOY_WEBHOOK_SECRET"
fi
chown root:assets-hook /etc/assets/deploy-webhook.env
chmod 0640 /etc/assets/deploy-webhook.env
install -m 0440 "$INFRA_DIR/deploy/sudoers-assets-hook" /etc/sudoers.d/assets-hook
visudo -cqf /etc/sudoers.d/assets-hook

log "systemd units"
install -m 0644 "$INFRA_DIR"/deploy/systemd/* "$INFRA_DIR"/backup/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable assets-deploy-receiver.service
# enable --now does not restart a running service; restart so unit changes take effect
systemctl restart assets-deploy-receiver.service
# The deploy and backup timers are enabled after the first manual deploy (README)

log "caddy site"
install -m 0644 "$INFRA_DIR/caddy/assets.caddy" /etc/caddy/sites/assets.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy

log "done"
cat <<'EOF'
Next (README "Production"):
  1. fill /opt/assets/.env and /opt/assets/backup.env
  2. sudo -u deploy /opt/assets/deploy.sh          # first deploy
  3. systemctl enable --now assets-deploy.timer assets-backup.timer
EOF
