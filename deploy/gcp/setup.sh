#!/usr/bin/env bash
# One-time setup of a Debian 12 Compute Engine VM for the tracker.
# Run as root on the VM:  sudo bash setup.sh <git-repo-url> [branch]
# Re-running it pulls the latest code, rebuilds and restarts.
set -euo pipefail

REPO="${1:?usage: setup.sh <git-repo-url> [branch]}"
BRANCH="${2:-main}"
APP=/opt/finance/app
ENV_FILE=/etc/finance-tracker/env

# Cloud Shell is a throwaway container, not the server; the VM is reached with
# `gcloud compute ssh`. (`sudo` drops CLOUD_SHELL, so look for its files too.)
if [ "${CLOUD_SHELL:-}" = "true" ] || [ -d /google/devshell ]; then
  echo "This is Cloud Shell, not the VM. Connect first:" >&2
  echo "  gcloud compute ssh finance --zone=us-central1-a" >&2
  exit 1
fi

# e2-micro has 1 GB of RAM; `next build` needs more, so add swap once.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null
  if swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    echo "Warning: could not enable swap; the build may run out of memory." >&2
    rm -f /swapfile
  fi
fi

# Node 24, git, and a compiler in case better-sqlite3 has no prebuilt binary.
if ! node --version 2>/dev/null | grep -q '^v24'; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg git build-essential python3
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

id finance >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/finance finance

if [ ! -d "$APP/.git" ]; then
  sudo -u finance git clone --branch "$BRANCH" "$REPO" "$APP"
else
  sudo -u finance git -C "$APP" fetch origin "$BRANCH"
  sudo -u finance git -C "$APP" checkout -B "$BRANCH" "origin/$BRANCH"
fi

# Secrets live outside the checkout, readable only by root and the service.
mkdir -p /etc/finance-tracker
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
FINANCE_DB=/opt/finance/data/finance.db
# From Era (era.app → settings → API keys). Required for the Era sync.
ERA_API_KEY=
# Optional: a Cloud Storage bucket name for nightly off-VM backups.
BACKUP_BUCKET=
ENV
fi
chown root:finance "$ENV_FILE" && chmod 640 "$ENV_FILE"
sudo -u finance mkdir -p /opt/finance/data

cd "$APP"
sudo -u finance npm ci --no-audit --no-fund
sudo -u finance npm run build

install -m 644 deploy/gcp/*.service deploy/gcp/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now finance-tracker.service era-sync.timer finance-backup.timer
systemctl restart finance-tracker.service

echo
echo "App running on 127.0.0.1:3000 (not exposed)."
grep -q '^ERA_API_KEY=.\+' "$ENV_FILE" \
  || echo "Next: put your Era key in $ENV_FILE, then: sudo systemctl start era-sync.service"
echo "Then publish it through Cloudflare Tunnel + Access: docs/DEPLOY-GCP.md step 5."
