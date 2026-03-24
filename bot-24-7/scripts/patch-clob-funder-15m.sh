#!/usr/bin/env bash
# Usage sur le VPS : bash patch-clob-funder-15m.sh
# Met à jour CLOB_FUNDER_ADDRESS (profil Polymarket) et CLOB_SIGNATURE_TYPE=1.
set -euo pipefail
FUNDER="0x3c42b7540EBf50259b3244E083633C525B1659B0"
ENV="${HOME}/bot-24-7/.env"
test -f "$ENV" || { echo "Fichier absent: $ENV"; exit 1; }
if grep -q '^CLOB_FUNDER_ADDRESS=' "$ENV"; then
  sed -i "s/^CLOB_FUNDER_ADDRESS=.*/CLOB_FUNDER_ADDRESS=${FUNDER}/" "$ENV"
else
  echo "CLOB_FUNDER_ADDRESS=${FUNDER}" >> "$ENV"
fi
if grep -q '^CLOB_SIGNATURE_TYPE=' "$ENV"; then
  sed -i 's/^CLOB_SIGNATURE_TYPE=.*/CLOB_SIGNATURE_TYPE=1/' "$ENV"
else
  echo 'CLOB_SIGNATURE_TYPE=1' >> "$ENV"
fi
echo "--- Lignes CLOB_ (pas de PRIVATE_KEY) ---"
grep -E '^CLOB_SIGNATURE_TYPE=|^CLOB_FUNDER_ADDRESS=' "$ENV" || true
pm2 restart polymarket-bot
pm2 list
