#!/bin/bash
# Test envoi Telegram depuis le serveur (lit ~/bot-24-7/.env). Usage : bash send-telegram-test.sh
set -euo pipefail
BOT_DIR="${BOT_DIR:-$HOME/bot-24-7}"
ENV_FILE="$BOT_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "Pas de $ENV_FILE"; exit 1; }
TOKEN=$(grep -E '^ALERT_TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' | sed "s/^[\"']//;s/[\"']$//")
CHAT=$(grep -E '^ALERT_TELEGRAM_CHAT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' | sed "s/^[\"']//;s/[\"']$//")
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "ALERT_TELEGRAM_BOT_TOKEN ou ALERT_TELEGRAM_CHAT_ID manquant dans .env"
  exit 1
fi
MSG="Test Polymarket bot (Lightsail) — $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC"
CODE=$(curl -s -o /tmp/tg_test_resp.json -w "%{http_code}" -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=${MSG}" \
  --max-time 25)
echo "HTTP $CODE"
head -c 300 /tmp/tg_test_resp.json
echo
rm -f /tmp/tg_test_resp.json
if [ "$CODE" != "200" ]; then exit 1; fi
