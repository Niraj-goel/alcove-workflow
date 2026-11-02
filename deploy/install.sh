#!/usr/bin/env bash
# Installs / updates the Alcove Workflow Portal on the Linux server (Ubuntu/Debian).
# Usage (as root or with sudo), from the folder that contains the uploaded app:
#   sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/alcove-workflow
APP_USER=alcoveflow
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Node.js 22+ (skip if already present)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo ">> Installing Node.js 24 LTS"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

command -v rsync >/dev/null || apt-get install -y rsync

# 2. Service user and app folder
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
# Copy code but never overwrite live data or .env
rsync -a --delete --exclude data --exclude .env --exclude node_modules "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data"

# 3. .env (first install only)
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i 's/^PORT=.*/PORT=3100/' "$APP_DIR/.env"
  echo "HOST=127.0.0.1" >> "$APP_DIR/.env"
  sed -i 's#^PORTAL_URL=.*#PORTAL_URL=https://workflow.alcoverealty.in#' "$APP_DIR/.env"
  echo ">> Created $APP_DIR/.env - edit SMTP settings there if e-mail reminders are needed"
fi

cd "$APP_DIR"
npm ci --omit=dev
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# 4. First-time checklist import (put the CSV next to install.sh as checklist.csv)
if [ ! -f "$APP_DIR/data/workflow.db" ] && [ -f "$SRC_DIR/deploy/checklist.csv" ]; then
  sudo -u "$APP_USER" node scripts/import-csv.js "$SRC_DIR/deploy/checklist.csv"
fi

# 5. systemd service
cp "$APP_DIR/deploy/alcove-workflow.service" /etc/systemd/system/alcove-workflow.service
systemctl daemon-reload
systemctl enable alcove-workflow
systemctl restart alcove-workflow

# 6. Daily backup at 11 PM
CRON="0 23 * * * cd $APP_DIR && /usr/bin/node scripts/backup.js >> $APP_DIR/data/backup.log 2>&1"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'scripts/backup.js' ; echo "$CRON" ) | crontab -u "$APP_USER" -

sleep 2
systemctl --no-pager status alcove-workflow | head -5
curl -fsS -o /dev/null -w "Local check: HTTP %{http_code}\n" http://127.0.0.1:3100/ || true
echo ">> Done. Now add deploy/Caddyfile.snippet to the Caddyfile and run: systemctl reload caddy"
