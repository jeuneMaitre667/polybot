#!/bin/bash
# Vérifie que le bot PM2 tourne ; sinon envoie une alerte (Discord webhook ou Telegram).
# À lancer via cron toutes les 5 min : crontab -e puis :
#   */5 * * * * /home/ubuntu/bot-24-7/check-bot-health.sh
# Variables dans .env : ALERT_DISCORD_WEBHOOK_URL ou ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID

set -e
BOT_DIR="${BOT_DIR:-$HOME/bot-24-7}"
cd "$BOT_DIR"
[ -f .env ] && export $(grep -v '^#' .env | xargs)

STATUS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'polymarket-bot') : null;
      console.log(p?.pm2_env?.status || 'stopped');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")

if [ "$STATUS" = "online" ]; then
  exit 0
fi

# Alerte : bot down
MSG="⚠️ **Bot Polymarket** : le processus n'est plus en ligne (statut: $STATUS). Vérifier sur Lightsail : pm2 list && pm2 restart polymarket-bot"

if [ -n "$ALERT_DISCORD_WEBHOOK_URL" ]; then
  BODY=$(node -e "console.log(JSON.stringify({content: process.argv[1]}))" "$MSG")
  curl -s -X POST "$ALERT_DISCORD_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    --max-time 5 >/dev/null 2>&1 || true
fi

if [ -n "$ALERT_TELEGRAM_BOT_TOKEN" ] && [ -n "$ALERT_TELEGRAM_CHAT_ID" ]; then
  curl -s -X POST "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ALERT_TELEGRAM_CHAT_ID}&text=${MSG}" \
    --max-time 5 >/dev/null 2>&1 || true
fi

exit 0
