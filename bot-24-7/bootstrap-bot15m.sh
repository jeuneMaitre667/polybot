#!/bin/bash
# Tout-en-un pour le serveur bot15m : Node.js, npm, pm2, deps, .env (MARKET_MODE=15m), démarrage du bot.
set -e
export DEBIAN_FRONTEND=noninteractive

echo "=== 1. Installation de Node.js 20 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo ""
echo "=== 2. Répertoire bot-24-7 ==="
cd ~/bot-24-7 || { echo "Erreur: ~/bot-24-7 introuvable. Lance d'abord deploy-bot.ps1 depuis ton PC."; exit 1; }

echo ""
echo "=== 3. Dépendances npm ==="
npm install

echo ""
echo "=== 4. Fichier .env (MARKET_MODE=15m) ==="
if [ ! -f .env ]; then
  cp .env.example .env 2>/dev/null || true
fi
if [ ! -f .env ]; then
  echo "MARKET_MODE=15m" > .env
  echo "PRIVATE_KEY=0xREMPLACE_PAR_TA_CLE" >> .env
  echo "USE_MARKET_ORDER=true" >> .env
  echo "POLL_INTERVAL_SEC=1" >> .env
  echo "USE_BALANCE_AS_SIZE=true" >> .env
fi
grep -q '^MARKET_MODE=' .env 2>/dev/null && sed -i.bak 's/^MARKET_MODE=.*/MARKET_MODE=15m/' .env || echo "MARKET_MODE=15m" >> .env
echo "  MARKET_MODE=15m OK. Pense à mettre ta PRIVATE_KEY : nano .env"

echo ""
echo "=== 5. Installation de PM2 ==="
sudo npm install -g pm2

echo ""
echo "=== 6. Démarrage du bot ==="
pm2 delete polymarket-bot 2>/dev/null || true
pm2 start index.js --name polymarket-bot

echo ""
echo "=== 7. Sauvegarde et démarrage au boot ==="
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || true

echo ""
echo "=== Terminé ==="
echo "  Bot en cours : pm2 logs polymarket-bot"
echo "  Ajoute ta clé wallet : nano ~/bot-24-7/.env  puis  pm2 restart polymarket-bot"
