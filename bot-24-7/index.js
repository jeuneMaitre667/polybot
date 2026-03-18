/**
 * Bot Polymarket Bitcoin Up or Down — exécution 24/7 (Node.js)
 *
 * Étapes :
 * 1. Connexion wallet Polygon (clé privée)
 * 2. Boucle : récupérer les signaux Gamma (prix 96,8–97 %)
 * 3. Pour chaque signal : si pas dans la dernière minute avant fin → placer ordre CLOB (marché ou limite)
 * 4. Ne pas placer deux fois pour le même créneau (mémorisation par conditionId)
 * 5. Au début de chaque cycle : tenter de redeem les tokens gagnants (marchés résolus) en USDC pour que le solde inclue les gains
 *
 * Usage : npm install && PRIVATE_KEY=0x... npm start
 * Config : .env (voir .env.example)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import WebSocket from 'ws';
import axios from 'axios';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_MS = 5000;
const WS_REFRESH_SUBSCRIPTIONS_MS = 30 * 1000;
const WS_PING_INTERVAL_MS = 10 * 1000; // doc Polymarket : garder la connexion alive
const WS_DEBOUNCE_MS = Number(process.env.WS_DEBOUNCE_MS) || 300; // évite rafales d'ordres sur même token
const CREDS_CACHE_TTL_MS = Number(process.env.CREDS_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const ENABLE_HEARTBEAT = process.env.ENABLE_HEARTBEAT === 'true';

/** Dossier du bot (où se trouve index.js), pour que balance.json et last-order.json soient toujours dans ~/bot-24-7 même si PM2 a été lancé depuis un autre répertoire. */
const BOT_DIR = path.resolve(__dirname);
const LAST_ORDER_FILE = path.join(BOT_DIR, 'last-order.json');
const BALANCE_FILE = path.join(BOT_DIR, 'balance.json');
const BALANCE_HISTORY_FILE = path.join(BOT_DIR, 'balance-history.json');
const ORDERS_LOG_FILE = path.join(BOT_DIR, 'orders.log');
const BOT_JSON_LOG_FILE = path.join(BOT_DIR, 'bot.log');
const LIQUIDITY_HISTORY_FILE = path.join(BOT_DIR, 'liquidity-history.json');
const TRADE_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'trade-latency-history.json');
const CYCLE_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'cycle-latency-history.json');
const SIGNAL_DECISION_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'signal-decision-latency-history.json');
const HEALTH_FILE = path.join(BOT_DIR, 'health.json');
const BALANCE_HISTORY_MAX = 500;
const LIQUIDITY_HISTORY_DAYS = 3;
const TRADE_LATENCY_HISTORY_DAYS = 7;
const TRADE_LATENCY_HISTORY_MAX = 2000;
const CYCLE_LATENCY_HISTORY_DAYS = 7;
const CYCLE_LATENCY_HISTORY_MAX = 5000;
const SIGNAL_DECISION_LATENCY_HISTORY_DAYS = 7;
const SIGNAL_DECISION_LATENCY_HISTORY_MAX = 10000;

/** Log structuré JSON (une ligne par événement) dans bot.log pour analyse ou envoi vers un outil de log. */
function logJson(level, message, meta = {}) {
  try {
    rotateBotJsonLogIfNeeded();
    fs.appendFileSync(BOT_JSON_LOG_FILE, JSON.stringify({ level, message, ts: new Date().toISOString(), ...meta }) + '\n', 'utf8');
  } catch (_) {}
}

// Rotation légère de bot.log (JSONL) pour éviter qu'il grossisse indéfiniment.
const BOT_LOG_MAX_MB = Number(process.env.BOT_LOG_MAX_MB) || 50;
const BOT_LOG_ROTATE_KEEP = Math.max(1, Number(process.env.BOT_LOG_ROTATE_KEEP) || 5);
const BOT_LOG_ROTATE_CHECK_MS = 5000;
let lastBotLogRotateCheckAt = 0;

function rotateBotJsonLogIfNeeded() {
  const now = Date.now();
  if (now - lastBotLogRotateCheckAt < BOT_LOG_ROTATE_CHECK_MS) return;
  lastBotLogRotateCheckAt = now;
  const maxBytes = BOT_LOG_MAX_MB * 1024 * 1024;
  try {
    const st = fs.statSync(BOT_JSON_LOG_FILE);
    if (!st?.size || st.size < maxBytes) return;
  } catch (_) {
    return; // fichier absent, rien à faire
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(BOT_DIR, `bot.log.${stamp}`);
    fs.renameSync(BOT_JSON_LOG_FILE, rotated);
    // garder les N derniers rotations
    const files = fs.readdirSync(BOT_DIR).filter((f) => f.startsWith('bot.log.')).sort();
    const toDelete = files.length > BOT_LOG_ROTATE_KEEP ? files.slice(0, files.length - BOT_LOG_ROTATE_KEEP) : [];
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(BOT_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

function writeLastOrder(data) {
  try {
    fs.writeFileSync(LAST_ORDER_FILE, JSON.stringify(data), 'utf8');
  } catch (_) {}
}

/** Met à jour health.json (lu par status-server pour /api/bot-status). Fusionne updates avec l'état existant. */
function writeHealth(updates) {
  try {
    let state = {
      wsConnected: false,
      wsLastChangeAt: null,
      wsLastConnectedAt: null,
      lastOrderAt: null,
      lastOrderSource: null,
      geoblockOk: null,
      killSwitchActive: false,
      at: null,
    };
    try {
      const raw = fs.readFileSync(HEALTH_FILE, 'utf8');
      const prev = JSON.parse(raw);
      if (prev && typeof prev === 'object') state = { ...state, ...prev };
    } catch (_) {}
    state = { ...state, ...updates, at: new Date().toISOString() };
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(state), 'utf8');
  } catch (_) {}
}

function writeBalance(balanceUsd) {
  try {
    const at = new Date().toISOString();
    fs.writeFileSync(BALANCE_FILE, JSON.stringify({ balance: balanceUsd, at }), 'utf8');
    appendBalanceHistory(balanceUsd != null ? balanceUsd : 0, at);
  } catch (_) {}
}

function appendBalanceHistory(balanceUsd, at) {
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(BALANCE_HISTORY_FILE, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch (_) {}
    arr.push({ balance: balanceUsd, at });
    if (arr.length > BALANCE_HISTORY_MAX) arr = arr.slice(-BALANCE_HISTORY_MAX);
    fs.writeFileSync(BALANCE_HISTORY_FILE, JSON.stringify(arr), 'utf8');
  } catch (_) {}
}

function appendOrderLog(obj) {
  try {
    fs.appendFileSync(ORDERS_LOG_FILE, JSON.stringify(obj) + '\n', 'utf8');
  } catch (_) {}
}

// ——— Config ———
const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const CLOB_HOST = 'https://clob.polymarket.com';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';
const CLOB_PRICE_URL = 'https://clob.polymarket.com/price';
const CHAIN_ID = 137;
// Fenêtre de prix pour signaux et mise max : 97 % – 97,5 % (plus de signaux qu’à 96,8–97 %).
const MIN_P = Number(process.env.MIN_SIGNAL_P) || 0.97;
const MAX_P = Number(process.env.MAX_SIGNAL_P) || 0.975;
const MAX_PRICE_LIQUIDITY = Number(process.env.MAX_PRICE_LIQUIDITY) || 0.975;
const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';
const NO_TRADE_LAST_MS_HOURLY = 5 * 60 * 1000; // 5 min avant la fin pour le marché horaire
const NO_TRADE_LAST_MS_15M = 4 * 60 * 1000; // 4 min pour le marché 15m

/** hourly = créneaux 1h (bitcoin-up-or-down), 15m = créneaux 15 min (btc-updown-15m). Défaut hourly. */
const MARKET_MODE = (process.env.MARKET_MODE || 'hourly').toLowerCase() === '15m' ? '15m' : 'hourly';

// Cache /book : plus long sur 15m pour réduire variance/ratelimits (overridable via BOOK_CACHE_MS).
const BOOK_CACHE_MS = Number(process.env.BOOK_CACHE_MS) || (MARKET_MODE === '15m' ? 3000 : 1500);

const privateKeyRaw = process.env.PRIVATE_KEY?.trim();
const isPlaceholder = !privateKeyRaw || privateKeyRaw === 'your_hex_private_key_here' || /^0x?REMPLACE/i.test(privateKeyRaw);
// Détecter si l'utilisateur a mis l'adresse (0x + 40 hex) au lieu de la clé privée (0x + 64 hex)
const hexPart = (privateKeyRaw || '').replace(/^0x/i, '');
const looksLikeAddress = hexPart.length === 40 && /^[0-9a-fA-F]+$/.test(hexPart);
const privateKey = isPlaceholder || looksLikeAddress ? '' : privateKeyRaw;
if (privateKeyRaw && looksLikeAddress) {
  console.error('ERREUR: PRIVATE_KEY ressemble à une ADRESSE (0x + 40 caractères). Il faut la CLÉ PRIVÉE (0x + 64 caractères hex). Récupère-la depuis Phantom/MetaMask : Paramètres → Sécurité → Exporter clé privée. Puis dans ~/bot-24-7/.env mets PRIVATE_KEY=0x...');
}
/** RPC Polygon : par défaut publicnode (plus fiable depuis un VPS). polygon-rpc.com provoque souvent NETWORK_ERROR. */
const polygonRpc = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const polygonRpcFallbacks = (process.env.POLYGON_RPC_FALLBACK || 'https://polygon-rpc.com,https://rpc.ankr.com/polygon').split(',').map((u) => u.trim()).filter(Boolean);
/** Montant minimum pour placer un ordre (USDC). En dessous, on skip. Défaut 1. */
const orderSizeMinUsd = Number(process.env.ORDER_SIZE_MIN_USD) || 1;
/** Si true, la taille de chaque ordre = solde USDC du wallet (réinvestissement des gains). Sinon ordre fixe ORDER_SIZE_USD. */
const useBalanceAsSize = process.env.USE_BALANCE_AS_SIZE !== 'false';
const orderSizeUsd = Number(process.env.ORDER_SIZE_USD) || 10;
/** Ordre au marché par défaut (exécution immédiate, latence min). USE_MARKET_ORDER=false pour ordre limite. */
const useMarketOrder = process.env.USE_MARKET_ORDER !== 'false';
const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC) || 1;
/** Placer les ordres en auto (défaut: true). Mettre à false pour faire tourner le bot sans trader. */
const autoPlaceEnabled = process.env.AUTO_PLACE_ENABLED !== 'false';
/** Tenter de redeem les tokens gagnants (marchés résolus) en USDC au début de chaque cycle. Sinon le solde ne inclut pas les gains tant qu'on n'a pas redeem. */
const redeemEnabled = process.env.REDEEM_ENABLED !== 'false';
/** Si true : quand le solde (ou la mise) dépasse la mise max au prix du marché, plafonner à la mise max pour que l'avg price reste égal au prix du marché et ne pas dégrader les gains. USE_LIQUIDITY_CAP=false pour désactiver. */
const useLiquidityCap = process.env.USE_LIQUIDITY_CAP !== 'false';
/** Réagir en temps réel aux changements de prix via WebSocket CLOB (best_bid_ask). USE_WEBSOCKET=false pour ne faire que du polling. */
const useWebSocket = process.env.USE_WEBSOCKET !== 'false';
const walletConfigured = !!privateKey;

// ——— Wallet & provider ———
// ethers v6 : 2e argument = chainId (number), pas un objet { chainId }
let provider = new ethers.JsonRpcProvider(polygonRpc, CHAIN_ID);
const wallet = walletConfigured
  ? new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey, provider)
  : null;

// @polymarket/clob-client s'attend à un signer Ethers qui expose `_signTypedData` (ethers v5).
// Avec ethers v6, on a `signTypedData` mais pas `_signTypedData`, donc il fall back sur un autre chemin
// et peut échouer avec "wallet client is missing account address".
// On shim pour que le SDK utilise bien le chemin "ethers typed data signer".
if (wallet && typeof wallet._signTypedData !== 'function' && typeof wallet.signTypedData === 'function') {
  wallet._signTypedData = wallet.signTypedData.bind(wallet);
}

// Debug : confirmer que le shim est bien pris en compte par @polymarket/clob-client
if (wallet) {
  console.log(
    `[CLOB signer shim] typeof wallet._signTypedData=${typeof wallet._signTypedData} typeof wallet.signTypedData=${typeof wallet.signTypedData}`
  );
}

/**
 * Type de wallet CLOB (doc Polymarket) :
 * 0 = EOA (clé privée standalone),
 * 1 = POLY_PROXY (Magic),
 * 2 = GNOSIS_SAFE (Gnosis Safe / proxy le plus fréquent côté Polymarket).
 *
 * IMPORTANT : par défaut on garde le comportement EOA (0) pour compatibilité,
 * mais tu peux corriger en proxy en mettant CLOB_SIGNATURE_TYPE=2 dans ~/bot-24-7/.env
 * (et éventuellement CLOB_FUNDER_ADDRESS si besoin).
 */
const CLOB_SIGNATURE_TYPE = Number(process.env.CLOB_SIGNATURE_TYPE) || 0;
const CLOB_FUNDER_ADDRESS_RAW = process.env.CLOB_FUNDER_ADDRESS?.trim();
const clobFunderAddress =
  CLOB_FUNDER_ADDRESS_RAW
    ? CLOB_FUNDER_ADDRESS_RAW
    : CLOB_SIGNATURE_TYPE === 0
      ? wallet?.address
      : undefined; // Pour Proxy/Gnosis Safe : funder auto-déduit par le client si non fourni.

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
/** USDC sur Polygon (USDC.e bridged, 6 decimals). */
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** CTF (Conditional Tokens) sur Polygon — redeem des tokens gagnants en USDC. */
const CTF_POLYGON = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];
const ORDER_RETRY_ATTEMPTS = 3;
const ORDER_RETRY_BASE_MS = 1000;
let consecutiveOrderErrors = 0;
let killSwitchActive = false;

function getSignalKey(signal) {
  return signal.market?.conditionId ?? signal.eventSlug ?? '';
}

function parsePrices(market) {
  try {
    const raw = market.outcomePrices ?? market.outcome_prices;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return [parseFloat(arr[0]) ?? 0.5, parseFloat(arr[1]) ?? 0.5];
  } catch {
    return null;
  }
}

function getTokenIdToBuy(market, takeSide) {
  const idx = takeSide === 'Up' ? 0 : 1;
  let ids = market.clobTokenIds ?? market.clob_token_ids;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { ids = null; }
  }
  if (Array.isArray(ids) && ids[idx]) return String(ids[idx]);
  const tokens = market.tokens;
  if (Array.isArray(tokens) && tokens[idx]?.token_id) return String(tokens[idx].token_id);
  if (Array.isArray(tokens) && tokens[idx]?.tokenId) return String(tokens[idx].tokenId);
  return null;
}

/** Appel RPC direct eth_call (secours si CLOB indisponible). Calcule data = balanceOf(address). */
function encodeBalanceOf(address) {
  const addr = address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return '0x70a08231' + addr; // selector balanceOf(address)
}

/** Récupère le solde USDC via l’API CLOB (balance-allowance). Recommandé par la doc Polymarket, pas de RPC. */
async function getUsdcBalanceViaClob(client) {
  if (!client) return null;
  try {
    const out = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const raw = out?.balance ?? out?.balance_raw;
    if (raw == null) return null;
    const num = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(num) ? num / 1e6 : null; // USDC 6 decimals
  } catch (err) {
    return null;
  }
}

/** Secours : solde USDC via eth_call RPC. Retourne null si tout échoue. */
async function getUsdcBalanceRpc() {
  if (!wallet) return null;
  const urls = [polygonRpc, ...polygonRpcFallbacks];
  const data = encodeBalanceOf(wallet.address);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await axios.post(
        url,
        { jsonrpc: '2.0', method: 'eth_call', params: [{ to: USDC_POLYGON, data }, 'latest'], id: 1 },
        { timeout: 8000 }
      );
      const hex = res.data?.result;
      if (hex && hex !== '0x') {
        const bn = BigInt(hex);
        return Number(ethers.formatUnits(bn, 6));
      }
      return 0;
    } catch (err) {
      if (i === 0) console.warn('Solde USDC (RPC secours):', err.message);
    }
  }
  return null;
}

/** Pas de trade si l’événement se termine dans moins d’une minute. */
/** Normalise un conditionId en bytes32 (0x + 64 hex). Retourne null si invalide. */
function conditionIdToBytes32(cid) {
  if (!cid || typeof cid !== 'string') return null;
  const s = cid.trim().replace(/^0x/i, '');
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return '0x' + s.toLowerCase();
}

/** Récupère les conditionIds uniques pour lesquels le bot a placé un ordre (orders.log + last-order.json). */
function getTradedConditionIds() {
  const ids = new Set();
  try {
    const raw = fs.readFileSync(ORDERS_LOG_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const cid = obj?.conditionId ?? obj?.condition_id;
        if (cid) ids.add(String(cid));
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(LAST_ORDER_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const cid = obj?.conditionId ?? obj?.condition_id;
    if (cid) ids.add(String(cid));
  } catch (_) {}
  return [...ids];
}

/** Tente de redeem les positions (tokens gagnants → USDC) pour les conditionIds tradés. Marchés doivent être résolus. Si positions sur proxy Polymarket, ce redeem ne fera rien (claim depuis le site). */
async function tryRedeemResolvedPositions() {
  if (!walletConfigured || !wallet || !redeemEnabled) return;
  const ctf = new ethers.Contract(CTF_POLYGON, CTF_ABI, wallet);
  const parentCollectionId = ethers.ZeroHash;
  const indexSets = [1, 2];
  const tradedIds = getTradedConditionIds();
  for (const cid of tradedIds) {
    const conditionIdBytes32 = conditionIdToBytes32(cid);
    if (!conditionIdBytes32) continue;
    try {
      const tx = await ctf.redeemPositions(USDC_POLYGON, parentCollectionId, conditionIdBytes32, indexSets);
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        logJson('info', 'Redeem positions OK', { conditionId: cid.slice(0, 18) + '…', hash: receipt.hash });
        console.log(`[${new Date().toISOString()}] Redeem OK — conditionId ${cid.slice(0, 14)}… — tx ${receipt.hash}`);
      }
    } catch (err) {
      if (!/no positions to redeem|revert|insufficient/i.test(String(err.message))) {
        logJson('warn', 'Redeem échoué (non bloquant)', { conditionId: cid.slice(0, 18) + '…', error: err.message });
      }
    }
  }
}

/** Enregistre un relevé de liquidité (pour moyenne sur 3 jours, exposée par le status-server). */
function appendLiquidityHistory(liquidityUsd) {
  if (liquidityUsd == null || liquidityUsd <= 0) return;
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(LIQUIDITY_HISTORY_FILE, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      // fichier absent ou invalide
    }
    const now = Date.now();
    arr.push({ at: new Date(now).toISOString(), liquidityUsd: Number(liquidityUsd) });
    const cutoff = now - LIQUIDITY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    arr = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    fs.writeFileSync(LIQUIDITY_HISTORY_FILE, JSON.stringify(arr), 'utf8');
    console.log(`[Mise max] Liquidité enregistrée: ${Number(liquidityUsd).toFixed(0)} USD (${arr.length} relevés sur 3 j)`);
  } catch (e) {
    console.error('Erreur enregistrement liquidité:', e?.message ?? e);
  }
}

/** Enregistre la latence d'un trade (ms) sur les 7 derniers jours (pour le dashboard). */
function appendTradeLatencyHistory(entry) {
  if (!entry || typeof entry !== 'object') return;
  const latencyMs = Number(entry.latencyMs);
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(TRADE_LATENCY_HISTORY_FILE, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      // fichier absent ou invalide
    }
    const now = Date.now();
    arr.push({ at: new Date(now).toISOString(), ...entry, latencyMs });
    const cutoff = now - TRADE_LATENCY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    arr = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    if (arr.length > TRADE_LATENCY_HISTORY_MAX) arr = arr.slice(-TRADE_LATENCY_HISTORY_MAX);
    fs.writeFileSync(TRADE_LATENCY_HISTORY_FILE, JSON.stringify(arr), 'utf8');
  } catch (_) {}
}

/** Enregistre la latence d'un cycle (ms) sur 7 jours (mesurable même sans trade). */
function appendCycleLatencyHistory(entry) {
  if (!entry || typeof entry !== 'object') return;
  const cycleMs = Number(entry.cycleMs);
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return;
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(CYCLE_LATENCY_HISTORY_FILE, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      // fichier absent ou invalide
    }
    const now = Date.now();
    arr.push({ at: new Date(now).toISOString(), ...entry, cycleMs });
    const cutoff = now - CYCLE_LATENCY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    arr = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    if (arr.length > CYCLE_LATENCY_HISTORY_MAX) arr = arr.slice(-CYCLE_LATENCY_HISTORY_MAX);
    fs.writeFileSync(CYCLE_LATENCY_HISTORY_FILE, JSON.stringify(arr), 'utf8');
  } catch (_) {}
}

/** Enregistre la latence "signal -> décision" (ms) sur 7 jours (mesurable même si aucun ordre n'est placé). */
function appendSignalDecisionLatencyHistory(entry) {
  if (!entry || typeof entry !== 'object') return;
  const decisionMs = Number(entry.decisionMs);
  if (!Number.isFinite(decisionMs) || decisionMs <= 0) return;
  try {
    let arr = [];
    try {
      const raw = fs.readFileSync(SIGNAL_DECISION_LATENCY_HISTORY_FILE, 'utf8');
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    } catch {
      // fichier absent ou invalide
    }
    const now = Date.now();
    arr.push({ at: new Date(now).toISOString(), ...entry, decisionMs });
    const cutoff = now - SIGNAL_DECISION_LATENCY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    arr = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    if (arr.length > SIGNAL_DECISION_LATENCY_HISTORY_MAX) arr = arr.slice(-SIGNAL_DECISION_LATENCY_HISTORY_MAX);
    fs.writeFileSync(SIGNAL_DECISION_LATENCY_HISTORY_FILE, JSON.stringify(arr), 'utf8');
  } catch (_) {}
}

/** Throttle : ne pas logger la même raison pour le même token plus d'une fois toutes les 5 s (évite spam tout en gardant visibilité). */
const liquidityLogThrottle = new Map(); // tokenId -> { reason, ts }
const LIQUIDITY_LOG_THROTTLE_MS = 5 * 1000;

function logLiquidityEmptyIfThrottled(tokenId, reason) {
  const key = tokenId || 'unknown';
  const now = Date.now();
  const prev = liquidityLogThrottle.get(key);
  if (prev && prev.reason === reason && now - prev.ts < LIQUIDITY_LOG_THROTTLE_MS) return;
  liquidityLogThrottle.set(key, { reason, ts: now });
  const short = (typeof key === 'string' && key.length > 18) ? key.slice(0, 18) + '…' : key;
  console.log(`[Mise max] Liquidité 97%: ${reason} (token ${short})`);
  logJson('info', 'Liquidité 97% vide', { reason, tokenId: short });
}

/** Throttle : éviter le spam quand la création du client CLOB échoue (ex. wallet client missing account address). */
const clobClientWarnThrottle = { ts: 0, lastMsg: '' };
const CLOB_CLIENT_WARN_THROTTLE_MS = 30 * 1000;

function warnClobClientIfThrottled(errOrMessage) {
  const err = (errOrMessage instanceof Error) ? errOrMessage : null;
  const msg = String(errOrMessage?.message || errOrMessage || 'erreur');
  const now = Date.now();
  if (clobClientWarnThrottle.lastMsg === msg && now - clobClientWarnThrottle.ts < CLOB_CLIENT_WARN_THROTTLE_MS) return;
  clobClientWarnThrottle.lastMsg = msg;
  clobClientWarnThrottle.ts = now;
  console.warn('CLOB client (solde/ordres):', msg);
  logJson('warn', 'CLOB client indisponible (solde/ordres)', {
    error: msg,
    stack: err?.stack ? String(err.stack).slice(0, 1200) : undefined,
  });
}

// Cache en mémoire : dernier book par token (y compris null) pour limiter /book et réduire la latence.
const bookCache = new Map(); // tokenId -> { atMs, value }

// Cache en mémoire des credentials CLOB (évite createOrDeriveApiKey() à chaque trade).
let cachedCreds = null;
let cachedCredsAt = 0;

async function getClobCredsCached() {
  const now = Date.now();
  if (cachedCreds && now - cachedCredsAt < CREDS_CACHE_TTL_MS) return cachedCreds;
  // Important : même pour la création/derivation de creds (L1),
  // le client a besoin d'une "account context" complète (signatureType + funderAddress)
  // sinon @polymarket/clob-client peut lever "wallet client is missing account address".
  const clientWithoutCreds = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    undefined,
    CLOB_SIGNATURE_TYPE,
    clobFunderAddress,
  );
  const creds = await clientWithoutCreds.createOrDeriveApiKey();
  cachedCreds = creds;
  cachedCredsAt = now;
  return creds;
}

async function buildClobClientCachedCreds() {
  const creds = await getClobCredsCached();
  return new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, CLOB_SIGNATURE_TYPE, clobFunderAddress);
}

/**
 * Récupère la "mise max" compatible avec un ordre market FOK :
 * montant max (USD) qu'on peut engager en USDC tout en s'assurant que l'exécution ne dépasse pas
 * le plafond de prix (97,5c) — en sommant la profondeur cumulée jusqu'au pire prix autorisé.
 *
 * Objectif : maximiser la probabilité de remplissage total (moins de no-fill),
 * au prix d'une avg price potentiellement un peu plus dégradée si on consomme jusqu'au plafond.
 */
async function getLiquidityAtTargetUsd(tokenId, profile = null) {
  if (!tokenId) return null;
  const overallStartMs = Date.now();
  const now = Date.now();
  const cached = bookCache.get(tokenId);
  if (profile && typeof profile === 'object') {
    profile.bookCacheHit = null;
    profile.bookCacheAgeMs = null;
    profile.bookMs = null;
    profile.liquidityCalcMs = null;
    profile.asksCount = null;
    profile.levelsAfterFilter = null;
  }

  // Cache hit (y compris null) -> zéro appel réseau CLOB.
  if (cached && now - cached.atMs < BOOK_CACHE_MS) {
    if (profile && typeof profile === 'object') {
      profile.bookCacheHit = true;
      profile.bookCacheAgeMs = now - cached.atMs;
      profile.bookMs = 0;
      profile.liquidityCalcMs = Date.now() - overallStartMs;
    }
    return cached.value;
  }

  try {
    if (profile && typeof profile === 'object') profile.bookCacheHit = false;
    const tBook0 = Date.now();
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 5000 });
    const bookMs = Date.now() - tBook0;
    const asks = data?.asks ?? [];
    if (!Array.isArray(asks) || asks.length === 0) {
      logLiquidityEmptyIfThrottled(tokenId, 'carnet vide (pas d\'asks)');
      bookCache.set(tokenId, { atMs: now, value: null });
      if (profile && typeof profile === 'object') {
        profile.bookMs = bookMs;
        profile.asksCount = Array.isArray(asks) ? asks.length : null;
        profile.levelsAfterFilter = 0;
        profile.liquidityCalcMs = Date.now() - overallStartMs;
      }
      return null;
    }

    const tCalc0 = Date.now();
    const levels = asks.map((level) => {
      const p = parseFloat(level?.price ?? level?.[0] ?? 0);
      const s = parseFloat(level?.size ?? level?.[1] ?? 0);
      return { p, s };
    }).filter(({ p, s }) => Number.isFinite(p) && Number.isFinite(s) && s > 0 && p >= MIN_P && p <= MAX_PRICE_LIQUIDITY);

    if (profile && typeof profile === 'object') {
      profile.bookMs = bookMs;
      profile.asksCount = asks.length;
      profile.levelsAfterFilter = Array.isArray(levels) ? levels.length : null;
    }

    if (levels.length === 0) {
      logLiquidityEmptyIfThrottled(tokenId, `aucun ask dans la plage ${(MIN_P * 100).toFixed(0)}–${(MAX_PRICE_LIQUIDITY * 100).toFixed(1)}%`);
      bookCache.set(tokenId, { atMs: now, value: null });
      if (profile && typeof profile === 'object') {
        profile.liquidityCalcMs = Date.now() - tCalc0;
      }
      return null;
    }
    let totalUsd = 0;
    // Somme cumulée : permet de caper la taille à la liquidité totale jusqu'au plafond 97,5%.
    for (const { p, s } of levels) totalUsd += p * s;
    const out = totalUsd > 0 ? totalUsd : null;
    bookCache.set(tokenId, { atMs: now, value: out });
    if (profile && typeof profile === 'object') {
      profile.liquidityCalcMs = Date.now() - tCalc0;
      profile.bookCacheAgeMs = null;
    }
    return out;
  } catch (err) {
    logLiquidityEmptyIfThrottled(tokenId, `erreur API carnet: ${err?.message || err}`);
    bookCache.set(tokenId, { atMs: now, value: null });
    if (profile && typeof profile === 'object') {
      profile.bookMs = Date.now() - overallStartMs;
      profile.liquidityCalcMs = Date.now() - overallStartMs;
      profile.asksCount = null;
      profile.levelsAfterFilter = null;
    }
    return null;
  }
}

/** Récupère le meilleur ask actuel pour un token (validation avant placement WS). */
async function getBestAsk(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(CLOB_PRICE_URL, { params: { token_id: tokenId, side: 'BUY' }, timeout: 3000 });
    const p = parseFloat(data?.price);
    return Number.isFinite(p) ? p : null;
  } catch (_) {
    return null;
  }
}

/** Pas de trade si l'événement se termine dans moins de X ms (5 min horaire, 4 min 15m). */
function isInLastMinute(signal) {
  const raw = signal?.endDate;
  if (raw == null || raw === '') return false;
  let endMs;
  if (typeof raw === 'number') {
    endMs = raw > 1e12 ? raw : raw * 1000;
  } else {
    endMs = new Date(raw).getTime();
  }
  if (Number.isNaN(endMs)) return false;
  const thresholdMs = MARKET_MODE === '15m' ? NO_TRADE_LAST_MS_15M : NO_TRADE_LAST_MS_HOURLY;
  return Date.now() >= endMs - thresholdMs;
}

/** Récupère les signaux 96,8–97 % depuis l’API Gamma. */
async function fetchSignals() {
  const slugMatch = MARKET_MODE === '15m' ? BITCOIN_UP_DOWN_15M_SLUG : BITCOIN_UP_DOWN_SLUG;
  let events = [];
  const tFetchStartMs = Date.now();
  const profile = {
    totalMs: null,
    strategy: null,
    // Gamma
    directSlugOk: null,
    directSlugMs: null,
    usedEvents: false,
    eventsMsTotal: null,
    eventsRetryUsed: false,
    hasMatchingSlugAfterEvents: null,
    fallbackSlugOk: null,
    fallbackSlugMs: null,
  };

  // Piste latence: sur le mode 15m, éviter le pattern "GET /events (puis fallback /events/slug)".
  // On fetch directement l'event courant par slug pour réduire les timeouts/variance et faire baisser le p95.
  if (MARKET_MODE === '15m') {
    const tDirect0 = Date.now();
    try {
      const slug = getCurrent15mEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        events = [ev];
        logJson('info', 'fetchSignals: direct slug 15m — event reçu', { slug });
        console.log(`[fetchSignals] Direct slug 15m: ${slug} — event reçu`);
        profile.directSlugOk = true;
      } else {
        logJson('info', 'fetchSignals: direct slug 15m — event invalide ou vide', { slug });
        console.log(`[fetchSignals] Direct slug 15m: ${slug} — event invalide ou vide`);
        profile.directSlugOk = false;
      }
      profile.directSlugMs = Date.now() - tDirect0;
    } catch (err) {
      const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
      logJson('info', 'fetchSignals: direct slug 15m — erreur (fallback /events)', { slug: getCurrent15mEventSlug(), error: msg });
      console.log(`[fetchSignals] Direct slug 15m: ${getCurrent15mEventSlug()} — ${msg} (fallback /events)`);
      profile.directSlugOk = false;
      profile.directSlugMs = Date.now() - tDirect0;
    }
  }

  // Si direct slug ne donne rien (ou si on est en mode horaire), on retombe sur la logique historique /events.
  if (events.length === 0) {
    try {
      const tEvents0 = Date.now();
      const { data } = await axios.get(GAMMA_EVENTS_URL, {
        params: { active: true, closed: false, limit: 150, slug_contains: slugMatch },
        timeout: 15000,
      });
      events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
      profile.usedEvents = true;
      profile.eventsMsTotal = Date.now() - tEvents0;
    } catch (err) {
      if (err.response?.status === 422 || err.response?.status === 400) {
        const tEvents1 = Date.now();
        const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 200 }, timeout: 15000 });
        profile.eventsRetryUsed = true;
        profile.eventsMsTotal = (profile.eventsMsTotal ?? 0) + (Date.now() - tEvents1);
        events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
      } else throw err;
    }

    const hasMatchingSlug = events.some((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
    profile.hasMatchingSlugAfterEvents = hasMatchingSlug;
    if (MARKET_MODE === '15m' && !hasMatchingSlug) {
      const tFallback0 = Date.now();
      try {
        const slug = getCurrent15mEventSlug();
        const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
        if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
          events = [ev];
          logJson('info', 'fetchSignals: secours slug 15m — event reçu', { slug });
          console.log(`[fetchSignals] Secours slug 15m: ${slug} — event reçu`);
          profile.fallbackSlugOk = true;
        } else {
          logJson('info', 'fetchSignals: secours slug 15m — event invalide ou vide', { slug });
          console.log(`[fetchSignals] Secours slug 15m: ${slug} — event invalide ou vide`);
          profile.fallbackSlugOk = false;
        }
        profile.fallbackSlugMs = Date.now() - tFallback0;
      } catch (err) {
        const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
        logJson('info', 'fetchSignals: secours slug 15m — erreur', { slug: getCurrent15mEventSlug(), error: msg });
        console.log(`[fetchSignals] Secours slug 15m: ${getCurrent15mEventSlug()} — ${msg}`);
        profile.fallbackSlugOk = false;
        profile.fallbackSlugMs = Date.now() - tFallback0;
      }
    }
    if (MARKET_MODE !== '15m' && !hasMatchingSlug) {
      try {
        // Profil uniquement si on tombe sur la logique hourly fallback slug
        const tFallback0 = Date.now();
        const slug = getCurrentHourlyEventSlug();
        const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
        if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
          events = [ev];
          logJson('info', 'fetchSignals: secours slug horaire — event reçu', { slug });
          console.log(`[fetchSignals] Secours slug horaire: ${slug} — event reçu`);
          profile.fallbackSlugOk = true;
        } else {
          logJson('info', 'fetchSignals: secours slug horaire — event invalide ou vide', { slug });
          console.log(`[fetchSignals] Secours slug horaire: ${slug} — event invalide ou vide`);
          profile.fallbackSlugOk = false;
        }
        profile.fallbackSlugMs = Date.now() - tFallback0;
      } catch (err) {
        const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
        logJson('info', 'fetchSignals: secours slug horaire — erreur', { slug: getCurrentHourlyEventSlug(), error: msg });
        console.log(`[fetchSignals] Secours slug horaire: ${getCurrentHourlyEventSlug()} — ${msg}`);
        profile.fallbackSlugOk = false;
        profile.fallbackSlugMs = Date.now() - tFetchStartMs;
      }
    }
  }
  const results = [];
  for (const ev of events) {
    if (!ev?.markets?.length) continue;
    const eventSlug = (ev.slug ?? '').toLowerCase();
    if (!eventSlug.includes(slugMatch)) continue;
    const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
    for (const m of ev.markets) {
      const prices = parsePrices(m);
      if (!prices) continue;
      const [priceUp, priceDown] = prices;
      const upInRange = priceUp >= MIN_P && priceUp <= MAX_P;
      const downInRange = priceDown >= MIN_P && priceDown <= MAX_P;
      const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
      if (upInRange) {
        results.push({
          market: m,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Up',
          priceUp,
          priceDown,
          tokenIdToBuy: getTokenIdToBuy(m, 'Up'),
          endDate: marketEndDate,
        });
      } else if (downInRange) {
        results.push({
          market: m,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Down',
          priceUp,
          priceDown,
          tokenIdToBuy: getTokenIdToBuy(m, 'Down'),
          endDate: marketEndDate,
        });
      }
    }
  }

  // Synthèse de stratégie pour corréler la latence avec le chemin Gamma pris.
  profile.totalMs = Date.now() - tFetchStartMs;
  if (MARKET_MODE === '15m') {
    if (profile.directSlugOk === true) profile.strategy = 'direct_ok';
    else if (profile.usedEvents && profile.hasMatchingSlugAfterEvents === true) profile.strategy = 'events_ok';
    else if (profile.usedEvents && profile.fallbackSlugOk != null) profile.strategy = 'events_no_match_then_slug';
    else profile.strategy = 'events_empty_or_invalid';
  } else {
    if (profile.usedEvents && profile.hasMatchingSlugAfterEvents === true) profile.strategy = 'events_ok';
    else if (profile.fallbackSlugOk != null) profile.strategy = 'events_no_match_then_slug';
    else profile.strategy = 'events_empty_or_invalid';
  }
  results._fetchSignalsProfile = profile;
  return results;
}

/** Vérifie si l’IP est autorisée à trader (geoblock). */
/** Récupère les token IDs des marchés actifs (Up + Down) pour s'abonner au WebSocket CLOB. Retourne { tokenIds, tokenToSignal }. */
async function getActiveMarketTokensForWs() {
  const slugMatch = MARKET_MODE === '15m' ? BITCOIN_UP_DOWN_15M_SLUG : BITCOIN_UP_DOWN_SLUG;
  let events = [];
  try {
    const { data } = await axios.get(GAMMA_EVENTS_URL, {
      params: { active: true, closed: false, limit: 150, slug_contains: slugMatch },
      timeout: 15000,
    });
    events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 400) {
      const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 200 }, timeout: 15000 });
      events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
    } else throw err;
  }
  const hasMatchingSlug = events.some((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
  if (MARKET_MODE === '15m' && !hasMatchingSlug) {
    try {
      const slug = getCurrent15mEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        events = [ev];
        console.log(`[WS] Secours slug 15m: ${slug} — event reçu`);
      } else {
        console.log(`[WS] Secours slug 15m: ${slug} — event invalide ou vide`);
      }
    } catch (err) {
      const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
      console.log(`[WS] Secours slug 15m: ${getCurrent15mEventSlug()} — ${msg}`);
    }
  }
  if (MARKET_MODE !== '15m' && !hasMatchingSlug) {
    try {
      const slug = getCurrentHourlyEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
        events = [ev];
        console.log(`[WS] Secours slug horaire: ${slug} — event reçu`);
      } else {
        console.log(`[WS] Secours slug horaire: ${slug} — event invalide ou vide`);
      }
    } catch (err) {
      const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
      console.log(`[WS] Secours slug horaire: ${getCurrentHourlyEventSlug()} — ${msg}`);
    }
  }
  const tokenIds = [];
  const tokenToSignal = new Map();
  for (const ev of events) {
    if (!ev?.markets?.length) continue;
    const eventSlug = (ev.slug ?? '').toLowerCase();
    if (!eventSlug.includes(slugMatch)) continue;
    const marketEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
    for (const m of ev.markets) {
      const endDate = m.endDate ?? m.end_date_iso ?? marketEndDate;
      const ids = m.clobTokenIds ?? m.clob_token_ids;
      const tokens = m.tokens;
      const tokenIdUp = Array.isArray(ids) && ids[0] ? String(ids[0]) : (Array.isArray(tokens) && tokens[0]?.token_id ? String(tokens[0].token_id) : null);
      const tokenIdDown = Array.isArray(ids) && ids[1] ? String(ids[1]) : (Array.isArray(tokens) && tokens[1]?.token_id ? String(tokens[1].token_id) : null);
      if (tokenIdUp) {
        tokenIds.push(tokenIdUp);
        tokenToSignal.set(tokenIdUp, { market: m, eventSlug: ev.slug ?? eventSlug, takeSide: 'Up', endDate, tokenIdToBuy: tokenIdUp, priceUp: 0.97, priceDown: 0.03 });
      }
      if (tokenIdDown) {
        tokenIds.push(tokenIdDown);
        tokenToSignal.set(tokenIdDown, { market: m, eventSlug: ev.slug ?? eventSlug, takeSide: 'Down', endDate, tokenIdToBuy: tokenIdDown, priceUp: 0.03, priceDown: 0.97 });
      }
    }
  }
  return { tokenIds: [...new Set(tokenIds)], tokenToSignal };
}

/** Slug du créneau 15m actuel (fin de créneau en s UTC). Aligné sur le dashboard (Math.ceil). L'API Gamma liste ne renvoie souvent pas les events 15m ; on les récupère par slug. */
function getCurrent15mEventSlug() {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotEnd = Math.ceil(nowSec / 900) * 900;
  return `${BITCOIN_UP_DOWN_15M_SLUG}-${slotEnd}`;
}

/** Slug du créneau horaire actuel (heure ET). Format: bitcoin-up-or-down-march-15-2026-4pm-et. */
function getCurrentHourlyEventSlug() {
  const tz = 'America/New_York';
  const d = new Date();
  const month = d.toLocaleString('en-US', { timeZone: tz, month: 'long' }).toLowerCase();
  const day = parseInt(d.toLocaleString('en-US', { timeZone: tz, day: 'numeric' }), 10);
  const year = parseInt(d.toLocaleString('en-US', { timeZone: tz, year: 'numeric' }), 10);
  let hour = parseInt(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  const ampm = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12 || 12;
  return `${BITCOIN_UP_DOWN_SLUG}-${month}-${day}-${year}-${hour}${ampm}-et`;
}

/** Récupère tous les créneaux actifs (15m ou 1h) sans filtre de prix — pour enregistrer la mise max par fenêtre même quand le prix n'est pas dans la fenêtre 97–97,5 %. */
async function fetchActiveWindows() {
  const slugMatch = MARKET_MODE === '15m' ? BITCOIN_UP_DOWN_15M_SLUG : BITCOIN_UP_DOWN_SLUG;
  let events = [];
  try {
    const { data } = await axios.get(GAMMA_EVENTS_URL, {
      params: { active: true, closed: false, limit: 150, slug_contains: slugMatch },
      timeout: 15000,
    });
    events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 400) {
      const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 200 }, timeout: 15000 });
      events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
    } else throw err;
  }
  const hasMatchingSlug = events.some((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
  // Secours : si la liste n'a aucun event qui matche notre slug (API peut ignorer slug_contains), récupérer le créneau actuel par slug.
  if (MARKET_MODE === '15m' && !hasMatchingSlug) {
    try {
      const slug = getCurrent15mEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        events = [ev];
        logJson('info', 'fetchActiveWindows: secours slug 15m — event reçu', { slug });
        console.log(`[Mise max] Secours slug 15m: ${slug} — event reçu`);
      } else {
        console.log(`[Mise max] Secours slug 15m: ${slug} — event invalide ou vide`);
      }
    } catch (err) {
      const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
      logJson('info', 'fetchActiveWindows: secours slug 15m — erreur', { slug: getCurrent15mEventSlug(), error: msg });
      console.log(`[Mise max] Secours slug 15m: ${getCurrent15mEventSlug()} — ${msg}`);
    }
  }
  if (MARKET_MODE !== '15m' && !hasMatchingSlug) {
    try {
      const slug = getCurrentHourlyEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
        events = [ev];
        logJson('info', 'fetchActiveWindows: secours slug horaire — event reçu', { slug });
        console.log(`[Mise max] Secours slug horaire: ${slug} — event reçu`);
      } else {
        console.log(`[Mise max] Secours slug horaire: ${slug} — event invalide ou vide`);
      }
    } catch (err) {
      const msg = err.response?.status === 404 ? 'slug not found' : (err.message || 'erreur');
      logJson('info', 'fetchActiveWindows: secours slug horaire — erreur', { slug: getCurrentHourlyEventSlug(), error: msg });
      console.log(`[Mise max] Secours slug horaire: ${getCurrentHourlyEventSlug()} — ${msg}`);
    }
  }
  const results = [];
  const seenKeys = new Set();
  for (const ev of events) {
    if (!ev?.markets?.length) continue;
    const eventSlug = (ev.slug ?? '').toLowerCase();
    if (!eventSlug.includes(slugMatch)) continue;
    const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
    for (const m of ev.markets) {
      const key = m.conditionId ?? m.condition_id ?? '';
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
      results.push({ market: m, endDate: marketEndDate, key });
    }
  }
  return results;
}

/** Vérifie si l'IP est autorisée à trader (geoblock). */
async function checkGeoblock() {
  try {
    const { data } = await axios.get(GEOBLOCK_URL, { timeout: 10000 });
    if (data?.blocked) {
      console.error(`Geobloc: trading refusé pour cette IP (pays: ${data.country ?? '?'}). Choisis un VPS dans une région autorisée.`);
      return false;
    }
    console.log(`Geoblock OK — IP autorisée (${data?.country ?? '?'} ${data?.region ?? ''}).`);
    return true;
  } catch (err) {
    console.warn('Impossible de vérifier le geoblock:', err.message, '— on continue.');
    return true;
  }
}

/** Récupère et normalise le tick size pour un token donné. */
async function getTickSizeForToken(client, tokenId) {
  try {
    const tickSize = await client.getTickSize(tokenId);
    const str = typeof tickSize === 'string' ? tickSize : tickSize?.minimum_tick_size ?? '0.01';
    const step = Number(str);
    return Number.isFinite(step) && step > 0 ? { str, step } : { str: '0.01', step: 0.01 };
  } catch {
    return { str: '0.01', step: 0.01 };
  }
}

/** Seuil en dessous duquel on ne place jamais (évite les ordres dust). */
const ABSOLUTE_MIN_USD = 0.5;

/** Place un ordre sur le CLOB (marché ou limite), avec retry sur 429 / erreur réseau et kill switch en cas d'erreurs répétées. amountUsd = taille du trade. clientOrNull = client CLOB déjà créé. options.allowBelowMin = true pour accepter une taille < ORDER_SIZE_MIN_USD (ex. plafond liquidité). */
async function placeOrder(signal, amountUsd, clientOrNull = null, options = {}) {
  if (!walletConfigured || !wallet) {
    return { ok: false, error: 'Wallet non configuré. Ajoute PRIVATE_KEY dans .env puis redémarre.' };
  }
  const size = Number(amountUsd) || orderSizeUsd;
  if (size < ABSOLUTE_MIN_USD) {
    return { ok: false, error: `Taille trop faible (${size.toFixed(2)} < ${ABSOLUTE_MIN_USD} USDC min).` };
  }
  if (!options.allowBelowMin && size < orderSizeMinUsd) {
    return { ok: false, error: `Solde insuffisant (${size.toFixed(2)} < ${orderSizeMinUsd} USDC min).` };
  }
  const { tokenIdToBuy, takeSide, priceUp, priceDown } = signal;
  const price = takeSide === 'Down' ? priceDown : priceUp;
  let lastError;
  for (let attempt = 0; attempt < ORDER_RETRY_ATTEMPTS; attempt++) {
    try {
      let client = clientOrNull;
      if (!client) {
        client = await buildClobClientCachedCreds();
      }
      const options = { negRisk: false };

      // Pour les ordres limites : normaliser le tick size et arrondir le prix. Annuler d'abord les ordres existants pour ce marché.
      let roundedPrice = Number(price);
      if (!useMarketOrder) {
        if (signal.market?.conditionId) {
          try {
            await client.cancelMarketOrders(signal.market.conditionId);
          } catch (e) {
            console.warn('cancelMarketOrders échoué (non bloquant):', e.message);
          }
        }
        const { str: tickSizeStr, step } = await getTickSizeForToken(client, tokenIdToBuy);
        options.tickSize = tickSizeStr;
        if (Number.isFinite(roundedPrice) && step > 0) {
          roundedPrice = Math.round(roundedPrice / step) * step;
        }
      }

      if (useMarketOrder) {
        // Worst-price limit : on autorise jusqu'à 97,5c (plafond constant),
        // afin de maximiser le remplissage total (FOK) même si le signal arrive à 97c.
        const worstPrice = MAX_P;
        const userMarketOrder = { tokenID: tokenIdToBuy, amount: size, side: Side.BUY, price: worstPrice };
        const result = await client.createAndPostMarketOrder(userMarketOrder, options, OrderType.FOK);
        consecutiveOrderErrors = 0;
        return { ok: true, orderID: result?.orderID ?? result?.id };
      }
      const userOrder = { tokenID: tokenIdToBuy, price: roundedPrice, size, side: Side.BUY };
      const result = await client.createAndPostOrder(userOrder, options, OrderType.GTC);
      consecutiveOrderErrors = 0;
      return { ok: true, orderID: result?.orderID ?? result?.id };
    } catch (err) {
      lastError = err.message;
      const status = err.response?.status;
      const is429 = status === 429 || String(err.message || status).includes('429');
      const is425 = status === 425; // Matching engine restart (mardi 7h ET, ~90s) — doc Polymarket
      const isRetryable = is429 || is425 || /timeout|network|ECONNRESET/i.test(String(err.message));
      if (is425) console.warn('CLOB: moteur de matching en redémarrage (425), retry…');
      if (isRetryable && attempt < ORDER_RETRY_ATTEMPTS - 1) {
        const delay = ORDER_RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`Tentative ${attempt + 1}/${ORDER_RETRY_ATTEMPTS} échouée, retry dans ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }
  consecutiveOrderErrors += 1;
  if (consecutiveOrderErrors >= 5 && !killSwitchActive) {
    killSwitchActive = true;
    writeHealth({ killSwitchActive: true });
    logJson('error', 'Kill switch activé: trop d’erreurs CLOB consécutives, annulation de tous les ordres.', {
      consecutiveOrderErrors,
      lastError,
    });
    try {
      const client = clientOrNull || new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
      await client.cancelAll();
    } catch (e) {
      console.warn('cancelAll échoué (kill switch):', e.message);
    }
  }
  return { ok: false, error: lastError };
}

/** Tente de placer un ordre pour un signal (appelé par le WebSocket quand best_ask entre dans la fenêtre). Valide le prix côté REST avant de placer, calcule la taille (solde / plafond liquidité), place l'ordre et enregistre. */
async function tryPlaceOrderForSignal(signal) {
  if (!walletConfigured || !autoPlaceEnabled || killSwitchActive || !signal?.tokenIdToBuy) return;
  const t0 = Date.now();
  const timingsMs = { bestAsk: null, creds: null, balance: null, book: null, placeOrder: null };
  const key = getSignalKey(signal);
  if (placedKeys.has(key)) return;
  if (isInLastMinute(signal)) return;
  const tBestAsk0 = Date.now();
  const currentBestAsk = await getBestAsk(signal.tokenIdToBuy);
  timingsMs.bestAsk = Date.now() - tBestAsk0;
  if (currentBestAsk == null || currentBestAsk < MIN_P || currentBestAsk > MAX_P) {
    logJson('info', 'WS: prix hors fenêtre au moment du placement, skip', { tokenId: signal.tokenIdToBuy, bestAsk: currentBestAsk });
    return;
  }
  const signalWithPrice = {
    ...signal,
    priceUp: signal.takeSide === 'Up' ? currentBestAsk : 1 - currentBestAsk,
    priceDown: signal.takeSide === 'Down' ? currentBestAsk : 1 - currentBestAsk,
  };
  let clobClient = null;
  try {
    const tCreds0 = Date.now();
    clobClient = await buildClobClientCachedCreds();
    timingsMs.creds = Date.now() - tCreds0;
  } catch (err) {
    console.warn('WebSocket tryPlace: CLOB client:', err.message);
    return;
  }
  const tBal0 = Date.now();
  const balance = await getUsdcBalanceViaClob(clobClient) ?? await getUsdcBalanceRpc();
  timingsMs.balance = Date.now() - tBal0;
  let amountUsd = useBalanceAsSize ? (balance ?? orderSizeUsd) : orderSizeUsd;
  const tBook0 = Date.now();
  const liquidity = await getLiquidityAtTargetUsd(signal.tokenIdToBuy);
  timingsMs.book = Date.now() - tBook0;
  // Enregistrer la mise max pour cette fenêtre dès qu'on a la liquidité (signal valide), même si on ne placera pas d'ordre (ex. pas de fonds, montant < min).
  if (liquidity != null && liquidity > 0 && !recordedLiquidityWindows.has(key)) {
    appendLiquidityHistory(liquidity);
    const endMs = signal.endDate ? (typeof signal.endDate === 'number' ? (signal.endDate > 1e12 ? signal.endDate : signal.endDate * 1000) : new Date(signal.endDate).getTime()) : Date.now();
    recordedLiquidityWindows.set(key, endMs);
  }
  let allowBelowMin = false;
  if (liquidity != null && liquidity > 0 && useLiquidityCap && amountUsd > liquidity) {
    amountUsd = liquidity;
    allowBelowMin = amountUsd < orderSizeMinUsd;
  }
  if (amountUsd < orderSizeMinUsd && !allowBelowMin) return;
  placedKeys.add(key);
  const tPlace0 = Date.now();
  const result = await placeOrder(signalWithPrice, amountUsd, clobClient, { allowBelowMin });
  timingsMs.placeOrder = Date.now() - tPlace0;
  const time = new Date().toISOString();
  if (result.ok) {
    const latencyMs = Date.now() - t0;
    writeHealth({ lastOrderAt: time, lastOrderSource: 'ws' });
    const orderData = { at: time, takeSide: signalWithPrice.takeSide, amountUsd, conditionId: key, orderID: result.orderID };
    writeLastOrder(orderData);
    appendOrderLog(orderData);
    logJson('info', 'Ordre placé (WS)', { takeSide: signalWithPrice.takeSide, amountUsd, orderID: result.orderID, latencyMs, timingsMs });
    appendTradeLatencyHistory({
      source: 'ws',
      latencyMs,
      timingsMs,
      takeSide: signalWithPrice.takeSide,
      amountUsd,
      conditionId: key,
      tokenId: signalWithPrice.tokenIdToBuy,
      orderID: result.orderID,
    });
    const miseMaxInfo = liquidity != null && liquidity > 0 ? ` | Mise max: ${liquidity.toFixed(0)} $` : '';
    console.log(`[${time}] [WS] Ordre placé ${signalWithPrice.takeSide} — ${amountUsd.toFixed(2)} USDC${miseMaxInfo} — orderID: ${result.orderID} (latence ~${Math.round(latencyMs)} ms)`);
  } else {
    placedKeys.delete(key);
    logJson('error', 'Erreur ordre WS', { takeSide: signalWithPrice.takeSide, error: result.error });
    console.error(`[${time}] [WS] Erreur ${signalWithPrice.takeSide}: ${result.error}`);
  }
}

// ——— Boucle principale ———
const placedKeys = new Set();
/** Fenêtres pour lesquelles on a déjà enregistré un relevé de liquidité (une fois par créneau = montant max par fenêtre pour le dashboard). */
const recordedLiquidityWindows = new Map(); // key (getSignalKey) -> endDateMs (pour purger les anciennes)
/** Dernier enregistrement de liquidité (lors d'un trade) pour aligner le throttle. */
let lastLiquidityRecordTime = 0;

// ——— WebSocket CLOB (temps réel) ———
const wsState = { tokenToSignal: new Map(), tokenIds: [] };
const wsDebounceTimers = new Map(); // assetId -> { timeoutId, signal }
let wsRefreshTimer = null;
let wsPingTimer = null;
let wsReconnectTimer = null;
let clobWs = null;

function sendWsSubscribe(ws, tokenIds) {
  if (!tokenIds?.length || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: tokenIds,
      custom_feature_enabled: true,
    }));
  } catch (err) {
    console.warn('WS send subscribe:', err.message);
  }
}

async function refreshWsSubscriptions(ws) {
  try {
    const { tokenIds, tokenToSignal } = await getActiveMarketTokensForWs();
    wsState.tokenIds = tokenIds;
    wsState.tokenToSignal = tokenToSignal;
    sendWsSubscribe(ws, tokenIds);
  } catch (err) {
    console.warn('WS refresh subscriptions:', err.message);
  }
}

function startClobWs() {
  if (!useWebSocket || !walletConfigured) return;
  try {
    clobWs = new WebSocket(CLOB_WS_URL);
  } catch (err) {
    console.warn('WebSocket create:', err.message);
    wsReconnectTimer = setTimeout(startClobWs, WS_RECONNECT_MS);
    return;
  }
  clobWs.on('open', async () => {
    const at = new Date().toISOString();
    writeHealth({ wsConnected: true, wsLastChangeAt: at, wsLastConnectedAt: at });
    console.log('WebSocket CLOB connecté — abonnement best_bid_ask (temps réel).');
    await refreshWsSubscriptions(clobWs);
    wsRefreshTimer = setInterval(() => refreshWsSubscriptions(clobWs), WS_REFRESH_SUBSCRIPTIONS_MS);
    wsPingTimer = setInterval(() => { if (clobWs?.readyState === WebSocket.OPEN) clobWs.ping(); }, WS_PING_INTERVAL_MS);
  });
  clobWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data?.event_type !== 'best_bid_ask') return;
      const assetId = String(data.asset_id ?? '');
      const bestAsk = parseFloat(data.best_ask);
      if (!assetId || !Number.isFinite(bestAsk) || bestAsk < MIN_P || bestAsk > MAX_P) return;
      const sig = wsState.tokenToSignal.get(assetId);
      if (!sig) return;
      const signal = {
        ...sig,
        priceUp: sig.takeSide === 'Up' ? bestAsk : 1 - bestAsk,
        priceDown: sig.takeSide === 'Down' ? bestAsk : 1 - bestAsk,
      };
      let entry = wsDebounceTimers.get(assetId);
      if (entry) clearTimeout(entry.timeoutId);
      const timeoutId = setTimeout(() => {
        wsDebounceTimers.delete(assetId);
        tryPlaceOrderForSignal(signal);
      }, WS_DEBOUNCE_MS);
      wsDebounceTimers.set(assetId, { timeoutId, signal });
    } catch (_) {}
  });
  clobWs.on('close', () => {
    writeHealth({ wsConnected: false, wsLastChangeAt: new Date().toISOString() });
    if (wsRefreshTimer) clearInterval(wsRefreshTimer);
    if (wsPingTimer) clearInterval(wsPingTimer);
    wsRefreshTimer = null;
    wsPingTimer = null;
    clobWs = null;
    wsReconnectTimer = setTimeout(startClobWs, WS_RECONNECT_MS);
  });
  clobWs.on('error', (err) => {
    console.warn('WebSocket CLOB erreur:', err.message);
  });
}

async function run() {
  const cycleStartMs = Date.now();
  let signalsCount = 0;
  let fetchProfile = null;
  const cycleBookStats = {
    bookCacheHits: 0,
    bookCacheMisses: 0,
    bookMsTotal: 0,
    liquidityCalcMsTotal: 0,
  };

  function bumpCycleBookStats(profile) {
    if (!profile || typeof profile !== 'object') return;
    if (profile.bookCacheHit === true) cycleBookStats.bookCacheHits += 1;
    if (profile.bookCacheHit === false) cycleBookStats.bookCacheMisses += 1;
    if (Number.isFinite(profile.bookMs)) cycleBookStats.bookMsTotal += profile.bookMs;
    if (Number.isFinite(profile.liquidityCalcMs)) cycleBookStats.liquidityCalcMsTotal += profile.liquidityCalcMs;
  }

  try {
    const signals = await fetchSignals();
    fetchProfile = signals?._fetchSignalsProfile ?? null;
    signalsCount = Array.isArray(signals) ? signals.length : 0;
    if (signalsCount === 0) {
      appendSignalDecisionLatencyHistory({
        source: 'poll',
        decisionMs: Date.now() - cycleStartMs,
        reason: 'no_signal',
        mode: MARKET_MODE,
        fetchSignalsTotalMs: fetchProfile?.totalMs ?? null,
        fetchSignalsStrategy: fetchProfile?.strategy ?? null,
        fetchSignalsDirectSlugOk: fetchProfile?.directSlugOk ?? null,
        fetchSignalsDirectSlugMs: fetchProfile?.directSlugMs ?? null,
        fetchSignalsUsedEvents: fetchProfile?.usedEvents ?? null,
        fetchSignalsEventsMsTotal: fetchProfile?.eventsMsTotal ?? null,
        fetchSignalsEventsRetryUsed: fetchProfile?.eventsRetryUsed ?? null,
        fetchSignalsHasMatchingSlugAfterEvents: fetchProfile?.hasMatchingSlugAfterEvents ?? null,
        fetchSignalsFallbackSlugOk: fetchProfile?.fallbackSlugOk ?? null,
        fetchSignalsFallbackSlugMs: fetchProfile?.fallbackSlugMs ?? null,
      });
    }

    // Relevé du montant max (liquidité à 97 %) pour chaque fenêtre, même sans trade — une fois par créneau pour avoir la moyenne "mise max par fenêtre".
    const liquidityCutoff = Date.now() - LIQUIDITY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    for (const [key, endMs] of recordedLiquidityWindows) {
      if (endMs < liquidityCutoff) recordedLiquidityWindows.delete(key);
    }
    // Enregistrer la mise max pour tous les créneaux actifs (sans filtre de prix) pour avoir des données même quand le prix n'est jamais dans 97–97,5 %.
    try {
      const activeWindows = await fetchActiveWindows();
      logJson('info', 'fetchActiveWindows: créneaux actifs', { count: activeWindows.length, mode: MARKET_MODE });
      console.log(`[Mise max] Créneaux actifs: ${activeWindows.length} (mode ${MARKET_MODE})`);
      for (const { market: m, endDate, key } of activeWindows) {
        if (recordedLiquidityWindows.has(key)) continue;
        const endMs = endDate ? (typeof endDate === 'number' ? (endDate > 1e12 ? endDate : endDate * 1000) : new Date(endDate).getTime()) : Date.now();
        const tokenUp = getTokenIdToBuy(m, 'Up');
        const tokenDown = getTokenIdToBuy(m, 'Down');
        const liqProfileUp = {};
        const liqProfileDown = {};
        const liqUp = tokenUp ? await getLiquidityAtTargetUsd(tokenUp, liqProfileUp) : null;
        const liqDown = tokenDown ? await getLiquidityAtTargetUsd(tokenDown, liqProfileDown) : null;
        bumpCycleBookStats(tokenUp ? liqProfileUp : null);
        bumpCycleBookStats(tokenDown ? liqProfileDown : null);
        const liquidity = Math.max(liqUp ?? 0, liqDown ?? 0);
        const liqLog = liquidity > 0 ? liquidity.toFixed(0) : (liquidity === 0 ? '0' : 'null');
        logJson('info', 'Mise max créneau', { key: key?.slice(0, 18) + '…', liquidityUsd: liquidity > 0 ? liquidity : null });
        console.log(`[Mise max] Créneau ${key?.slice(0, 20)}… → liquidité: ${liqLog} USD`);
        if (liquidity > 0) {
          appendLiquidityHistory(liquidity);
          recordedLiquidityWindows.set(key, endMs);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (err) {
      console.warn('Relevé mise max (créneaux actifs):', err?.message ?? err);
    }
    // B) "signal -> décision" (max 3 par cycle pour éviter le spam)
    let decisionLogged = 0;
    for (const s of signals) {
      if (!s.tokenIdToBuy) continue;
      const key = getSignalKey(s);
      if (recordedLiquidityWindows.has(key)) continue;
      let endMs = Date.now();
      if (s.endDate) {
        const raw = s.endDate;
        endMs = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
      }
      try {
        const liquidityProfile = {};
        const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy, liquidityProfile);
        bumpCycleBookStats(liquidityProfile);
        if (liquidity != null && liquidity > 0) {
          appendLiquidityHistory(liquidity);
          recordedLiquidityWindows.set(key, endMs);
        } else {
          console.warn('Mise max non enregistrée: pas de profondeur au prix du marché (0.97–0.975) pour ce créneau (ou erreur API CLOB).');
        }
        if (decisionLogged < 3) {
          appendSignalDecisionLatencyHistory({
            source: 'poll',
            decisionMs: Date.now() - cycleStartMs,
            reason: liquidity != null && liquidity > 0 ? 'liquidity_ok' : 'liquidity_null',
            tokenId: s.tokenIdToBuy,
            conditionId: key,
            takeSide: s.takeSide,
            mode: MARKET_MODE,
            // Profil Gamma: quel chemin a été choisi pour trouver l'event.
            fetchSignalsTotalMs: fetchProfile?.totalMs ?? null,
            fetchSignalsStrategy: fetchProfile?.strategy ?? null,
            fetchSignalsDirectSlugOk: fetchProfile?.directSlugOk ?? null,
            fetchSignalsDirectSlugMs: fetchProfile?.directSlugMs ?? null,
            fetchSignalsUsedEvents: fetchProfile?.usedEvents ?? null,
            fetchSignalsEventsMsTotal: fetchProfile?.eventsMsTotal ?? null,
            fetchSignalsEventsRetryUsed: fetchProfile?.eventsRetryUsed ?? null,
            fetchSignalsHasMatchingSlugAfterEvents: fetchProfile?.hasMatchingSlugAfterEvents ?? null,
            fetchSignalsFallbackSlugOk: fetchProfile?.fallbackSlugOk ?? null,
            fetchSignalsFallbackSlugMs: fetchProfile?.fallbackSlugMs ?? null,
            // Profil CLOB /book + calcul liquidité
            bookCacheHit: liquidityProfile.bookCacheHit ?? null,
            bookCacheAgeMs: liquidityProfile.bookCacheAgeMs ?? null,
            bookMs: liquidityProfile.bookMs ?? null,
            liquidityCalcMs: liquidityProfile.liquidityCalcMs ?? null,
            asksCount: liquidityProfile.asksCount ?? null,
            levelsAfterFilter: liquidityProfile.levelsAfterFilter ?? null,
          });
          decisionLogged += 1;
        }
      } catch (err) {
        console.warn('Erreur relevé liquidité par fenêtre (ignorée pour le cycle):', err?.message ?? err);
      }
      await new Promise((r) => setTimeout(r, 150)); // éviter de surcharger l'API CLOB
    }

    if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) return;

    // Redeem des tokens gagnants (marchés résolus) en USDC pour que le solde inclue les gains au prochain trade
    await tryRedeemResolvedPositions();

    // Client CLOB une fois par cycle : solde via API balance-allowance (doc Polymarket), plus d’erreur RPC "could not detect network"
    let clobClient = null;
    try {
      clobClient = await buildClobClientCachedCreds();
    } catch (err) {
      warnClobClientIfThrottled(err);
    }

    async function getBalance() {
      const viaClob = clobClient ? await getUsdcBalanceViaClob(clobClient) : null;
      if (viaClob != null) return viaClob;
      return getUsdcBalanceRpc();
    }

    let amountUsd = orderSizeUsd;
    if (useBalanceAsSize) {
      const viaClob = clobClient ? await getUsdcBalanceViaClob(clobClient) : null;
      const balance = viaClob != null ? viaClob : await getUsdcBalanceRpc();
      amountUsd = balance != null ? balance : orderSizeUsd;
      // Un log par cycle pour vérifier clé + solde (CLOB = bonne config, RPC = secours, null = secours ORDER_SIZE_USD)
      if (viaClob != null) console.log(`Solde USDC: ${balance.toFixed(2)} (API CLOB)`);
      else if (balance != null) console.log(`Solde USDC: ${balance.toFixed(2)} (RPC secours)`);
      else console.warn('Solde USDC: CLOB + RPC indisponibles — utilisation de ORDER_SIZE_USD en secours.');
      writeBalance(balance);
      if (amountUsd < orderSizeMinUsd) return;
    } else {
      const balanceForStatus = await getBalance();
      writeBalance(balanceForStatus);
    }

    for (const s of signals) {
    if (!s.tokenIdToBuy) continue;
    if (isInLastMinute(s)) continue;
    const key = getSignalKey(s);
    if (placedKeys.has(key)) continue;
    const t0 = Date.now();
    const timingsMs = { bestAsk: 0, creds: 0, balance: null, book: null, placeOrder: null };

    if (useBalanceAsSize) {
      const tBal0 = Date.now();
      const balance = await getBalance();
      timingsMs.balance = Date.now() - tBal0;
      amountUsd = balance != null ? balance : orderSizeUsd;
      if (amountUsd < orderSizeMinUsd) break;
    }

    let allowBelowMin = false;
    const tBook0 = Date.now();
    const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy);
    timingsMs.book = Date.now() - tBook0;
    if (liquidity != null && liquidity > 0) {
      if (!recordedLiquidityWindows.has(key)) {
        appendLiquidityHistory(liquidity);
        const endMs = s.endDate ? (typeof s.endDate === 'number' ? (s.endDate > 1e12 ? s.endDate : s.endDate * 1000) : new Date(s.endDate).getTime()) : Date.now();
        recordedLiquidityWindows.set(key, endMs);
      }
      lastLiquidityRecordTime = Date.now();
      if (useLiquidityCap && amountUsd > liquidity) {
        amountUsd = liquidity;
        allowBelowMin = amountUsd < orderSizeMinUsd;
        console.log(`Mise plafonnée à ${amountUsd.toFixed(2)} $ (mise max au prix du marché) pour garder avg price = prix du marché${allowBelowMin ? ' (sous min, ordre quand même)' : ''}`);
      }
    } else if (liquidity === null || liquidity === 0) {
      console.warn('Mise max au prix du marché non disponible pour ce créneau (book CLOB ou erreur API)');
    }

    placedKeys.add(key);
    const tPlace0 = Date.now();
    const result = await placeOrder(s, amountUsd, clobClient, { allowBelowMin });
    timingsMs.placeOrder = Date.now() - tPlace0;
    const time = new Date().toISOString();
    if (result.ok) {
      const latencyMs = Date.now() - t0;
      writeHealth({ lastOrderAt: time, lastOrderSource: 'poll' });
      const orderData = { at: time, takeSide: s.takeSide, amountUsd, conditionId: key, orderID: result.orderID };
      writeLastOrder(orderData);
      appendOrderLog(orderData);
      logJson('info', 'Ordre placé', { takeSide: s.takeSide, amountUsd, orderID: result.orderID, latencyMs, timingsMs });
      appendTradeLatencyHistory({
        source: 'poll',
        latencyMs,
        timingsMs,
        takeSide: s.takeSide,
        amountUsd,
        conditionId: key,
        tokenId: s.tokenIdToBuy,
        orderID: result.orderID,
      });
      const miseMaxInfo = liquidity != null && liquidity > 0 ? ` | Mise max au prix du marché : ${liquidity.toFixed(0)} $` : '';
      console.log(`[${time}] Ordre placé ${s.takeSide} — ${amountUsd.toFixed(2)} USDC${miseMaxInfo} — ${key?.slice(0, 10)}… — orderID: ${result.orderID} (latence ~${Math.round(latencyMs)} ms)`);
    } else {
      logJson('error', 'Erreur ordre', { takeSide: s.takeSide, error: result.error });
      console.error(`[${time}] Erreur ${s.takeSide}: ${result.error}`);
    }
    await new Promise((r) => setTimeout(r, 350));
    }
  } finally {
    appendCycleLatencyHistory({
      cycleMs: Date.now() - cycleStartMs,
      ok: true,
      mode: MARKET_MODE,
      signalsCount,
      fetchSignalsTotalMs: fetchProfile?.totalMs ?? null,
      fetchSignalsStrategy: fetchProfile?.strategy ?? null,
      bookCacheHits: cycleBookStats.bookCacheHits,
      bookCacheMisses: cycleBookStats.bookCacheMisses,
      bookMsTotal: cycleBookStats.bookMsTotal,
      liquidityCalcMsTotal: cycleBookStats.liquidityCalcMsTotal,
    });
  }
}

async function main() {
  console.log('Bot Polymarket Bitcoin Up or Down — démarrage 24/7');
  console.log(`Marché: ${MARKET_MODE === '15m' ? '15 min (btc-updown-15m)' : 'horaire (bitcoin-up-or-down)'} | Pas de trade: ${MARKET_MODE === '15m' ? '4 min avant fin' : '5 min avant fin'}`);
  if (walletConfigured && wallet) {
    const sizeMode = useBalanceAsSize ? 'taille = solde USDC (réinvestissement)' : `fixe ${orderSizeUsd} USDC`;
    console.log(`Wallet: ${wallet.address} | Auto: ${autoPlaceEnabled} | Ordre: ${useMarketOrder ? 'marché' : 'limite'} | ${sizeMode} | Poll: ${pollIntervalSec}s`);
    if (useWebSocket) console.log('WebSocket CLOB activé (best_bid_ask) — réaction en temps réel aux changements de prix.');
    if (useLiquidityCap) console.log('Règle : si solde > mise max au prix du marché, ordre plafonné à la mise max pour conserver avg price = prix du marché (USE_LIQUIDITY_CAP=true).');
  } else {
    console.log('Wallet: non configuré — pas de placement d’ordres. Ajoute PRIVATE_KEY dans .env puis redémarre (pm2 restart polymarket-bot).');
  }
  if (walletConfigured && !autoPlaceEnabled) {
    console.log('AUTO_PLACE_ENABLED=false — le bot tourne sans placer d\'ordres.');
  }

  const allowed = await checkGeoblock();
  writeHealth({ geoblockOk: !!allowed });
  if (!allowed) {
    process.exit(1);
  }
  console.log('—');

  if (useWebSocket) startClobWs();

  const pollMs = pollIntervalSec * 1000;
  for (;;) {
    try {
      await run();
    } catch (err) {
      logJson('error', 'Erreur boucle', { error: err.message });
      console.error(new Date().toISOString(), 'Erreur boucle:', err.message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main();
