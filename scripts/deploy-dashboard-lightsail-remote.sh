#!/usr/bin/env bash
# Exécuté sur l’instance Lightsail **bot 15m** après upload de /tmp/polymarket-dash-deploy.tgz
# Dashboard : uniquement le statut bot 15m (+ historique trades profil Polymarket).
#
# ⚠️ Petites instances : `npm install` peut être tué par le OOM (exit 137). En cas d’échec :
# build en local avec les mêmes VITE_* puis : scp -r dist ubuntu@IP:~/polymarket-dashboard/
# et PM2 : scripts/serve-dashboard-15m.sh
set -euo pipefail
REPO="${HOME}/polymarket-dashboard"
BOT15M_STATUS_PORT="${BOT15M_STATUS_PORT:-3001}"
BOT15M_PUBLIC_IP="${BOT15M_PUBLIC_IP:-34.253.136.19}"

test -f /tmp/polymarket-dash-deploy.tgz
mkdir -p "$REPO"
cd "$REPO"
tar -xzf /tmp/polymarket-dash-deploy.tgz
rm -f /tmp/polymarket-dash-deploy.tgz

# Pas de VITE_BOT_STATUS_URL : vue « horaire » désactivée (bot 15m seul).
printf '%s\n' \
  "VITE_BOT_STATUS_URL_15M=http://${BOT15M_PUBLIC_IP}:${BOT15M_STATUS_PORT}" \
  'VITE_TRADE_HISTORY_ADDRESS=0x3c42b7540EBf50259b3244E083633C525B1659B0' \
  > .env

npm install
npm run build
test -f dist/index.html
echo "=== Build OK (15m only) : dist/index.html ==="
ls -la dist/index.html
grep -E '^VITE_' .env || true
