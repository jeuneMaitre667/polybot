#!/bin/bash
# Vérification post-déploiement : bot et status-server répondent.
# À lancer après redeploy.sh (manuel ou via GitHub Action).
# Usage : bash ~/bot-24-7/verify-deploy.sh
#
# Si BOT_STATUS_SECRET est défini dans .env, les routes passent ?token=... (sinon 401).
# /api/bot-status peut être lent (gros fichiers) : timeout long + succès si /api/health OK + PM2 online.

set -e
BOT_DIR="${BOT_DIR:-$HOME/bot-24-7}"
ENV_FILE="$BOT_DIR/.env"
PORT="${BOT_STATUS_PORT:-3001}"

get_env_value() {
  local key="$1"
  local file="$2"
  [ -f "$file" ] || { echo ""; return 0; }
  local line
  line=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1) || true
  [ -n "$line" ] || { echo ""; return 0; }
  local val="${line#*=}"
  val="${val%$'\r'}"
  case "$val" in
    \"*) val="${val#\"}"; val="${val%\"}" ;;
    \'*) val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

urlencode_token() {
  local raw="$1"
  [ -n "$raw" ] || { echo ""; return 0; }
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$raw" 2>/dev/null || printf '%s' "$raw"
  else
    printf '%s' "$raw"
  fi
}

STATUS_SECRET="$(get_env_value BOT_STATUS_SECRET "$ENV_FILE")"
PORT_FROM_ENV="$(get_env_value BOT_STATUS_PORT "$ENV_FILE")"
if [ -n "$PORT_FROM_ENV" ] && [[ "$PORT_FROM_ENV" =~ ^[0-9]+$ ]]; then
  PORT="$PORT_FROM_ENV"
fi

TOKEN_QS=""
if [ -n "$STATUS_SECRET" ]; then
  enc="$(urlencode_token "$STATUS_SECRET")"
  TOKEN_QS="?token=${enc}"
fi

BASE="http://127.0.0.1:${PORT}"

echo "=== Vérification post-déploiement ==="

# PM2
echo -n "PM2 polymarket-bot : "
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'polymarket-bot') : null;
      console.log(p?.pm2_env?.status || 'absent');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "$STATUS"

echo -n "PM2 bot-status-server : "
STATUS_SS=$(pm2 jlist 2>/dev/null | node -e "
  let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
    try {
      const list = JSON.parse(d);
      const p = Array.isArray(list) ? list.find(x => x.name === 'bot-status-server') : null;
      console.log(p?.pm2_env?.status || 'absent');
    } catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "$STATUS_SS"

# HTTP status-server (127.0.0.1 évite soucis IPv6 localhost)
echo -n "GET ${BASE}/api/health${TOKEN_QS:+?...} : "
HEALTH=$(curl -sS --max-time 25 -o /dev/null -w "%{http_code}" "${BASE}/api/health${TOKEN_QS}" 2>/dev/null || echo "000")
echo "HTTP $HEALTH"

echo -n "GET ${BASE}/api/bot-status (peut être lent) : "
STATUS_HTTP=$(curl -sS --max-time 90 -o /dev/null -w "%{http_code}" "${BASE}/api/bot-status${TOKEN_QS}" 2>/dev/null || echo "000")
echo "HTTP $STATUS_HTTP"

echo ""
echo "=== npm audit (info — ne bloque pas ce script ; vuln. transitives Polymarket souvent sans correctif npm) ==="
( cd "$BOT_DIR" && npm audit --omit=dev --no-fund ) || true
echo ""

if [ "$STATUS_HTTP" = "200" ]; then
  echo "=== OK : /api/bot-status répond (200). ==="
  exit 0
fi

if [ "$HEALTH" = "200" ] && [ "$STATUS_SS" = "online" ]; then
  echo "=== OK : /api/health OK (200) et bot-status-server PM2 online (bot-status HTTP $STATUS_HTTP ignoré — souvent timeout si gros bot.log). ==="
  exit 0
fi

echo "=== ÉCHEC : health HTTP $HEALTH, bot-status HTTP $STATUS_HTTP, PM2 status-server=$STATUS_SS ==="
echo "    Si secret requis : vérifier BOT_STATUS_SECRET dans .env. Sinon : pm2 logs bot-status-server"
exit 1
