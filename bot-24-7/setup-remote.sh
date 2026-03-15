#!/bin/bash
# À exécuter sur l'instance Lightsail après upload du dossier bot-24-7
set -e
cd ~/bot-24-7

echo "=== Vérification Node.js ==="
if ! command -v node &>/dev/null; then
  echo "Installation de Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo ""
echo "=== Installation des dépendances ==="
npm install

echo ""
if [ ! -f .env ]; then
  echo "Création du fichier .env depuis .env.example..."
  cp .env.example .env 2>/dev/null || true
  if [ ! -f .env ]; then
    echo "PRIVATE_KEY=0xREMPLACE_PAR_TA_CLE" > .env
    echo "ORDER_SIZE_USD=10" >> .env
    echo "USE_MARKET_ORDER=false" >> .env
    echo "POLL_INTERVAL_SEC=5" >> .env
  fi
  echo "⚠️  Ouvre le fichier .env et mets ta clé privée : nano .env"
else
  echo "Le fichier .env existe déjà."
  if grep -q '^USE_MARKET_ORDER=' .env 2>/dev/null; then
    sed -i.bak 's/^USE_MARKET_ORDER=.*/USE_MARKET_ORDER=false/' .env
    echo "USE_MARKET_ORDER mis à false (ordres limite, règle du bot)."
  else
    echo "USE_MARKET_ORDER=false" >> .env
  fi
fi

echo ""
echo "=== Terminé ==="
echo "Pour lancer le bot : cd ~/bot-24-7 && npm start"
echo "Pour lancer en arrière-plan avec PM2 :"
echo "  sudo npm install -g pm2"
echo "  pm2 start index.js --name polymarket-bot"
echo "  pm2 save && pm2 startup"
