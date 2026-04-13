#!/bin/bash
# Vérifie que le cron et les variables d’alerte sont en place pour check-bot-health.sh.
# À lancer sur Lightsail (SSH) : bash ~/bot-24-7/check-alertes-setup.sh

set -e
BOT_DIR="${BOT_DIR:-$HOME/bot-24-7}"
ENV_FILE="$BOT_DIR/.env"

echo "=== Vérification configuration alertes ==="

# Cron
echo ""
echo "1. Cron (crontab -l) :"
if crontab -l 2>/dev/null | grep -q "check-bot-health"; then
  echo "   OK : une entrée check-bot-health trouvée."
  crontab -l 2>/dev/null | grep "check-bot-health" || true
else
  echo "   MANQUANT : aucune entrée pour check-bot-health.sh"
  echo "   À ajouter : crontab -e puis"
  echo "   */5 * * * * bash $BOT_DIR/check-bot-health.sh"
fi

# .env
echo ""
echo "2. Variables d’alerte dans $ENV_FILE :"
if [ ! -f "$ENV_FILE" ]; then
  echo "   Fichier .env absent."
else
  if grep -q "ALERT_DISCORD_WEBHOOK_URL" "$ENV_FILE" 2>/dev/null; then
    echo "   ALERT_DISCORD_WEBHOOK_URL : défini"
  else
    echo "   ALERT_DISCORD_WEBHOOK_URL : non défini (optionnel)"
  fi
  if grep -q "ALERT_TELEGRAM_BOT_TOKEN" "$ENV_FILE" 2>/dev/null; then
    echo "   ALERT_TELEGRAM_BOT_TOKEN : défini"
  else
    echo "   ALERT_TELEGRAM_BOT_TOKEN : non défini (optionnel)"
  fi
  if grep -q "ALERT_TELEGRAM_CHAT_ID" "$ENV_FILE" 2>/dev/null; then
    echo "   ALERT_TELEGRAM_CHAT_ID : défini"
  else
    echo "   ALERT_TELEGRAM_CHAT_ID : non défini (optionnel)"
  fi
  echo "   Au moins un canal (Discord ou Telegram) doit être configuré pour recevoir les alertes."
fi

echo ""
echo "=== Fin vérification ==="
