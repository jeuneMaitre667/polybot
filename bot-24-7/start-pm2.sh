#!/bin/bash
# À exécuter une fois sur l'instance (en SSH) pour lancer le bot avec PM2 (24/7)
set -e
cd ~/bot-24-7

echo "=== Installation de PM2 ==="
sudo npm install -g pm2

echo ""
echo "=== Démarrage du bot ==="
pm2 delete polymarket-bot 2>/dev/null || true
pm2 start index.js --name polymarket-bot

echo ""
echo "=== Sauvegarde et démarrage automatique au boot ==="
pm2 save
pm2 startup

echo ""
echo "=== Terminé. Le bot tourne en arrière-plan."
echo "Quand tu auras ajouté ta PRIVATE_KEY dans .env :"
echo "  nano ~/bot-24-7/.env"
echo "  pm2 restart polymarket-bot"
echo "Logs : pm2 logs polymarket-bot"
