#!/bin/bash
# Vérification post-déploiement : bot et status-server répondent.
# À lancer après redeploy.sh (manuel ou via GitHub Action).
# Usage : bash ~/bot-24-7/verify-deploy.sh

set -e
BOT_DIR="${BOT_DIR:-$HOME/bot-24-7}"
PORT="${BOT_STATUS_PORT:-3001}"

echo "=== Vérification post-déploiement ==="

# PM2
echo -n "PM2 polymarket-bot : "
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'polymarket-bot') : null;
      console.log(p?.pm2_env?.status || 'absent');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "$STATUS"

echo -n "PM2 bot-status-server : "
STATUS_SS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'bot-status-server') : null;
      console.log(p?.pm2_env?.status || 'absent');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "$STATUS_SS"

# HTTP status-server
echo -n "GET http://localhost:${PORT}/api/health : "
HEALTH=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/health" 2>/dev/null || echo "000")
echo "HTTP $HEALTH"

echo -n "GET http://localhost:${PORT}/api/bot-status : "
STATUS_HTTP=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/bot-status" 2>/dev/null || echo "000")
echo "HTTP $STATUS_HTTP"

echo ""
echo "=== npm audit (info — ne bloque pas ce script ; vuln. transitives Polymarket souvent sans correctif npm) ==="
( cd "$BOT_DIR" && npm audit --omit=dev --no-fund ) || true
echo ""

if [ "$STATUS_HTTP" = "200" ]; then
  echo "=== OK : status-server répond. ==="
  exit 0
else
  echo "=== ATTENTION : status-server ne répond pas correctement (HTTP $STATUS_HTTP). Vérifier pm2 list et pm2 logs. ==="
  exit 1
fi
