#!/bin/bash
# Usage sur VPS : bash scripts/patch-polygon-rpc-public.sh  (depuis repo) ou copié dans ~/bot-24-7/
set -euo pipefail
F="${1:-$HOME/bot-24-7/.env}"
U='POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com'
B='POLYGON_RPC_FALLBACK=https://polygon-rpc.com,https://polygon-bor-rpc.publicnode.com'
tmp="$(mktemp)"
has_u=0
has_b=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == POLYGON_RPC_URL=* ]]; then
    if [[ "$has_u" -eq 0 ]]; then echo "$U"; has_u=1; fi
  elif [[ "$line" == POLYGON_RPC_FALLBACK=* ]]; then
    if [[ "$has_b" -eq 0 ]]; then echo "$B"; has_b=1; fi
  else
    echo "$line"
  fi
done < "$F" > "$tmp"
[[ "$has_u" -eq 1 ]] || echo "$U" >> "$tmp"
[[ "$has_b" -eq 1 ]] || echo "$B" >> "$tmp"
mv "$tmp" "$F"
echo "Updated $F (POLYGON_RPC public, no Ankr)"
grep -E '^POLYGON_RPC' "$F" | sed 's/=.*/=***/'
