#!/bin/bash
# Vérification post-déploiement : bot en ligne.
# À lancer après redeploy.sh (manuel ou via GitHub Action).
# Usage : bash ~/polybot/bot-24-7/verify-deploy.sh

set -e
BOT_DIR="${BOT_DIR:-$HOME/polybot/bot-24-7}"

echo "=== Vérification post-déploiement ==="

# PM2
echo -n "PM2 poly-engine : "
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'poly-engine' || x.name === 'polymarket-bot') : null;
      console.log(p?.pm2_env?.status || 'absent');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "$STATUS"

echo ""
echo "=== npm audit (info — ne bloque pas ce script ; vuln. transitives Polymarket souvent sans correctif npm) ==="
( cd "$BOT_DIR" && npm audit --omit=dev --no-fund ) || true
echo ""

if [ "$STATUS" = "online" ]; then
  echo "=== OK : poly-engine PM2 online. ==="
  exit 0
fi

echo "=== ÉCHEC : PM2 poly-engine=$STATUS ==="
echo "    Vérifier pm2 logs poly-engine"
exit 1
