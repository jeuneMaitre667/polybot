#!/bin/bash
# Exécuté sur le VPS par GitHub Actions (scp + bash) : pre-pull GitHub avec retries, puis redeploy.sh à jour.
set -euo pipefail

grep -q '^GIT_REPO_URL=' "$HOME/bot-24-7/.env" 2>/dev/null \
  || echo 'GIT_REPO_URL=https://github.com/jeuneMaitre667/polybot.git' >> "$HOME/bot-24-7/.env"

REPO="$HOME/polymarket-dashboard"
if [ -d "$REPO/.git" ]; then
  for a in 1 2 3 4 5; do
    if git -C "$REPO" fetch --prune origin "+refs/heads/main:refs/remotes/origin/main" \
      || git -C "$REPO" fetch --prune; then
      git -C "$REPO" reset --hard origin/main 2>/dev/null \
        || git -C "$REPO" reset --hard origin/master 2>/dev/null \
        || true
      break
    fi
    echo "ci-redeploy: pre-pull $a/5 échoué — attente $((a * 8))s (réseau GitHub / errno 107)"
    sleep $((a * 8))
  done
fi

if [ -f "$REPO/bot-24-7/redeploy.sh" ]; then
  bash "$REPO/bot-24-7/redeploy.sh"
else
  bash "$HOME/bot-24-7/redeploy.sh"
fi

bash "$HOME/bot-24-7/verify-deploy.sh"
