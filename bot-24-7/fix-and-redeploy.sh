#!/bin/bash
# À exécuter sur Lightsail en SSH : bash ~/bot-24-7/fix-and-redeploy.sh
# Déplace balance.json et last-order.json du home vers ~/bot-24-7 si présents, puis redéploie.
set -e
BOT_DIR="$HOME/bot-24-7"

echo "=== Vérification des fichiers dans le home ==="
if [ -f "$HOME/balance.json" ] || [ -f "$HOME/last-order.json" ]; then
  mv "$HOME/balance.json" "$BOT_DIR/" 2>/dev/null || true
  mv "$HOME/last-order.json" "$BOT_DIR/" 2>/dev/null || true
  echo "   Fichiers déplacés vers $BOT_DIR"
else
  echo "   Aucun fichier balance.json ou last-order.json dans le home."
fi

echo ""
exec bash "$BOT_DIR/redeploy.sh"
