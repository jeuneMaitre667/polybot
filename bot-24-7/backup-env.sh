#!/bin/bash
# Sauvegarde la config du bot en masquant la clé privée (à ne jamais committer).
# Usage : ~/bot-24-7/backup-env.sh
# Crée ~/bot-24-7/.env.backup.redacted (à stocker ailleurs ou en coffre-fort ; la vraie PRIVATE_KEY reste à sauvegarder à part).

set -e
DIR="${BOT_DIR:-$HOME/bot-24-7}"
ENV="$DIR/.env"
OUT="$DIR/.env.backup.redacted"

if [ ! -f "$ENV" ]; then
  echo "Fichier $ENV introuvable."
  exit 1
fi

sed 's/^PRIVATE_KEY=.*/PRIVATE_KEY=***REDACTED***/' "$ENV" > "$OUT"
echo "Sauvegarde créée : $OUT"
echo "  (PRIVATE_KEY masquée — sauvegarde la vraie clé dans un endroit sûr séparément.)"
