#!/bin/bash
# Redéploiement depuis Lightsail : récupère le code à jour depuis Git puis redémarre le bot.
# À exécuter sur l'instance (SSH) : ~/bot-24-7/redeploy.sh
# Prérequis : une fois, définir GIT_REPO_URL dans ~/bot-24-7/.env (voir .env.example).

set -euo pipefail

# Pas de prompt npm (CI / SSH non interactive)
export CI=true
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_UPDATE_NOTIFIER=false

BOT_DIR="$HOME/bot-24-7"
REPO_DIR="$HOME/polymarket-dashboard"
ENV_FILE="$BOT_DIR/.env"

git_reset_to_origin_default() {
  local dir="$1"
  # git -C : ne pas « cd » dans le repo — sinon, si fetch échoue puis on rm -rf ce dossier,
  # le CWD du shell devient invalide → « Unable to read current working directory » (CI / SSH).
  rm -f "$dir/.git/index.lock" 2>/dev/null || true
  rm -f "$dir/.git/refs/remotes/origin/main.lock" "$dir/.git/refs/remotes/origin/master.lock" 2>/dev/null || true
  # Shallow / ref désalignée : forcer la ref distante (évite « cannot lock ref ... expected ... »)
  if git -C "$dir" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
    git -C "$dir" fetch --prune origin "+refs/heads/main:refs/remotes/origin/main" || git -C "$dir" fetch --prune || return 1
  elif git -C "$dir" rev-parse --verify refs/remotes/origin/master >/dev/null 2>&1; then
    git -C "$dir" fetch --prune origin "+refs/heads/master:refs/remotes/origin/master" || git -C "$dir" fetch --prune || return 1
  else
    git -C "$dir" fetch --prune || return 1
  fi
  if git -C "$dir" rev-parse --verify origin/main >/dev/null 2>&1; then
    git -C "$dir" reset --hard origin/main
  elif git -C "$dir" rev-parse --verify origin/master >/dev/null 2>&1; then
    git -C "$dir" reset --hard origin/master
  else
    echo "   (ni origin/main ni origin/master — fetch invalide ou repo vide)"
    return 1
  fi
}

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

cd "$HOME"

# Clone ou mise à jour du repo
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "=== Premier clone du repo ==="
  rm -rf "$REPO_DIR" 2>/dev/null || true
  git clone --depth 1 "$GIT_REPO_URL" "$REPO_DIR"
else
  echo "=== Mise à jour du repo (fetch + reset) ==="
  # Evite les échecs Git récents (divergent branches / lock refs) en forçant l'état local sur origin/main.
  # Si Git échoue (lock ref), on reclone pour garantir un état cohérent.
  if git_reset_to_origin_default "$REPO_DIR"; then
    :
  else
    echo "   Git fetch/reset a échoué — reclone du repo pour stabiliser redeploy."
    cd "$HOME"
    rm -rf "$REPO_DIR" 2>/dev/null || true
    sleep 1
    git clone --depth 1 "$GIT_REPO_URL" "$REPO_DIR" || {
      echo "   Reclone échoué — nettoyage forcé du dossier puis nouvel essai."
      rm -rf "$REPO_DIR" 2>/dev/null || true
      git clone --depth 1 "$GIT_REPO_URL" "$REPO_DIR"
    }
  fi
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
# Évite ENOTEMPTY / rmdir sur certains VPS si un ancien npm était interrompu ou concurrent.
rm -rf "$BOT_DIR/node_modules"
if (cd "$BOT_DIR" && npm ci --no-audit --no-fund); then
  echo "   npm ci OK"
else
  echo "   npm ci a échoué (lock manquant ou désaligné) — fallback npm install"
  (cd "$BOT_DIR" && npm install --no-audit --no-fund)
fi

echo ""
echo "=== Rotation logs PM2 (pm2-logrotate) ==="
pm2 ping >/dev/null 2>&1 || true
pm2 ls >/dev/null 2>&1 || true
pm2 jlist >/dev/null 2>&1 || true
pm2 list >/dev/null 2>&1 || true
pm2 list 2>/dev/null | grep -q 'pm2-logrotate' && echo "   pm2-logrotate déjà installé" || pm2 install pm2-logrotate >/dev/null 2>&1 || true
# Config recommandée (sans être trop agressif)
pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true
pm2 set pm2-logrotate:workerInterval 30 >/dev/null 2>&1 || true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null 2>&1 || true

echo ""
echo "=== Redémarrage du bot (PM2) ==="
(cd "$BOT_DIR" && pm2 restart polymarket-bot 2>/dev/null || pm2 start index.js --name polymarket-bot)
(cd "$BOT_DIR" && pm2 restart bot-status-server 2>/dev/null || true)
pm2 save 2>/dev/null || true

echo ""
echo "=== Redéploiement terminé. ==="
echo "   Logs : pm2 logs polymarket-bot"
