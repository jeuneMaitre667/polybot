#!/bin/bash
# À exécuter sur le serveur bot15m (une fois) si pm2 n'est pas installé
set -e
cd ~/bot-24-7

echo "=== Installation de PM2 ==="
sudo npm install -g pm2

echo ""
echo "=== Démarrage du bot ==="
pm2 delete polymarket-bot 2>/dev/null || true
pm2 start index.js --name polymarket-bot

echo ""
echo "=== Sauvegarde et démarrage au boot ==="
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "=== Terminé. Pense à : nano .env → MARKET_MODE=15m + PRIVATE_KEY → pm2 restart polymarket-bot"
