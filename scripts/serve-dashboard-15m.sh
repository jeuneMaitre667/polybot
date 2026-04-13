#!/usr/bin/env bash
# Servir le build statique du dashboard (PM2 sur instance 15m).
cd "$(dirname "$0")/.." || cd "$HOME/polymarket-dashboard" || exit 1
exec npx -y serve@14 dist -s -l 4173
