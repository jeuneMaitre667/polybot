#!/bin/bash
# Redéploiement depuis Lightsail : récupère le code à jour depuis Git puis redémarre le bot.
# À exécuter sur l'instance (SSH) : ~/bot-24-7/redeploy.sh
# Prérequis : une fois, définir GIT_REPO_URL dans ~/bot-24-7/.env (voir .env.example).

set -e
BOT_DIR="$HOME/bot-24-7"
REPO_DIR="$HOME/polymarket-dashboard"
ENV_FILE="$BOT_DIR/.env"

echo "=== Redéploiement du bot Polymarket depuis Git ==="

# Lire l’URL du repo (depuis .env ou variable d’environnement)
if [ -f "$ENV_FILE" ]; then
  GIT_REPO_URL="${GIT_REPO_URL:-$(grep -E '^GIT_REPO_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')}"
fi
GIT_REPO_URL="${GIT_REPO_URL:-}"

if [ -z "$GIT_REPO_URL" ]; then
  echo ""
  echo "⚠️  GIT_REPO_URL non défini."
  echo "   Ajoute dans $ENV_FILE une ligne, par exemple :"
  echo "   GIT_REPO_URL=https://github.com/jeuneMaitre667/polybot.git"
  echo ""
  echo "   Puis relance : ~/bot-24-7/redeploy.sh"
  exit 1
fi

echo "   Repo : $GIT_REPO_URL"
echo ""

# Clone ou mise à jour du repo
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "=== Premier clone du repo ==="
  rm -rf "$REPO_DIR" 2>/dev/null || true
  git clone --depth 1 "$GIT_REPO_URL" "$REPO_DIR"
else
  echo "=== Mise à jour du repo (git pull) ==="
  (cd "$REPO_DIR" && git pull)
fi

if [ ! -d "$REPO_DIR/bot-24-7" ]; then
  echo "Erreur : le dossier bot-24-7 est introuvable dans le repo."
  exit 1
fi

# Copie du code vers ~/bot-24-7 en conservant .env
echo ""
echo "=== Copie du code (conservation de .env) ==="
mkdir -p "$BOT_DIR"
rsync -a --exclude='.env' --exclude='node_modules' "$REPO_DIR/bot-24-7/" "$BOT_DIR/"
if [ -f "$BOT_DIR/.env.example" ] && [ ! -f "$BOT_DIR/.env" ]; then
  cp "$BOT_DIR/.env.example" "$BOT_DIR/.env"
  echo "   .env créé depuis .env.example — pense à configurer PRIVATE_KEY."
fi
# Appliquer la config recommandée (ordre au marché, poll 3s) sans écraser PRIVATE_KEY
if [ -f "$BOT_DIR/.env" ]; then
  grep -q '^USE_MARKET_ORDER=' "$BOT_DIR/.env" && sed -i.bak 's/^USE_MARKET_ORDER=.*/USE_MARKET_ORDER=true/' "$BOT_DIR/.env" || echo "USE_MARKET_ORDER=true" >> "$BOT_DIR/.env"
  grep -q '^POLL_INTERVAL_SEC=' "$BOT_DIR/.env" && sed -i.bak 's/^POLL_INTERVAL_SEC=.*/POLL_INTERVAL_SEC=1/' "$BOT_DIR/.env" || echo "POLL_INTERVAL_SEC=1" >> "$BOT_DIR/.env"
  echo "   .env mis à jour : USE_MARKET_ORDER=true, POLL_INTERVAL_SEC=1"
fi

echo ""
echo "=== Installation des dépendances ==="
(cd "$BOT_DIR" && npm install)

echo ""
echo "=== Redémarrage du bot (PM2) ==="
(cd "$BOT_DIR" && pm2 restart polymarket-bot 2>/dev/null || pm2 start index.js --name polymarket-bot)
(cd "$BOT_DIR" && pm2 restart bot-status-server 2>/dev/null || true)
pm2 save 2>/dev/null || true

echo ""
echo "=== Redéploiement terminé. ==="
echo "   Logs : pm2 logs polymarket-bot"
