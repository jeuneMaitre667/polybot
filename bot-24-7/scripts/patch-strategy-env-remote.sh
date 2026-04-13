#!/bin/bash
# Applique uniquement les paramètres stratégie (signal, SL, grille 15m) — ne touche pas à la mise.
set -euo pipefail
cd ~/bot-24-7
f=.env
[ -f "$f" ] || { echo "Pas de .env"; exit 1; }

upsert() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" "$f"; then
    sed -i.bak_strategy "s|^${key}=.*|${key}=${val}|" "$f"
  else
    echo "${key}=${val}" >> "$f"
  fi
}

upsert MIN_SIGNAL_P 0.77
upsert MAX_SIGNAL_P 0.78
upsert MAX_PRICE_LIQUIDITY 0.78
upsert STOP_LOSS_TRIGGER_PRICE_P 0.57
upsert ENTRY_FORBIDDEN_FIRST_MIN 0
upsert ENTRY_FORBIDDEN_LAST_MIN 0

echo "Stratégie appliquée (mise inchangée)."
grep -E '^(MIN_SIGNAL_P|MAX_SIGNAL_P|MAX_PRICE_LIQUIDITY|STOP_LOSS_TRIGGER_PRICE_P|ENTRY_FORBIDDEN_|ORDER_SIZE_USD|MAX_STAKE_USD|USE_BALANCE_AS_SIZE)=' "$f" || true
