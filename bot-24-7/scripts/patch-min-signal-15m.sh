#!/usr/bin/env bash
set -euo pipefail
ENV="${HOME}/bot-24-7/.env"
if grep -q '^MIN_SIGNAL_P=' "$ENV"; then
  sed -i 's/^MIN_SIGNAL_P=.*/MIN_SIGNAL_P=0.97/' "$ENV"
else
  echo 'MIN_SIGNAL_P=0.97' >> "$ENV"
fi
echo "--- MIN / MAX signal ---"
grep '^MIN_SIGNAL_P=' "$ENV" || true
grep '^MAX_SIGNAL_P=' "$ENV" || true
pm2 restart polymarket-bot
