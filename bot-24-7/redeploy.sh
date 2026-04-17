#!/bin/bash
# Redéploiement depuis Lightsail : récupère le code à jour depuis Git puis redémarre le bot.
# À exécuter sur l'instance (SSH) : ~/bot-24-7/redeploy.sh
# Prérequis : une fois, définir GIT_REPO_URL dans ~/bot-24-7/.env (voir .env.example).
# Optionnel : GIT_REDEPLOY_FETCH_RETRIES=8 pour plus de réessais git fetch (défaut 5).

set -euo pipefail

# Pas de prompt npm (CI / SSH non interactive)
export CI=true
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_UPDATE_NOTIFIER=false

BOT_DIR="$HOME/polybot/bot-24-7"
REPO_DIR="$HOME/polybot"
ENV_FILE="$BOT_DIR/.env"

git_reset_to_origin_default() {
  local dir="$1"
  # git -C : ne pas « cd » dans le repo — sinon, si fetch échoue puis on rm -rf ce dossier,
  # le CWD du shell devient invalide → « Unable to read current working directory » (CI / SSH).
  rm -f "$dir/.git/index.lock" 2>/dev/null || true
  rm -f "$dir/.git/refs/remotes/origin/main.lock" "$dir/.git/refs/remotes/origin/master.lock" 2>/dev/null || true

  # Plusieurs essais : sur Lightsail, git fetch vers GitHub peut échouer avec
  # « getpeername() failed errno 107: Transport endpoint is not connected » (socket / réseau transitoire).
  local max="${GIT_REDEPLOY_FETCH_RETRIES:-5}"
  local i=1
  local fetched=0
  while [ "$i" -le "$max" ]; do
    if git -C "$dir" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
      if git -C "$dir" fetch --prune origin "+refs/heads/main:refs/remotes/origin/main" || git -C "$dir" fetch --prune; then
        fetched=1
        break
      fi
    elif git -C "$dir" rev-parse --verify refs/remotes/origin/master >/dev/null 2>&1; then
      if git -C "$dir" fetch --prune origin "+refs/heads/master:refs/remotes/origin/master" || git -C "$dir" fetch --prune; then
        fetched=1
        break
      fi
    else
      if git -C "$dir" fetch --prune; then
        fetched=1
        break
      fi
    fi
    echo "   git fetch échec $i/$max (réseau GitHub / errno 107…) — attente $((i * 8))s puis réessai"
    if [ "$i" -eq "$max" ]; then
      return 1
    fi
    sleep $((i * 8))
    i=$((i + 1))
  done
  [ "$fetched" = 1 ] || return 1

  if git -C "$dir" rev-parse --verify origin/main >/dev/null 2>&1; then
    git -C "$dir" reset --hard origin/main
  elif git -C "$dir" rev-parse --verify origin/master >/dev/null 2>&1; then
    git -C "$dir" reset --hard origin/master
  else
    echo "   (ni origin/main ni origin/master — fetch invalide ou repo vide)"
    return 1
  fi
}

# Phase 2 : install npm ; reprise si ENOTEMPTY sur viem (install incrémentale sans rm -rf complet).
npm_install_bot_phase2() {
  cd "$BOT_DIR" || return 1
  if npm install --no-audit --no-fund; then
    echo "   npm install OK"
    return 0
  fi
  echo "   npm install échoué (souvent ENOTEMPTY sur viem) — suppression viem + dossiers .viem-* puis réessai"
  shopt -s nullglob
  rm -rf node_modules/viem node_modules/.viem-* 2>/dev/null || true
  shopt -u nullglob
  if npm install --no-audit --no-fund; then
    echo "   npm install OK (après nettoyage ciblé)"
    return 0
  fi
  echo "   Échec persistant — rm -rf node_modules puis npm install (pic RAM ; ajouter 1–2 Go de swap si Killed)"
  rm -rf node_modules
  npm install --no-audit --no-fund
}

# Phase 1 : git + rsync. Phase 2 : npm + PM2 — relance via exec pour lire le script **après** rsync
# (sinon bash garde l’ancienne version en mémoire et npm peut rester sur une logique obsolète).
if [ "${REDEPLOY_PHASE:-}" != "2" ]; then
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
  rsync -a --exclude='.env' --exclude='node_modules' --exclude='*.json' "$REPO_DIR/bot-24-7/" "$BOT_DIR/"
  if [ -f "$BOT_DIR/.env.example" ] && [ ! -f "$BOT_DIR/.env" ]; then
    cp "$BOT_DIR/.env.example" "$BOT_DIR/.env"
    echo "   .env créé depuis .env.example — pense à configurer PRIVATE_KEY."
  fi
  # Appliquer la config recommandée (ordre au marché, poll 3s) sans écraser PRIVATE_KEY
  # (Supprimé car causait des corruptions de .env)

  export REDEPLOY_PHASE=2
  exec bash "$BOT_DIR/redeploy.sh"
fi

echo ""
echo "=== Installation des dépendances (phase 2) ==="
# Petits Lightsail (512 Mo–1 Go) : « rm -rf node_modules » + « npm ci » pic RAM → processus « Killed » (OOM),
# le script s’arrête (set -e) et PM2 n’est jamais redémarré. Par défaut : mise à jour **sans** effacer node_modules.
# Forcer ancien comportement (clean + ci) : REDEPLOY_NPM_CLEAN=1 bash ~/polybot/bot-24-7/redeploy.sh
cd "$BOT_DIR" || exit 1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
if [ "${REDEPLOY_NPM_CLEAN:-}" = "1" ]; then
  echo "   REDEPLOY_NPM_CLEAN=1 : suppression node_modules puis npm ci"
  rm -rf node_modules
  if npm ci --no-audit --no-fund; then
    echo "   npm ci OK"
  else
    echo "   npm ci a échoué — fallback npm install"
    npm install --no-audit --no-fund
  fi
else
  echo "   npm install incrémental (pas de rm -rf au départ ; reprise auto si ENOTEMPTY). REDEPLOY_NPM_CLEAN=1 pour clean + npm ci."
  npm_install_bot_phase2
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
pm2 set pm2-logrotate:rotateInterval '0 3 * * *' >/dev/null 2>&1 || true

echo ""
echo "=== Redémarrage du bot (PM2) ==="
# On essaie de redémarrer, sinon on start proprement avec les noms attendus
pm2 restart poly-engine --update-env 2>/dev/null || pm2 start index.js --name poly-engine
pm2 restart bot-status-server --update-env 2>/dev/null || pm2 start status-server.js --name bot-status-server
pm2 save 2>/dev/null || true

echo ""
echo "=== Redéploiement terminé. ==="
echo "   Logs : pm2 logs poly-engine"
