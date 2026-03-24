/**
 * Bot Polymarket Bitcoin Up or Down — exécution 24/7 (Node.js)
 *
 * Étapes :
 * 1. Connexion wallet Polygon (clé privée)
 * 2. Boucle : récupérer les signaux Gamma (prix dans MIN_SIGNAL_P–MAX_SIGNAL_P, défaut 97–98 %)
 * 3. Pour chaque signal : respect des fenêtres « pas de trade » (15m = quart d’heure ET comme le dashboard ; 1h = 5 min avant fin) → placer ordre CLOB (marché ou limite)
 * 4. Ne pas placer deux fois pour le même créneau (mémorisation par conditionId)
 * 5. Au début de chaque cycle : redeem positions résolues → USDC (EOA ou relayer si proxy/Safe + clés Relayer ou Builder)
 *
 * Usage : npm install && PRIVATE_KEY=0x... npm start
 * Config : .env (voir .env.example)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { encodeFunctionData, zeroHash } from 'viem';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import WebSocket from 'ws';
import axios from 'axios';
import { get15mSlotEntryTimingDetail, is15mSlotEntryTimeForbiddenNow } from './et15mEntryTiming.js';
import {
  mergeGammaEventMarketForUpDown,
  getAlignedUpDownGammaPrices,
  getAlignedUpDownTokenIds,
  getTokenIdForSide,
} from './gammaUpDownOrder.js';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_MS = 5000;
const WS_REFRESH_SUBSCRIPTIONS_MS = 30 * 1000;
const WS_PING_INTERVAL_MS = 10 * 1000; // doc Polymarket : garder la connexion alive
const WS_DEBOUNCE_MS = Number(process.env.WS_DEBOUNCE_MS) || 300; // évite rafales d'ordres sur même token
const CREDS_CACHE_TTL_MS = Number(process.env.CREDS_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const ENABLE_HEARTBEAT = process.env.ENABLE_HEARTBEAT === 'true';
/** Cache de pré-signature : create + sign en avance, seul le POST au moment du trade. TTL 60s. */
const PRE_SIGN_CACHE_TTL_MS = Number(process.env.PRE_SIGN_CACHE_TTL_MS) || 60 * 1000;
const preSignCache = new Map(); // key -> { signedOrder, expiresAt }

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
/** `conditionId` déjà redeemés avec succès (évite de retenter indéfiniment ; remplit le bot au fil des trades). */
const REDEEMED_CONDITION_IDS_FILE = path.join(BOT_DIR, 'redeemed-condition-ids.json');
const BALANCE_HISTORY_MAX = 500;
const LIQUIDITY_HISTORY_DAYS = 3;
const TRADE_LATENCY_HISTORY_DAYS = 7;
const TRADE_LATENCY_HISTORY_MAX = 2000;
const CYCLE_LATENCY_HISTORY_DAYS = 7;
const CYCLE_LATENCY_HISTORY_MAX = 5000;
const SIGNAL_DECISION_LATENCY_HISTORY_DAYS = 7;
const SIGNAL_DECISION_LATENCY_HISTORY_MAX = 10000;

// Assure que le fichier existe pour que le dashboard puisse agréger même si aucun trade n'a encore eu lieu.
function ensureJsonArrayFileExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
  } catch (_) {}
}
ensureJsonArrayFileExists(TRADE_LATENCY_HISTORY_FILE);
ensureJsonArrayFileExists(REDEEMED_CONDITION_IDS_FILE);

// Cache Gamma (évite de retaper l'API Gamma deux fois par cycle : fetchSignals + fetchActiveWindows).
const GAMMA_EVENTS_CACHE_MS = Number(process.env.GAMMA_EVENTS_CACHE_MS) || 4000;
const gammaEventsCache = new Map(); // cacheKey -> { expiresAt, events, profile }

/** Compteur / throttle pour ne pas saturer stderr si bot.log reste injoignable. */
let botLogAppendFailCount = 0;
let botLogAppendLastStderrMs = 0;
const BOT_LOG_APPEND_STDERR_THROTTLE_MS = 60 * 1000;

/** Log structuré JSON (une ligne par événement) dans bot.log pour analyse ou envoi vers un outil de log. */
function logJson(level, message, meta = {}) {
  try {
    rotateBotJsonLogIfNeeded();
    fs.appendFileSync(BOT_JSON_LOG_FILE, JSON.stringify({ level, message, ts: new Date().toISOString(), ...meta }) + '\n', 'utf8');
  } catch (e) {
    botLogAppendFailCount += 1;
    const now = Date.now();
    if (now - botLogAppendLastStderrMs >= BOT_LOG_APPEND_STDERR_THROTTLE_MS || botLogAppendFailCount === 1) {
      botLogAppendLastStderrMs = now;
      console.error(
        '[bot.log] Écriture impossible (vérifie permissions / disque / inode).',
        'path=',
        BOT_JSON_LOG_FILE,
        'code=',
        e?.code,
        'message=',
        e?.message,
        'failCount=',
        botLogAppendFailCount,
      );
    }
  }
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

function readLastOrder() {
  try {
    return JSON.parse(fs.readFileSync(LAST_ORDER_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Met à jour health.json (lu par status-server pour /api/bot-status). Fusionne updates avec l'état existant. */
function writeHealth(updates) {
  try {
    let state = {
      wsConnected: false,
      wsLastChangeAt: null,
      wsLastConnectedAt: null,
      wsLastBidAskAt: null,
      lastOrderAt: null,
      lastOrderSource: null,
      geoblockOk: null,
      killSwitchActive: false,
      polymarketDegraded: false,
      degradedReason: null,
      degradedUntil: null,
      staleWsData: false,
      staleWsDataAt: null,
      executionDelayed: false,
      executionDelayedAt: null,
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
// Fenêtre de prix pour signaux et mise max : 97 % – 98 % (override MIN_SIGNAL_P / MAX_SIGNAL_P dans .env).
const MIN_P = Number(process.env.MIN_SIGNAL_P) || 0.97;
const MAX_P = Number(process.env.MAX_SIGNAL_P) || 0.98;
const MAX_PRICE_LIQUIDITY = Number(process.env.MAX_PRICE_LIQUIDITY) || 0.98;
/**
 * Plafond worst price pour les ordres marché BUY (prix max accepté pour le matching), ex. 0.99 = 99¢.
 * Indépendant de MAX_SIGNAL_P (fenêtre de détection du signal, ex. 97–98 %).
 */
const marketWorstPricePRaw = Number(process.env.MARKET_WORST_PRICE_P);
let marketWorstPriceP = Number.isFinite(marketWorstPricePRaw) && marketWorstPricePRaw > 0 ? marketWorstPricePRaw : 0.99;
marketWorstPriceP = Math.min(0.99, Math.max(0.01, marketWorstPriceP));
/**
 * Comportement à l’envoi (doc Polymarket CLOB) :
 * - FOK : tout le montant doit être rempli immédiatement, sinon annulé.
 * - FAK : remplir immédiatement tout ce qui est possible au worst price, annuler le reste (partiel OK).
 */
const marketOrderTif = (process.env.MARKET_ORDER_TIF || 'FAK').trim().toUpperCase();
const marketOrderType = marketOrderTif === 'FOK' ? OrderType.FOK : OrderType.FAK;
const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';
/** Fin de fenêtre 15m (ms UTC) : suffixe slug = `eventStart` Gamma → fin = start + 900 s (comme le dashboard). */
function slotEndMsFrom15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const raw = parseInt(m[1], 10);
  if (!Number.isFinite(raw)) return null;
  const startSec = raw < 1e12 ? raw : Math.floor(raw / 1000);
  return (startSec + 900) * 1000;
}
const NO_TRADE_LAST_MS_HOURLY = 5 * 60 * 1000; // 5 min avant la fin pour le marché horaire

/** hourly = créneaux 1h (bitcoin-up-or-down), 15m = créneaux 15 min (btc-updown-15m). Défaut hourly. */
const MARKET_MODE = (process.env.MARKET_MODE || 'hourly').toLowerCase() === '15m' ? '15m' : 'hourly';

// Cache /book : plus long sur 15m pour réduire variance/ratelimits (overridable via BOOK_CACHE_MS).
const BOOK_CACHE_MS = Number(process.env.BOOK_CACHE_MS) || (MARKET_MODE === '15m' ? 3000 : 1500);

/**
 * Prix utilisés pour décider si fetchSignals() émet un signal (poll).
 * - gamma : outcomePrices Gamma (lissé / mid, défaut historique 1h).
 * - clob : best ask CLOB par token Up/Down (aligné exécution, défaut auto pour MARKET_MODE=15m).
 * Défaut si non défini : 15m → clob, hourly → gamma. Override : SIGNAL_PRICE_SOURCE=gamma|clob
 */
const signalPriceSourceEnv = (process.env.SIGNAL_PRICE_SOURCE || '').trim().toLowerCase();
const signalPriceSource =
  signalPriceSourceEnv === 'gamma' || signalPriceSourceEnv === 'clob'
    ? signalPriceSourceEnv
    : MARKET_MODE === '15m'
      ? 'clob'
      : 'gamma';
/** Cache court best ask pour fetchSignals (évite 2 hits CLOB identiques dans le même cycle). */
const BEST_ASK_SIGNAL_CACHE_MS = Number(process.env.BEST_ASK_SIGNAL_CACHE_MS) || 400;

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
/** Ankr public sans clé renvoie souvent 401 — utiliser une URL avec clé ou retirer Ankr d’ici. */
const polygonRpcFallbacks = (
  process.env.POLYGON_RPC_FALLBACK ||
  'https://polygon-rpc.com,https://polygon-bor-rpc.publicnode.com'
)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
/** Montant minimum pour placer un ordre (USDC). En dessous, on skip. Défaut 1. */
const orderSizeMinUsd = Number(process.env.ORDER_SIZE_MIN_USD) || 1;
/** Si true, la taille de chaque ordre = solde USDC du wallet (réinvestissement des gains). Sinon ordre fixe ORDER_SIZE_USD. */
const useBalanceAsSize = process.env.USE_BALANCE_AS_SIZE !== 'false';
const orderSizeUsd = Number(process.env.ORDER_SIZE_USD) || 10;
/**
 * Plafond fixe de taille d'ordre (USDC), appliqué après solde / liquidité.
 * Remplace l'intérêt de la « mise max » carnet si USE_LIQUIDITY_CAP / USE_AVG_PRICE_SIZING sont désactivés.
 * Désactivé si absent, NaN ou ≤ 0.
 */
const maxStakeUsd = Number(process.env.MAX_STAKE_USD);
const hasMaxStakeUsd = Number.isFinite(maxStakeUsd) && maxStakeUsd > 0;
/** Enregistrer liquidity-history.json (dashboard « mise max »). true = activer (désactivé par défaut avec FAK / sans plafond carnet). */
const recordLiquidityHistory = process.env.RECORD_LIQUIDITY_HISTORY === 'true';

function applyMaxStakeUsd(amountUsd) {
  const x = Number(amountUsd);
  if (!Number.isFinite(x) || x <= 0) return x;
  if (!hasMaxStakeUsd) return x;
  return Math.min(x, maxStakeUsd);
}
/** Ordre au marché par défaut (exécution immédiate, latence min). USE_MARKET_ORDER=false pour ordre limite. */
const useMarketOrder = process.env.USE_MARKET_ORDER !== 'false';
/**
 * Si FAK ne remplit qu’une partie du stake, ré-envoyer uniquement le reliquat (même worst price / FAK),
 * avec délai entre envois et plafond de tentatives / fenêtre temps. PARTIAL_FILL_RETRY=false pour désactiver.
 * Inactif si ordre limite ou FOK.
 */
const partialFillRetryEnabled =
  useMarketOrder &&
  marketOrderType === OrderType.FAK &&
  process.env.PARTIAL_FILL_RETRY !== 'false';
const PARTIAL_FILL_RETRY_MAX_EXTRA = Math.max(0, Math.min(50, Number(process.env.PARTIAL_FILL_RETRY_MAX_EXTRA) || 5));
const PARTIAL_FILL_RETRY_DELAY_MS = Math.max(0, Number(process.env.PARTIAL_FILL_RETRY_DELAY_MS) || 400);
const PARTIAL_FILL_RETRY_MAX_WINDOW_MS = Math.max(500, Number(process.env.PARTIAL_FILL_RETRY_MAX_WINDOW_MS) || 15000);
const PARTIAL_FILL_RETRY_MIN_REMAINING_USD = Math.max(0.01, Number(process.env.PARTIAL_FILL_RETRY_MIN_REMAINING_USD) || 0.5);
/** Si true : entre deux compléments, vérifie que le best ask CLOB est encore dans [MIN_P, MAX_P] (sinon arrêt). */
const partialFillRetryRevalidatePrice = process.env.PARTIAL_FILL_RETRY_REVALIDATE_PRICE === 'true';
const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC) || 1;
/** Placer les ordres en auto (défaut: true). Mettre à false pour faire tourner le bot sans trader. */
/** Autotrade désactivé par défaut — les deux bots (1h / 15m) doivent avoir AUTO_PLACE_ENABLED=true pour placer des ordres. */
const autoPlaceEnabled = process.env.AUTO_PLACE_ENABLED === 'true';
/** Garde-fou: couper la position avant résolution si le bid du côté acheté passe sous un seuil absolu. */
const stopLossEnabled = process.env.STOP_LOSS_ENABLED !== 'false';
const stopLossTriggerPriceP = Math.max(0.01, Math.min(0.99, Number(process.env.STOP_LOSS_TRIGGER_PRICE_P) || 0.75));
/** Option hybride: déclenchement aussi sur drawdown max fixe (en %) depuis le prix d’entrée. */
const stopLossMaxDrawdownPct = Math.max(1, Math.min(95, Number(process.env.STOP_LOSS_MAX_DRAWDOWN_PCT) || 30));
/** Prix mini accepté pour une vente stop-loss au marché (évite une exécution à 0). */
const stopLossWorstPriceP = Math.max(0.001, Math.min(0.99, Number(process.env.STOP_LOSS_WORST_PRICE_P) || 0.01));
/** Délai mini après entrée avant d'armer le stop-loss (évite les déclenchements instantanés). */
const STOP_LOSS_MIN_HOLD_MS = Math.max(0, Number(process.env.STOP_LOSS_MIN_HOLD_MS) || 10_000);
/** Backoff entre tentatives stop-loss sur le même conditionId. */
const STOP_LOSS_RETRY_BACKOFF_MS = Math.max(5_000, Number(process.env.STOP_LOSS_RETRY_BACKOFF_MS) || 20_000);
/** Tenter de redeem les tokens gagnants (marchés résolus) en USDC au début de chaque cycle. Sinon le solde ne inclut pas les gains tant qu'on n'a pas redeem. */
const redeemEnabled = process.env.REDEEM_ENABLED !== 'false';
/**
 * N’essaie pas le redeem avant `fin du marché (Gamma) + N ms` pour ce `conditionId` (évite STATE_FAILED tout de suite après la cloche).
 * Défaut si non défini : **60_000 ms (1 min) en MARKET_MODE=15m**, **0** en hourly. `REDEEM_AFTER_MARKET_END_MS=0` désactive.
 */
const redeemAfterMarketEndMsRaw = process.env.REDEEM_AFTER_MARKET_END_MS;
const REDEEM_AFTER_MARKET_END_MS =
  redeemAfterMarketEndMsRaw !== undefined && String(redeemAfterMarketEndMsRaw).trim() !== ''
    ? Math.max(0, Number(redeemAfterMarketEndMsRaw) || 0)
    : MARKET_MODE === '15m'
      ? 60_000
      : 0;
/** Si true : plafonner la taille d’ordre sur la liquidité MIN_P–MAX_PRICE_LIQUIDITY (désactivé par défaut ; avec FAK + worst price, inutile en général). */
const useLiquidityCap = process.env.USE_LIQUIDITY_CAP === 'true';
/**
 * Si true (défaut), refuse l'ordre si le scénario « victoire » ne rapporte pas strictement plus USDC que la mise
 * (marché binaire : encaissement ≈ mise / prix, donc exiger prix < 1 $). Protège contre prix corrompu / MAX_P=1.
 * Ordre marché : prix conservateur = MARKET_WORST_PRICE_P (pire exécution acceptée, ex. 98¢). Ordre limite : prix signal clamp [MIN_P, MAX_P].
 * REQUIRE_WIN_GROSS_GAIN_GUARD=false pour désactiver.
 */
const requireWinGrossGainGuard = process.env.REQUIRE_WIN_GROSS_GAIN_GUARD !== 'false';
/** Gain brut minimum si victoire (USDC), en plus de encaissement > mise. Défaut 0. */
const minWinGrossProfitUsd = Number(process.env.MIN_WIN_GROSS_PROFIT_USD) || 0;
// Si true (défaut), la mise max est enregistrée uniquement au moment où un signal est détecté/évalué,
// pas via le relevé périodique des créneaux actifs.
const recordMiseMaxOnSignalOnly = process.env.RECORD_MISE_MAX_ON_SIGNAL_ONLY !== 'false';
/**
 * Sizing « avg constrained » (désactivé par défaut). Si true : taille max pour garder un avg <= bestAsk + tol.
 * USE_AVG_PRICE_SIZING=true pour réactiver (legacy).
 */
const useAvgPriceSizing = process.env.USE_AVG_PRICE_SIZING === 'true';
/** Tolérance en delta de prix (ex: 0.0005 = 0,05c) pour éviter que l'avg devienne trop strict. */
const avgPriceTolP = Number(process.env.AVG_PRICE_TOL_P) || 0.0005;
/** Nombre d'itérations de binary search pour trouver la taille max (USD). */
const avgPriceBinIters = Number(process.env.AVG_PRICE_BIN_ITERS) || 25;
/** Appels carnet / liquidité « mise max » : seulement si historique ou plafonds legacy activés (évite la latence sinon). */
const needLiquidityBook = recordLiquidityHistory || useLiquidityCap || useAvgPriceSizing;
/**
 * Si true : à chaque fetchSignals (poll), log JSON `signal_visibility_poll` avec les prix Up/Down **tels que le bot les voit**,
 * même hors [MIN_P, MAX_P], + indicateurs « serait dans la fenêtre stratégie ? » et « timing interdit maintenant ? ».
 * Utile pour vérifier que Gamma/CLOB répondent sans attendre un vrai signal. Throttle : SIGNAL_VISIBILITY_LOG_MS (défaut 10 s).
 */
const signalVisibilityLog = process.env.SIGNAL_VISIBILITY_LOG === 'true';
const SIGNAL_VISIBILITY_LOG_MS = Math.max(2000, Number(process.env.SIGNAL_VISIBILITY_LOG_MS) || 10_000);
let signalVisibilityLogLastAt = 0;
/** Réagir en temps réel aux changements de prix via WebSocket CLOB (best_bid_ask). USE_WEBSOCKET=false pour ne faire que du polling. */
const useWebSocket = process.env.USE_WEBSOCKET !== 'false';
/** Garde-fous incidents Polymarket (retards prix/exécution/balance). */
const incidentDegradedModeEnabled = process.env.INCIDENT_DEGRADED_MODE !== 'false';
const incidentBehavior = (process.env.INCIDENT_DEGRADED_BEHAVIOR || 'pause').trim().toLowerCase() === 'reduced' ? 'reduced' : 'pause';
const incidentErrorThreshold = Math.max(1, Number(process.env.INCIDENT_ERROR_THRESHOLD) || 4);
const incidentErrorWindowMs = Math.max(5000, Number(process.env.INCIDENT_ERROR_WINDOW_MS) || 45_000);
const incidentDurationMs = Math.max(5000, Number(process.env.INCIDENT_DURATION_MS) || 120_000);
const degradedSizeFactor = Math.min(1, Math.max(0.05, Number(process.env.DEGRADED_SIZE_FACTOR) || 0.25));
const wsFreshnessMaxMs = Math.max(500, Number(process.env.WS_FRESHNESS_MAX_MS) || 3000);
const wsPriceMismatchMaxP = Math.max(0.0001, Number(process.env.WS_PRICE_MISMATCH_MAX_P) || 0.0015); // 0.15c
const executionErrorCooldownMinMs = Math.max(1000, Number(process.env.EXECUTION_ERROR_COOLDOWN_MIN_MS) || 15_000);
const executionErrorCooldownMaxMs = Math.max(executionErrorCooldownMinMs, Number(process.env.EXECUTION_ERROR_COOLDOWN_MAX_MS) || 60_000);
const executionDelayAlertMs = Math.max(1000, Number(process.env.EXECUTION_DELAY_ALERT_MS) || 5000);
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
 * Type de wallet CLOB (doc Polymarket / @polymarket/clob-client) :
 * 0 = EOA (signer = adresse qui trade, pas de funder séparé),
 * 1 = POLY_PROXY (compte email / Magic — l’adresse « Profil » du site est le proxy / funder),
 * 2 = GNOSIS_SAFE (Safe — souvent l’adresse affichée sur le profil).
 *
 * Si ton adresse Polymarket (Paramètres → Profil) ≠ l’adresse dérivée de PRIVATE_KEY :
 * mets CLOB_SIGNATURE_TYPE=1 ou 2 selon le type de compte, et CLOB_FUNDER_ADDRESS = exactement
 * l’adresse affichée sur polymarket.com (sinon les trades partent sur un autre compte).
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
/** Redeem gasless via relayer Polymarket (doc : builders / relayer) — nécessaire si les positions sont sur le proxy (Magic), pas sur l’EOA. */
const POLY_BUILDER_API_KEY = process.env.POLY_BUILDER_API_KEY?.trim();
const POLY_BUILDER_SECRET = process.env.POLY_BUILDER_SECRET?.trim();
const POLY_BUILDER_PASSPHRASE = process.env.POLY_BUILDER_PASSPHRASE?.trim();
/** Auth alternative (Paramètres → Clés API du Relayer) — doc : submit transaction relayer. */
const RELAYER_API_KEY = process.env.RELAYER_API_KEY?.trim();
const RELAYER_API_KEY_ADDRESS = process.env.RELAYER_API_KEY_ADDRESS?.trim();
const POLY_RELAYER_URL = (process.env.POLY_RELAYER_URL || 'https://relayer-v2.polymarket.com').replace(/\/$/, '');
const redeemViaRelayerEnv = (process.env.REDEEM_VIA_RELAYER || '').trim().toLowerCase();

function hasPolyBuilderCreds() {
  return !!(POLY_BUILDER_API_KEY && POLY_BUILDER_SECRET && POLY_BUILDER_PASSPHRASE);
}

function hasRelayerApiCreds() {
  return !!(RELAYER_API_KEY && RELAYER_API_KEY_ADDRESS);
}

/** Builder HMAC **ou** clés Relayer (même API HTTP). */
function hasRelayerSubmitAuth() {
  return hasPolyBuilderCreds() || hasRelayerApiCreds();
}

/**
 * Patch le client SDK : sans BuilderConfig, `sendAuthedRequest` n’envoyait aucun header ;
 * la doc Polymarket accepte RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS à la place.
 */
function attachRelayerApiKeyAuth(relayClient, apiKey, apiKeyAddress) {
  relayClient.sendAuthedRequest = async function (method, path, body) {
    if (this.canBuilderAuth()) {
      const builderHeaders = await this._generateBuilderHeaders(method, path, body);
      if (builderHeaders !== undefined) {
        return this.send(path, method, { headers: builderHeaders, data: body });
      }
    }
    return this.send(path, method, {
      data: body,
      headers: {
        RELAYER_API_KEY: apiKey,
        RELAYER_API_KEY_ADDRESS: apiKeyAddress,
      },
    });
  };
}

/** true = utiliser le relayer ; false = redeem EOA uniquement. Auto = Proxy/Safe + (creds Builder **ou** clés Relayer). */
function shouldRedeemViaRelayer() {
  if (redeemViaRelayerEnv === 'false') return false;
  const can = hasRelayerSubmitAuth() && (CLOB_SIGNATURE_TYPE === 1 || CLOB_SIGNATURE_TYPE === 2);
  if (redeemViaRelayerEnv === 'true') return can;
  return can;
}

function relayerTxTypeForClob() {
  if (CLOB_SIGNATURE_TYPE === 1) return RelayerTxType.PROXY;
  if (CLOB_SIGNATURE_TYPE === 2) return RelayerTxType.SAFE;
  return null;
}

/** Throttle logs « redeem relayer sans succès » par conditionId (défaut : 10 min). */
const redeemRelayerNoSuccessLogAt = new Map();
const REDEEM_NO_SUCCESS_LOG_MS = Math.max(
  60_000,
  Number(process.env.REDEEM_NO_SUCCESS_LOG_MS) || 600_000
);

function shouldLogRedeemRelayerNoSuccess(cid) {
  const now = Date.now();
  const prev = redeemRelayerNoSuccessLogAt.get(cid) || 0;
  if (now - prev < REDEEM_NO_SUCCESS_LOG_MS) return false;
  redeemRelayerNoSuccessLogAt.set(cid, now);
  return true;
}

/** Après échec redeem, prochain essai pour ce `conditionId` pas avant N ms (défaut 2 min — laisse l’oracle CTF rattraper la nuit). */
const REDEEM_FAIL_BACKOFF_MS = Math.max(30_000, Number(process.env.REDEEM_FAIL_BACKOFF_MS) || 120_000);
const redeemFailNextAttemptAt = new Map(); // conditionId -> timestamp ms

/** @type {Set<string> | null} */
let redeemedConditionIdsSet = null;

function getRedeemedConditionIdsSet() {
  if (redeemedConditionIdsSet) return redeemedConditionIdsSet;
  redeemedConditionIdsSet = new Set();
  try {
    const raw = fs.readFileSync(REDEEMED_CONDITION_IDS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const x of arr) {
        const s = String(x || '').trim();
        if (s) redeemedConditionIdsSet.add(s);
      }
    }
  } catch (_) {}
  return redeemedConditionIdsSet;
}

/** `REDEEM_SKIP_CONDITION_IDS=0xabc,0xdef` — skip permanent (ex. claim manuel déjà fait, tu ajoutes le conditionId). */
function isRedeemSkippedByEnv(cid) {
  const raw = process.env.REDEEM_SKIP_CONDITION_IDS || '';
  if (!raw.trim()) return false;
  const key = String(cid || '').trim();
  for (const p of raw.split(',')) {
    if (p.trim() === key) return true;
  }
  return false;
}

function markConditionRedeemedSuccess(cid) {
  const key = String(cid || '').trim();
  if (!key) return;
  const set = getRedeemedConditionIdsSet();
  if (set.has(key)) return;
  set.add(key);
  redeemFailNextAttemptAt.delete(key);
  redeemRelayerNoSuccessLogAt.delete(key);
  try {
    const sorted = [...set].sort();
    fs.writeFileSync(REDEEMED_CONDITION_IDS_FILE, JSON.stringify(sorted, null, 0) + '\n', 'utf8');
  } catch (e) {
    console.warn('[Redeem] écriture redeemed-condition-ids.json impossible:', e?.message || e);
  }
}

function noteRedeemFailureBackoff(cid) {
  redeemFailNextAttemptAt.set(String(cid), Date.now() + REDEEM_FAIL_BACKOFF_MS);
}

function canAttemptRedeemNow(cid) {
  const t = redeemFailNextAttemptAt.get(String(cid)) || 0;
  return Date.now() >= t;
}

let redeemRelayerMisconfigLogged = false;
function logRedeemRelayerMisconfigOnce(msg) {
  if (redeemRelayerMisconfigLogged) return;
  redeemRelayerMisconfigLogged = true;
  console.warn('[Redeem relayer]', msg);
  try {
    logJson('warn', 'Redeem relayer misconfig', { message: msg });
  } catch (_) {}
}

/** @type {RelayClient | null | undefined} undefined = pas encore tenté */
let relayClientCache;

function createRelayClientForRedeem() {
  if (!walletConfigured || !privateKey) return null;
  const rtx = relayerTxTypeForClob();
  if (!rtx || !hasRelayerSubmitAuth()) return null;
  const pkHex = /** @type {`0x${string}`} */ (privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
  const account = privateKeyToAccount(pkHex);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(polygonRpc),
  });
  let builderConfig;
  if (hasPolyBuilderCreds()) {
    builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: POLY_BUILDER_API_KEY,
        secret: POLY_BUILDER_SECRET,
        passphrase: POLY_BUILDER_PASSPHRASE,
      },
    });
  }
  const client = new RelayClient(POLY_RELAYER_URL, CHAIN_ID, walletClient, builderConfig, rtx);
  if (hasRelayerApiCreds() && !hasPolyBuilderCreds()) {
    attachRelayerApiKeyAuth(client, RELAYER_API_KEY, RELAYER_API_KEY_ADDRESS);
  }
  const signerAddr = walletClient.account?.address?.toLowerCase?.();
  const keyAddr = RELAYER_API_KEY_ADDRESS?.toLowerCase?.();
  if (hasRelayerApiCreds() && signerAddr && keyAddr && signerAddr !== keyAddr) {
    console.warn(
      `[Redeem relayer] RELAYER_API_KEY_ADDRESS (${RELAYER_API_KEY_ADDRESS}) ≠ signer PRIVATE_KEY (${walletClient.account.address}). La clé Relayer doit appartenir au même signataire que le bot.`
    );
  }
  return client;
}

function getRelayClientForRedeem() {
  if (relayClientCache !== undefined) return relayClientCache;
  try {
    relayClientCache = createRelayClientForRedeem();
    if (relayClientCache) {
      const auth = hasPolyBuilderCreds() ? 'Builder HMAC' : 'Relayer API key';
      console.log(
        `[Redeem] Relayer Polymarket activé (${CLOB_SIGNATURE_TYPE === 1 ? 'PROXY' : 'SAFE'}, auth: ${auth}) — ${POLY_RELAYER_URL}`
      );
    }
  } catch (err) {
    logRedeemRelayerMisconfigOnce(`Init RelayClient impossible : ${err?.message || err}`);
    relayClientCache = null;
  }
  return relayClientCache;
}

const CTF_REDEEM_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
];

const ORDER_RETRY_ATTEMPTS = 3;
const ORDER_RETRY_BASE_MS = 1000;
let consecutiveOrderErrors = 0;
let killSwitchActive = false;
let degradedModeUntilMs = 0;
let degradedModeReason = null;
const incidentErrorTimes = [];
const executionCooldownByCondition = new Map(); // conditionId/eventSlug -> nextAllowedAtMs
const stopLossNextAttemptByCondition = new Map(); // conditionId -> timestamp ms
let wsLastBidAskAtMs = 0;
const lastSkipReasonThrottle = new Map(); // reason|source -> ts

function recordSkipReason(reason, source = 'unknown', details = {}) {
  const r = String(reason || 'unknown_skip');
  const s = String(source || 'unknown');
  const now = Date.now();
  const key = `${r}|${s}`;
  const prev = lastSkipReasonThrottle.get(key);
  if (prev && now - prev < 2000) return;
  lastSkipReasonThrottle.set(key, now);
  const safeDetails = {};
  if (details && typeof details === 'object') {
    if (details.conditionId) safeDetails.conditionId = String(details.conditionId).slice(0, 120);
    if (details.tokenId) safeDetails.tokenId = String(details.tokenId).slice(0, 120);
    if (Number.isFinite(Number(details.remainingMs))) safeDetails.remainingMs = Math.round(Number(details.remainingMs));
    if (details.timingBlock) safeDetails.timingBlock = String(details.timingBlock).slice(0, 40);
    if (Number.isFinite(Number(details.timingOffsetSec))) safeDetails.timingOffsetSec = Math.round(Number(details.timingOffsetSec));
    if (details.takeSide === 'Up' || details.takeSide === 'Down') safeDetails.takeSide = details.takeSide;
    if (Number.isFinite(Number(details.bestAskP))) safeDetails.bestAskP = Math.round(Number(details.bestAskP) * 1e6) / 1e6;
  }
  const skipAtIso = new Date(now).toISOString();
  const skipDetails = Object.keys(safeDetails).length ? safeDetails : null;
  /** `lastSkipReason` est écrasé par tout autre skip ; ce bloc reste consultable après coup (ex. fin de créneau). */
  const healthPayload = {
    lastSkipReason: r,
    lastSkipSource: s,
    lastSkipAt: skipAtIso,
    lastSkipDetails: skipDetails,
  };
  if (r === 'timing_forbidden') {
    healthPayload.lastTimingForbiddenSkip = {
      at: skipAtIso,
      source: s,
      details: skipDetails,
    };
  }
  writeHealth(healthPayload);
}

function getSignalKey(signal) {
  return signal.market?.conditionId ?? signal.eventSlug ?? '';
}

/** Prix “best ask” du côté acheté (Up = priceUp, Down = priceDown) pour logs / garde-fous. */
function pickSignalBestAskP(signal) {
  if (!signal?.takeSide) return null;
  const p = signal.takeSide === 'Down' ? signal.priceDown : signal.priceUp;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

const SIGNAL_IN_RANGE_NO_ORDER_LOG_MS = Math.max(1000, Number(process.env.SIGNAL_IN_RANGE_NO_ORDER_LOG_MS) || 5000);
const signalInRangeNoOrderThrottle = new Map(); // key -> ts

/**
 * Une ligne PM2 + entrée JSONL bot.log quand un prix est dans [MIN_P, MAX_P] mais aucun ordre n’est placé.
 * Throttle par (source, reason, conditionId|token).
 */
function logSignalInRangeButNoOrder(source, reason, signal, fields = {}) {
  if (!signal || typeof signal !== 'object') return;
  const bestAskP =
    fields.bestAskP != null && Number.isFinite(Number(fields.bestAskP))
      ? Number(fields.bestAskP)
      : pickSignalBestAskP(signal);
  if (bestAskP == null || bestAskP < MIN_P || bestAskP > MAX_P) return;
  const cond = getSignalKey(signal) || signal.tokenIdToBuy || 'na';
  const throttleKey = `${source}|${reason}|${cond}`;
  const now = Date.now();
  const prev = signalInRangeNoOrderThrottle.get(throttleKey);
  if (prev && now - prev < SIGNAL_IN_RANGE_NO_ORDER_LOG_MS) return;
  signalInRangeNoOrderThrottle.set(throttleKey, now);
  const { bestAskP: _drop, ...restFields } = fields;
  const payload = {
    source,
    reason,
    bestAskP: Math.round(bestAskP * 1e6) / 1e6,
    minP: MIN_P,
    maxP: MAX_P,
    takeSide: signal.takeSide,
    conditionId: String(getSignalKey(signal) || '').slice(0, 120),
    tokenId: signal.tokenIdToBuy ? String(signal.tokenIdToBuy).slice(0, 32) : null,
    ...restFields,
  };
  logJson('info', 'signal_in_range_but_no_order', payload);
  try {
    console.log(`[signal_in_range_but_no_order] ${JSON.stringify(payload)}`);
  } catch (_) {}
}

function isRetryableExecutionError(errLike) {
  const msg = String(errLike?.message || errLike || '').toLowerCase();
  const status = Number(errLike?.response?.status);
  if (status === 425 || status === 429 || status >= 500) return true;
  return /timeout|network|econn|socket|temporar|gateway|service unavailable|internal server error/.test(msg);
}

function isInsufficientBalanceOrAllowanceError(errLike) {
  const msg = String(errLike?.message || errLike || '').toLowerCase();
  const status = Number(errLike?.response?.status);
  if (status !== 400 && status !== 422 && !msg) return false;
  return /not enough balance|insufficient balance|allowance|insufficient funds|size too large/.test(msg);
}

function computeExecutionCooldownMs(errLike) {
  const msg = String(errLike?.message || errLike || '').toLowerCase();
  const status = Number(errLike?.response?.status);
  if (status === 425) return executionErrorCooldownMaxMs;
  if (status === 429) return Math.min(executionErrorCooldownMaxMs, Math.max(executionErrorCooldownMinMs, 30_000));
  if (/timeout|econn|network|gateway|service unavailable|internal server error/.test(msg)) {
    return executionErrorCooldownMaxMs;
  }
  return executionErrorCooldownMinMs;
}

function setExecutionCooldown(conditionKey, errLike) {
  if (!conditionKey) return;
  const now = Date.now();
  const cooldownMs = computeExecutionCooldownMs(errLike);
  const untilMs = now + cooldownMs;
  executionCooldownByCondition.set(conditionKey, untilMs);
  logJson('warn', 'Cooldown exécution activé', { conditionId: conditionKey, cooldownMs, until: new Date(untilMs).toISOString() });
}

function getExecutionCooldownRemainingMs(conditionKey) {
  if (!conditionKey) return 0;
  const untilMs = executionCooldownByCondition.get(conditionKey);
  if (!Number.isFinite(untilMs)) return 0;
  const remaining = untilMs - Date.now();
  if (remaining <= 0) {
    executionCooldownByCondition.delete(conditionKey);
    return 0;
  }
  return remaining;
}

function setPolymarketDegraded(reason, durationMs = incidentDurationMs) {
  if (!incidentDegradedModeEnabled) return;
  const untilMs = Date.now() + Math.max(1000, durationMs);
  degradedModeUntilMs = Math.max(degradedModeUntilMs, untilMs);
  degradedModeReason = String(reason || 'incident');
  writeHealth({
    polymarketDegraded: true,
    degradedReason: degradedModeReason,
    degradedUntil: new Date(degradedModeUntilMs).toISOString(),
  });
}

function clearPolymarketDegradedIfExpired() {
  if (!degradedModeUntilMs) return;
  if (Date.now() < degradedModeUntilMs) return;
  degradedModeUntilMs = 0;
  degradedModeReason = null;
  writeHealth({ polymarketDegraded: false, degradedReason: null, degradedUntil: null });
}

function inPolymarketDegradedMode() {
  clearPolymarketDegradedIfExpired();
  return degradedModeUntilMs > Date.now();
}

function notePolymarketIncidentError(source, errLike) {
  const now = Date.now();
  incidentErrorTimes.push(now);
  while (incidentErrorTimes.length && now - incidentErrorTimes[0] > incidentErrorWindowMs) incidentErrorTimes.shift();
  if (incidentErrorTimes.length >= incidentErrorThreshold) {
    setPolymarketDegraded(`${source}_errors_spike`, incidentDurationMs);
  }
}

/** Clé de cache pour un ordre pré-signé (même signal + même montant). */
function getPreSignCacheKey(signal, amountUsd) {
  const key = getSignalKey(signal);
  const tokenId = signal?.tokenIdToBuy ?? '';
  const amount = Number(amountUsd);
  const amt = Number.isFinite(amount) ? amount.toFixed(2) : '0';
  const wp = Number.isFinite(marketWorstPriceP) ? marketWorstPriceP.toFixed(4) : '0';
  const tif = marketOrderType === OrderType.FOK ? 'FOK' : 'FAK';
  return `${key}|${tokenId}|${amt}|${wp}|${tif}`;
}

/** Purge les entrées expirées du cache de pré-signature. */
function purgeExpiredPreSignCache() {
  const now = Date.now();
  for (const [k, v] of preSignCache.entries()) {
    if (v.expiresAt <= now) preSignCache.delete(k);
  }
}

/**
 * Crée et signe un ordre marché (sans le poster). Centralise la partie "signature" pour pouvoir,
 * plus tard, la déplacer dans un worker_thread si les mesures montrent un pic de latence ici.
 */
async function createSignedMarketOrder(client, userMarketOrder) {
  return client.createMarketOrder(userMarketOrder, { negRisk: false });
}

/** Taille max du JSON `clobResponse` dans last-order / orders.log (évite fichiers énormes). */
const CLOB_RESPONSE_LOG_MAX_JSON = Number(process.env.CLOB_RESPONSE_LOG_MAX_JSON) || 12000;

/**
 * Copie profonde « safe » de la réponse POST /order pour audit (tronque chaînes / tableaux / profondeur).
 * Inclut tout champ supplémentaire renvoyé par le CLOB (ex. fills) même s’il n’est pas dans l’OpenAPI.
 */
function serializeClobPostOrderResponseForLog(body) {
  if (!body || typeof body !== 'object') return null;
  const seen = new WeakSet();
  const walk = (x, depth) => {
    if (depth > 5) return '[max-depth]';
    if (x === null || typeof x === 'boolean' || typeof x === 'number') return x;
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'string') return x.length > 400 ? `${x.slice(0, 400)}…` : x;
    if (Array.isArray(x)) {
      const max = 50;
      const arr = x.slice(0, max).map((el) => walk(el, depth + 1));
      if (x.length > max) arr.push(`…+${x.length - max} more`);
      return arr;
    }
    if (typeof x === 'object') {
      if (seen.has(x)) return '[circular]';
      seen.add(x);
      const o = {};
      let i = 0;
      for (const [k, v] of Object.entries(x)) {
        if (i++ > 80) {
          o._truncatedKeys = true;
          break;
        }
        o[k] = walk(v, depth + 1);
      }
      return o;
    }
    return String(x);
  };
  try {
    const serialized = walk(body, 0);
    const str = JSON.stringify(serialized);
    if (str.length > CLOB_RESPONSE_LOG_MAX_JSON) {
      return {
        _jsonTruncated: true,
        _approxBytes: str.length,
        head: str.slice(0, Math.min(4000, CLOB_RESPONSE_LOG_MAX_JSON)),
      };
    }
    return serialized;
  } catch (e) {
    return { _serializeError: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Parse la réponse POST /order (SendOrderResponse Polymarket).
 * makingAmount / takingAmount : fixed-point 6 décimales (chaîne ou nombre).
 * Pour un BUY : maker paie USDC → makingAmount = USDC ; takingAmount = tokens outcome.
 */
function parsePolymarketPostOrderFill(responseBody, { orderSide = Side.BUY, requestedUsd = null } = {}) {
  const out = {
    clobStatus: null,
    clobSuccess: null,
    filledUsdc: null,
    filledOutcomeTokens: null,
    fillRatio: null,
    averageFillPriceP: null,
    tradeIDs: undefined,
    transactionsHashes: undefined,
    clobErrorMsg: null,
  };
  if (!responseBody || typeof responseBody !== 'object') return out;

  const raw6ToFloat = (v) => {
    if (v == null || v === '') return null;
    const s = typeof v === 'bigint' ? v.toString() : String(v);
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n / 1e6;
  };

  const rawMake = responseBody.makingAmount ?? responseBody.making_amount;
  const rawTake = responseBody.takingAmount ?? responseBody.taking_amount;
  if (orderSide === Side.BUY) {
    out.filledUsdc = raw6ToFloat(rawMake);
    out.filledOutcomeTokens = raw6ToFloat(rawTake);
  } else {
    out.filledOutcomeTokens = raw6ToFloat(rawMake);
    out.filledUsdc = raw6ToFloat(rawTake);
  }

  if (requestedUsd != null && requestedUsd > 0 && out.filledUsdc != null && out.filledUsdc >= 0) {
    out.fillRatio = Math.min(2, out.filledUsdc / requestedUsd);
    out.fillRatio = Math.round(out.fillRatio * 10000) / 10000;
  }

  // Prix moyen effectif (VWAP) : USDC / tokens ; ou champ API s’il existe un jour.
  const apiAvgRaw =
    responseBody.averagePrice ??
    responseBody.average_price ??
    responseBody.avgPrice ??
    responseBody.avg_price ??
    responseBody.price ??
    null;
  if (apiAvgRaw != null && apiAvgRaw !== '') {
    const n = Number(typeof apiAvgRaw === 'bigint' ? apiAvgRaw.toString() : apiAvgRaw);
    if (Number.isFinite(n) && n > 0) {
      // Heuristique : valeurs > 1 traitées comme fixed-point 6 déc (comme making/taking), sinon probabilité 0–1.
      out.averageFillPriceP = n > 1 ? n / 1e6 : n;
    }
  }
  if (
    out.averageFillPriceP == null &&
    out.filledUsdc != null &&
    out.filledOutcomeTokens != null &&
    out.filledUsdc > 0 &&
    out.filledOutcomeTokens > 0
  ) {
    out.averageFillPriceP = Math.round((out.filledUsdc / out.filledOutcomeTokens) * 1e8) / 1e8;
  }

  out.clobStatus = typeof responseBody.status === 'string' ? responseBody.status : null;
  out.clobSuccess = typeof responseBody.success === 'boolean' ? responseBody.success : null;
  out.clobErrorMsg = responseBody.errorMsg || responseBody.error_msg || null;
  if (Array.isArray(responseBody.tradeIDs)) out.tradeIDs = responseBody.tradeIDs;
  else if (Array.isArray(responseBody.trade_ids)) out.tradeIDs = responseBody.trade_ids;
  if (Array.isArray(responseBody.transactionsHashes)) out.transactionsHashes = responseBody.transactionsHashes;
  else if (Array.isArray(responseBody.transactions_hashes)) out.transactionsHashes = responseBody.transactions_hashes;

  return out;
}

/** Champs remplissage à fusionner dans order log / JSON (évite les undefined). */
function pickFillFieldsForLog(fill) {
  if (!fill) return {};
  const o = {};
  if (fill.clobStatus != null) o.clobStatus = fill.clobStatus;
  if (fill.clobSuccess != null) o.clobSuccess = fill.clobSuccess;
  if (fill.filledUsdc != null) o.filledUsdc = fill.filledUsdc;
  if (fill.filledOutcomeTokens != null) o.filledOutcomeTokens = fill.filledOutcomeTokens;
  if (fill.fillRatio != null) o.fillRatio = fill.fillRatio;
  if (fill.averageFillPriceP != null) o.averageFillPriceP = fill.averageFillPriceP;
  if (fill.tradeIDs?.length) o.tradeIDs = fill.tradeIDs;
  if (fill.transactionsHashes?.length) o.transactionsHashes = fill.transactionsHashes;
  if (fill.clobErrorMsg) o.clobErrorMsg = fill.clobErrorMsg;
  if (fill.clobResponse != null) o.clobResponse = fill.clobResponse;
  if (Array.isArray(fill.clobResponses) && fill.clobResponses.length) o.clobResponses = fill.clobResponses;
  return o;
}

function formatFillConsoleSuffix(placeResult) {
  if (!placeResult?.ok) return '';
  if (placeResult.filledUsdc == null) return '';
  const pct = placeResult.fillRatio != null ? ` (${(placeResult.fillRatio * 100).toFixed(1)} % du montant demandé)` : '';
  const st = placeResult.clobStatus ? ` [CLOB: ${placeResult.clobStatus}]` : '';
  const avg =
    placeResult.averageFillPriceP != null && Number.isFinite(placeResult.averageFillPriceP)
      ? ` @ ~${(placeResult.averageFillPriceP * 100).toFixed(2)}¢`
      : '';
  return ` — exécuté ~${placeResult.filledUsdc.toFixed(2)} USDC${avg}${pct}${st}`;
}

/** Token CLOB pour acheter Up ou Down — indices alignés sur les libellés Gamma (souvent Down, Up). */
function getTokenIdToBuy(market, takeSide) {
  return getTokenIdForSide(market, takeSide);
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

/** Solde réellement utilisable via CLOB: min(balance, allowance) si allowance présent. */
async function getUsdcSpendableViaClob(client) {
  if (!client) return null;
  try {
    const out = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const rawBalance = out?.balance ?? out?.balance_raw;
    const rawAllowance = out?.allowance ?? out?.allowance_raw;
    const balanceNum = rawBalance == null ? null : (typeof rawBalance === 'string' ? Number(rawBalance) : rawBalance);
    const allowanceNum = rawAllowance == null ? null : (typeof rawAllowance === 'string' ? Number(rawAllowance) : rawAllowance);
    const balanceUsdc = Number.isFinite(balanceNum) ? balanceNum / 1e6 : null;
    const allowanceUsdc = Number.isFinite(allowanceNum) ? allowanceNum / 1e6 : null;
    if (balanceUsdc == null && allowanceUsdc == null) return null;
    if (balanceUsdc == null) return allowanceUsdc;
    if (allowanceUsdc == null) return balanceUsdc;
    return Math.max(0, Math.min(balanceUsdc, allowanceUsdc));
  } catch (_) {
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

/** Parse `endDate` Gamma / ISO (même logique que liquidité / timing). */
function parseMarketEndDateToMs(endDate) {
  if (endDate == null || endDate === '') return null;
  if (typeof endDate === 'number') {
    return endDate > 1e12 ? endDate : endDate * 1000;
  }
  const t = new Date(endDate).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
}

async function tryStopLossForOpenPosition(clobClient) {
  if (!stopLossEnabled || !walletConfigured || !wallet || !clobClient) return;
  const last = readLastOrder();
  if (!last || typeof last !== 'object') return;
  if (last.stopLossExit === true) return;
  const conditionId = String(last.conditionId || '').trim();
  const tokenId = String(last.tokenId || '').trim();
  const takeSide = last.takeSide === 'Up' || last.takeSide === 'Down' ? last.takeSide : null;
  if (!conditionId || !tokenId || !takeSide) return;

  const endMs = parseMarketEndDateToMs(last.marketEndMs ?? last.endDate);
  if (!Number.isFinite(endMs) || Date.now() >= endMs) return;
  const enteredAtMs = last?.at ? new Date(last.at).getTime() : null;
  if (Number.isFinite(enteredAtMs) && Date.now() - enteredAtMs < STOP_LOSS_MIN_HOLD_MS) return;

  const nextAllowed = stopLossNextAttemptByCondition.get(conditionId) || 0;
  if (Date.now() < nextAllowed) return;

  const entryPriceRaw = Number(last.averageFillPriceP);
  const entryPriceP = Number.isFinite(entryPriceRaw) && entryPriceRaw > 0 ? entryPriceRaw : null;
  if (!(entryPriceP > 0)) return;

  const bestBid = await getBestBid(tokenId);
  if (!(bestBid > 0 && bestBid < 1)) return;

  const drawdownPct = ((bestBid - entryPriceP) / entryPriceP) * 100;
  const triggerByPrice = bestBid < stopLossTriggerPriceP;
  const triggerByDrawdown = drawdownPct <= -Math.abs(stopLossMaxDrawdownPct);
  if (!triggerByPrice && !triggerByDrawdown) return;

  let tokensToSell = Number(last.filledOutcomeTokens);
  if (!(Number.isFinite(tokensToSell) && tokensToSell > 0)) {
    const stakeUsd = Number(last.filledUsdc ?? last.amountUsd);
    if (Number.isFinite(stakeUsd) && stakeUsd > 0) {
      tokensToSell = stakeUsd / entryPriceP;
    }
  }
  if (!(Number.isFinite(tokensToSell) && tokensToSell > 0)) return;

  try {
    const userMarketOrder = {
      tokenID: tokenId,
      amount: tokensToSell,
      side: Side.SELL,
      price: stopLossWorstPriceP,
    };
    const signedOrder = await createSignedMarketOrder(clobClient, userMarketOrder);
    const result = await clobClient.postOrder(signedOrder, marketOrderType);
    const fill = parsePolymarketPostOrderFill(result, { orderSide: Side.SELL, requestedUsd: null });
    const clobResponse = serializeClobPostOrderResponseForLog(result);
    const nowIso = new Date().toISOString();
    const exitOrder = {
      at: nowIso,
      conditionId,
      tokenId,
      takeSide,
      orderID: result?.orderID ?? result?.id,
      stopLossExit: true,
      stopLossTriggerPriceP: Math.round(stopLossTriggerPriceP * 1e6) / 1e6,
      stopLossMaxDrawdownPct: -Math.abs(stopLossMaxDrawdownPct),
      stopLossTriggerReason: triggerByPrice ? 'price_below_threshold' : 'drawdown_limit',
      stopLossObservedDrawdownPct: Math.round(drawdownPct * 100) / 100,
      stopLossEntryPriceP: Math.round(entryPriceP * 1e6) / 1e6,
      stopLossBestBidP: Math.round(bestBid * 1e6) / 1e6,
      marketEndMs: endMs,
      clobSignerAddress: wallet?.address ?? null,
      clobSignatureType: CLOB_SIGNATURE_TYPE,
      clobFunderAddress: clobFunderAddress ?? null,
      ...pickFillFieldsForLog({ clobResponse, ...fill }),
    };
    writeLastOrder(exitOrder);
    appendOrderLog(exitOrder);
    stopLossNextAttemptByCondition.delete(conditionId);
    executionCooldownByCondition.set(conditionId, endMs + 60_000);
    logJson('warn', 'Stop-loss déclenché: sortie avant résolution', {
      conditionId: conditionId.slice(0, 18) + '…',
      takeSide,
      drawdownPct: Math.round(drawdownPct * 100) / 100,
      triggerPriceP: Math.round(stopLossTriggerPriceP * 1e6) / 1e6,
      maxDrawdownPct: -Math.abs(stopLossMaxDrawdownPct),
      triggerReason: triggerByPrice ? 'price_below_threshold' : 'drawdown_limit',
      entryPriceP: Math.round(entryPriceP * 1e6) / 1e6,
      bestBidP: Math.round(bestBid * 1e6) / 1e6,
      orderID: result?.orderID ?? result?.id,
    });
    console.warn(
      `[${nowIso}] [STOP-LOSS] Sortie ${takeSide} avant résolution — ${
        triggerByPrice
          ? `bid ${(bestBid * 100).toFixed(2)}¢ < seuil ${(stopLossTriggerPriceP * 100).toFixed(2)}¢`
          : `drawdown ${drawdownPct.toFixed(2)}% <= -${Math.abs(stopLossMaxDrawdownPct)}%`
      }`
    );
  } catch (err) {
    stopLossNextAttemptByCondition.set(conditionId, Date.now() + STOP_LOSS_RETRY_BACKOFF_MS);
    notePolymarketIncidentError('stop_loss_exit', err);
    logJson('warn', 'Stop-loss: échec sortie', {
      conditionId: conditionId.slice(0, 18) + '…',
      error: String(err?.message || err).slice(0, 220),
    });
  }
}

/**
 * Dernière `marketEndMs` connue par `conditionId` (orders.log puis last-order écrase).
 * Rempli pour les trades **après** déploiement du champ ; sinon redeem sans ce garde-fou.
 */
function getLatestMarketEndMsByConditionId() {
  /** @type {Map<string, number>} */
  const map = new Map();
  function consider(obj) {
    if (!obj || typeof obj !== 'object') return;
    const cid = String(obj.conditionId ?? obj.condition_id ?? '').trim();
    if (!cid) return;
    let ms = null;
    if (obj.marketEndMs != null && Number.isFinite(Number(obj.marketEndMs))) {
      ms = Number(obj.marketEndMs);
    }
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return;
    map.set(cid, ms);
  }
  try {
    const raw = fs.readFileSync(ORDERS_LOG_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        consider(JSON.parse(trimmed));
      } catch (_) {}
    }
  } catch (_) {}
  try {
    consider(JSON.parse(fs.readFileSync(LAST_ORDER_FILE, 'utf8')));
  } catch (_) {}
  return map;
}

/**
 * Redeem positions (tokens gagnants → USDC) pour les conditionIds tradés (marchés résolus).
 * - EOA (CLOB_SIGNATURE_TYPE=0) : tx directe depuis le wallet.
 * - Proxy / Safe : même appel CTF mais via le relayer Polymarket (gasless) — doc builders ; nécessite POLY_BUILDER_*.
 */
async function tryRedeemResolvedPositions() {
  if (!walletConfigured || !wallet || !redeemEnabled) return;

  const wantRelayer = shouldRedeemViaRelayer();
  if (redeemViaRelayerEnv === 'true' && !wantRelayer) {
    logRedeemRelayerMisconfigOnce(
      'REDEEM_VIA_RELAYER=true mais il faut CLOB_SIGNATURE_TYPE 1 ou 2 + soit POLY_BUILDER_* (Builder), soit RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS (onglet Clés API du Relayer). Fallback : redeem EOA.'
    );
  }

  let relayerClient = wantRelayer ? getRelayClientForRedeem() : null;
  if (wantRelayer && !relayerClient) {
    logRedeemRelayerMisconfigOnce(
      'Relayer redeem demandé mais RelayClient indisponible — tentative redeem depuis l’EOA (souvent sans effet si positions sur proxy).'
    );
  }
  const ctf = new ethers.Contract(CTF_POLYGON, CTF_ABI, wallet);
  const parentCollectionIdEthers = ethers.ZeroHash;
  const indexSetsEthers = [1, 2];

  const tradedIds = getTradedConditionIds();
  const marketEndByCid =
    REDEEM_AFTER_MARKET_END_MS > 0 ? getLatestMarketEndMsByConditionId() : null;
  const nowMs = Date.now();
  for (const cid of tradedIds) {
    const conditionIdBytes32 = conditionIdToBytes32(cid);
    if (!conditionIdBytes32) continue;
    if (getRedeemedConditionIdsSet().has(String(cid).trim())) continue;
    if (isRedeemSkippedByEnv(cid)) continue;
    if (marketEndByCid) {
      const endMs = marketEndByCid.get(String(cid).trim());
      if (endMs != null && nowMs < endMs + REDEEM_AFTER_MARKET_END_MS) continue;
    }
    if (!canAttemptRedeemNow(cid)) continue;
    try {
      if (relayerClient) {
        const data = encodeFunctionData({
          abi: CTF_REDEEM_ABI,
          functionName: 'redeemPositions',
          args: [
            /** @type {`0x${string}`} */ (USDC_POLYGON),
            zeroHash,
            /** @type {`0x${string}`} */ (conditionIdBytes32),
            [1n, 2n],
          ],
        });
        const resp = await relayerClient.execute(
          [{ to: CTF_POLYGON, data, value: '0' }],
          `Redeem bot ${cid.slice(0, 12)}…`
        );
        const result = await resp.wait();
        if (result?.transactionHash) {
          markConditionRedeemedSuccess(cid);
          logJson('info', 'Redeem positions OK (relayer)', {
            conditionId: cid.slice(0, 18) + '…',
            hash: result.transactionHash,
          });
          console.log(
            `[${new Date().toISOString()}] Redeem OK (relayer) — conditionId ${cid.slice(0, 14)}… — tx ${result.transactionHash}`
          );
        } else {
          noteRedeemFailureBackoff(cid);
          let detail =
            'relayer: pas MINED/CONFIRMED (souvent STATE_FAILED on-chain — marché pas encore redeemable CTF, rien à redeem, ou revert)';
          try {
            const txs = await relayerClient.getTransaction(resp.transactionID);
            const t = Array.isArray(txs) && txs[0];
            if (t) {
              detail = `state=${t.state || '?'} tx=${t.transactionHash || ''}`.slice(0, 280);
            }
          } catch (e) {
            detail = `${detail} (${String(e?.message || e).slice(0, 120)})`;
          }
          if (shouldLogRedeemRelayerNoSuccess(cid)) {
            logJson('warn', 'Redeem relayer sans succès (réessaiera au prochain cycle)', {
              conditionId: cid.slice(0, 18) + '…',
              detail,
            });
            console.warn(
              `[${new Date().toISOString()}] Redeem relayer — pas de succès pour ${cid.slice(0, 14)}… — ${detail}`
            );
          }
        }
      } else {
        const tx = await ctf.redeemPositions(
          USDC_POLYGON,
          parentCollectionIdEthers,
          conditionIdBytes32,
          indexSetsEthers
        );
        const receipt = await tx.wait();
        if (receipt?.status === 1) {
          markConditionRedeemedSuccess(cid);
          logJson('info', 'Redeem positions OK', { conditionId: cid.slice(0, 18) + '…', hash: receipt.hash });
          console.log(`[${new Date().toISOString()}] Redeem OK — conditionId ${cid.slice(0, 14)}… — tx ${receipt.hash}`);
        } else {
          noteRedeemFailureBackoff(cid);
        }
      }
    } catch (err) {
      const em = String(err.message || err);
      if (/no positions to redeem|nothing to redeem|payout of zero|already been redeemed/i.test(em)) {
        markConditionRedeemedSuccess(cid);
      } else {
        noteRedeemFailureBackoff(cid);
      }
      if (!/no positions to redeem|revert|insufficient|STATE_FAILED|invalid/i.test(em)) {
        logJson('warn', 'Redeem échoué (non bloquant)', {
          conditionId: cid.slice(0, 18) + '…',
          error: err.message,
          viaRelayer: !!relayerClient,
        });
      }
    }
  }
}

/**
 * Enregistre un relevé de liquidité (dashboard / status-server).
 * @param {number|{ liquidityUsd: number, takeSide?: 'Up'|'Down', source?: string, signalPriceP?: number }} payload
 */
function appendLiquidityHistory(payload) {
  if (!recordLiquidityHistory) return;
  const obj = typeof payload === 'number' ? { liquidityUsd: payload } : payload;
  const liquidityUsd = Number(obj?.liquidityUsd);
  if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return;
  const takeSide = obj?.takeSide === 'Up' || obj?.takeSide === 'Down' ? obj.takeSide : undefined;
  const source = typeof obj?.source === 'string' ? obj.source : undefined;
  const signalPriceP =
    Number.isFinite(Number(obj?.signalPriceP)) && Number(obj?.signalPriceP) > 0
      ? Number(obj.signalPriceP)
      : undefined;
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
    const row = {
      at: new Date(now).toISOString(),
      liquidityUsd,
      ...(takeSide ? { takeSide } : {}),
      ...(source ? { source } : {}),
      ...(signalPriceP != null ? { signalPriceP } : {}),
    };
    arr.push(row);
    const cutoff = now - LIQUIDITY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    arr = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    fs.writeFileSync(LIQUIDITY_HISTORY_FILE, JSON.stringify(arr), 'utf8');
    const sideLabel = takeSide ? ` (${takeSide})` : '';
    console.log(`[Mise max] Liquidité enregistrée${sideLabel}: ${liquidityUsd.toFixed(0)} USD (${arr.length} relevés sur 3 j)`);
  } catch (e) {
    console.error('Erreur enregistrement liquidité:', e?.message ?? e);
  }
}

/** Enregistre la latence d'un trade (ms) sur les 7 derniers jours (pour le dashboard). */
function appendTradeLatencyHistory(entry) {
  if (!entry || typeof entry !== 'object') return;
  const latencyMs = Number(entry.latencyMs);
  const hasTimings =
    entry?.timingsMs &&
    typeof entry.timingsMs === 'object' &&
    Object.values(entry.timingsMs).some((v) => Number.isFinite(Number(v)) && Number(v) > 0);
  // On veut aussi logger des "tentatives d'évaluation" (bestAsk/creds/balance/book) même sans trade réel.
  // Dans ce cas, latencyMs peut être 0/undefined => le dashboard n'en tiendra pas compte pour Trade latency,
  // mais pourra agréger le breakdown via timingsMs.
  if ((!Number.isFinite(latencyMs) || latencyMs <= 0) && !hasTimings) return;
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
    const latencyMsToStore = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
    arr.push({ at: new Date(now).toISOString(), ...entry, latencyMs: latencyMsToStore });
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
  console.log(`[Mise max] Liquidité signal (${(MIN_P * 100).toFixed(0)}–${(MAX_PRICE_LIQUIDITY * 100).toFixed(0)}%): ${reason} (token ${short})`);
  logJson('info', 'Liquidité fenêtre signal vide', { reason, tokenId: short });
}

// Eviter de spammer trade-latency-history.json quand le bot ne peut pas placer (ex: wallet=0).
const tradeLatencyAttemptLogThrottle = new Map(); // conditionKey -> lastAt
const TRADE_LATENCY_ATTEMPT_LOG_THROTTLE_MS = Number(process.env.TRADE_LATENCY_ATTEMPT_LOG_THROTTLE_MS) || 60 * 1000;
function shouldLogTradeLatencyAttempt(conditionKey) {
  if (!conditionKey) return true;
  const now = Date.now();
  const prev = tradeLatencyAttemptLogThrottle.get(conditionKey);
  if (prev && now - prev < TRADE_LATENCY_ATTEMPT_LOG_THROTTLE_MS) return false;
  tradeLatencyAttemptLogThrottle.set(conditionKey, now);
  return true;
}

/**
 * Évite de remplir bot.log avec « fetchActiveWindows: créneaux actifs » à chaque cycle (~1/s quand RECORD_LIQUIDITY_HISTORY + relevé périodique).
 * - LOG_FETCH_ACTIVE_WINDOWS_MS : intervalle min entre deux logs si le **count** est inchangé (défaut 120_000 ms). Mettre **0** pour logger chaque cycle (ancien comportement).
 * - Si **count** change (ex. 0 → 1), log immédiat.
 */
const LOG_FETCH_ACTIVE_WINDOWS_MS = (() => {
  const raw = process.env.LOG_FETCH_ACTIVE_WINDOWS_MS;
  if (raw === '0') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 120 * 1000;
})();
const fetchActiveWindowsLogState = { lastAt: 0, lastCount: null };
function logFetchActiveWindowsIfDue(count) {
  const now = Date.now();
  const mode = MARKET_MODE;
  if (fetchActiveWindowsLogState.lastCount !== count) {
    fetchActiveWindowsLogState.lastCount = count;
    fetchActiveWindowsLogState.lastAt = now;
    logJson('info', 'fetchActiveWindows: créneaux actifs', { count, mode });
    console.log(`[Mise max] Créneaux actifs: ${count} (mode ${mode})`);
    return;
  }
  if (LOG_FETCH_ACTIVE_WINDOWS_MS === 0) {
    fetchActiveWindowsLogState.lastAt = now;
    logJson('info', 'fetchActiveWindows: créneaux actifs', { count, mode });
    console.log(`[Mise max] Créneaux actifs: ${count} (mode ${mode})`);
    return;
  }
  if (now - fetchActiveWindowsLogState.lastAt >= LOG_FETCH_ACTIVE_WINDOWS_MS) {
    fetchActiveWindowsLogState.lastAt = now;
    logJson('info', 'fetchActiveWindows: créneaux actifs', { count, mode });
    console.log(`[Mise max] Créneaux actifs: ${count} (mode ${mode})`);
  }
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
// tokenId -> { atMs, value: totalUsd|null, levels: Array<{ p:number, s:number }> }
const bookCache = new Map();

// Cache en mémoire des credentials CLOB (évite derive/create à chaque trade).
let cachedCreds = null;
let cachedCredsAt = 0;

/** Creds utilisables pour ClobClient (key + secret + passphrase). */
function normalizeClobCreds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = raw.key ?? raw.apiKey;
  if (!key || !raw.secret || !raw.passphrase) return null;
  if (raw.apiKey && !raw.key) return { ...raw, key: raw.apiKey };
  return raw;
}

/** 400 « Could not create api key » = clé déjà présente côté Polymarket → il faut derive, pas create. */
function isCreateApiKeyAlreadyExistsError(err) {
  const status = err?.response?.status;
  const body = err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message;
  const s = String(body || err?.message || '');
  return status === 400 || /could not create api key|already exist|duplicate key/i.test(s);
}

/**
 * Obtient les creds L2 CLOB (api key + secret + passphrase).
 * Ne pas utiliser createOrDeriveApiKey() du SDK : il appelle createApiKey() en premier ;
 * si une clé existe déjà, create renvoie 400 et derive n'est jamais tenté.
 * Ordre : derive → si incomplet, create → si 400 « clé existe », derive à nouveau.
 */
async function getClobCredsCached() {
  const now = Date.now();
  if (cachedCreds && now - cachedCredsAt < CREDS_CACHE_TTL_MS) {
    const hit = normalizeClobCreds(cachedCreds);
    if (hit) return hit;
    cachedCreds = null;
  }

  const clientWithoutCreds = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    undefined,
    CLOB_SIGNATURE_TYPE,
    clobFunderAddress,
  );

  async function tryDerive() {
    try {
      const d = await clientWithoutCreds.deriveApiKey();
      return normalizeClobCreds(d);
    } catch {
      return null;
    }
  }

  let creds = await tryDerive();
  if (creds) {
    cachedCreds = creds;
    cachedCredsAt = now;
    return creds;
  }

  try {
    const created = await clientWithoutCreds.createApiKey();
    creds = normalizeClobCreds(created);
    if (creds) {
      cachedCreds = creds;
      cachedCredsAt = now;
      logJson('info', 'CLOB createApiKey OK (nouvelle clé)', {});
      return creds;
    }
  } catch (createErr) {
    if (isCreateApiKeyAlreadyExistsError(createErr)) {
      logJson('info', 'CLOB createApiKey 400 (clé existante) — nouvelle tentative deriveApiKey', {
        error: String(createErr?.message || createErr?.response?.data?.error || createErr).slice(0, 300),
      });
      creds = await tryDerive();
      if (creds) {
        cachedCreds = creds;
        cachedCredsAt = now;
        return creds;
      }
    }
    throw createErr;
  }

  creds = await tryDerive();
  if (creds) {
    cachedCreds = creds;
    cachedCredsAt = now;
    return creds;
  }

  const err = new Error(
    'CLOB: impossible d’obtenir des clés API (derive incomplet + create sans succès). Vérifie PRIVATE_KEY, CLOB_SIGNATURE_TYPE, compte Polymarket.',
  );
  logJson('error', 'CLOB creds échec total', { error: err.message });
  throw err;
}

async function buildClobClientCachedCreds() {
  const creds = await getClobCredsCached();
  return new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, CLOB_SIGNATURE_TYPE, clobFunderAddress);
}

/**
 * Récupère la "mise max" compatible avec un ordre market FOK :
 * montant max (USD) qu'on peut engager en USDC tout en s'assurant que l'exécution ne dépasse pas
 * le plafond MAX_PRICE_LIQUIDITY (défaut 98¢) — en sommant la profondeur cumulée jusqu’à ce prix.
 *
 * Objectif : maximiser la probabilité de remplissage total (moins de no-fill),
 * au prix d'une avg price potentiellement un peu plus dégradée si on consomme jusqu'au plafond.
 */
async function getFilteredAskLevels(tokenId, profile = null) {
  if (!tokenId) return { levels: [], totalUsd: null };

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
    return { levels: Array.isArray(cached.levels) ? cached.levels : [], totalUsd: cached.value };
  }

  try {
    if (profile && typeof profile === 'object') profile.bookCacheHit = false;
    const tBook0 = Date.now();
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 5000 });
    const bookMs = Date.now() - tBook0;
    const asks = data?.asks ?? [];
    if (!Array.isArray(asks) || asks.length === 0) {
      logLiquidityEmptyIfThrottled(tokenId, "carnet vide (pas d'asks)");
      bookCache.set(tokenId, { atMs: now, value: null, levels: [] });
      if (profile && typeof profile === 'object') {
        profile.bookMs = bookMs;
        profile.asksCount = Array.isArray(asks) ? asks.length : null;
        profile.levelsAfterFilter = 0;
        profile.liquidityCalcMs = Date.now() - overallStartMs;
      }
      return { levels: [], totalUsd: null };
    }

    const tCalc0 = Date.now();
    const levels = asks
      .map((level) => {
        const p = parseFloat(level?.price ?? level?.[0] ?? 0);
        const s = parseFloat(level?.size ?? level?.[1] ?? 0);
        return { p, s };
      })
      .filter(({ p, s }) => Number.isFinite(p) && Number.isFinite(s) && s > 0 && p >= MIN_P && p <= MAX_PRICE_LIQUIDITY)
      .sort((a, b) => a.p - b.p);

    if (profile && typeof profile === 'object') {
      profile.bookMs = bookMs;
      profile.asksCount = asks.length;
      profile.levelsAfterFilter = Array.isArray(levels) ? levels.length : null;
    }

    if (levels.length === 0) {
      logLiquidityEmptyIfThrottled(tokenId, `aucun ask dans la plage ${(MIN_P * 100).toFixed(0)}–${(MAX_PRICE_LIQUIDITY * 100).toFixed(1)}%`);
      bookCache.set(tokenId, { atMs: now, value: null, levels: [] });
      if (profile && typeof profile === 'object') {
        profile.liquidityCalcMs = Date.now() - tCalc0;
      }
      return { levels: [], totalUsd: null };
    }

    let totalUsd = 0;
    // Somme cumulée : caper la taille à la liquidité totale jusqu’au plafond MAX_PRICE_LIQUIDITY.
    for (const { p, s } of levels) totalUsd += p * s;
    const out = totalUsd > 0 ? totalUsd : null;
    bookCache.set(tokenId, { atMs: now, value: out, levels });
    if (profile && typeof profile === 'object') {
      profile.liquidityCalcMs = Date.now() - tCalc0;
      profile.bookCacheAgeMs = null;
    }
    return { levels, totalUsd: out };
  } catch (err) {
    notePolymarketIncidentError('clob_book', err);
    logLiquidityEmptyIfThrottled(tokenId, `erreur API carnet: ${err?.message || err}`);
    bookCache.set(tokenId, { atMs: now, value: null, levels: [] });
    if (profile && typeof profile === 'object') {
      profile.bookMs = Date.now() - overallStartMs;
      profile.liquidityCalcMs = Date.now() - overallStartMs;
      profile.asksCount = null;
      profile.levelsAfterFilter = null;
    }
    return { levels: [], totalUsd: null };
  }
}

async function getLiquidityAtTargetUsd(tokenId, profile = null) {
  if (!tokenId) return null;
  const { totalUsd } = await getFilteredAskLevels(tokenId, profile);
  return totalUsd;
}

function simulateAvgPriceForUsd(amountUsd, levels) {
  // amountUsd est une valeur USDC (coût total) qu'on veut remplir à travers le carnet.
  let costRemaining = amountUsd;
  let sharesUsed = 0;
  for (const { p, s } of levels) {
    if (costRemaining <= 0) break;
    const levelCost = p * s; // USDC coût pour consommer tout le niveau
    if (costRemaining <= levelCost) {
      sharesUsed += costRemaining / p;
      costRemaining = 0;
      break;
    }
    sharesUsed += s;
    costRemaining -= levelCost;
  }
  const filled = costRemaining <= 1e-9;
  const avgP = sharesUsed > 0 ? amountUsd / sharesUsed : null;
  return { filled, avgP };
}

function getMaxUsdForAvgPriceFromLevels(levels, targetAvgP, totalUsdHint = null) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const pTarget = Number.isFinite(targetAvgP) ? Math.min(Math.max(targetAvgP, MIN_P), MAX_PRICE_LIQUIDITY) : null;
  if (!pTarget) return null;

  let totalUsd = Number.isFinite(totalUsdHint) ? Number(totalUsdHint) : null;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    totalUsd = 0;
    for (const { p, s } of levels) totalUsd += p * s;
  }
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return null;

  let lo = 0;
  let hi = totalUsd;
  const eps = 1e-12;
  for (let i = 0; i < avgPriceBinIters; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= 0) break;
    const { filled, avgP } = simulateAvgPriceForUsd(mid, levels);
    if (filled && avgP != null && avgP <= pTarget + eps) lo = mid;
    else hi = mid;
  }
  return lo > 0 ? lo : 0;
}

/**
 * Sizing “avg constrained” : calcule la plus grosse taille (USD) telle que
 * le prix moyen de remplissage reste <= targetAvgP.
 */
async function getMaxUsdForAvgPrice(tokenId, targetAvgP, profile = null) {
  if (!tokenId) return null;
  const { levels, totalUsd } = await getFilteredAskLevels(tokenId, profile);
  return getMaxUsdForAvgPriceFromLevels(levels, targetAvgP, totalUsd);
}

/**
 * Meilleur ask (prix pour acheter le token) : d’abord le carnet `/book` (prix réels du marché),
 * puis GET `/price?side=BUY` en secours (doc Polymarket : BUY = best **ask**, prix pour acheter le token).
 * (~0,55/0,45) alors que le carnet affiche les vrais niveaux (ex. 0,10 / 0,91) — aligné avec le site Polymarket.
 */
async function getBestAskFromBookOnly(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 3000 });
    const asks = data?.asks;
    if (!Array.isArray(asks) || asks.length === 0) return null;
    let best = Infinity;
    for (const level of asks) {
      const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
      if (Number.isFinite(p) && p > 0 && p < best) best = p;
    }
    return best === Infinity ? null : best;
  } catch (err) {
    notePolymarketIncidentError('clob_book', err);
    return null;
  }
}

async function getBestAsk(tokenId) {
  if (!tokenId) return null;
  const fromBook = await getBestAskFromBookOnly(tokenId);
  if (fromBook != null) return fromBook;
  try {
    const { data } = await axios.get(CLOB_PRICE_URL, { params: { token_id: tokenId, side: 'BUY' }, timeout: 3000 });
    const p = parseFloat(data?.price);
    return Number.isFinite(p) ? p : null;
  } catch (err) {
    notePolymarketIncidentError('clob_price', err);
    return null;
  }
}

async function getBestBidFromBookOnly(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 3000 });
    const bids = data?.bids;
    if (!Array.isArray(bids) || bids.length === 0) return null;
    let best = 0;
    for (const level of bids) {
      const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
      if (Number.isFinite(p) && p > best) best = p;
    }
    return best > 0 ? best : null;
  } catch (err) {
    notePolymarketIncidentError('clob_book', err);
    return null;
  }
}

async function getBestBid(tokenId) {
  if (!tokenId) return null;
  const fromBook = await getBestBidFromBookOnly(tokenId);
  if (fromBook != null) return fromBook;
  try {
    const { data } = await axios.get(CLOB_PRICE_URL, { params: { token_id: tokenId, side: 'SELL' }, timeout: 3000 });
    const p = parseFloat(data?.price);
    return Number.isFinite(p) ? p : null;
  } catch (err) {
    notePolymarketIncidentError('clob_price', err);
    return null;
  }
}

const bestAskSignalCache = new Map(); // tokenId -> { p, exp }

async function getBestAskCachedForSignal(tokenId) {
  if (!tokenId) return null;
  const now = Date.now();
  const hit = bestAskSignalCache.get(tokenId);
  if (hit && hit.exp > now) return hit.p;
  const p = await getBestAsk(tokenId);
  if (p != null) bestAskSignalCache.set(tokenId, { p, exp: now + BEST_ASK_SIGNAL_CACHE_MS });
  return p;
}

/**
 * Paire [priceUp, priceDown] pour le filtre signal : Gamma ou best asks CLOB selon signalPriceSource.
 * En mode clob, secours partiel sur Gamma si un ask CLOB manque.
 */
async function getOutcomePricesForSignal(market) {
  const fromGamma = getAlignedUpDownGammaPrices(market);
  if (signalPriceSource !== 'clob') return fromGamma;

  const tokenUp = getTokenIdToBuy(market, 'Up');
  const tokenDown = getTokenIdToBuy(market, 'Down');
  const [askUp, askDown] = await Promise.all([
    tokenUp ? getBestAskCachedForSignal(tokenUp) : Promise.resolve(null),
    tokenDown ? getBestAskCachedForSignal(tokenDown) : Promise.resolve(null),
  ]);
  if (askUp == null && askDown == null) return fromGamma;
  const priceUp = askUp != null ? askUp : fromGamma?.[0] ?? null;
  const priceDown = askDown != null ? askDown : fromGamma?.[1] ?? null;
  if (priceUp == null || priceDown == null) return fromGamma;
  return [priceUp, priceDown];
}

/**
 * Marché horaire : pas de trade dans les 5 dernières minutes avant `endDate` Gamma.
 * (Le 15m utilise `shouldSkipTradeTiming` → grille ET, pas cette fonction.)
 */
function isInLastMinute(signal) {
  if (MARKET_MODE === '15m') return false;
  const raw = signal?.endDate;
  if (raw == null || raw === '') return false;
  let endMs;
  if (typeof raw === 'number') {
    endMs = raw > 1e12 ? raw : raw * 1000;
  } else {
    endMs = new Date(raw).getTime();
  }
  if (Number.isNaN(endMs)) return false;
  const thresholdMs = NO_TRADE_LAST_MS_HOURLY;
  if (thresholdMs <= 0) return false;
  return Date.now() >= endMs - thresholdMs;
}

/**
 * Skip placement selon le mode :
 * - 15m : **même règle que le dashboard** — pas les 3 premières / 4 dernières minutes de chaque quart d’heure **ET** (:00,:15,:30,:45).
 * - horaire : 5 dernières minutes avant fin événement Gamma.
 */
function shouldSkipTradeTiming(signal) {
  if (MARKET_MODE === '15m') {
    return is15mSlotEntryTimeForbiddenNow(Math.floor(Date.now() / 1000));
  }
  return isInLastMinute(signal);
}

function getTimingForbiddenDetails() {
  if (MARKET_MODE !== '15m') return null;
  const d = get15mSlotEntryTimingDetail(Math.floor(Date.now() / 1000));
  if (!d?.forbidden) return null;
  return {
    timingBlock: d.block,
    timingOffsetSec: d.offsetSec,
  };
}

function getGammaEventsCacheKey(slugMatch) {
  // La fallback dépend du créneau courant (hourly/15m). On inclut donc le slug courant dans la clé.
  const currentSlug = MARKET_MODE === '15m' ? getCurrent15mEventSlug() : getCurrentHourlyEventSlug();
  return `${MARKET_MODE}|${slugMatch}|${currentSlug}`;
}

/**
 * Récupère la liste d'events Gamma, avec fallback par slug courant si `slug_contains` ne renvoie pas.
 * Met en cache pour réduire la latence du cycle (fetchSignals + fetchActiveWindows).
 */
async function fetchGammaEventsCached(slugMatch, eventsTimeoutMs = 15000) {
  const cacheKey = getGammaEventsCacheKey(slugMatch);
  const now = Date.now();
  const cached = gammaEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  const profile = {
    usedEvents: false,
    eventsMsTotal: null,
    eventsRetryUsed: false,
    hasMatchingSlugAfterEvents: null,
    fallbackSlugOk: null,
    fallbackSlugMs: null,
  };

  let events = [];
  try {
    const tEvents0 = Date.now();
    const { data } = await axios.get(GAMMA_EVENTS_URL, {
      params: { active: true, closed: false, limit: 150, slug_contains: slugMatch },
      timeout: eventsTimeoutMs,
    });
    events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
    profile.usedEvents = true;
    profile.eventsMsTotal = Date.now() - tEvents0;
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 400) {
      const tEvents1 = Date.now();
      const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 200 }, timeout: eventsTimeoutMs });
      profile.usedEvents = true;
      profile.eventsRetryUsed = true;
      profile.eventsMsTotal = (profile.eventsMsTotal ?? 0) + (Date.now() - tEvents1);
      events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
    } else throw err;
  }

  const hasMatchingSlug = events.some((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
  profile.hasMatchingSlugAfterEvents = hasMatchingSlug;

  // Secours : si la liste n'a aucun event qui matche notre slug (API peut ignorer slug_contains), récupérer le créneau actuel par slug.
  if (MARKET_MODE === '15m' && !hasMatchingSlug) {
    try {
      const tFallback0 = Date.now();
      const slug = getCurrent15mEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        events = [ev];
        profile.fallbackSlugOk = true;
      } else {
        profile.fallbackSlugOk = false;
      }
      profile.fallbackSlugMs = Date.now() - tFallback0;
    } catch (_) {
      profile.fallbackSlugOk = false;
      profile.fallbackSlugMs = 0;
    }
  }

  if (MARKET_MODE !== '15m' && !hasMatchingSlug) {
    try {
      const tFallback0 = Date.now();
      const slug = getCurrentHourlyEventSlug();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
        events = [ev];
        profile.fallbackSlugOk = true;
      } else {
        profile.fallbackSlugOk = false;
      }
      profile.fallbackSlugMs = Date.now() - tFallback0;
    } catch (_) {
      profile.fallbackSlugOk = false;
      profile.fallbackSlugMs = 0;
    }
  }

  const expiresAt = now + GAMMA_EVENTS_CACHE_MS;
  const out = { expiresAt, events, profile };
  gammaEventsCache.set(cacheKey, out);
  return out;
}

/** Récupère les signaux (fenêtre MIN_P–MAX_P) : marchés via Gamma, prix via Gamma ou best ask CLOB selon signalPriceSource. */
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

  // Même logique pour 15m et horaire : d'abord GET /events (liste), puis secours par slug si la liste ne contient pas le créneau actuel.
  // On appelle un helper mutualisé + cache pour réduire la latence (évite un 2e appel Gamma dans fetchActiveWindows()).
  const eventsTimeoutMs = 15000;
  const gammaOut = await fetchGammaEventsCached(slugMatch, eventsTimeoutMs);
  events = gammaOut.events;
  profile.usedEvents = gammaOut.profile.usedEvents;
  profile.eventsMsTotal = gammaOut.profile.eventsMsTotal;
  profile.eventsRetryUsed = gammaOut.profile.eventsRetryUsed;
  profile.hasMatchingSlugAfterEvents = gammaOut.profile.hasMatchingSlugAfterEvents;
  profile.fallbackSlugOk = gammaOut.profile.fallbackSlugOk;
  profile.fallbackSlugMs = gammaOut.profile.fallbackSlugMs;

  if (MARKET_MODE === '15m') {
    const r = await resolve15mEventsForTrading(events, Date.now());
    events = r.events;
    profile.fifteenMResolveStrategy = r.resolveStrategy;
    profile.fifteenMSlugMismatch = r.slugMismatch;
    profile.expected15mSlug = r.expectedSlug;
  }

  const results = [];
  /** @type {Array<Record<string, unknown>>} */
  const visibilitySnapshots = [];
  for (const ev of events) {
    if (!ev?.markets?.length) continue;
    const eventSlug = (ev.slug ?? '').toLowerCase();
    if (!eventSlug.includes(slugMatch)) continue;
    const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
    for (const m of ev.markets) {
      const merged = mergeGammaEventMarketForUpDown(ev, m);
      const prices = await getOutcomePricesForSignal(merged);
      if (!prices) continue;
      const [priceUp, priceDown] = prices;
      const upInRange = priceUp >= MIN_P && priceUp <= MAX_P;
      const downInRange = priceDown >= MIN_P && priceDown <= MAX_P;
      const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
      if (signalVisibilityLog) {
        const gammaPair = getAlignedUpDownGammaPrices(merged);
        const timingSignal = { endDate: marketEndDate };
        visibilitySnapshots.push({
          slug: (ev.slug ?? eventSlug).slice(0, 80),
          priceSource: signalPriceSource,
          priceUp: Math.round(priceUp * 1e6) / 1e6,
          priceDown: Math.round(priceDown * 1e6) / 1e6,
          gammaUp: gammaPair?.[0] != null ? Math.round(gammaPair[0] * 1e6) / 1e6 : null,
          gammaDown: gammaPair?.[1] != null ? Math.round(gammaPair[1] * 1e6) / 1e6 : null,
          strategyWindow: { minP: MIN_P, maxP: MAX_P },
          upInStrategyWindow: upInRange,
          downInStrategyWindow: downInRange,
          /** Même règle que l’émission du signal (Up prioritaire si les deux). */
          wouldEmitSide: upInRange ? 'Up' : downInRange ? 'Down' : null,
          timingForbiddenNow: shouldSkipTradeTiming(timingSignal),
          ...(MARKET_MODE === '15m'
            ? {
                expected15mSlug: profile.expected15mSlug ?? null,
                fifteenMResolveStrategy: profile.fifteenMResolveStrategy ?? null,
                fifteenMSlugMismatch: profile.fifteenMSlugMismatch ?? false,
              }
            : {}),
        });
      }
      if (upInRange) {
        results.push({
          market: merged,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Up',
          priceUp,
          priceDown,
          tokenIdToBuy: getTokenIdToBuy(merged, 'Up'),
          endDate: marketEndDate,
        });
      } else if (downInRange) {
        results.push({
          market: merged,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Down',
          priceUp,
          priceDown,
          tokenIdToBuy: getTokenIdToBuy(merged, 'Down'),
          endDate: marketEndDate,
        });
      }
    }
  }

  if (signalVisibilityLog && visibilitySnapshots.length > 0) {
    const nowVis = Date.now();
    if (nowVis - signalVisibilityLogLastAt >= SIGNAL_VISIBILITY_LOG_MS) {
      signalVisibilityLogLastAt = nowVis;
      const payload = {
        mode: MARKET_MODE,
        pollEmittedSignals: results.length,
        snapshots: visibilitySnapshots.slice(0, 5),
      };
      logJson('info', 'signal_visibility_poll', payload);
      const s0 = visibilitySnapshots[0];
      console.log(
        `[signal_visibility] ${MARKET_MODE} src=${signalPriceSource} | Up=${s0.priceUp} Down=${s0.priceDown} | fenêtre stratégie Up/Down=${s0.upInStrategyWindow}/${s0.downInStrategyWindow} | émettrait=${s0.wouldEmitSide ?? '∅'} | timing_interdit=${s0.timingForbiddenNow} | signaux_poll=${results.length}`,
      );
    }
  }

  // Synthèse de stratégie (15m et horaire : même logique liste puis secours slug).
  profile.totalMs = Date.now() - tFetchStartMs;
  if (profile.usedEvents && profile.hasMatchingSlugAfterEvents === true) profile.strategy = 'events_ok';
  else if (profile.usedEvents && profile.fallbackSlugOk != null) profile.strategy = 'events_no_match_then_slug';
  else profile.strategy = 'events_empty_or_invalid';
  if (MARKET_MODE === '15m' && profile.fifteenMResolveStrategy) {
    const mis = profile.fifteenMSlugMismatch ? '|mismatch' : '';
    profile.strategy = `${profile.strategy}|15m:${profile.fifteenMResolveStrategy}${mis}`;
  }
  results._fetchSignalsProfile = profile;
  return results;
}

/** Vérifie si l’IP est autorisée à trader (geoblock). */
/** Récupère les token IDs des marchés actifs (Up + Down) pour s'abonner au WebSocket CLOB. Retourne { tokenIds, tokenToSignal }. */
async function getActiveMarketTokensForWs() {
  const slugMatch = MARKET_MODE === '15m' ? BITCOIN_UP_DOWN_15M_SLUG : BITCOIN_UP_DOWN_SLUG;
  const gammaOut = await fetchGammaEventsCached(slugMatch, 15000);
  let events = gammaOut.events;

  if (MARKET_MODE === '15m') {
    const r = await resolve15mEventsForTrading(events, Date.now());
    events = r.events;
    if (r.slugMismatch) {
      console.log(
        `[WS] 15m: résolution créneau — stratégie=${r.resolveStrategy} attendu=${r.expectedSlug} (mismatch vs liste Gamma)`,
      );
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
      const merged = mergeGammaEventMarketForUpDown(ev, m);
      const { tokenIdUp, tokenIdDown } = getAlignedUpDownTokenIds(merged);
      if (tokenIdUp) {
        tokenIds.push(tokenIdUp);
        tokenToSignal.set(tokenIdUp, {
          market: merged,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Up',
          endDate,
          tokenIdToBuy: tokenIdUp,
          priceUp: MIN_P,
          priceDown: 1 - MIN_P,
        });
      }
      if (tokenIdDown) {
        tokenIds.push(tokenIdDown);
        tokenToSignal.set(tokenIdDown, {
          market: merged,
          eventSlug: ev.slug ?? eventSlug,
          takeSide: 'Down',
          endDate,
          tokenIdToBuy: tokenIdDown,
          priceUp: 1 - MIN_P,
          priceDown: MIN_P,
        });
      }
    }
  }
  return { tokenIds: [...new Set(tokenIds)], tokenToSignal };
}

/** Slug du créneau 15m ouvert : `btc-updown-15m-{eventStartSec}` (Gamma), start = floor(epoch/900)*900. */
function getCurrent15mEventSlug() {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotStart = Math.floor(nowSec / 900) * 900;
  return `${BITCOIN_UP_DOWN_15M_SLUG}-${slotStart}`;
}

/**
 * Repli : marchés 15m encore ouverts, triés par fin de créneau (plus proche d’abord).
 * Aligné sur le dashboard (`pickCurrent15mEvent`).
 */
function pick15mFallbackEventFromList(events, nowMs) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const preferred = getCurrent15mEventSlug().toLowerCase();
  const exact = events.find((e) => (e.slug ?? '').toLowerCase() === preferred);
  if (exact) return exact;
  const stillOpen = events.filter((e) => {
    const end = slotEndMsFrom15mSlug(e.slug ?? '');
    return end != null && Number.isFinite(end) && nowMs < end;
  });
  stillOpen.sort((a, b) => {
    const ea = slotEndMsFrom15mSlug(a.slug ?? '') ?? 0;
    const eb = slotEndMsFrom15mSlug(b.slug ?? '') ?? 0;
    return ea - eb;
  });
  return stillOpen[0] ?? events[0];
}

/**
 * Un seul event 15m pour trading / WS : slug UTC courant exact, sinon GET /events/slug, sinon repli trié.
 * (La liste Gamma peut contenir plusieurs `btc-updown-15m-*` — ne pas prendre le premier au hasard.)
 */
async function resolve15mEventsForTrading(events, nowMs = Date.now()) {
  const expectedSlug = getCurrent15mEventSlug().toLowerCase();
  const exact = events.find((e) => (e.slug ?? '').toLowerCase() === expectedSlug);
  if (exact?.markets?.length) {
    return { events: [exact], resolveStrategy: 'list_exact_slug', slugMismatch: false, expectedSlug };
  }
  try {
    const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(expectedSlug)}`, {
      timeout: 8000,
    });
    if (ev?.markets?.length && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
      const sl = (ev.slug ?? '').toLowerCase();
      return { events: [ev], resolveStrategy: 'direct_slug', slugMismatch: sl !== expectedSlug, expectedSlug };
    }
  } catch (_) {
    /* 404 ou réseau */
  }
  const fb = pick15mFallbackEventFromList(events, nowMs);
  if (fb?.markets?.length) {
    const sl = (fb.slug ?? '').toLowerCase();
    return {
      events: [fb],
      resolveStrategy: 'fallback_open_sorted',
      slugMismatch: sl !== expectedSlug,
      expectedSlug,
    };
  }
  return { events: [], resolveStrategy: 'empty', slugMismatch: false, expectedSlug };
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
  const { events } = await fetchGammaEventsCached(slugMatch, 15000);
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
      results.push({ market: m, ev, endDate: marketEndDate, key });
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

/**
 * Garde : mise `stakeUsd` au prix moyen `p` (0<p<1) → parts ≈ stake/p → si victoire encaissement ≈ stake/p USDC.
 * Exige encaissement > mise et gain brut ≥ minWinGrossProfitUsd.
 */
function validateWinPayoutExceedsStake(stakeUsd, effectivePriceP) {
  const stake = Number(stakeUsd);
  const p = Number(effectivePriceP);
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: 'Garde gain : mise USDC invalide.' };
  }
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    return { ok: false, error: `Garde gain : prix effectif invalide (${String(effectivePriceP)}) — attendu dans ]0,1[.` };
  }
  const payoutIfWin = stake / p;
  const grossGain = payoutIfWin - stake;
  if (payoutIfWin <= stake + 1e-9) {
    return {
      ok: false,
      error: `Garde gain : si victoire, encaissement ${payoutIfWin.toFixed(2)} $ ≤ mise ${stake.toFixed(2)} $ (p=${p.toFixed(4)}). Trade refusé.`,
    };
  }
  if (grossGain + 1e-9 < minWinGrossProfitUsd) {
    return {
      ok: false,
      error: `Garde gain : gain brut si victoire ${grossGain.toFixed(4)} $ < minimum ${minWinGrossProfitUsd} $ — trade refusé.`,
    };
  }
  return { ok: true, payoutIfWin, grossGain };
}

/** Prix conservateur pour la garde : marché = worst price plafond ; limite = prix signal clamp stratégie. */
function getConservativePriceForGainGuard(signal, marketOrder) {
  if (marketOrder) return marketWorstPriceP;
  const raw = signal.takeSide === 'Down' ? signal.priceDown : signal.priceUp;
  const p = Number(raw);
  if (!Number.isFinite(p)) return null;
  return Math.min(Math.max(p, MIN_P), MAX_P);
}

/** Place un ordre sur le CLOB (marché ou limite), avec retry sur 429 / erreur réseau et kill switch en cas d'erreurs répétées. amountUsd = taille du trade. clientOrNull = client CLOB déjà créé. options.allowBelowMin = true pour accepter une taille < ORDER_SIZE_MIN_USD (ex. plafond liquidité). */
async function placeOrder(signal, amountUsd, clientOrNull = null, options = {}) {
  if (!walletConfigured || !wallet) {
    return { ok: false, error: 'Wallet non configuré. Ajoute PRIVATE_KEY dans .env puis redémarre.' };
  }
  let size = applyMaxStakeUsd(Number(amountUsd) || orderSizeUsd);
  if (size < ABSOLUTE_MIN_USD) {
    return { ok: false, error: `Taille trop faible (${size.toFixed(2)} < ${ABSOLUTE_MIN_USD} USDC min).` };
  }
  if (!options.allowBelowMin && size < orderSizeMinUsd) {
    return { ok: false, error: `Solde insuffisant (${size.toFixed(2)} < ${orderSizeMinUsd} USDC min).` };
  }
  const { tokenIdToBuy, takeSide, priceUp, priceDown } = signal;
  const price = takeSide === 'Down' ? priceDown : priceUp;

  if (requireWinGrossGainGuard) {
    const pGuard = getConservativePriceForGainGuard(signal, useMarketOrder);
    if (pGuard == null) {
      return { ok: false, error: 'Garde gain : prix du signal indisponible — trade refusé.' };
    }
    const gainCheck = validateWinPayoutExceedsStake(size, pGuard);
    if (!gainCheck.ok) {
      logJson('warn', 'Garde gain vs mise', { stake: size, pGuard, error: gainCheck.error });
      return { ok: false, error: gainCheck.error };
    }
  }

  let lastError;
  const maxAttempts = Math.max(1, Math.min(ORDER_RETRY_ATTEMPTS, Number(options?.maxAttempts) || ORDER_RETRY_ATTEMPTS));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        // Pré-signature : create + sign puis POST (réduit la latence perçue au moment du trade).
        const worstPrice = marketWorstPriceP;
        const userMarketOrder = { tokenID: tokenIdToBuy, amount: size, side: Side.BUY, price: worstPrice };
        const cacheKey = getPreSignCacheKey(signal, size);
        purgeExpiredPreSignCache();
        let signedOrder = null;
        let preSignCacheHit = false;
        const cached = preSignCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          signedOrder = cached.signedOrder;
          preSignCache.delete(cacheKey);
          preSignCacheHit = true;
        }
        if (!signedOrder) {
          signedOrder = await createSignedMarketOrder(client, userMarketOrder);
          preSignCache.set(cacheKey, { signedOrder, expiresAt: Date.now() + PRE_SIGN_CACHE_TTL_MS });
        }
        const result = await client.postOrder(signedOrder, marketOrderType);
        const fill = parsePolymarketPostOrderFill(result, { orderSide: Side.BUY, requestedUsd: size });
        const clobResponse = serializeClobPostOrderResponseForLog(result);
        consecutiveOrderErrors = 0;
        return { ok: true, orderID: result?.orderID ?? result?.id, preSignCacheHit, clobResponse, ...fill };
      }
      const userOrder = { tokenID: tokenIdToBuy, price: roundedPrice, size, side: Side.BUY };
      // Ordre limite : create + sign puis POST (même pattern que marché).
      const signedOrderLimit = await client.createOrder(userOrder, options);
      const result = await client.postOrder(signedOrderLimit, OrderType.GTC);
      const fill = parsePolymarketPostOrderFill(result, { orderSide: Side.BUY, requestedUsd: size });
      const clobResponse = serializeClobPostOrderResponseForLog(result);
      consecutiveOrderErrors = 0;
      return { ok: true, orderID: result?.orderID ?? result?.id, preSignCacheHit: false, clobResponse, ...fill };
    } catch (err) {
      const apiErrorDetail =
        err?.response?.data?.error ||
        err?.response?.data?.errorMsg ||
        err?.response?.data?.message ||
        null;
      lastError = apiErrorDetail ? `${err.message} | ${apiErrorDetail}` : err.message;
      const status = err.response?.status;
      const is429 = status === 429 || String(err.message || status).includes('429');
      const is425 = status === 425; // Matching engine restart (mardi 7h ET, ~90s) — doc Polymarket
      const isRetryable = is429 || is425 || /timeout|network|ECONNRESET/i.test(String(err.message));
      if (isRetryable || (Number.isFinite(Number(status)) && Number(status) >= 500)) {
        notePolymarketIncidentError('place_order', err);
      }
      if (is425) console.warn('CLOB: moteur de matching en redémarrage (425), retry…');
      if (isRetryable && attempt < maxAttempts - 1) {
        const delay = ORDER_RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`Tentative ${attempt + 1}/${maxAttempts} échouée, retry dans ${delay}ms…`);
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

/**
 * Ordre marché FAK : en cas de remplissage partiel, enchaîne des ordres sur le **reliquat uniquement**
 * (même worst price / FAK / garde gain), avec délai, fenêtre temps max et nombre max de compléments.
 * Si la réponse du 1er POST ne donne pas filledUsdc, pas de complément (évite un double plein stake).
 */
async function placeMarketOrderWithPartialFillRetries(signal, amountUsd, clientOrNull = null, options = {}) {
  if (!partialFillRetryEnabled || options?.forceSingleAttempt) {
    return placeOrder(signal, amountUsd, clientOrNull, options);
  }

  const targetUsd = Number(amountUsd) || 0;
  if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
    return placeOrder(signal, amountUsd, clientOrNull, options);
  }

  const first = await placeOrder(signal, amountUsd, clientOrNull, options);
  if (!first.ok) return first;
  // Sans montant exécuté > 0, pas de reliquat fiable — évite de renvoyer tout le stake (doublon si l’API est ambiguë).
  if (first.filledUsdc == null || first.filledUsdc <= 0) return first;

  let totalFilled = first.filledUsdc;
  let totalFilledOutcomeTokens =
    first.filledOutcomeTokens != null && Number.isFinite(first.filledOutcomeTokens) ? first.filledOutcomeTokens : null;
  const orderIDs = first.orderID != null ? [first.orderID] : [];
  const clobResponses = first.clobResponse != null ? [first.clobResponse] : [];
  let anyPreSignHit = !!first.preSignCacheHit;
  const epsUsd = Math.max(0.05, targetUsd * 0.002);

  if (totalFilled >= targetUsd - epsUsd) {
    return { ...first, partialFillRetries: 0 };
  }

  const tWindow0 = Date.now();
  let lastOk = first;

  for (let extra = 0; extra < PARTIAL_FILL_RETRY_MAX_EXTRA; extra++) {
    if (Date.now() - tWindow0 > PARTIAL_FILL_RETRY_MAX_WINDOW_MS) {
      logJson('info', 'Complément FAK: fenêtre temps épuisée', { totalFilled, targetUsd, extra });
      break;
    }
    if (PARTIAL_FILL_RETRY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PARTIAL_FILL_RETRY_DELAY_MS));
    }

    if (partialFillRetryRevalidatePrice && signal?.tokenIdToBuy) {
      try {
        const ask = await getBestAsk(signal.tokenIdToBuy);
        if (ask == null || ask < MIN_P || ask > MAX_P) {
          logJson('info', 'Complément FAK: best ask hors fenêtre signal, arrêt', { ask, extra });
          break;
        }
      } catch (e) {
        logJson('warn', 'Complément FAK: revalidation prix échouée', { error: e?.message, extra });
      }
    }

    const remaining = targetUsd - totalFilled;
    if (remaining < PARTIAL_FILL_RETRY_MIN_REMAINING_USD) break;

    let requestUsd = applyMaxStakeUsd(remaining);
    if (useBalanceAsSize) {
      let client = clientOrNull;
      if (!client) {
        try {
          client = await buildClobClientCachedCreds();
        } catch (_) {}
      }
      if (client) {
        const bal = await getUsdcBalanceViaClob(client) ?? (await getUsdcBalanceRpc());
        if (bal != null && Number.isFinite(bal)) {
          requestUsd = Math.min(requestUsd, Math.max(0, bal));
        }
      }
    }

    if (requestUsd < ABSOLUTE_MIN_USD) break;

    const allowBelowMin = !!options.allowBelowMin || requestUsd < orderSizeMinUsd;
    const next = await placeOrder(signal, requestUsd, clientOrNull, { ...options, allowBelowMin });
    lastOk = next;
    anyPreSignHit = anyPreSignHit || !!next.preSignCacheHit;

    if (!next.ok) {
      logJson('warn', 'Complément FAK: échec ordre', { error: next.error, extra, totalFilled });
      break;
    }
    if (next.orderID != null) orderIDs.push(next.orderID);
    if (next.clobResponse != null) clobResponses.push(next.clobResponse);

    if (next.filledUsdc == null) break;
    totalFilled += next.filledUsdc;
    if (next.filledOutcomeTokens != null && Number.isFinite(next.filledOutcomeTokens)) {
      totalFilledOutcomeTokens = (totalFilledOutcomeTokens ?? 0) + next.filledOutcomeTokens;
    }

    if (totalFilled >= targetUsd - epsUsd) break;
  }

  const aggregateFillRatio =
    targetUsd > 0 ? Math.min(2, Math.round((totalFilled / targetUsd) * 10000) / 10000) : null;
  let aggregateAverageFillPriceP = null;
  if (totalFilled > 0 && totalFilledOutcomeTokens != null && totalFilledOutcomeTokens > 0) {
    aggregateAverageFillPriceP = Math.round((totalFilled / totalFilledOutcomeTokens) * 1e8) / 1e8;
  }
  const baseLog = pickFillFieldsForLog(lastOk);

  return {
    ok: true,
    orderID: orderIDs.length ? orderIDs[orderIDs.length - 1] : first.orderID,
    orderIDs: orderIDs.length > 1 ? orderIDs : undefined,
    partialFillRetries: Math.max(0, orderIDs.length - 1),
    preSignCacheHit: anyPreSignHit,
    ...baseLog,
    filledUsdc: totalFilled,
    filledOutcomeTokens: totalFilledOutcomeTokens,
    fillRatio: aggregateFillRatio,
    averageFillPriceP: aggregateAverageFillPriceP ?? baseLog.averageFillPriceP ?? lastOk?.averageFillPriceP,
    clobResponse: clobResponses.length ? clobResponses[clobResponses.length - 1] : lastOk?.clobResponse,
    clobResponses: clobResponses.length > 1 ? clobResponses : undefined,
  };
}

/** Utiliser uniquement le prix reçu par WS (pas de re-validation REST) → économise ~50–150 ms au moment du trade. Défaut true. */
const USE_WS_PRICE_ONLY = process.env.USE_WS_PRICE_ONLY !== 'false';

/** Tente de placer un ordre pour un signal (appelé par le WebSocket quand best_ask entre dans la fenêtre). Prix = valeur WS (ou re-validation REST si USE_WS_PRICE_ONLY=false). */
async function tryPlaceOrderForSignal(signal) {
  if (!signal?.tokenIdToBuy) return;
  const key = getSignalKey(signal);
  /** Avant wallet / autotrade : sinon le dashboard voyait `auto_place_disabled` au lieu de « fenêtre interdite » 15m. */
  if (shouldSkipTradeTiming(signal)) {
    const timingDetails = getTimingForbiddenDetails();
    recordSkipReason('timing_forbidden', 'ws', {
      conditionId: key,
      tokenId: signal.tokenIdToBuy,
      takeSide: signal.takeSide,
      bestAskP: pickSignalBestAskP(signal),
      ...timingDetails,
    });
    logSignalInRangeButNoOrder('ws', 'timing_forbidden', signal, { ...timingDetails });
    return;
  }
  if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) {
    const r = !walletConfigured
      ? 'wallet_not_configured'
      : !autoPlaceEnabled
        ? 'auto_place_disabled'
        : killSwitchActive
          ? 'kill_switch'
          : 'unknown';
    logSignalInRangeButNoOrder('ws', r, signal, {});
    return;
  }
  const cooldownRemainingMs = getExecutionCooldownRemainingMs(key);
  if (cooldownRemainingMs > 0) {
    recordSkipReason('cooldown_active', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy, remainingMs: cooldownRemainingMs });
    logSignalInRangeButNoOrder('ws', 'cooldown_active', signal, { remainingMs: Math.round(cooldownRemainingMs) });
    return;
  }
  if (inPolymarketDegradedMode() && incidentBehavior === 'pause') {
    recordSkipReason('degraded_mode', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
    logSignalInRangeButNoOrder('ws', 'degraded_mode_pause', signal, {});
    return;
  }
  const t0 = Date.now();
  const timingsMs = { bestAsk: null, creds: null, balance: null, book: null, placeOrder: null };
  if (placedKeys.has(key)) {
    recordSkipReason('already_placed_for_slot', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
    logSignalInRangeButNoOrder('ws', 'already_placed_for_slot', signal, {});
    return;
  }
  let signalWithPrice = signal;
  let bestAskLive = null; // best ask (USD de probabilité) au moment du trigger WS
  const wsEventAtMs = Number(signal?._wsReceivedAtMs) || 0;
  if (USE_WS_PRICE_ONLY) {
    // Prix déjà sur le signal (reçu par WS, filtré [MIN_P, MAX_P]). Pas d'appel REST → ~50–150 ms de gagné.
    const tBestAsk0 = Date.now();
    const wsBestAsk = signal.takeSide === 'Up' ? signal.priceUp : signal.priceDown;
    if (wsBestAsk == null || wsBestAsk < MIN_P || wsBestAsk > MAX_P) {
      recordSkipReason('ws_price_out_of_window', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
      logJson('info', 'WS: prix hors fenêtre (stale?), skip', { tokenId: signal.tokenIdToBuy, bestAsk: wsBestAsk });
      return;
    }
    bestAskLive = wsBestAsk;
    timingsMs.bestAsk = Math.max(1, Date.now() - tBestAsk0);
    const wsAgeMs = wsEventAtMs > 0 ? Math.max(0, Date.now() - wsEventAtMs) : (wsLastBidAskAtMs > 0 ? Math.max(0, Date.now() - wsLastBidAskAtMs) : null);
    if (wsAgeMs != null && wsAgeMs > wsFreshnessMaxMs) {
      const restAsk = await getBestAsk(signal.tokenIdToBuy);
      if (restAsk == null || restAsk < MIN_P || restAsk > MAX_P) {
        recordSkipReason('ws_stale', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
        logSignalInRangeButNoOrder('ws', 'ws_stale_rest_invalid', signal, {
          bestAskP: wsBestAsk,
          wsAgeMs: Math.round(wsAgeMs),
          restAsk: restAsk != null ? Math.round(restAsk * 1e6) / 1e6 : null,
        });
        writeHealth({ staleWsData: true, staleWsDataAt: new Date().toISOString() });
        setPolymarketDegraded('stale_ws_data', incidentDurationMs);
        logJson('warn', 'WS stale: revalidation REST indisponible/hors fenêtre, skip', { tokenId: signal.tokenIdToBuy, wsAgeMs, wsBestAsk });
        return;
      }
      const mismatch = Math.abs(restAsk - wsBestAsk);
      if (mismatch > wsPriceMismatchMaxP) {
        recordSkipReason('ws_stale', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
        logSignalInRangeButNoOrder('ws', 'ws_stale_rest_mismatch', signal, {
          bestAskP: wsBestAsk,
          wsAgeMs: Math.round(wsAgeMs),
          restAsk: Math.round(restAsk * 1e6) / 1e6,
          mismatch: Math.round(mismatch * 1e6) / 1e6,
          mismatchMaxP: wsPriceMismatchMaxP,
        });
        writeHealth({ staleWsData: true, staleWsDataAt: new Date().toISOString() });
        setPolymarketDegraded('ws_rest_price_mismatch', incidentDurationMs);
        logJson('warn', 'WS stale: mismatch WS/REST, skip', { tokenId: signal.tokenIdToBuy, wsAgeMs, wsBestAsk, restAsk, mismatch });
        return;
      }
      writeHealth({ staleWsData: false });
      bestAskLive = restAsk;
      signalWithPrice = {
        ...signal,
        priceUp: signal.takeSide === 'Up' ? restAsk : 1 - restAsk,
        priceDown: signal.takeSide === 'Down' ? restAsk : 1 - restAsk,
      };
    }
  } else {
    const tBestAsk0 = Date.now();
    const currentBestAsk = await getBestAsk(signal.tokenIdToBuy);
    timingsMs.bestAsk = Date.now() - tBestAsk0;
    if (currentBestAsk == null || currentBestAsk < MIN_P || currentBestAsk > MAX_P) {
      recordSkipReason('ws_price_out_of_window', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
      logJson('info', 'WS: prix hors fenêtre au moment du placement, skip', { tokenId: signal.tokenIdToBuy, bestAsk: currentBestAsk });
      return;
    }
    bestAskLive = currentBestAsk;
    signalWithPrice = {
      ...signal,
      priceUp: signal.takeSide === 'Up' ? currentBestAsk : 1 - currentBestAsk,
      priceDown: signal.takeSide === 'Down' ? currentBestAsk : 1 - currentBestAsk,
    };
  }
  // Carnet : seulement si relevé historique ou plafonds legacy (sinon inutile avec FAK + worst price).
  let liquidity = null;
  let maxUsdAvg = null;
  if (needLiquidityBook) {
    const tBook0 = Date.now();
    liquidity = await getLiquidityAtTargetUsd(signal.tokenIdToBuy);
    timingsMs.book = Math.max(1, Date.now() - tBook0);
    if (useAvgPriceSizing && bestAskLive != null && liquidity != null && liquidity > 0) {
      maxUsdAvg = await getMaxUsdForAvgPrice(signal.tokenIdToBuy, bestAskLive + avgPriceTolP);
    }
    const miseMaxUsdForRecord = maxUsdAvg != null && maxUsdAvg > 0 ? maxUsdAvg : liquidity;
    if (recordLiquidityHistory && miseMaxUsdForRecord != null && miseMaxUsdForRecord > 0 && !recordedLiquidityWindows.has(key)) {
      appendLiquidityHistory({ liquidityUsd: miseMaxUsdForRecord, takeSide: signal.takeSide, source: 'ws', signalPriceP: bestAskLive });
      const endMs = signal.endDate ? (typeof signal.endDate === 'number' ? (signal.endDate > 1e12 ? signal.endDate : signal.endDate * 1000) : new Date(signal.endDate).getTime()) : Date.now();
      recordedLiquidityWindows.set(key, endMs);
    }
  } else {
    timingsMs.book = 1;
  }

  let clobClient = null;
  try {
    const tCreds0 = Date.now();
    clobClient = await buildClobClientCachedCreds();
    timingsMs.creds = Math.max(1, Date.now() - tCreds0);
  } catch (err) {
    notePolymarketIncidentError('clob_creds', err);
    logSignalInRangeButNoOrder('ws', 'clob_creds', signal, {
      bestAskP: bestAskLive,
      error: String(err?.message || err).slice(0, 240),
    });
    console.warn('WebSocket tryPlace: CLOB client:', err.message);
    return;
  }
  const tBal0 = Date.now();
  const spendableBalance = await getUsdcSpendableViaClob(clobClient);
  const rpcBalance = spendableBalance == null ? await getUsdcBalanceRpc() : null;
  const balance = spendableBalance ?? rpcBalance;
  timingsMs.balance = Math.max(1, Date.now() - tBal0);
  let amountUsd = useBalanceAsSize ? (balance ?? orderSizeUsd) : orderSizeUsd;
  const spendableBufferUsd = Math.max(0.05, amountUsd * 0.003);
  if (balance != null && Number.isFinite(balance) && balance > 0) {
    amountUsd = Math.min(amountUsd, Math.max(0, balance - spendableBufferUsd));
  }

  let allowBelowMin = false;
  let cappedBy = false;
  if (liquidity != null && liquidity > 0 && useLiquidityCap && amountUsd > liquidity) {
    amountUsd = liquidity;
    cappedBy = true;
  }
  if (useAvgPriceSizing && maxUsdAvg != null && maxUsdAvg > 0 && amountUsd > maxUsdAvg) {
    amountUsd = maxUsdAvg;
    cappedBy = true;
  }
  amountUsd = applyMaxStakeUsd(amountUsd);
  const degradedNow = inPolymarketDegradedMode();
  if (degradedNow && incidentBehavior === 'reduced') {
    amountUsd = Math.max(ABSOLUTE_MIN_USD, amountUsd * degradedSizeFactor);
    allowBelowMin = true;
  }
  if (cappedBy) allowBelowMin = amountUsd < orderSizeMinUsd;
  if (hasMaxStakeUsd && amountUsd < orderSizeMinUsd) allowBelowMin = true;

  // Tentative d'évaluation: on a déjà mesuré bestAsk/book/creds/balance, mais pas de placement d'ordre.
  // Permet d'avoir un breakdown même sans trade réel.
  if (amountUsd < orderSizeMinUsd && !allowBelowMin) {
    recordSkipReason('amount_below_min', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
    logSignalInRangeButNoOrder('ws', 'amount_below_min', signalWithPrice, {
      bestAskP: bestAskLive,
      amountUsd: Math.round(amountUsd * 100) / 100,
      orderSizeMinUsd,
      balanceUsd: balance != null ? Math.round(balance * 100) / 100 : null,
    });
    if (shouldLogTradeLatencyAttempt(key)) {
      logJson('info', 'Trade latency attempt (WS, no order)', {
        conditionId: key,
        timingsMs,
      });
      appendTradeLatencyHistory({
        source: 'ws',
        latencyMs: 0,
        timingsMs,
        takeSide: signalWithPrice.takeSide,
        amountUsd,
        conditionId: key,
        tokenId: signalWithPrice.tokenIdToBuy,
      });
    }
    placedKeys.delete(key); // sécurité: ne pas bloquer un éventuel trade si le wallet change
    return;
  }
  if (!(amountUsd > 0)) {
    recordSkipReason('amount_zero_after_clamp', 'ws', { conditionId: key, tokenId: signal?.tokenIdToBuy });
    logSignalInRangeButNoOrder('ws', 'amount_zero_after_clamp', signalWithPrice, {
      bestAskP: bestAskLive,
      amountUsd: Math.round((amountUsd || 0) * 100) / 100,
      balanceUsd: balance != null ? Math.round(balance * 100) / 100 : null,
    });
    return;
  }
  // Pré-signature : créer + signer l'ordre maintenant pour que placeOrder ne fasse que le POST (réduit latence au moment du trade).
  if (useMarketOrder && clobClient) {
    try {
      const worstPrice = marketWorstPriceP;
      const userMarketOrder = { tokenID: signalWithPrice.tokenIdToBuy, amount: amountUsd, side: Side.BUY, price: worstPrice };
      const signedOrder = await createSignedMarketOrder(clobClient, userMarketOrder);
      const cacheKey = getPreSignCacheKey(signalWithPrice, amountUsd);
      preSignCache.set(cacheKey, { signedOrder, expiresAt: Date.now() + PRE_SIGN_CACHE_TTL_MS });
    } catch (e) {
      logJson('info', 'WS: pré-signature ordre (non bloquant)', { error: e?.message });
    }
  }
  placedKeys.add(key);
  const tPlace0 = Date.now();
  const result = await placeMarketOrderWithPartialFillRetries(signalWithPrice, amountUsd, clobClient, {
    allowBelowMin,
    forceSingleAttempt: degradedNow && incidentBehavior === 'reduced',
    maxAttempts: degradedNow && incidentBehavior === 'reduced' ? 1 : undefined,
  });
  timingsMs.placeOrder = Date.now() - tPlace0;
  const time = new Date().toISOString();
  if (result.ok) {
    const latencyMs = Date.now() - t0;
    if (latencyMs >= executionDelayAlertMs) {
      writeHealth({ executionDelayed: true, executionDelayedAt: time });
      setPolymarketDegraded('execution_delayed', incidentDurationMs);
    } else {
      writeHealth({ executionDelayed: false });
    }
    writeHealth({ lastOrderAt: time, lastOrderSource: 'ws' });
    const fillLog = pickFillFieldsForLog(result);
    const marketEndMs = parseMarketEndDateToMs(signalWithPrice?.endDate);
    const orderData = {
      at: time,
      takeSide: signalWithPrice.takeSide,
      amountUsd,
      conditionId: key,
      tokenId: signalWithPrice.tokenIdToBuy ?? null,
      orderID: result.orderID,
      preSignCacheHit: result.preSignCacheHit,
      partialFillRetries: result.partialFillRetries ?? 0,
      orderIDs: result.orderIDs,
      clobSignerAddress: wallet?.address ?? null,
      clobSignatureType: CLOB_SIGNATURE_TYPE,
      clobFunderAddress: clobFunderAddress ?? null,
      ...(signalWithPrice?.eventSlug ? { eventSlug: String(signalWithPrice.eventSlug).slice(0, 120) } : {}),
      ...(marketEndMs != null ? { marketEndMs } : {}),
      ...fillLog,
    };
    writeLastOrder(orderData);
    appendOrderLog(orderData);
    logJson('info', 'Ordre placé (WS)', {
      takeSide: signalWithPrice.takeSide,
      amountUsd,
      orderID: result.orderID,
      latencyMs,
      timingsMs,
      preSignCacheHit: result.preSignCacheHit,
      partialFillRetries: result.partialFillRetries ?? 0,
      orderIDs: result.orderIDs,
      ...fillLog,
    });
    appendTradeLatencyHistory({
      source: 'ws',
      latencyMs,
      timingsMs,
      takeSide: signalWithPrice.takeSide,
      amountUsd,
      conditionId: key,
      tokenId: signalWithPrice.tokenIdToBuy,
      orderID: result.orderID,
      preSignCacheHit: result.preSignCacheHit ?? false,
      partialFillRetries: result.partialFillRetries ?? 0,
      orderIDs: result.orderIDs,
      ...fillLog,
    });
    const cacheHitInfo = result.preSignCacheHit ? ' [cache pré-sign hit]' : '';
    const fillConsole = formatFillConsoleSuffix(result);
    const retryInfo =
      (result.partialFillRetries ?? 0) > 0 ? ` — ${result.partialFillRetries} complément(s) FAK sur reliquat` : '';
    console.log(
      `[${time}] [WS] Ordre placé ${signalWithPrice.takeSide} — ${amountUsd.toFixed(2)} USDC demandés${fillConsole}${retryInfo} — orderID: ${result.orderID} (latence ~${Math.round(latencyMs)} ms)${cacheHitInfo}`
    );
  } else {
    const isInsufficient = isInsufficientBalanceOrAllowanceError(result?.error);
    if (!isInsufficient) placedKeys.delete(key);
    if (isRetryableExecutionError(result?.error) || isInsufficient) {
      setExecutionCooldown(key, result.error);
      notePolymarketIncidentError('ws_order_failure', result.error);
    }
    logSignalInRangeButNoOrder('ws', 'place_order_failed', signalWithPrice, {
      bestAskP: bestAskLive,
      amountUsd: Math.round(amountUsd * 100) / 100,
      error: String(result?.error || '').slice(0, 240),
    });
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
let wsLastBidAskHealthWriteMs = 0;

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
      wsLastBidAskAtMs = Date.now();
      if (wsLastBidAskAtMs - wsLastBidAskHealthWriteMs >= 2000) {
        wsLastBidAskHealthWriteMs = wsLastBidAskAtMs;
        writeHealth({ wsLastBidAskAt: new Date(wsLastBidAskAtMs).toISOString() });
      }
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
        tryPlaceOrderForSignal({ ...signal, _wsReceivedAtMs: wsLastBidAskAtMs });
      }, WS_DEBOUNCE_MS);
      wsDebounceTimers.set(assetId, { timeoutId, signal });
    } catch (_) {}
  });
  clobWs.on('close', () => {
    notePolymarketIncidentError('ws_close', 'close');
    writeHealth({ wsConnected: false, wsLastChangeAt: new Date().toISOString() });
    if (wsRefreshTimer) clearInterval(wsRefreshTimer);
    if (wsPingTimer) clearInterval(wsPingTimer);
    wsRefreshTimer = null;
    wsPingTimer = null;
    clobWs = null;
    wsReconnectTimer = setTimeout(startClobWs, WS_RECONNECT_MS);
  });
  clobWs.on('error', (err) => {
    notePolymarketIncidentError('ws_error', err);
    console.warn('WebSocket CLOB erreur:', err.message);
  });
}

/** Profiler de cycle : mesure où le temps est perdu (activer avec CYCLE_PROFILER=1). */
function createCycleProfiler() {
  const timings = {};
  return {
    async measure(name, fn) {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        timings[name] = Math.round(Date.now() - start);
      }
    },
    log() {
      const entries = Object.entries(timings).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
      console.log('--- Cycle profiler ---');
      for (const [name, ms] of entries) {
        if (ms != null) console.log(`  [${name}] ${ms}ms`);
      }
      console.log('----------------------');
    },
    getTimings() {
      return { ...timings };
    },
  };
}

const CYCLE_PROFILER = process.env.CYCLE_PROFILER === '1' || process.env.CYCLE_PROFILER === 'true';

async function run() {
  const cycleStartMs = Date.now();
  const profiler = createCycleProfiler();
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
    const signals = await profiler.measure('fetchSignals', () => fetchSignals());
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
    // Option legacy: relever la mise max périodiquement (uniquement si RECORD_LIQUIDITY_HISTORY=true).
    if (!recordMiseMaxOnSignalOnly && recordLiquidityHistory) {
      await profiler.measure('fetchActiveWindows_and_liquidity', async () => {
        try {
          const activeWindows = await fetchActiveWindows();
          logFetchActiveWindowsIfDue(activeWindows.length);
          for (const { market: m, ev, endDate, key } of activeWindows) {
            if (recordedLiquidityWindows.has(key)) continue;
            const endMs = endDate ? (typeof endDate === 'number' ? (endDate > 1e12 ? endDate : endDate * 1000) : new Date(endDate).getTime()) : Date.now();
            const merged = mergeGammaEventMarketForUpDown(ev, m);
            const tokenUp = getTokenIdToBuy(merged, 'Up');
            const tokenDown = getTokenIdToBuy(merged, 'Down');
            const liqProfileUp = {};
            const liqProfileDown = {};
            const [bookUp, bookDown] = await Promise.all([
              tokenUp ? getFilteredAskLevels(tokenUp, liqProfileUp) : Promise.resolve({ levels: [], totalUsd: null }),
              tokenDown ? getFilteredAskLevels(tokenDown, liqProfileDown) : Promise.resolve({ levels: [], totalUsd: null }),
            ]);
            const liqUp = bookUp?.totalUsd ?? null;
            const liqDown = bookDown?.totalUsd ?? null;
            const bestAskUp = Array.isArray(bookUp?.levels) && bookUp.levels.length > 0 ? Number(bookUp.levels[0].p) : null;
            const bestAskDown = Array.isArray(bookDown?.levels) && bookDown.levels.length > 0 ? Number(bookDown.levels[0].p) : null;
            bumpCycleBookStats(tokenUp ? liqProfileUp : null);
            bumpCycleBookStats(tokenDown ? liqProfileDown : null);
            let recUp = liqUp;
            let recDown = liqDown;
            if (useAvgPriceSizing) {
              if (tokenUp && Number.isFinite(bestAskUp) && liqUp != null && liqUp > 0) {
                const maxUp = getMaxUsdForAvgPriceFromLevels(bookUp.levels, bestAskUp + avgPriceTolP, liqUp);
                if (maxUp != null && maxUp > 0) recUp = maxUp;
              }
              if (tokenDown && Number.isFinite(bestAskDown) && liqDown != null && liqDown > 0) {
                const maxDown = getMaxUsdForAvgPriceFromLevels(bookDown.levels, bestAskDown + avgPriceTolP, liqDown);
                if (maxDown != null && maxDown > 0) recDown = maxDown;
              }
            }
            const liquidity = Math.max(recUp ?? 0, recDown ?? 0);
            const liqLog = liquidity > 0 ? liquidity.toFixed(0) : (liquidity === 0 ? '0' : 'null');
            logJson('info', 'Mise max créneau', {
              key: key?.slice(0, 18) + '…',
              liquidityUsd: liquidity > 0 ? liquidity : null,
              rawLiquidityUpUsd: liqUp,
              rawLiquidityDownUsd: liqDown,
              recordedUpUsd: recUp,
              recordedDownUsd: recDown,
              mode: useAvgPriceSizing ? 'avg_constrained' : 'raw_liquidity',
            });
            console.log(`[Mise max] Créneau ${key?.slice(0, 20)}… → mise max: ${liqLog} USD${useAvgPriceSizing ? ' (avg constrained)' : ''}`);
            if (liquidity > 0) {
              if (recUp != null && recUp > 0) appendLiquidityHistory({ liquidityUsd: recUp, takeSide: 'Up', source: 'active_window', signalPriceP: bestAskUp });
              if (recDown != null && recDown > 0) appendLiquidityHistory({ liquidityUsd: recDown, takeSide: 'Down', source: 'active_window', signalPriceP: bestAskDown });
              recordedLiquidityWindows.set(key, endMs);
            }
            await new Promise((r) => setTimeout(r, 150));
          }
        } catch (err) {
          console.warn('Relevé mise max (créneaux actifs):', err?.message ?? err);
        }
      });
    }
    // B) "signal -> décision" + relevé liquidité (uniquement si RECORD_LIQUIDITY_HISTORY=true)
    let decisionLogged = 0;
    if (recordLiquidityHistory) {
    await profiler.measure('signal_decision_liquidity', async () => {
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
          appendLiquidityHistory({
            liquidityUsd: liquidity,
            takeSide: s.takeSide,
            source: 'signal_decision',
            signalPriceP: s.takeSide === 'Up' ? s.priceUp : s.priceDown,
          });
          recordedLiquidityWindows.set(key, endMs);
        } else {
          console.warn(
            `Mise max non enregistrée: pas de profondeur au prix du marché (${(MIN_P * 100).toFixed(0)}–${(MAX_P * 100).toFixed(0)}¢) pour ce créneau (ou erreur API CLOB).`,
          );
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
    });
    }

    // Observabilité : `place_orders` (timing_forbidden, etc.) n’est pas exécuté si autotrade off / sans wallet —
    // le dashboard restait vide alors qu’un signal poll était bien dans [MIN_P, MAX_P] et la grille ET interdisait l’entrée.
    if (
      MARKET_MODE === '15m' &&
      Array.isArray(signals) &&
      signals.length > 0 &&
      is15mSlotEntryTimeForbiddenNow(Math.floor(Date.now() / 1000))
    ) {
      const s0 = signals.find((x) => x?.tokenIdToBuy);
      if (s0) {
        const k = getSignalKey(s0);
        const timingDetails = getTimingForbiddenDetails();
        recordSkipReason('timing_forbidden', 'poll', {
          conditionId: k,
          tokenId: s0.tokenIdToBuy,
          takeSide: s0.takeSide,
          bestAskP: pickSignalBestAskP(s0),
          ...timingDetails,
        });
        logSignalInRangeButNoOrder('poll', 'timing_forbidden', s0, { ...timingDetails });
      }
    }

    if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) return;
    if (inPolymarketDegradedMode() && incidentBehavior === 'pause') {
      recordSkipReason('degraded_mode', 'poll');
      return;
    }

    await profiler.measure('redeem', () => tryRedeemResolvedPositions());

    // Client CLOB une fois par cycle : solde via API balance-allowance (doc Polymarket), plus d’erreur RPC "could not detect network"
    let clobClient = null;
    await profiler.measure('clob_creds', async () => {
      try {
        clobClient = await buildClobClientCachedCreds();
      } catch (err) {
        notePolymarketIncidentError('clob_creds', err);
        warnClobClientIfThrottled(err);
      }
    });
    await profiler.measure('stop_loss', async () => {
      await tryStopLossForOpenPosition(clobClient);
    });

    async function getBalance() {
      const viaClob = clobClient ? await getUsdcSpendableViaClob(clobClient) : null;
      if (viaClob != null) return viaClob;
      return getUsdcBalanceRpc();
    }

    let amountUsd = orderSizeUsd;
    await profiler.measure('balance', async () => {
      if (useBalanceAsSize) {
        const viaClob = clobClient ? await getUsdcSpendableViaClob(clobClient) : null;
        const balance = viaClob != null ? viaClob : await getUsdcBalanceRpc();
        amountUsd = balance != null ? balance : orderSizeUsd;
        const spendableBufferUsd = Math.max(0.05, amountUsd * 0.003);
        if (balance != null && Number.isFinite(balance) && balance > 0) {
          amountUsd = Math.min(amountUsd, Math.max(0, balance - spendableBufferUsd));
        }
        if (viaClob != null) console.log(`Solde USDC: ${balance.toFixed(2)} (API CLOB)`);
        else if (balance != null) console.log(`Solde USDC: ${balance.toFixed(2)} (RPC secours)`);
        else console.warn('Solde USDC: CLOB + RPC indisponibles — utilisation de ORDER_SIZE_USD en secours.');
        writeBalance(balance);
        if (amountUsd < orderSizeMinUsd) return;
      } else {
        const balanceForStatus = await getBalance();
        writeBalance(balanceForStatus);
      }
    });
    // Même si le wallet est < min et qu'aucun ordre ne sera placé, on continue pour pouvoir logger
    // des timings d'évaluation (bestAsk/creds/balance/book) dans trade-latency-history.json.

    await profiler.measure('place_orders', async () => {
    for (const s of signals) {
    if (!s.tokenIdToBuy) continue;
    const key = getSignalKey(s);
    const cooldownRemainingMs = getExecutionCooldownRemainingMs(key);
    if (cooldownRemainingMs > 0) {
      recordSkipReason('cooldown_active', 'poll', { conditionId: key, tokenId: s?.tokenIdToBuy, remainingMs: cooldownRemainingMs });
      logSignalInRangeButNoOrder('poll', 'cooldown_active', s, { remainingMs: Math.round(cooldownRemainingMs) });
      continue;
    }
    if (placedKeys.has(key)) {
      recordSkipReason('already_placed_for_slot', 'poll', { conditionId: key, tokenId: s?.tokenIdToBuy });
      logSignalInRangeButNoOrder('poll', 'already_placed_for_slot', s, {});
      continue;
    }
    const t0 = Date.now();
    // En poll, le "bestAsk" provient des prix déjà inclus dans le signal (pas d'appel REST dédié),
    // donc on loggue au minimum 1ms pour que le breakdown ait une granularité exploitable.
    const timingsMs = {
      bestAsk: 1,
      creds: clobClient ? 1 : null,
      balance: null,
      book: null,
      placeOrder: null,
    };

    // Même si on ne place pas d'ordre (last minute), on loggue un breakdown attempt.
    // Sinon, trade-latency-history.json reste vide quand le bot est en "skip last-minute".
    if (shouldSkipTradeTiming(s)) {
      const timingDetails = getTimingForbiddenDetails();
      recordSkipReason('timing_forbidden', 'poll', {
        conditionId: key,
        tokenId: s?.tokenIdToBuy,
        takeSide: s?.takeSide,
        bestAskP: pickSignalBestAskP(s),
        ...timingDetails,
      });
      logSignalInRangeButNoOrder('poll', 'timing_forbidden', s, { ...timingDetails });
      let attemptAmountUsd = amountUsd;
      if (useBalanceAsSize) {
        const tBal0 = Date.now();
        const balance = await getBalance();
        timingsMs.balance = Math.max(1, Date.now() - tBal0);
        attemptAmountUsd = balance != null ? balance : orderSizeUsd;
      }
      if (needLiquidityBook) {
        const tBook0 = Date.now();
        await getLiquidityAtTargetUsd(s.tokenIdToBuy);
        timingsMs.book = Math.max(1, Date.now() - tBook0);
      } else {
        timingsMs.book = 1;
      }

      if (shouldLogTradeLatencyAttempt(key)) {
        logJson('info', 'Trade latency attempt (poll, last-minute no order)', {
          conditionId: key,
          timingsMs,
        });
        appendTradeLatencyHistory({
          source: 'poll',
          latencyMs: 0,
          timingsMs,
          takeSide: s.takeSide,
          amountUsd: attemptAmountUsd,
          conditionId: key,
          tokenId: s.tokenIdToBuy,
        });
      }
      continue;
    }

    if (useBalanceAsSize) {
      const tBal0 = Date.now();
      const balance = await getBalance();
      timingsMs.balance = Math.max(1, Date.now() - tBal0);
      amountUsd = balance != null ? balance : orderSizeUsd;
      if (amountUsd < orderSizeMinUsd) {
        recordSkipReason('amount_below_min', 'poll', { conditionId: key, tokenId: s?.tokenIdToBuy });
        logSignalInRangeButNoOrder('poll', 'amount_below_min', s, {
          amountUsd: Math.round(amountUsd * 100) / 100,
          orderSizeMinUsd,
        });
        if (recordLiquidityHistory) {
          const tBook0 = Date.now();
          const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy);
          timingsMs.book = Math.max(1, Date.now() - tBook0);
          if (liquidity != null && liquidity > 0 && !recordedLiquidityWindows.has(key)) {
            appendLiquidityHistory({
              liquidityUsd: liquidity,
              takeSide: s.takeSide,
              source: 'poll',
              signalPriceP: s.takeSide === 'Up' ? s.priceUp : s.priceDown,
            });
            const endMs = s.endDate
              ? (typeof s.endDate === 'number' ? (s.endDate > 1e12 ? s.endDate : s.endDate * 1000) : new Date(s.endDate).getTime())
              : Date.now();
            recordedLiquidityWindows.set(key, endMs);
          }
        } else {
          timingsMs.book = 1;
        }

        if (shouldLogTradeLatencyAttempt(key)) {
          logJson('info', 'Trade latency attempt (poll, no order)', {
            conditionId: key,
            timingsMs,
          });
          appendTradeLatencyHistory({
            source: 'poll',
            latencyMs: 0,
            timingsMs,
            takeSide: s.takeSide,
            amountUsd,
            conditionId: key,
            tokenId: s.tokenIdToBuy,
          });
        }
        break;
      }
    }

    let allowBelowMin = false;
    if (needLiquidityBook) {
      const tBook0 = Date.now();
      const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy);
      timingsMs.book = Math.max(1, Date.now() - tBook0);
      if (liquidity != null && liquidity > 0) {
        if (recordLiquidityHistory && !recordedLiquidityWindows.has(key)) {
          appendLiquidityHistory({
            liquidityUsd: liquidity,
            takeSide: s.takeSide,
            source: 'poll',
            signalPriceP: s.takeSide === 'Up' ? s.priceUp : s.priceDown,
          });
          const endMs = s.endDate ? (typeof s.endDate === 'number' ? (s.endDate > 1e12 ? s.endDate : s.endDate * 1000) : new Date(s.endDate).getTime()) : Date.now();
          recordedLiquidityWindows.set(key, endMs);
        }
        lastLiquidityRecordTime = Date.now();
        if (useLiquidityCap && amountUsd > liquidity) {
          amountUsd = liquidity;
          allowBelowMin = amountUsd < orderSizeMinUsd;
          console.log(`Mise plafonnée à ${amountUsd.toFixed(2)} $ (USE_LIQUIDITY_CAP, liquidité carnet)${allowBelowMin ? ' (sous min, ordre quand même)' : ''}`);
        }
      } else if (useLiquidityCap && (liquidity === null || liquidity === 0)) {
        console.warn(
          `USE_LIQUIDITY_CAP: liquidité ${(MIN_P * 100).toFixed(0)}–${(MAX_P * 100).toFixed(0)}¢ indisponible pour ce créneau (book CLOB ou erreur API)`,
        );
      }
    } else {
      timingsMs.book = 1;
    }

    amountUsd = applyMaxStakeUsd(amountUsd);
    const degradedNow = inPolymarketDegradedMode();
    if (degradedNow && incidentBehavior === 'reduced') {
      amountUsd = Math.max(ABSOLUTE_MIN_USD, amountUsd * degradedSizeFactor);
      allowBelowMin = true;
    }
    if (hasMaxStakeUsd && amountUsd < orderSizeMinUsd) allowBelowMin = true;
    if (!(amountUsd > 0)) {
      recordSkipReason('amount_zero_after_clamp', 'poll', { conditionId: key, tokenId: s?.tokenIdToBuy });
      logSignalInRangeButNoOrder('poll', 'amount_zero_after_clamp', s, {
        bestAskP: pickSignalBestAskP(s),
        amountUsd: Math.round((amountUsd || 0) * 100) / 100,
      });
      continue;
    }

    placedKeys.add(key);
    const tPlace0 = Date.now();
    const result = await placeMarketOrderWithPartialFillRetries(s, amountUsd, clobClient, {
      allowBelowMin,
      forceSingleAttempt: degradedNow && incidentBehavior === 'reduced',
      maxAttempts: degradedNow && incidentBehavior === 'reduced' ? 1 : undefined,
    });
    timingsMs.placeOrder = Date.now() - tPlace0;
    const time = new Date().toISOString();
    if (result.ok) {
      const latencyMs = Date.now() - t0;
      if (latencyMs >= executionDelayAlertMs) {
        writeHealth({ executionDelayed: true, executionDelayedAt: time });
        setPolymarketDegraded('execution_delayed', incidentDurationMs);
      } else {
        writeHealth({ executionDelayed: false });
      }
      writeHealth({ lastOrderAt: time, lastOrderSource: 'poll' });
      const fillLog = pickFillFieldsForLog(result);
      const marketEndMs = parseMarketEndDateToMs(s?.endDate);
      const orderData = {
        at: time,
        takeSide: s.takeSide,
        amountUsd,
        conditionId: key,
        tokenId: s.tokenIdToBuy ?? null,
        orderID: result.orderID,
        preSignCacheHit: result.preSignCacheHit,
        partialFillRetries: result.partialFillRetries ?? 0,
        orderIDs: result.orderIDs,
        clobSignerAddress: wallet?.address ?? null,
        clobSignatureType: CLOB_SIGNATURE_TYPE,
        clobFunderAddress: clobFunderAddress ?? null,
        ...(s?.eventSlug ? { eventSlug: String(s.eventSlug).slice(0, 120) } : {}),
        ...(marketEndMs != null ? { marketEndMs } : {}),
        ...fillLog,
      };
      writeLastOrder(orderData);
      appendOrderLog(orderData);
      logJson('info', 'Ordre placé', {
        takeSide: s.takeSide,
        amountUsd,
        orderID: result.orderID,
        latencyMs,
        timingsMs,
        preSignCacheHit: result.preSignCacheHit ?? false,
        partialFillRetries: result.partialFillRetries ?? 0,
        orderIDs: result.orderIDs,
        ...fillLog,
      });
      appendTradeLatencyHistory({
        source: 'poll',
        latencyMs,
        timingsMs,
        takeSide: s.takeSide,
        amountUsd,
        conditionId: key,
        tokenId: s.tokenIdToBuy,
        orderID: result.orderID,
        preSignCacheHit: result.preSignCacheHit ?? false,
        partialFillRetries: result.partialFillRetries ?? 0,
        orderIDs: result.orderIDs,
        ...fillLog,
      });
      const cacheHitInfo = result.preSignCacheHit ? ' [cache pré-sign hit]' : '';
      const fillConsole = formatFillConsoleSuffix(result);
      const retryInfoPoll =
        (result.partialFillRetries ?? 0) > 0 ? ` — ${result.partialFillRetries} complément(s) FAK sur reliquat` : '';
      console.log(
        `[${time}] Ordre placé ${s.takeSide} — ${amountUsd.toFixed(2)} USDC demandés${fillConsole}${retryInfoPoll} — ${key?.slice(0, 10)}… — orderID: ${result.orderID} (latence ~${Math.round(latencyMs)} ms)${cacheHitInfo}`
      );
    } else {
      const isInsufficient = isInsufficientBalanceOrAllowanceError(result?.error);
      if (!isInsufficient) placedKeys.delete(key);
      if (isRetryableExecutionError(result?.error) || isInsufficient) {
        setExecutionCooldown(key, result.error);
        notePolymarketIncidentError('poll_order_failure', result.error);
      }
      logSignalInRangeButNoOrder('poll', 'place_order_failed', s, {
        bestAskP: pickSignalBestAskP(s),
        amountUsd: Math.round(amountUsd * 100) / 100,
        error: String(result?.error || '').slice(0, 240),
      });
      logJson('error', 'Erreur ordre', { takeSide: s.takeSide, error: result.error });
      console.error(`[${time}] Erreur ${s.takeSide}: ${result.error}`);
    }
    await new Promise((r) => setTimeout(r, 350));
    }
    });
  } finally {
    if (CYCLE_PROFILER) profiler.log();
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
      cycleProfileMs: profiler.getTimings(),
    });
  }
}

async function main() {
  console.log('Bot Polymarket Bitcoin Up or Down — démarrage 24/7');
  console.log(
  `Marché: ${MARKET_MODE === '15m' ? '15 min (btc-updown-15m)' : 'horaire (bitcoin-up-or-down)'} | Pas de trade: ${MARKET_MODE === '15m' ? 'grille ET : 3 premières + 4 dernières min de chaque quart (:00,:15,:30,:45)' : '5 min avant fin'}`
);
  console.log(
    `Prix signal (poll / fetchSignals): ${signalPriceSource} — ${signalPriceSource === 'clob' ? 'best ask CLOB par token' : 'outcomePrices Gamma'} (SIGNAL_PRICE_SOURCE=gamma|clob pour forcer)`
  );
  if (walletConfigured && wallet) {
    const sizeMode = useBalanceAsSize ? 'taille = solde USDC (réinvestissement)' : `fixe ${orderSizeUsd} USDC`;
    console.log(`Wallet: ${wallet.address} | Auto: ${autoPlaceEnabled} | Ordre: ${useMarketOrder ? 'marché' : 'limite'} | ${sizeMode} | Poll: ${pollIntervalSec}s`);
    if (useMarketOrder) {
      const tifHint = marketOrderType === OrderType.FOK ? 'FOK (tout ou rien)' : 'FAK (partiel OK si carnet insuffisant)';
      console.log(
        `Ordre marché CLOB: worst price ≤ ${(marketWorstPriceP * 100).toFixed(2)}¢ | ${tifHint} — MARKET_ORDER_TIF=${marketOrderTif} MARKET_WORST_PRICE_P=${marketWorstPriceP}`
      );
      if (partialFillRetryEnabled) {
        console.log(
          `Complément FAK (reliquat): jusqu’à ${PARTIAL_FILL_RETRY_MAX_EXTRA} ordre(s) suppl. | pause ${PARTIAL_FILL_RETRY_DELAY_MS} ms | fenêtre ${PARTIAL_FILL_RETRY_MAX_WINDOW_MS} ms | reliquat min ${PARTIAL_FILL_RETRY_MIN_REMAINING_USD} USDC — PARTIAL_FILL_RETRY=false pour désactiver`
        );
        if (partialFillRetryRevalidatePrice) {
          console.log('Complément FAK: revalidation best ask CLOB entre chaque envoi (PARTIAL_FILL_RETRY_REVALIDATE_PRICE=true).');
        }
      }
    }
    if (stopLossEnabled) {
      console.log(
        `Stop-loss: activé | trigger bid < ${(stopLossTriggerPriceP * 100).toFixed(2)}¢ OU drawdown <= -${Math.abs(stopLossMaxDrawdownPct)}% | worst SELL ${(stopLossWorstPriceP * 100).toFixed(2)}¢`
      );
    } else {
      console.log('Stop-loss: désactivé (STOP_LOSS_ENABLED=false).');
    }
    if (useWebSocket) console.log('WebSocket CLOB activé (best_bid_ask) — réaction en temps réel aux changements de prix.');
    if (useLiquidityCap) console.log(`USE_LIQUIDITY_CAP=true : taille d’ordre plafonnée par la liquidité ${(MIN_P * 100).toFixed(0)}–${(MAX_PRICE_LIQUIDITY * 100).toFixed(0)}¢ (legacy).`);
    if (useAvgPriceSizing) console.log('USE_AVG_PRICE_SIZING=true : taille limitée pour avg ≤ bestAsk + tol (legacy).');
    if (recordLiquidityHistory) console.log('RECORD_LIQUIDITY_HISTORY=true : écriture liquidity-history.json + relevés signal/créneaux.');
  } else {
    console.log('Wallet: non configuré — pas de placement d’ordres. Ajoute PRIVATE_KEY dans .env puis redémarre (pm2 restart polymarket-bot).');
  }
  if (signalVisibilityLog) {
    console.log(
      `SIGNAL_VISIBILITY_LOG=true : log périodique des prix vus par le poll (hors fenêtre incl.) — throttle ${SIGNAL_VISIBILITY_LOG_MS} ms → bot.log (signal_visibility_poll).`,
    );
  }
  if (walletConfigured && !autoPlaceEnabled) {
    console.log('Autotrade désactivé — définir AUTO_PLACE_ENABLED=true pour placer des ordres.');
  }

  const allowed = await checkGeoblock();
  writeHealth({ geoblockOk: !!allowed });
  if (!allowed) {
    process.exit(1);
  }
  console.log('—');

  logJson('info', 'Bot démarré — boucle poll', {
    pid: process.pid,
    mode: MARKET_MODE,
    autoPlaceEnabled,
    recordLiquidityHistory,
    signalVisibilityLog,
    signalVisibilityLogMs: signalVisibilityLog ? SIGNAL_VISIBILITY_LOG_MS : null,
    botLogPath: BOT_JSON_LOG_FILE,
  });

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
