#!/bin/bash
# Mise à jour du code, application de la config (.env) et redémarrage du bot.
# À exécuter sur Lightsail en SSH : bash ~/bot-24-7/update-and-restart.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/redeploy.sh"
