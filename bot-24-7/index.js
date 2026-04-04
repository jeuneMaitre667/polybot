/**
 * Bot Polymarket Bitcoin Up or Down — exécution 24/7 (Node.js)
 *
 * Étapes :
 * 1. Connexion wallet Polygon (clé privée)
 * 2. Boucle : récupérer les signaux Gamma (prix dans MIN_SIGNAL_P–MAX_SIGNAL_P, défaut 77–78 %)
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
import lagRecorder from './lag-recorder.js';
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
import { calculateMakerPrice, TICK_SIZE } from './limit-order-utils.js';
import WebSocket from 'ws';
import axios from 'axios';
import crypto from 'crypto';

// --- v7.0.0 Globals ---
export const ORDER_EXECUTION_TYPE = process.env.ORDER_EXECUTION_TYPE || 'LIMIT';
export const LIMIT_ORDER_TTL_MS = Number(process.env.LIMIT_ORDER_TTL_MS) || 30000;
export const DEEP_ORDER_ENABLED = process.env.DEEP_ORDER_ENABLED !== 'false';
export const DEEP_ORDER_OFFSET = Number(process.env.DEEP_ORDER_OFFSET) || 0.005; // 0.5% d'écart supplémentaire

// --- Smart Rate Limiter / Cloudflare (Blindage 2026) ---
function updateRateLimitFromHeaders(headers) {
  if (!headers) return;
  const limit = Number(headers['x-ratelimit-limit'] || headers['X-RateLimit-Limit']);
  const remaining = Number(headers['x-ratelimit-remaining'] || headers['X-RateLimit-Remaining']);
  const reset = Number(headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset']);
  
  if (Number.isFinite(limit)) lastRateLimitInfo.limit = limit;
  if (Number.isFinite(remaining)) lastRateLimitInfo.remaining = remaining;
  if (Number.isFinite(reset)) lastRateLimitInfo.reset = reset;
  lastRateLimitInfo.lastUpdate = Date.now();
  
  // Mettre à jour health.json pour le dashboard (Blindage 2026)
  writeHealth({ lastRateLimitInfo });
  
  // Si on approche du seuil critique (20%), on log pour le dashboard.
  if (limit > 0 && (remaining / limit) < 0.2) {
    logJson('warn', 'Approche limite Rate-Limit (Cloudflare)', { limit, remaining, reset });
  }
}

// Intercepteur global pour tous les appels axios directs (Gamma, etc.)
axios.interceptors.response.use(
  (res) => {
    updateRateLimitFromHeaders(res.headers);
    return res;
  },
  (err) => {
    if (err.response) {
      updateRateLimitFromHeaders(err.response.headers);
      if (err.response.status === 425) {
        console.warn('[Blindage 2026] ⚠️ 425 Too Early (Matching Engine Restart). Cooldown actif.');
        last425ErrorAt = Date.now();
        writeHealth({ last425ErrorAt });
      }
    }
    return Promise.reject(err);
  }
);

function checkRateLimitProactive() {
  const { limit, remaining, lastUpdate } = lastRateLimitInfo;
  const now = Date.now();
  
  // On ne se fie aux données que si elles sont récentes (< 10s)
  if (now - lastUpdate > 10000) return 0;
  
  // Si moins de 20% de quota restant, on ralentit pour éviter la file d'attente Cloudflare.
  if (limit > 0 && remaining < (limit * 0.2)) {
    const delay = Math.round(500 + Math.random() * 500); // 500-1000ms de délais volontaire
    console.warn(`[RateLimit] Seuil 20% atteint (${remaining}/${limit}). Throttling de ${delay}ms pour éviter Latency Bloat.`);
    return delay;
  }
  return 0;
}
import {
  sendTelegramAlert,
  telegramTradeAlertsEnabled,
  telegramRedeemAlertsEnabled,
  telegramBalanceDigestMs,
  telegramAlertsConfigured,
  telegramMiddayDigestEnabled,
} from './telegramAlerts.js';
import {
  computeMiddayDigestStats,
  formatMiddayDigestMessage,
  getMidnightToNoonWindowMs,
  getNoonToMidnightWindowMs,
  getFullDayWindowMs,
  getYesterdayYmdInTz,
  readOrdersLogSafe,
  getCalendarDateYmd,
  getLocalHourMinute,
} from './middayDigest.js';
import {
  get15mSlotEntryTimingDetail,
  is15mSlotEntryTimeForbiddenNow,
  ENTRY_FORBID_FIRST_MIN_RESOLVED,
  ENTRY_FORBID_LAST_MIN_RESOLVED,
} from './et15mEntryTiming.js';
import {
  mergeGammaEventMarketForUpDown,
  getAlignedUpDownGammaPrices,
  getAlignedUpDownTokenIds,
  getTokenIdForSide,
  ORDER_TYPE_FOK,
  ORDER_TYPE_GTC,
} from './gammaUpDownOrder.js';
import { isInsufficientBalanceOrAllowance, resolveSellAmountFromSpendable } from './stopLossUtils.js';
import * as simulationTrade from './simulationTrade.js';
import { getChainlinkPrice, getChainlinkPriceCached, captureStrikeAtSlotOpen, getChainlinkHealthStats } from './chainlink-price.js';
import { fetchSignals, getSignalKey, shouldSkipTradeTiming, saveBoundaryStrike, lookupBoundaryStrike } from './signal-engine.js';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_MS = 5000;
const WS_REFRESH_SUBSCRIPTIONS_MS = 30 * 1000;
const WS_PING_INTERVAL_MS = 10 * 1000; // doc Polymarket : garder la connexion alive
const WS_DEBOUNCE_MS = Number(process.env.WS_DEBOUNCE_MS) || 10; // Réduit v5.3.0 (Blindage 2026)
const SUPPORTED_ASSETS = ['BTC', 'ETH', 'SOL']; // v5.4.0 (Option 4)
const BINANCE_WS_URL = 'wss://fstream.binance.com/stream?streams=';
const OKX_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

// État global des prix Perp par Asset (v5.4.0)
// v5.4.3 : perpState converti en Map pour multi-actifs
const perpState = new Map([
  ['BTC', { binance: 0, okx: 0, hyper: 0, binanceTs: 0, okxTs: 0, hyperTs: 0 }],
  ['ETH', { binance: 0, okx: 0, hyper: 0, binanceTs: 0, okxTs: 0, hyperTs: 0 }],
  ['SOL', { binance: 0, okx: 0, hyper: 0, binanceTs: 0, okxTs: 0, hyperTs: 0 }],
]);

const OPEN_LIMIT_ORDERS = new Map(); // { conditionId: { orderId: string, at: number, price: number, asset: string, tokenId: string } }
const ACTIVE_REDEMPTIONS = new Set();
let lastRewardsFetch = 0;
let cachedRewardsData = null;

let binanceBtcPrice = 0; // Legacy global (v5.4.1: will be prioritized by current asset in perpState)
let binanceLastUpdateMs = 0;
let okxBtcPrice = 0;
let okxLastUpdateMs = 0;
let hyperliquidBtcPrice = 0;
let hyperliquidLastUpdateMs = 0;

/**
 * Calculateur de prix de consensus multi-actifs (v5.4.1)
 * Combine Binance, OKX et Hyperliquid pour l'actif demandé.
 */
function calculateConsensusPrice(asset = 'BTC') {
  const p = perpState.get(asset);
  if (!p) return 0;
  const sources = [];
  if (p.binance > 0) sources.push(p.binance);
  if (p.okx > 0) sources.push(p.okx);
  if (p.hyper > 0) sources.push(p.hyper);
  if (sources.length === 0) return (asset === 'BTC' && binanceBtcPrice > 0) ? binanceBtcPrice : 0;
  return sources.reduce((a, b) => a + b, 0) / sources.length;
}

let binanceWs = null;
let okxWs = null;
let hyperliquidWs = null;

/** Cache global des prix Polymarket (via WS) pour le SL Miroir et l'enrichissement */
const latestPrices = new Map(); // assetId -> { bestBid, bestAsk }
const ofiState = new Map(); // assetId -> { prevBidPrice, prevBidSize, ..., ofi }
// v5.4.2 : État spécifique par actif (BTC, ETH, SOL)
const assetSpecificState = new Map();
function getAssetState(asset) {
  if (!assetSpecificState.has(asset)) {
    const defaultVolMap = { BTC: 0.40, ETH: 0.50, SOL: 0.80 };
    const defaultVol = Number(process.env[`${asset}_ANNUALIZED_VOLATILITY`]) || defaultVolMap[asset] || 0.20;
    assetSpecificState.set(asset, {
      vol: defaultVol,
      priceHistory: [],
      currentSlotStrike: null
    });
  }
  return assetSpecificState.get(asset);
}

/// État global des Strikes par Asset (v5.4.0)
const assetStrikes = {
  BTC: { price: null, slotSlug: null, capturedAt: null, isOfficial: false, lastFetchPrice: null, stableCount: 0 },
  ETH: { price: null, slotSlug: null, capturedAt: null, isOfficial: false, lastFetchPrice: null, stableCount: 0 },
  SOL: { price: null, slotSlug: null, capturedAt: null, isOfficial: false, lastFetchPrice: null, stableCount: 0 },
};
const assetLastSlugs = { BTC: null, ETH: null, SOL: null };

async function fetchPolymarketStrikeOfficial(startTimeIso, endTimeIso, symbol = 'BTC') {
  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=${symbol}&eventStartTime=${startTimeIso}&variant=fifteen&endDate=${endTimeIso}`;
    const resp = await axios.get(url, { timeout: 5000 });
    if (resp.data && resp.data.openPrice != null) {
      return Number(resp.data.openPrice);
    }
  } catch (err) {
    console.warn(`[Strike] Échec capture officielle Polymarket (${startTimeIso}): ${err.message}`);
  }
  return null;
}
let lastKnownSlotSlug = null; // Pour détecter le changement de slot
let chainlinkSpotPrice = 0; // Prix Chainlink live (mis à jour à chaque cycle)
let chainlinkRoundId = null; // v5.2.0 : Pour le logging
let chainlinkAgeMs = 0; // v5.2.0 : Pour le logging

const ARBITRAGE_GAP_THRESHOLD = Number(process.env.ARBITRAGE_GAP_THRESHOLD) || 0.05;
const BTC_ANNUALIZED_VOLATILITY = Number(process.env.BTC_ANNUALIZED_VOLATILITY) || 0.40;
const POLYMARKET_FEE_RATE = 0.072; // Taux officiel pour Crypto (Crypto Fee Rate)
const FEE_SAFETY_BUFFER = 1.05; // Marge de sécurité 5% (Blindage 2026)
const DEFAULT_STAKE_USDC = 300; 

/** Vérifie si le côté du trade correspond au sens du carnet d'ordres (v5.8.2) */
function isOfiSideMatch(side, ofiScore) {
  const s = String(side || '').toLowerCase();
  const isUp = (s === 'up' || s === 'yes');
  const isDown = (s === 'down' || s === 'no');
  return (isUp && ofiScore > 0) || (isDown && ofiScore < 0);
}

/** Calculateur de multiplicateur de seuil basé sur l'OFI (v6.2.2 : Neutralisé suite à l'Audit Alpha) */
function getOfiThresholdMultiplier(asset, ofiScore, side) {
  // Audit v6.2.0 : Accuracy 14-20% (Contrarian). On repasse à 1.0 (Neutre) pour la collecte 48h.
  return 1.0;
}

console.log("=== 🛡️ Blindage 2026 v5.3.0 Engine Active ===");

const SKEW_ADJUSTMENT = Number(process.env.SKEW_ADJUSTMENT) || -0.03; // Biais BTC historique
const MAX_CHAINLINK_AGE_SEC = 8; // Sécurité Stale Chainlink (v5.2.0 : Audit Compliance)
const POLYMARKET_MAINTENANCE_DAY_UTC = 2; // Mardi
const POLYMARKET_MAINTENANCE_HOUR_UTC = 11; // 11h UTC = 13h Paris (pendant DST)
const ORDER_TYPE_ARBITRAGE = 'FOK'; // Fill-Or-Kill recommandé par la doc
const USE_KELLY_SIZING = process.env.USE_KELLY_SIZING !== 'false'; // Activé par défaut en 3.0
const strikeHistoryCacheMap = new Map(); // Cache de Strike par Slug pour le mode 15m

// --- Paramètres Arbitrage Engine 3.0 (Capital Optimization) ---
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION) || 0.25; // Quarter-Kelly
const KELLY_MAX_BANKROLL_PCT = Number(process.env.KELLY_MAX_BANKROLL_PCT) || 0.25;
const ABSOLUTE_MAX_STAKE_USD = Number(process.env.ABSOLUTE_MAX_STAKE_USD) || 200; // Cap absolu (v5.8.0)
const MAX_CONCURRENT_BTC_EXPOSURE = Number(process.env.MAX_CONCURRENT_BTC_EXPOSURE) || 15;
// v7.9.1: Per-asset exposure limits (Surgical Calibration)
const MAX_POSITIONS_PER_ASSET = {
  'BTC': 15,
  'ETH': 15,
  'SOL': 8
};
const MAX_DAILY_LOSS_USDC = 500; 
const STRIKE_DRIFT_THRESHOLD = Number(process.env.STRIKE_DRIFT_THRESHOLD) || 0.03; 

// v7.12.0: Inventory Skew Constants
const INVENTORY_CAP = 500; // parts max avant skew
const SKEW_REDUCTION_OFFSET = 0.005; // 0.5% de réduction du bid

const TARGET_PROFIT = Number(process.env.TARGET_PROFIT) || 0.05;
const MAX_LOSS = Number(process.env.MAX_LOSS) || 0.10;
const EXIT_GAP_THRESHOLD = Number(process.env.EXIT_GAP_THRESHOLD) || 0.01;

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
const DECISION_LOG_FILE = path.join(BOT_DIR, 'decisions.log');
const STOP_LOSS_METRICS_FILE = path.join(BOT_DIR, 'stop-loss-metrics.json');
const LIQUIDITY_HISTORY_FILE = path.join(BOT_DIR, 'liquidity-history.json');
const TRADE_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'trade-latency-history.json');
const CYCLE_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'cycle-latency-history.json');
const SIGNAL_DECISION_LATENCY_HISTORY_FILE = path.join(BOT_DIR, 'signal-decision-latency-history.json');
const HEALTH_FILE = path.join(BOT_DIR, 'health.json');
const ACTIVE_POSITIONS_FILE = path.join(BOT_DIR, 'active-positions.json');
const DAILY_STATS_FILE = path.join(BOT_DIR, 'daily-stats.json');
const ANALYTICS_LOG_FILE = path.join(BOT_DIR, 'analytics.log');
/** `conditionId` déjà redeemés avec succès (évite de retenter indéfiniment ; remplit le bot au fil des trades). */
const REDEEMED_CONDITION_IDS_FILE = path.join(BOT_DIR, 'redeemed-condition-ids.json');
/** État des 3 digests (matin / après-midi / journée) ; migre depuis midday-digest-last.json si besoin. */
const TELEGRAM_DIGEST_STATE_FILE = path.join(BOT_DIR, 'telegram-digest-state.json');
const MIDDAY_DIGEST_LAST_FILE = path.join(BOT_DIR, 'midday-digest-last.json');
const TELEGRAM_MIDDAY_DIGEST_TZ = (process.env.TELEGRAM_MIDDAY_DIGEST_TZ || 'Europe/Paris').trim();
const TELEGRAM_MIDDAY_DIGEST_HOUR = Math.max(0, Math.min(23, Number(process.env.TELEGRAM_MIDDAY_DIGEST_HOUR) || 12));
const TELEGRAM_MIDDAY_DIGEST_MINUTE = Math.max(0, Math.min(59, Number(process.env.TELEGRAM_MIDDAY_DIGEST_MINUTE) || 0));
const TELEGRAM_MIDNIGHT_DIGEST_HOUR = Math.max(0, Math.min(23, Number(process.env.TELEGRAM_MIDNIGHT_DIGEST_HOUR) || 0));
const TELEGRAM_MIDNIGHT_DIGEST_MINUTE = Math.max(0, Math.min(59, Number(process.env.TELEGRAM_MIDNIGHT_DIGEST_MINUTE) || 0));
const BALANCE_HISTORY_MAX = 500;
const LIQUIDITY_HISTORY_DAYS = 3;
const TRADE_LATENCY_HISTORY_DAYS = 7;
const TRADE_LATENCY_HISTORY_MAX = 2000;
const CYCLE_LATENCY_HISTORY_DAYS = 7;
const CYCLE_LATENCY_HISTORY_MAX = 5000;
const SIGNAL_DECISION_LATENCY_HISTORY_DAYS = 7;
const SIGNAL_DECISION_LATENCY_HISTORY_MAX = 10000;

// v6.2.0 : Rolling history for dashboard charts
const wsLatencyHistory = []; 
const pollLatencyHistory = [];
const LATENCY_HISTORY_MAX_SAMPLES = 100;

// v6.3.0 : Self-Healing Watchdog
let lastHeartbeatMs = Date.now();
const WATCHDOG_STALL_THRESHOLD_MS = 60_000;

function checkHeartbeat() {
  const delta = Date.now() - lastHeartbeatMs;
  if (delta > WATCHDOG_STALL_THRESHOLD_MS) {
    console.error(`[WATCHDOG] 🚨 ENGINE STALL DETECTED! Delta=${Math.round(delta)}ms. Terminating for PM2 restart...`);
    // On force la sortie pour que PM2 relance proprement
    process.exit(1);
  }
}
// Surveillance toutes les 15s
setInterval(checkHeartbeat, 15_000);

// v6.3.0 : PnL & Performance Cache
let cachedPerformanceStats = null;
async function refreshPerformanceStats() {
  const stats = await calculateSessionStats();
  if (stats) cachedPerformanceStats = stats;
}
// Rafraîchissement toutes les 60s
setInterval(refreshPerformanceStats, 60_000);
// Premier appel immédiat
setTimeout(refreshPerformanceStats, 2000);

function addLatencyHistorySample(type, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const target = type === 'ws' ? wsLatencyHistory : pollLatencyHistory;
  target.push({ t: Date.now(), v: Math.round(ms) });
  if (target.length > LATENCY_HISTORY_MAX_SAMPLES) target.shift();
}

// Assure que le fichier existe pour que le dashboard puisse agréger même si aucun trade n'a encore eu lieu.
function ensureJsonArrayFileExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
  } catch (_) {}
}
ensureJsonArrayFileExists(TRADE_LATENCY_HISTORY_FILE);
ensureJsonArrayFileExists(REDEEMED_CONDITION_IDS_FILE);

let binanceHigh24h = null;
let binanceLow24h = null;
let lastBinance24hFetchAt = 0;

async function refreshBinance24hStats() {
  if (Date.now() - lastBinance24hFetchAt < 60_000) return;
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
    if (res.data && res.data.highPrice && res.data.lowPrice) {
      binanceHigh24h = Number(res.data.highPrice);
      binanceLow24h = Number(res.data.lowPrice);
      lastBinance24hFetchAt = Date.now();
      console.log(`[Quant] 📊 Volatilité 24h rafraîchie : High ${binanceHigh24h} | Low ${binanceLow24h}`);
    }
  } catch (_) {}
}

const GAMMA_EVENTS_CACHE_MS = 200; // Débridage HFT v3.6.0
const gammaEventsCache = new Map(); // cacheKey -> { expiresAt, events, profile }
/** Fast-path "slot courant" : cache dédié du GET /events/slug (utilisé par fetchSignals). */
const GAMMA_SLOT_EVENT_CACHE_MS = Math.max(1000, Number(process.env.GAMMA_SLOT_EVENT_CACHE_MS) || 60_000);
const GAMMA_DIRECT_SLUG_TIMEOUT_MS = Math.max(500, Number(process.env.GAMMA_DIRECT_SLUG_TIMEOUT_MS) || 3500);
const gammaSlotEventCache = new Map(); // slotSlugLower -> { expiresAt, event }

function computeGammaSlotEventCacheExpiresAt(slotSlugLower, nowMs = Date.now()) {
  const base = nowMs + GAMMA_SLOT_EVENT_CACHE_MS;
  if (MARKET_MODE !== '15m') return base;
  const endMs = slotEndMsFrom15mSlug(slotSlugLower);
  if (!Number.isFinite(endMs)) return base;
  // Invalidation naturelle au changement de créneau + petite marge.
  return Math.min(base, endMs + 5000);
}

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

/** État de santé local en mémoire pour éviter les corruptions de fichier par lecture/réécriture concurrente. */
let currentHealthState = {
  wsConnected: false,
  wsLastConnectedAt: null,
  wsLastBidAskAt: null,
  lastOrderAt: null,
  lastOrderSource: null,
  at: null,
};

/** Met à jour health.json (lu par status-server). */
function writeHealth(updates, extra = {}) {
  try {
    // 1. Fusionner avec l'état en mémoire
    currentHealthState = { 
      ...currentHealthState, 
      ...updates, 
      at: new Date().toISOString() 
    };

    // 2. Enrichir avec les données globales actuelles (v5.6.1)
    const fullState = {
      ...currentHealthState,
      parkinsonVol: (binanceHigh24h && binanceLow24h) ? calculateParkinsonVol(binanceHigh24h, binanceLow24h) : null,
      perpSources: Object.fromEntries(
        [...perpState.entries()].map(([k, v]) => [k, { ...v, lastUpdate: Math.max(v.binanceTs || 0, v.okxTs || 0, v.hyperTs || 0) }])
      ),
      chainlinkSources: Object.fromEntries(
        SUPPORTED_ASSETS.map(asset => [asset, getChainlinkHealthStats(asset)])
      ),
      assetStates: Object.fromEntries(
        [...assetSpecificState.entries()].map(([asset, state]) => [asset, {
          realizedVol60m: state.vol,
          currentSlot: state.currentSlotStrike?.slotSlug || null,
          strike: state.currentSlotStrike?.strike || null,
          ofiScore: (() => {
            let total = 0; let count = 0;
            for (const [tid, o] of ofiState.entries()) {
              const sig = wsState.tokenToSignal.get(tid);
              if (sig && sig.asset === asset) {
                total += (sig.takeSide === 'Up' ? o.ofi : -o.ofi);
                count++;
              }
            }
            return count > 0 ? total / count : 0;
          })(),
          strikeLocked: state.currentSlotStrike?.isOfficial || false
        }])
      ),
      lastRateLimitInfo: typeof lastRateLimitInfo !== 'undefined' ? lastRateLimitInfo : null,
      isMaintenance: isMaintenanceWindow(),
      kellyFraction: KELLY_FRACTION,
      kellyMaxBankrollPct: KELLY_MAX_BANKROLL_PCT,
      maxConcurrentPositions: MAX_CONCURRENT_BTC_EXPOSURE,
      availableCapital: typeof availableCapital !== 'undefined' ? availableCapital : null,
      uptimeStart: process.uptime(), // Secondes depuis démarrage
      // v6.2.0 : Historisation pour les charts
      latencyHistory: {
        ws: wsLatencyHistory,
        poll: pollLatencyHistory
      },
      performance: cachedPerformanceStats || {
        totalVolume: 0,
        netProfit: 0,
        winRatePct: 0,
        tradeCount: 0,
        updatedAt: new Date().toISOString()
      },
      openLimitOrders: OPEN_LIMIT_ORDERS.size,
      executionMode: ORDER_EXECUTION_TYPE,
      rewards: cachedRewardsData,
      trendHistory: (currentHealthState && currentHealthState.trendHistory) || [],
      equityHistory: (currentHealthState && currentHealthState.equityHistory) || []
    };

    // v7.4.0 Analytics: Store trends every cycle (throttled by 5m in caller usually)
    const maxReward = (cachedRewardsData && Array.isArray(cachedRewardsData)) ? Math.max(...(cachedRewardsData.map(r => Number(r.reward_percentage) || 0))) : 0;
    const currentVol = (fullState.performance && fullState.performance.totalVolume) || 0;
    
    // Only push if time passed > 5m or first point
    const lastPoint = fullState.trendHistory[fullState.trendHistory.length - 1];
    if (!lastPoint || (Date.now() - new Date(lastPoint.t).getTime() > 300000)) {
        fullState.trendHistory.push({
            t: new Date().toISOString(),
            vol: currentVol,
            rew: maxReward
        });
        if (fullState.trendHistory.length > 100) fullState.trendHistory.shift();
    }

    // v7.6.0 PnL Logic: Store equity trends (v7.7.1: Robustness fix)
    const extraVal = typeof extra !== 'undefined' ? extra : {};
    if (extraVal && extraVal.totalUsd) {
       const lastEq = fullState.equityHistory[fullState.equityHistory.length - 1];
       if (!lastEq || (Date.now() - new Date(lastEq.t).getTime() > 300000)) {
           fullState.equityHistory.push({
               t: new Date().toISOString(),
               v: Number(extraVal.totalUsd).toFixed(2)
           });
           if (fullState.equityHistory.length > 100) fullState.equityHistory.shift();
       }
    }

    // 3. Écriture atomique
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(fullState, null, 2), 'utf8');
  } catch (e) {
    console.error('[health] writeHealth échoué:', e?.message ?? e);
  }
}

function readStopLossMetrics() {
  const base = {
    triggered: 0,
    filled: 0,
    failed: 0,
    partial: 0,
    withRetries: 0,
    sumFillRatio: 0,
    fillRatioSamples: 0,
    sumTriggerToFillMs: 0,
    triggerToFillSamples: 0,
    sumSlippageCents: 0,
    slippageSamples: 0,
    last: { at: null, conditionId: null, status: null, error: null },
  };
  try {
    const raw = fs.readFileSync(STOP_LOSS_METRICS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    return { ...base, ...parsed, last: { ...base.last, ...(parsed.last || {}) } };
  } catch (_) {
    return base;
  }
}

function writeDailyStats(next) {
  try {
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(next), 'utf8');
  } catch (_) {}
}

function readDailyStats() {
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const base = { date: now, dailyPnl: 0, consecutiveLosses: 0 };
  try {
    const raw = fs.readFileSync(DAILY_STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.date !== now) return base;
    return { ...base, ...parsed };
  } catch (_) {
    return base;
  }
}

function writeActivePositions(positions) {
  try {
    fs.writeFileSync(ACTIVE_POSITIONS_FILE, JSON.stringify(positions), 'utf8');
  } catch (_) {}
}

async function getBalance() {
  const viaClob = clobClient ? await getUsdcSpendableViaClob(clobClient) : null;
  if (viaClob != null) return viaClob;
  return getUsdcBalanceRpc();
}

function readActivePositions() {
  try {
    if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return [];
    const raw = fs.readFileSync(ACTIVE_POSITIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/** 7.13.0: Met à jour une position spécifique dans active-positions.json */
function updateActivePosition(pos) {
  if (!pos || !pos.conditionId) return;
  const positions = readActivePositions();
  const idx = positions.findIndex(p => p.conditionId === pos.conditionId);
  if (idx !== -1) {
    positions[idx] = { ...positions[idx], ...pos };
    writeActivePositions(positions);
  }
}

async function updateActivePositionsFromFill(fill) {
   try {
      const positions = readActivePositions();
      console.log(`[Sync] 📡 Fill detected (${fill.side}). Updating active positions...`);
      
      if (fill.side === 'buy' || fill.side === 'BUY') {
         positions.push({
            at: new Date().toISOString(),
            side: fill.side,
            asset: fill.asset,
            underlying: fill.asset,
            amountUsd: Number(fill.filledUsdc || fill.size * fill.price || 0),
            price: Number(fill.price),
            tokenId: fill.asset_id || fill.tokenId,
            resolved: false
         });
      } else {
         // Sell: On marque la position correspondante comme résolue (simplifié: on retire la plus ancienne)
         const idx = positions.findIndex(p => !p.resolved && (p.underlying === fill.asset || p.tokenId === fill.asset_id));
         if (idx !== -1) positions.splice(idx, 1);
      }
      
      fs.writeFileSync(ACTIVE_POSITIONS_FILE, JSON.stringify(positions, null, 2));
      // Force immediate balance refresh
      getBalance().then(b => writeHealth({ balance: b.toFixed(2) }));
      return true;
   } catch (err) {
      console.error(`[Sync] ❌ Update failed: ${err.message}`);
      return false;
   }
}

function recordStopLossMetric(event, payload = {}) {
  const m = readStopLossMetrics();
  const nowIso = new Date().toISOString();
  if (event === 'triggered') m.triggered += 1;
  if (event === 'filled') m.filled += 1;
  if (event === 'failed') m.failed += 1;

  if (event === 'filled') {
    if (Number.isFinite(payload?.fillRatio)) {
      m.sumFillRatio += Number(payload.fillRatio);
      m.fillRatioSamples += 1;
    }
    if (Number.isFinite(payload?.retries) && payload.retries > 0) m.withRetries += 1;
    if (Number.isFinite(payload?.remainingTokens) && payload.remainingTokens > 0.00001) m.partial += 1;
    if (Number.isFinite(payload?.triggeredAtMs)) {
      const dt = Date.now() - Number(payload.triggeredAtMs);
      if (Number.isFinite(dt) && dt >= 0) {
        m.sumTriggerToFillMs += dt;
        m.triggerToFillSamples += 1;
      }
    }
    if (Number.isFinite(payload?.triggerPriceP) && Number.isFinite(payload?.averageFillPriceP)) {
      const slippageCents = (Number(payload.triggerPriceP) - Number(payload.averageFillPriceP)) * 100;
      if (Number.isFinite(slippageCents)) {
        m.sumSlippageCents += slippageCents;
        m.slippageSamples += 1;
      }
    }
  }

  m.last = {
    at: nowIso,
    conditionId: payload?.conditionId ?? null,
    status: event,
    error: payload?.errorHint ? String(payload.errorHint).slice(0, 180) : null,
  };
  writeStopLossMetrics(m);
  writeHealth({
    stopLossMetrics: {
      triggered: m.triggered,
      filled: m.filled,
      failed: m.failed,
      partial: m.partial,
      withRetries: m.withRetries,
      avgFillRatio: m.fillRatioSamples > 0 ? m.sumFillRatio / m.fillRatioSamples : null,
      avgTriggerToFillMs: m.triggerToFillSamples > 0 ? Math.round(m.sumTriggerToFillMs / m.triggerToFillSamples) : null,
      avgSlippageCents: m.slippageSamples > 0 ? Math.round((m.sumSlippageCents / m.slippageSamples) * 100) / 100 : null,
      last: m.last,
    },
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ——— Config ———
const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';
const CLOB_HOST = 'https://clob.polymarket.com';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';
const CLOB_PRICE_URL = 'https://clob.polymarket.com/price';
const CHAIN_ID = 137;
// Fenêtre de prix pour signaux et mise max : 77 % – 78 % (override MIN_SIGNAL_P / MAX_SIGNAL_P dans .env).
const MIN_P = Number(process.env.MIN_SIGNAL_P) || 0.77;
const MAX_P = Number(process.env.MAX_SIGNAL_P) || 0.78;
const SIGNAL_MIN_DWELL_MS = Math.max(0, Number(process.env.SIGNAL_MIN_DWELL_SEC) * 1000 || 1000);
const signalEntryTimes = new Map(); // tokenId -> premier instant vu en ms
const MAX_PRICE_LIQUIDITY = Number(process.env.MAX_PRICE_LIQUIDITY) || 0.78;
/**
 * Plafond worst price pour les ordres marché BUY (prix max accepté pour le matching), ex. 0.99 = 99¢.
 * Indépendant de MAX_SIGNAL_P (fenêtre de détection du signal, ex. 77–78 %).
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
const ETHEREUM_UP_DOWN_15M_SLUG = 'eth-updown-15m'; // v5.4.0
const SOLANA_UP_DOWN_15M_SLUG = 'sol-updown-15m'; // v5.4.0
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
const polygonRpc = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const polygonRpcFallbacks = (
  process.env.POLYGON_RPC_FALLBACKS ||
  'https://1rpc.io/matic,https://rpc.ankr.com/polygon,https://polygon.llamarpc.com'
).split(',').map(u => u.trim()).filter(Boolean);
/** Montant minimum pour placer un ordre (USDC). En dessous, on skip. Défaut 1. */
const orderSizeMinUsd = Number(process.env.ORDER_SIZE_MIN_USD) || 1;
/** Si true, la taille de chaque ordre = solde USDC du wallet (réinvestissement des gains). Sinon ordre fixe ORDER_SIZE_USD. */
const useBalanceAsSize = process.env.USE_BALANCE_AS_SIZE !== 'false';
const orderSizeUsd = Number(process.env.ORDER_SIZE_USD) || 10;
 
/**
 * Budget “réinvestissement uniquement des gains”.
 * Mode: reserve_excess_from_start
 * - On “fige” un excès de capital au démarrage (ex: wallet=15, startStake=10 => réserve 5).
 * - Le bot trade avec (balance - réserve), donc seul le capital au-dessus de la mise de départ est réinvesti.
 * - La réserve est persistée dans budget-state.json pour rester stable après redémarrage.
 */
const botBudgetMode = process.env.BOT_BUDGET_MODE?.trim() || '';
const budgetModeReserveExcessFromStart = botBudgetMode === 'reserve_excess_from_start';
const botStartStakeUsd = Math.max(1.0, Number(process.env.BOT_START_STAKE_USD) || orderSizeUsd);
const botReservedExtraUsdOverride = Number(process.env.BOT_RESERVED_EXTRA_USD);
const hasBotReservedExtraUsdOverride = Number.isFinite(botReservedExtraUsdOverride) && botReservedExtraUsdOverride >= 0;

const BUDGET_STATE_FILE = path.join(BOT_DIR, 'budget-state.json');
let budgetStateLoaded = false;
/** @type {{ mode: string, startStakeUsd: number, reservedExtraUsd: number, seedBalanceUsd: number, createdAtMs: number } | null} */
let budgetState = null;

function loadBudgetStateIfNeeded() {
  if (!budgetModeReserveExcessFromStart) return;
  if (budgetStateLoaded) return;
  budgetStateLoaded = true;
  try {
    const raw = fs.readFileSync(BUDGET_STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    const reservedExtraUsd = Number(obj.reservedExtraUsd);
    const startStakeUsd = Number(obj.startStakeUsd);
    if (!Number.isFinite(reservedExtraUsd) || !Number.isFinite(startStakeUsd)) return;
    budgetState = {
      mode: String(obj.mode || botBudgetMode),
      startStakeUsd,
      reservedExtraUsd,
      seedBalanceUsd: Number(obj.seedBalanceUsd ?? 0),
      createdAtMs: Number(obj.createdAtMs ?? Date.now()),
    };
  } catch (_) {
    // initialisé au premier sizing effectif
  }
}

function persistBudgetState(next) {
  if (!budgetModeReserveExcessFromStart) return;
  try {
    const tmp = BUDGET_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 0) + '\n', 'utf8');
    fs.renameSync(tmp, BUDGET_STATE_FILE);
  } catch (e) {
    console.warn('[Budget] impossible de persister budget-state.json:', e?.message || e);
  }
}

function ensureBudgetStateInitialized(seedBalanceUsd) {
  loadBudgetStateIfNeeded();
  if (budgetState) return budgetState;
  if (!Number.isFinite(seedBalanceUsd) || seedBalanceUsd <= 0) return null;

  const reservedExtraUsd = hasBotReservedExtraUsdOverride
    ? Math.max(0, botReservedExtraUsdOverride)
    : Math.max(0, seedBalanceUsd - botStartStakeUsd);

  const next = {
    mode: botBudgetMode,
    startStakeUsd: botStartStakeUsd,
    reservedExtraUsd,
    seedBalanceUsd,
    createdAtMs: Date.now(),
  };
  budgetState = next;
  persistBudgetState(next);
  return budgetState;
}

/** Solde “effectif” utilisé pour sizing, une fois la réserve excès retirée. */
function getEffectiveBalanceForSizing(balanceUsd) {
  if (!budgetModeReserveExcessFromStart) return balanceUsd;
  if (!Number.isFinite(balanceUsd)) return null;
  const st = ensureBudgetStateInitialized(balanceUsd);
  if (!st) return null;
  const reservedExtraUsd = st.reservedExtraUsd ?? 0;
  return Math.max(0, balanceUsd - reservedExtraUsd);
}
/**
 * Plafond fixe de taille d'ordre (USDC), appliqué après solde / liquidité.
 * Remplace l'intérêt de la « mise max » carnet si USE_LIQUIDITY_CAP / USE_AVG_PRICE_SIZING sont désactivés.
 * Défaut **500** si variable absente (réinvestissement plafonné). `MAX_STAKE_USD=0` désactive le plafond.
 */
const maxStakeUsdEnv = process.env.MAX_STAKE_USD;
const maxStakeUsd =
  maxStakeUsdEnv !== undefined && String(maxStakeUsdEnv).trim() !== ''
    ? Number(maxStakeUsdEnv)
    : 500;
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
/** Cache court pour éviter de refaire un fetchSignals complet à chaque tick. 0 = désactivé. */
const fetchSignalsCacheMsRaw = Number(process.env.FETCH_SIGNALS_CACHE_MS);
const FETCH_SIGNALS_CACHE_MS = Math.max(
  0,
  Number.isFinite(fetchSignalsCacheMsRaw) ? fetchSignalsCacheMsRaw : 1200
);
/** Boucle rapide dédiée au SL (indépendante du cycle poll lourd). 0 = désactivée. */
const stopLossFastIntervalMsRaw = Number(process.env.STOP_LOSS_FAST_INTERVAL_MS);
const STOP_LOSS_FAST_INTERVAL_MS = Math.max(
  0,
  Number.isFinite(stopLossFastIntervalMsRaw) ? stopLossFastIntervalMsRaw : 150
);
/** Priorise l'entrée en position: reporte les relevés de liquidité lourds si un signal est présent. */
const entryFastPathEnabled = process.env.ENTRY_FAST_PATH_ENABLED !== 'false';
/** Placer les ordres en auto (défaut: true). Mettre à false pour faire tourner le bot sans trader. */
/** Autotrade désactivé par défaut — les deux bots (1h / 15m) doivent avoir AUTO_PLACE_ENABLED=true pour placer des ordres. */
const autoPlaceEnabled = process.env.AUTO_PLACE_ENABLED === 'true';
/** Simulation : solde virtuel (fichier simulation-paper.json), mêmes signaux / sizing / Telegram [PAPER], aucun ordre CLOB réel. */
const simulationTradeEnabled = simulationTrade.isSimulationTradeEnabled();
/** Garde-fou: couper la position avant résolution si le bid du côté acheté passe sous un seuil absolu. */
const stopLossEnabled = process.env.STOP_LOSS_ENABLED !== 'false';
const stopLossTriggerPriceP = Math.max(0.01, Math.min(0.99, Number(process.env.STOP_LOSS_TRIGGER_PRICE_P) || 0.6));
/** Désactiver la condition drawdown avec STOP_LOSS_DRAWDOWN_ENABLED=false (le SL ne déclenche alors que sur le prix). */
const stopLossDrawdownEnabled = process.env.STOP_LOSS_DRAWDOWN_ENABLED !== 'false';
/** Option hybride: déclenchement aussi sur drawdown max fixe (en %) depuis le prix d’entrée. */
const stopLossMaxDrawdownPct = Math.max(1, Math.min(95, Number(process.env.STOP_LOSS_MAX_DRAWDOWN_PCT) || 30));
/** Prix mini accepté pour une vente stop-loss au marché (évite une exécution à 0). */
const stopLossWorstPriceP = Math.max(0.001, Math.min(0.99, Number(process.env.STOP_LOSS_WORST_PRICE_P) || 0.01));
/** Délai mini après entrée avant d'armer le stop-loss (évite les déclenchements instantanés). */
const STOP_LOSS_MIN_HOLD_MS = Math.max(0, Number(process.env.STOP_LOSS_MIN_HOLD_MS) || 10_000);
/** Backoff entre tentatives stop-loss sur le même conditionId. */
const stopLossRetryBackoffMsRaw = Number(process.env.STOP_LOSS_RETRY_BACKOFF_MS);
// Autorise des valeurs basses (ex. 1000ms) pour retenter rapidement une sortie stop-loss en fin de créneau.
const STOP_LOSS_RETRY_BACKOFF_MS = Math.max(
  0,
  Number.isFinite(stopLossRetryBackoffMsRaw) ? stopLossRetryBackoffMsRaw : 20_000
);
/** Retries FAK dans le même passage après « no match » / non rempli, avec bid rafraîchi. 0 = une seule tentative. */
const STOP_LOSS_IMMEDIATE_RETRY_MAX = Math.max(
  0,
  Math.min(15, Number(process.env.STOP_LOSS_IMMEDIATE_RETRY_MAX) || 3)
);
const STOP_LOSS_IMMEDIATE_RETRY_DELAY_MS = Math.max(
  0,
  Number(process.env.STOP_LOSS_IMMEDIATE_RETRY_DELAY_MS) || 50
);
/** Retry du reliquat après un SL partiellement rempli (SELL FAK). */
const stopLossPartialRetryEnabled = process.env.STOP_LOSS_PARTIAL_RETRY !== 'false';
const STOP_LOSS_PARTIAL_RETRY_MAX_EXTRA = Math.max(0, Math.min(20, Number(process.env.STOP_LOSS_PARTIAL_RETRY_MAX_EXTRA) || 5));
const STOP_LOSS_PARTIAL_RETRY_DELAY_MS = Math.max(0, Number(process.env.STOP_LOSS_PARTIAL_RETRY_DELAY_MS) || 400);
const STOP_LOSS_PARTIAL_RETRY_MAX_WINDOW_MS = Math.max(500, Number(process.env.STOP_LOSS_PARTIAL_RETRY_MAX_WINDOW_MS) || 15_000);
const STOP_LOSS_PARTIAL_RETRY_MIN_REMAINING_TOKENS = Math.max(
  0.000001,
  Number(process.env.STOP_LOSS_PARTIAL_RETRY_MIN_REMAINING_TOKENS) || 0.00001
);
/** Escalade Telegram si la position reste ouverte après déclenchement SL. */
const STOP_LOSS_ESCALATION_MS = Math.max(10_000, Number(process.env.STOP_LOSS_ESCALATION_MS) || 60_000);


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
    : 60_000; // Forçons 1 minute par défaut pour éviter les conflits de solde entre créneaux
/**
 * Si REDEEM_AFTER_MARKET_END_MS > 0 et qu’un trade n’a ni marketEndMs ni endDate dans les logs : sans ça, le bot tentait quand même le redeem → erreurs / Telegram avant fin de créneau.
 * Défaut **false** : sans fin de marché connue pour ce conditionId, on ne tente pas le redeem. `REDEEM_ALLOW_UNKNOWN_MARKET_END_MS=true` réactive l’ancien comportement.
 */
const REDEEM_ALLOW_UNKNOWN_MARKET_END_MS =
  String(process.env.REDEEM_ALLOW_UNKNOWN_MARKET_END_MS || '').trim().toLowerCase() === 'true';
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
const latencyAbnormalAlertMs = Math.max(500, Number(process.env.ALERT_TELEGRAM_LATENCY_MS) || 1500);
const latencyAbnormalAlertsEnabled = process.env.ALERT_TELEGRAM_LATENCY !== 'false';
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
/** Une seule alerte Telegram « échec redeem » par conditionId jusqu’au succès (évite spam à chaque retry / cycle). */
// Caching des signaux par ASSET (v5.4.0)
const fetchSignalsCacheEntries = new Map(); // asset -> { expiresAt, signals, createdAt }
const fetchSignalsInFlightMap = new Map();  // asset -> Promise
const fetchSignalsCacheHitCount = new Map();
const fetchSignalsCacheMissCount = new Map();

// Initialisation globale
SUPPORTED_ASSETS.forEach(a => {
  fetchSignalsCacheHitCount.set(a, 0);
  fetchSignalsCacheMissCount.set(a, 0);
});
const redeemTelegramFailureNotified = new Set();

/** Stop-loss Telegram : évite le spam sur un même `conditionId`. */
const stopLossTelegramTriggeredNotified = new Set();
const stopLossTelegramFilledNotified = new Set();
const stopLossTelegramExitFailedNotified = new Set();
const stopLossTelegramEscalatedNotified = new Set();
const stopLossTelegramRecoveredNotified = new Set();
const stopLossFirstTriggeredAtByCondition = new Map();
let stopLossPassBusy = false;
let fetchSignalsCacheEntry = null;
let fetchSignalsInFlight = null;
const fetchSignalsPerfWindowMs = [];
let fetchSignalsPerfLastLogAt = 0;
let fetchSignalsBreakdownLastLogAt = 0;

function pushFetchSignalsPerf(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  fetchSignalsPerfWindowMs.push(ms);
  if (fetchSignalsPerfWindowMs.length > 300) fetchSignalsPerfWindowMs.shift();
}

function percentileFromSorted(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = Math.min(sortedValues.length - 1, Math.floor(clamped * (sortedValues.length - 1)));
  return sortedValues[idx];
}

function maybeLogFetchSignalsPerf() {
  const now = Date.now();
  if (now - fetchSignalsPerfLastLogAt < 60_000) return;
  fetchSignalsPerfLastLogAt = now;
  if (!fetchSignalsPerfWindowMs.length) return;
  const sorted = [...fetchSignalsPerfWindowMs].sort((a, b) => a - b);
  const p50 = percentileFromSorted(sorted, 0.5);
  const p95 = percentileFromSorted(sorted, 0.95);
  const max = sorted[sorted.length - 1];
  const total = fetchSignalsCacheHitCount + fetchSignalsCacheMissCount;
  const hitRatePct = total > 0 ? Math.round((fetchSignalsCacheHitCount / total) * 100) : 0;
  console.log(
    `[fetchSignals_perf] cache=${FETCH_SIGNALS_CACHE_MS}ms | samples=${sorted.length} | p50=${Math.round(p50 ?? 0)}ms | p95=${Math.round(p95 ?? 0)}ms | max=${Math.round(max ?? 0)}ms | cache_hit_rate=${hitRatePct}% (${fetchSignalsCacheHitCount}/${total})`
  );
}

function maybeLogFetchSignalsBreakdown(profile) {
  if (!profile || typeof profile !== 'object') return;
  if (!CYCLE_PROFILER) return;
  const totalMs = Number(profile.totalMs);
  if (!Number.isFinite(totalMs) || totalMs < 1500) return;
  const now = Date.now();
  if (now - fetchSignalsBreakdownLastLogAt < 20_000) return;
  fetchSignalsBreakdownLastLogAt = now;
  console.log(
    `[fetchSignals_breakdown] total=${Math.round(totalMs)}ms eventsFetch=${Math.round(profile.eventsFetchMs ?? 0)}ms resolve15m=${Math.round(profile.resolve15mMs ?? 0)}ms loop=${Math.round(profile.loopMs ?? 0)}ms priceLookups=${profile.priceLookups ?? 0} priceAvg=${Math.round(profile.priceLookupMsAvg ?? 0)}ms eventsRaw=${profile.eventCountRaw ?? 0} eventsAfter=${profile.eventCountAfterResolve ?? 0} markets=${profile.marketCountVisited ?? 0} strategy=${profile.strategy ?? 'n/a'}`
  );
}

function telegramStopLossAlertsEnabled() {
  // Par défaut activé si bot Telegram configuré, désactivable via ALERT_TELEGRAM_STOPLOSS=false
  return telegramAlertsConfigured() && process.env.ALERT_TELEGRAM_STOPLOSS !== 'false';
}

function getAssetBranding(asset) {
  if (!asset) return { emoji: '🤖', label: 'Bot' };
  const up = String(asset).toUpperCase();
  if (up === 'BTC') return { emoji: '🟠', label: 'BTC' };
  if (up === 'ETH') return { emoji: '🔵', label: 'ETH' };
  if (up === 'SOL') return { emoji: '🟣', label: 'SOL' };
  return { emoji: '💎', label: up };
}

async function notifyTelegramStopLossTriggered(p) {
  if (!telegramStopLossAlertsEnabled()) return;
  const cid = String(p?.conditionId || '').trim();
  if (!cid || stopLossTelegramTriggeredNotified.has(cid)) return;
  stopLossTelegramTriggeredNotified.add(cid);

  try {
    const reason = p?.triggerReason ?? '—';
    const entryCents = Number.isFinite(p?.entryPriceP) ? p.entryPriceP * 100 : null;
    const bestBidCents = Number.isFinite(p?.bestBidP) ? p.bestBidP * 100 : null;
    const triggerCents = Number.isFinite(p?.stopLossTriggerPriceP) ? p.stopLossTriggerPriceP * 100 : null;
    const pre = p?.simulationTrade ? '[PAPER] ' : '';
    const brand = getAssetBranding(p?.underlying || p?.asset);
    const lines = [
      `${pre}${brand.emoji} Stop-loss déclenché (${reason})`,
      `Asset : ${brand.label}`,
      `conditionId : ${cid.slice(0, 20)}…`,
      `takeSide : ${p?.takeSide ?? '?'}`,
      `entry : ${entryCents != null ? `${entryCents.toFixed(2)}¢` : '—'}`,
      `bestBid : ${bestBidCents != null ? `${bestBidCents.toFixed(2)}¢` : '—'}`,
      `drawdown : ${p?.drawdownPct != null && Number.isFinite(p.drawdownPct) ? p.drawdownPct.toFixed(2) : '—'}%`,
      `triggerPx : ${triggerCents != null ? `${triggerCents.toFixed(2)}¢` : '—'}`,
      `maxDD : ${p?.stopLossMaxDrawdownPct != null && Number.isFinite(p.stopLossMaxDrawdownPct) ? p.stopLossMaxDrawdownPct.toFixed(0) : '—'}%`,
    ];
    if (p?.stopLossWorstPricePUsed != null && Number.isFinite(p.stopLossWorstPricePUsed)) {
      lines.push(`worst SELL utilisé : ${(p.stopLossWorstPricePUsed * 100).toFixed(2)}¢`);
    }
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify stop-loss triggered:', e?.message || e);
  }
}

async function notifyTelegramStopLossFilled(p) {
  if (!telegramStopLossAlertsEnabled()) return;
  const cid = String(p?.conditionId || '').trim();
  if (!cid || stopLossTelegramFilledNotified.has(cid)) return;
  stopLossTelegramFilledNotified.add(cid);

  try {
    const brand = getAssetBranding(p?.underlying || p?.asset);
    const lines = [
      `${pre}${brand.emoji} Stop-loss vente remplie`,
      `Asset : ${brand.label}`,
      `conditionId : ${cid.slice(0, 20)}…`,
      `takeSide : ${p?.takeSide ?? '?'}`,
      `filled : ${p?.filledUsdc != null && Number.isFinite(p.filledUsdc) ? p.filledUsdc.toFixed(2) : '?'} USDC`,
      `filledTokens : ${p?.filledOutcomeTokens != null && Number.isFinite(p.filledOutcomeTokens) ? p.filledOutcomeTokens : '?'}`,
      p?.fillRatio != null && Number.isFinite(p.fillRatio) ? `fillRatio : ${(Number(p.fillRatio) * 100).toFixed(1)} %` : '',
      p?.orderID ? `orderID : ${p.orderID}` : '',
    ].filter(Boolean);
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify stop-loss filled:', e?.message || e);
  }
}

async function notifyTelegramStopLossExitFailed(p) {
  if (!telegramStopLossAlertsEnabled()) return;
  const cid = String(p?.conditionId || '').trim();
  if (!cid || stopLossTelegramExitFailedNotified.has(cid)) return;
  stopLossTelegramExitFailedNotified.add(cid);
  try {
    const brand = getAssetBranding(p?.underlying || p?.asset);
    const lines = [
      `${pre}${brand.emoji} Stop-loss automatique refusé`,
      `Asset : ${brand.label}`,
      `conditionId : ${cid.slice(0, 20)}…`,
      `takeSide : ${p?.takeSide ?? '?'}`,
      p?.errorHint ? `raison : ${String(p.errorHint).slice(0, 180)}` : '',
      p?.tokensToSell != null && Number.isFinite(p.tokensToSell) ? `tokens visés : ${p.tokensToSell}` : '',
      p?.spendableTokens != null && Number.isFinite(p.spendableTokens) ? `tokens dispo CLOB : ${p.spendableTokens}` : '',
      p?.orderID ? `orderID : ${p.orderID}` : '',
    ].filter(Boolean);
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify stop-loss exit failed:', e?.message || e);
  }
}

async function notifyTelegramStopLossEscalation(p) {
  if (!telegramStopLossAlertsEnabled()) return;
  const cid = String(p?.conditionId || '').trim();
  if (!cid || stopLossTelegramEscalatedNotified.has(cid)) return;
  stopLossTelegramEscalatedNotified.add(cid);
  try {
    const brand = getAssetBranding(p?.underlying || p?.asset);
    const pre = p?.simulationTrade ? '[PAPER] ' : '';
    const lines = [
      `${pre}🚨 ${brand.emoji} Escalade SL: position non clôturée`,
      `Asset : ${brand.label}`,
      `conditionId : ${cid.slice(0, 20)}…`,
      `takeSide : ${p?.takeSide ?? '?'}`,
      Number.isFinite(p?.openSinceMs) ? `ouvert depuis : ${Math.round(Number(p.openSinceMs) / 1000)}s` : '',
      p?.lastErrorHint ? `dernier rejet : ${String(p.lastErrorHint).slice(0, 180)}` : '',
    ].filter(Boolean);
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify stop-loss escalation:', e?.message || e);
  }
}

async function notifyTelegramStopLossRecoveredLater(p) {
  if (!telegramStopLossAlertsEnabled()) return;
  const cid = String(p?.conditionId || '').trim();
  if (!cid || stopLossTelegramRecoveredNotified.has(cid)) return;
  stopLossTelegramRecoveredNotified.add(cid);
  try {
    const pre = p?.simulationTrade ? '[PAPER] ' : '';
    const lines = [
      `${pre}ℹ️ SL rattrapé: sortie détectée a posteriori`,
      `conditionId : ${cid.slice(0, 20)}…`,
      `takeSide : ${p?.takeSide ?? '?'}`,
      p?.detail ? `détail : ${String(p.detail).slice(0, 180)}` : '',
    ].filter(Boolean);
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify stop-loss recovered-later:', e?.message || e);
  }
}

async function notifyTelegramLatencyAbnormal(p) {
  if (!telegramTradeAlertsEnabled() || !latencyAbnormalAlertsEnabled) return;
  try {
    const totalLatencyMs = Number(p?.latencyMs);
    const placeOrderMs = Number(p?.timingsMs?.placeOrder);
    if (!(Number.isFinite(placeOrderMs) && placeOrderMs > latencyAbnormalAlertMs)) return;
    const ratio =
      Number.isFinite(totalLatencyMs) && totalLatencyMs > 0
        ? Math.max(0, Math.min(1, placeOrderMs / totalLatencyMs))
        : null;
    const lines = [
      `⏱️ Latence anormale trade`,
      `source : ${p?.source ?? '?'}`,
      `conditionId : ${String(p?.conditionId || '').slice(0, 20)}…`,
      Number.isFinite(totalLatencyMs) ? `latence totale : ${Math.round(totalLatencyMs)} ms` : '',
      `placeOrder : ${Math.round(placeOrderMs)} ms (seuil ${Math.round(latencyAbnormalAlertMs)} ms)`,
      ratio != null ? `ratio placeOrder/total : ${(ratio * 100).toFixed(1)}%` : '',
      p?.orderID ? `orderID : ${p.orderID}` : '',
    ].filter(Boolean);
    await sendTelegramAlert(lines.join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify latency abnormal:', e?.message || e);
  }
}

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
  redeemTelegramFailureNotified.delete(key);
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
  /**
   * Redeem relayer : si RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS sont définis, on les utilise seuls.
   * Sinon Builder HMAC. (Avant : Builder + Relayer tous les deux dans .env → le SDK n’envoyait que le Builder ;
   * des POLY_BUILDER_* faux/expirés donnaient 401 « invalid authorization » même avec de bonnes clés Relayer.)
   */
  let builderConfig;
  if (!hasRelayerApiCreds() && hasPolyBuilderCreds()) {
    builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: POLY_BUILDER_API_KEY,
        secret: POLY_BUILDER_SECRET,
        passphrase: POLY_BUILDER_PASSPHRASE,
      },
    });
  }
  const client = new RelayClient(POLY_RELAYER_URL, CHAIN_ID, walletClient, builderConfig, rtx);
  if (hasRelayerApiCreds()) {
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
      const auth = hasRelayerApiCreds() ? 'Relayer API key' : hasPolyBuilderCreds() ? 'Builder HMAC' : 'inconnu';
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
const marketConfigCache = new Map(); // tokenId -> { tickSize: string, minOrderSize: number }
const equityHistory = []; // { t: ISO, v: USD }

async function calculateTotalValue(clobClient) {
  try {
    const balRes = await clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    let totalUsd = Number(balRes.balance) || 0;
    
    // Scan active assets (simpler list for latency)
    for (const [tokenId, config] of marketConfigCache.entries()) {
       try {
          const res = await clobClient.getBalanceAllowance({ token_id: tokenId });
          const bal = Number(res.balance) || 0;
          if (bal > 0) {
             const book = await clobClient.getOrderBook(tokenId);
             const price = (book.bids && book.bids.length > 0) ? Number(book.bids[0].price) : 0.5;
             totalUsd += (bal * price);
          }
       } catch (_) {}
    }
    return totalUsd;
  } catch (err) {
    return 0;
  }
}

function detectWhales(asset, side, book) {
   const threshold = 1000; // $1,000
   const levels = side === 'bid' ? book.bids : book.asks;
   for (const level of (levels || []).slice(0, 5)) {
      const value = Number(level.size) * Number(level.price);
      if (value > threshold) {
         console.log(`[${asset}] 🐳 WHALE ALERT: ${side.toUpperCase()} of $${value.toFixed(0)} at ${level.price}¢`);
         if (telegramTradeAlertsEnabled) {
            sendTelegramAlert(`🐳 *WHALE ALERT*\nAsset: ${asset}\nSide: ${side.toUpperCase()}\nValue: $${value.toFixed(0)}\nPrice: ${level.price}¢`);
         }
         return true;
      }
   }
   return false;
}

let lastGasAlertAt = 0;
async function checkNativeGasBalance(clobClient) {
  try {
    const address = await clobClient.signer.getAddress();
    const balanceBN = await clobClient.signer.getBalance();
    const balance = Number(balanceBN) / 1e18; // POL/MATIC has 18 decimals
    
    if (balance < 0.5 && (Date.now() - lastGasAlertAt > 3600000)) {
       console.warn(`[Gas] ⛽ CRITICAL: Low POL/MATIC balance (${balance.toFixed(4)}). Refill wallet!`);
       if (telegramTradeAlertsEnabled) {
          sendTelegramAlert(`⛽ *CRITICAL GAS ALERT*\nWallet: ${address.slice(0,6)}...${address.slice(-4)}\nBalance: ${balance.toFixed(4)} POL\n*Action*: The bot might stop trading soon. Refill MATIC/POL!`);
       }
       lastGasAlertAt = Date.now();
    }
    return balance;
  } catch (err) {
    return null;
  }
}

async function runAutoRedeem(clobClient) {
   try {
      console.log(`[Redeem] ♻️ Starting automated profit conversion...`);
      // v7.10.1: Correction pour l'appel SDK ClobClient
      const res = await clobClient.postRedeem(); 
      console.log(`[Redeem] ✅ Success: ${JSON.stringify(res)}`);
      if (telegramTradeAlertsEnabled) {
          sendTelegramAlert(`♻️ *AUTO-REDEEM SUCCESS*\nProfit converted to USDC successfully.`);
      }
      return true;
   } catch (err) {
      console.error(`[Redeem] ❌ Fail: ${err.message}`);
      return false;
   }
}

async function getMarketConfig(clobClient, tokenId) {
  if (marketConfigCache.has(tokenId)) return marketConfigCache.get(tokenId);
  try {
    const tickSize = await clobClient.getTickSize(tokenId);
    const config = { tickSize: tickSize || '0.001', minOrderSize: 0.1 };
    marketConfigCache.set(tokenId, config);
    return config;
  } catch (err) {
    return { tickSize: '0.001', minOrderSize: 0.1 };
  }
}

/** État global du Rate-Limit CLOB/Cloudflare (Blindage 2026) */
let last425ErrorAt = 0; // v5.3.0 (Blindage 2026) : Détection redémarrage moteur Polymarket
let lastRateLimitInfo = {
  limit: 100, // Valeur par défaut prudente
  remaining: 100,
  reset: 0,
  lastUpdate: 0,
};

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
  if (cond && cond !== 'na' && bestAskP != null) {
    const endMs = parseMarketEndDateToMs(signal.endDate);
    virtualWatchEntries.set(cond, {
      entryPriceP: bestAskP,
      tokenId: signal.tokenIdToBuy,
      takeSide: signal.takeSide,
      endMs,
      at: now,
    });
  }
  try {
    console.log(`[signal_in_range_but_no_order] ${JSON.stringify(payload)}`);
  } catch (_) {}
}

const STOP_LOSS_TOUCHED_WATCH_LOG_MS = Math.max(1000, Number(process.env.STOP_LOSS_TOUCHED_WATCH_LOG_MS) || 5000);
const stopLossTouchedWatchThrottle = new Map();

/**
 * Ligne JSONL pour le panneau dashboard « Watch no-order (live) » : seuil SL atteint (best bid ou drawdown).
 * Throttle par (conditionId, type prix vs drawdown), comme signal_in_range_but_no_order.
 */
function logStopLossTouchedWatch({
  conditionId,
  tokenId,
  takeSide,
  bestBid,
  entryPriceP,
  drawdownPct,
  triggerByPrice,
  triggerByDrawdown,
}) {
  const cond = String(conditionId || 'na').slice(0, 120);
  const kind = triggerByPrice ? 'price' : triggerByDrawdown ? 'drawdown' : 'na';
  const throttleKey = `${cond}|${kind}`;
  const now = Date.now();
  const prev = stopLossTouchedWatchThrottle.get(throttleKey);
  if (prev && now - prev < STOP_LOSS_TOUCHED_WATCH_LOG_MS) return;
  stopLossTouchedWatchThrottle.set(throttleKey, now);
  const reason = triggerByPrice ? 'stop_loss_price' : 'stop_loss_drawdown';
  const payload = {
    source: 'stop_loss',
    reason,
    bestBidP: Math.round(Number(bestBid) * 1e6) / 1e6,
    stopLossTriggerPriceP: Math.round(stopLossTriggerPriceP * 1e6) / 1e6,
    takeSide: takeSide === 'Up' || takeSide === 'Down' ? takeSide : null,
    conditionId: cond,
    tokenId: tokenId ? String(tokenId).slice(0, 32) : null,
    entryPriceP: entryPriceP != null && Number.isFinite(Number(entryPriceP)) ? Math.round(Number(entryPriceP) * 1e6) / 1e6 : null,
    drawdownPct: drawdownPct != null && Number.isFinite(Number(drawdownPct)) ? Math.round(Number(drawdownPct) * 100) / 100 : null,
  };
  logJson('info', 'stop_loss_touched_watch', payload);
  try {
    console.log(`[stop_loss_touched_watch] ${JSON.stringify(payload)}`);
  } catch (_) {}
}

function isRetryableExecutionError(errLike) {
  const msg = String(errLike?.message || errLike || '').toLowerCase();
  const status = Number(errLike?.response?.status);
  if (status === 425 || status === 429 || status >= 500) return true;
  return /timeout|network|econn|socket|temporar|gateway|service unavailable|internal server error/.test(msg);
}

function isInsufficientBalanceOrAllowanceError(errLike) {
  return isInsufficientBalanceOrAllowance(errLike);
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

function writeStopLossMetrics(metrics) {
  try {
    fs.writeFileSync(path.join(BOT_DIR, 'stop-loss-metrics.json'), JSON.stringify(metrics));
  } catch (err) {}
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

async function createSignedLimitOrder(client, userLimitOrder) {
  return client.createLimitOrder(userLimitOrder, { negRisk: false });
}

/**
 * Place a LIMIT order as a Maker.
 * v7.0.0 Pivot.
 */
async function placeLimitOrderAtOptimalPrice(signal, amountUsd, clobClient) {
  const side = 'bid'; // v7.12.0 Fix
  const asset = signal.underlying || signal.asset || 'BTC';
  const tokenId = signal.tokenIdToBuy;
  
  // v7.4.0: Emergency Inventory Brake (Safety 1500 tokens)
  const EMERGENCY_CAP = 1500;
  try {
     const balRes = await clobClient.getBalanceAllowance({ token_id: tokenId });
     const balance = Number(balRes.balance) || 0;
     if (balance > EMERGENCY_CAP) {
        console.error(`[${asset}] 🚨 EMERGENCY: Inventory too high (${balance.toFixed(0)} > ${EMERGENCY_CAP}). DELEVERAGING NOW.`);
        if (telegramTradeAlertsEnabled) {
           await sendTelegramAlert(`🚨 *EMERGENCY BRAKE*\nAsset: ${asset}\nInventory: ${balance.toFixed(0)}\nAction: Market SELL Triggered`);
        }
        await clobClient.createAndPostMarketOrder({ tokenId, amount: balance, side: Side.SELL }, { tickSize: '0.001' });
        return { ok: false, reason: 'emergency_brake_triggered' };
     }
  } catch (_) {}
  
  try {
    // 1. Get Order Book
    const book = await clobClient.getOrderBook(tokenId);
    const bestBid = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
    const bestAsk = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
    
    // 2. Inventory Skewing (Safety Engine v7.3.0)
    let inventorySkew = 0;
    try {
       const balRes = await clobClient.getBalanceAllowance({ token_id: tokenId });
       const balance = Number(balRes.balance) || 0;
       if (balance > (INVENTORY_CAP * 0.7)) {
          inventorySkew = SKEW_REDUCTION_OFFSET;
          console.warn(`[${asset}] 🛡️ Inventory Skew active: balance ${balance.toFixed(0)} tokens. Reducing bid by ${(inventorySkew * 100).toFixed(1)}%.`);
       }
    } catch (_) {}

    // v7.5.0: Compliance (Dynamic Tick Size & GTD Expiry)
    const config = await getMarketConfig(clobClient, tokenId);
    const tickNum = parseFloat(config.tickSize);
    const decimals = config.tickSize.includes('.') ? config.tickSize.split('.')[1].length : 0;

    // v7.6.0: Whale Sentinel
    detectWhales(asset, 'bid', book);
    detectWhales(asset, 'ask', book);

    // v7.8.0: Pre-Expiration Safety (T-90s)
    const state = getAssetState(asset);
    if (state.currentSlotStrike) {
       const endTime = state.currentSlotStrike.endMs;
       const remaining = endTime - Date.now();
       if (remaining > 0 && remaining < 90000) { // < 90s
          logJson('warn', `🛡️ [${asset}] Pre-Expiration Safety (T-90s): Halt quoting.`, { remainingMs: remaining });
          return null; 
       }
    }

    // 3. Calculate Maker Price (Best Bid + Tick - inventorySkew)
    // v7.8.0: Symmetric Skewing (Shift both Bid and Ask when overloaded)
    const bidPrice = Number((bestBid + tickNum - inventorySkew).toFixed(decimals));
    const askPrice = Number((bestAsk - tickNum - inventorySkew).toFixed(decimals));
    
    const limitPrice = side === 'bid' ? bidPrice : askPrice;
    
    // 4. Round amount to min_order_size (usually 0.1 tokens)
    const rawTokens = amountUsd / limitPrice;
    const tokens = Math.floor(rawTokens * 10) / 10;
    
    console.log(`[${asset}] [DEBUG] Limit Order Calculation (Tick: ${config.tickSize}): $${amountUsd} / ${limitPrice} = ${tokens} tokens`);

    if (tokens < config.minOrderSize || !Number.isFinite(tokens)) return { ok: false, error: 'Amount too low for limit order' };

    const userLimitOrder = {
      tokenId,
      price: limitPrice,
      side: Side.BUY,
      size: tokens,
      feeRateBps: 0,
      expiration: Math.floor(Date.now() / 1000) + 60 + 300 // v7.5.0: 5m GTD safety window
    };

    const signedOrder = await createSignedLimitOrder(clobClient, userLimitOrder);
    
    // v7.5.0: Switch to GTD (Good-Til-Date) for absolute safety
    const result = await clobClient.postOrder(signedOrder, OrderType.GTD, false, true);

    if (result.success && result.orderID) {
      OPEN_LIMIT_ORDERS.set(signal.conditionId, {
        orderId: result.orderID,
        at: Date.now(),
        price: limitPrice,
        asset,
        tokenId
      });
      saveOpenOrders(); // v7.1.0 Persistence
      
      // v7.3.0: Liquidity Ladder (3-Tier Bidding)
      // Tier 1 (Primary) is already placed. Now Tier 2 (Volume) and Tier 3 (Deep).
      const ladderSteps = [
         { name: 'Volume', offset: 0.002, suffix: 'vol' },
         { name: 'Deep', offset: 0.006, suffix: 'deep' }
      ];

      for (const step of ladderSteps) {
         try {
           const stepPrice = (limitPrice - step.offset).toFixed(3);
           if (stepPrice <= 0.01) continue;
           
           const stepTokens = (amountUsd / Number(stepPrice)).toFixed(1);
           const stepOrder = { ...userLimitOrder, price: Number(stepPrice), size: stepTokens };
           const stepSigned = await createSignedLimitOrder(clobClient, stepOrder);
           const resStep = await clobClient.postOrder(stepSigned, OrderType.GTC, false, true);
           
           if (resStep.success) {
              OPEN_LIMIT_ORDERS.set(`${signal.conditionId}_${step.suffix}`, {
                orderId: resStep.orderID,
                at: Date.now(),
                price: Number(stepPrice),
                asset,
                tokenId
              });
              console.log(`[${asset}] 🪜 ${step.name} ladder step placed at ${stepPrice}`);
           }
         } catch (_) {}
      }
      saveOpenOrders();

      return { ok: true, orderId: result.orderID, price: limitPrice, filledUsd: 0 }; // Maker is not filled yet
    }
    
    return { ok: false, error: result.errorMsg || 'Clob post failed' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Monitor and cancel stale limit orders (v7.0.0).
 * Runs at the end of each cycle.
 */
const OPEN_ORDERS_FILE = path.join(__dirname, 'open-orders.json');

function saveOpenOrders() {
  try {
    const data = Object.fromEntries(OPEN_LIMIT_ORDERS);
    fs.writeFileSync(OPEN_ORDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Persistence] Error saving open orders:', e.message);
  }
}

function loadOpenOrders() {
  try {
    if (fs.existsSync(OPEN_ORDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(OPEN_ORDERS_FILE, 'utf8'));
      for (const [key, val] of Object.entries(data)) {
        OPEN_LIMIT_ORDERS.set(key, val);
      }
      console.log(`[Persistence] Loaded ${OPEN_LIMIT_ORDERS.size} orders from disk.`);
    }
  } catch (e) {
    console.error('[Persistence] Error loading open orders:', e.message);
  }
}

/**
 * Fetch Rewards Score from Polymarket (v7.1.0).
 * Requires API credentials.
 */
async function fetchRewardsUserPercentages(clobClient) {
  if (!clobClient) return null;
  try {
    // v7.3.0: Using native SDK method for 100% reliable rewards monitor
    const res = await clobClient.getRewardPercentages();
    // v7.4.3: Robust array detection for various SDK/API return formats
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.data)) return res.data;
    return [];
  } catch (err) {
    if (err.message.includes('403') || err.message.includes('401')) {
       // Silently fail if auth is not ready yet
    } else {
       console.warn(`[Rewards] Native fetch failed: ${err.message}`);
    }
    return null;
  }
}

async function checkAndCancelStaleOrders(clobClient) {
  // v7.4.0: Detect Fills via SDK comparison
  let activeOrderIds = new Set();
  try {
    const res = await clobClient.getOpenOrders();
    const openClobOrders = Array.isArray(res) ? res : (res?.data || []);
    activeOrderIds = new Set(openClobOrders.map(o => o.orderID));
  } catch (err) {
     warnClobClientIfThrottled(`[Monitor] Could not fetch active CLOB orders: ${err.message}`);
     return; // Safety: don't delete anything if we can't verify status
  }

  const now = Date.now();
  for (const [condId, data] of OPEN_LIMIT_ORDERS.entries()) {
    // 0. Fill Detection (Order exists in our map but NOT in CLOB API)
    if (!activeOrderIds.has(data.orderId)) {
        console.log(`[${data.asset}] 🌊 LADDER FILL DETECTED: Order ${data.orderId} at ${data.price}¢`);
        if (telegramTradeAlertsEnabled) {
           await sendTelegramAlert(`🌊 *LADDER FILL*\nAsset: ${data.asset}\nPrice: ${data.price}¢\nType: Maker Fill`);
        }
        OPEN_LIMIT_ORDERS.delete(condId);
        saveOpenOrders();
        continue;
    }

    const ageMs = now - data.at;
    
    // 1. Time-based Expiration (TTL)
    if (ageMs > LIMIT_ORDER_TTL_MS) {
       // ... existing cancel logic ...
      console.log(`[${data.asset}] 🕒 Cancel stale LIMIT order ${data.orderId} (Age: ${Math.round(ageMs/1000)}s)`);
      try {
        await clobClient.cancelOrder(data.orderId);
        OPEN_LIMIT_ORDERS.delete(condId);
        saveOpenOrders(); // v7.1.0 Persistence
      } catch (err) {
        warnClobClientIfThrottled(`Error cancelling order ${data.orderId}: ${err.message}`);
      }
      continue;
    }

    // 2. Market-based Stale (Price moved too far)
    try {
        const book = await clobClient.getOrderBook(data.tokenId);
        const bestBid = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
        const bestAsk = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
        
        if (isOrderStale(data.price, bestBid, bestAsk, 0.005)) {
            console.log(`[${data.asset}] 📉 Market move: Cancel stale LIMIT order ${data.orderId}`);
            await clobClient.cancelOrder(data.orderId);
            OPEN_LIMIT_ORDERS.delete(condId);
            saveOpenOrders(); // v7.1.0 Persistence
        }
    } catch (err) {
        // Silent fail on book fetch
    }
  }
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
 * Montant CLOB : soit entier en micro-unités (÷ 1e6), soit déjà en unités décimales (ex. "11.919974" USDC).
 * Sans cette distinction, "11.919974" était lu comme ~0.000012 USDC → Telegram / last-order à ~0 %.
 */
function parseClobAmountField(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'bigint' ? v.toString() : String(v).trim();
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (/[.eE]/.test(s)) return n;
  return n / 1e6;
}

/**
 * Somme des legs `matched` dans `clobResponses` quand le top-level est vide / erroné.
 */
function sumMatchedClobLegFills(clobResponses, orderSide) {
  if (!Array.isArray(clobResponses) || !clobResponses.length) return null;
  let sumUsdc = 0;
  let sumTok = 0;
  let matched = 0;
  for (const leg of clobResponses) {
    if (!leg || typeof leg !== 'object') continue;
    const ok =
      leg.success === true ||
      leg.status === 'matched' ||
      leg.status === 'MATCHED' ||
      leg.status === 'filled';
    if (!ok) continue;
    const rawMake = leg.makingAmount ?? leg.making_amount;
    const rawTake = leg.takingAmount ?? leg.taking_amount;
    let fu;
    let ft;
    if (orderSide === Side.BUY) {
      fu = parseClobAmountField(rawMake);
      ft = parseClobAmountField(rawTake);
    } else {
      ft = parseClobAmountField(rawMake);
      fu = parseClobAmountField(rawTake);
    }
    if (fu != null && fu > 0) {
      sumUsdc += fu;
      matched += 1;
    }
    if (ft != null && ft > 0) sumTok += ft;
  }
  if (matched === 0 || sumUsdc <= 0) return null;
  return { filledUsdc: sumUsdc, filledOutcomeTokens: sumTok > 0 ? sumTok : null };
}

/**
 * Parse la réponse POST /order (SendOrderResponse Polymarket).
 * makingAmount / takingAmount : micro-unités entières **ou** chaînes décimales selon la route.
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

  const rawMake = responseBody.makingAmount ?? responseBody.making_amount;
  const rawTake = responseBody.takingAmount ?? responseBody.taking_amount;
  if (orderSide === Side.BUY) {
    out.filledUsdc = parseClobAmountField(rawMake);
    out.filledOutcomeTokens = parseClobAmountField(rawTake);
  } else {
    out.filledOutcomeTokens = parseClobAmountField(rawMake);
    out.filledUsdc = parseClobAmountField(rawTake);
  }

  const legSum = sumMatchedClobLegFills(responseBody.clobResponses, orderSide);
  if (legSum?.filledUsdc != null && legSum.filledUsdc > (out.filledUsdc ?? 0)) {
    if ((out.filledUsdc ?? 0) < legSum.filledUsdc * 0.01) {
      logJson('warn', 'Remplissage CLOB: top-level sous-estimé — utilisation des legs clobResponses', {
        topFilledUsdc: out.filledUsdc,
        legFilledUsdc: legSum.filledUsdc,
      });
    }
    out.filledUsdc = legSum.filledUsdc;
    if (legSum.filledOutcomeTokens != null) out.filledOutcomeTokens = legSum.filledOutcomeTokens;
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

/** Solde outcome token réellement vendable via CLOB: min(balance, allowance) pour un tokenId CTF. */
async function getOutcomeSpendableViaClob(client, tokenId) {
  if (!client || !tokenId) return null;
  const reqs = [
    { asset_type: 'CONDITIONAL', token_id: String(tokenId) },
    { asset_type: 'CONDITIONAL', tokenId: String(tokenId) },
  ];
  for (const req of reqs) {
    try {
      const out = await client.getBalanceAllowance(req);
      const rawBalance = out?.balance ?? out?.balance_raw;
      const rawAllowance = out?.allowance ?? out?.allowance_raw;
      const balanceTok = rawBalance == null ? null : parseClobAmountField(rawBalance);
      const allowanceTok = rawAllowance == null ? null : parseClobAmountField(rawAllowance);
      if (balanceTok == null && allowanceTok == null) continue;
      if (balanceTok == null) return Math.max(0, allowanceTok);
      if (allowanceTok == null) return Math.max(0, balanceTok);
      return Math.max(0, Math.min(balanceTok, allowanceTok));
    } catch (_) {
      // essaie format alternatif de payload
    }
  }
  return null;
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

/** Ligne de référence PnL « depuis démarrage process » (premier solde CLOB/RPC noté). */
let botSessionBaselineUsdc = null;
let lastTelegramBalanceDigestMs = 0;

function noteSessionBaselineIfNeeded(bal) {
  if (botSessionBaselineUsdc != null) return;
  if (bal == null || !Number.isFinite(bal)) return;
  botSessionBaselineUsdc = bal;
}

function formatSessionDeltaLine(balanceAfter) {
  if (botSessionBaselineUsdc == null || balanceAfter == null || !Number.isFinite(balanceAfter)) return '';
  const d = balanceAfter - botSessionBaselineUsdc;
  const sign = d >= 0 ? '+' : '';
  return `Δ solde depuis démarrage bot : ${sign}${d.toFixed(2)} USDC`;
}

/**
 * Aligné sur les alertes trade : solde collateral CLOB (API) si disponible, sinon USDC sur l’EOA (RPC).
 * Après redeem relayer/proxy, les USDC sont souvent visibles côté CLOB alors que le wallet EOA reste à ~0.
 */
async function getUsdcBalanceForTelegramAlerts() {
  try {
    const client = await buildClobClientCachedCreds();
    const viaClob = await getUsdcSpendableViaClob(client);
    if (viaClob != null && Number.isFinite(viaClob)) {
      return { balance: viaClob, source: 'clob' };
    }
  } catch (_) {
    // creds CLOB indisponibles → RPC
  }
  const rpc = await getUsdcBalanceRpc();
  return { balance: rpc, source: 'rpc' };
}

/**
 * Alerte Telegram après ordre accepté (WS ou poll) : position, remplissage, MTM best bid, solde.
 * @param {'ws'|'poll'} source
 * @param {Record<string, unknown>} orderData
 * @param {import('@polymarket/clob-client').ClobClient | null} clobClient
 */
const notifiedTelegramTradeOrders = new Set();

async function notifyTelegramTradeSuccess(source, orderData, clobClient) {
  if (!telegramTradeAlertsEnabled()) return;
  const orderId = orderData?.orderID ?? orderData?.order_id;
  if (orderId && notifiedTelegramTradeOrders.has(String(orderId))) return;
  if (orderId) notifiedTelegramTradeOrders.add(String(orderId));
  // Limiter la taille du set pour éviter les fuites mémoire sur le long terme (on garde les 1000 derniers)
  if (notifiedTelegramTradeOrders.size > 1000) {
    const first = notifiedTelegramTradeOrders.values().next().value;
    notifiedTelegramTradeOrders.delete(first);
  }

  try {
    let balanceAfter = null;
    if (orderData?.simulationTrade) {
      balanceAfter = simulationTrade.getPaperBalanceUsd(BOT_DIR);
    } else {
      if (clobClient) {
        balanceAfter = await getUsdcSpendableViaClob(clobClient);
      }
      if (balanceAfter == null) {
        balanceAfter = await getUsdcBalanceRpc();
      }
    }
    noteSessionBaselineIfNeeded(balanceAfter);

    const tok = orderData?.filledOutcomeTokens;
    const usdc = orderData?.filledUsdc;
    const tokenId = orderData?.tokenId;
    const orderId = orderData?.orderID ?? orderData?.order_id;
    const clobStatus = orderData?.clobStatus ?? null;
    const clobSuccess = orderData?.clobSuccess ?? null;

    const hasFilled =
      Number.isFinite(tok) &&
      Number.isFinite(usdc) &&
      tok > 0 &&
      usdc > 0 &&
      tokenId &&
      typeof tokenId === 'string';

    const brand = getAssetBranding(orderData?.asset || orderData?.underlying);
    let mtmLine = '';
    if (hasFilled) {
      const bid = await getBestBid(tokenId);
      if (bid != null && Number.isFinite(usdc) && Number.isFinite(tok)) {
        const estVal = tok * bid;
        const mtm = estVal - usdc;
        const sign = mtm >= 0 ? '+' : '';
        mtmLine = `PnL latente (vs best bid): ${sign}${mtm.toFixed(2)} USDC\n  (valeur revente ~${estVal.toFixed(2)} USDC, coût ~${usdc.toFixed(2)} USDC, bid ~${(bid * 100).toFixed(2)}¢)`;
      }
    }

    const fr = orderData?.fillRatio != null ? `${(Number(orderData.fillRatio) * 100).toFixed(1)} %` : 'n/a';
    const avg =
      orderData?.averageFillPriceP != null && Number.isFinite(Number(orderData.averageFillPriceP))
        ? `${(Number(orderData.averageFillPriceP) * 100).toFixed(2)}¢`
        : 'n/a';
    const endMs = orderData?.marketEndMs;
    const endStr = endMs != null ? new Date(Number(endMs)).toISOString() : 'n/a';
    const cid = String(orderData?.conditionId || '').slice(0, 20);
    const amt = orderData?.amountUsd;
    const amtStr = typeof amt === 'number' && Number.isFinite(amt) ? amt.toFixed(2) : String(amt ?? '?');

    const deltaLine = formatSessionDeltaLine(balanceAfter);
    const totalLatencyMs = Number(orderData?.latencyMs);
    const placeOrderMs = Number(orderData?.timingsMs?.placeOrder);
    const latencyRatio =
      Number.isFinite(totalLatencyMs) && totalLatencyMs > 0 && Number.isFinite(placeOrderMs) && placeOrderMs >= 0
        ? Math.max(0, Math.min(1, placeOrderMs / totalLatencyMs))
        : null;
    const assetLabel = brand.label;
    const paperPre = orderData?.simulationTrade ? '[PAPER] ' : '';
    const lines = [
      hasFilled
        ? `${paperPre}${brand.emoji} Trade Success (${brand.label})`
        : `${paperPre}⚠️ [${assetLabel}] Trade accepté (remplissage nul)`,
      `Côté : ${orderData?.takeSide ?? '?'}`,
      `Montant demandé : ${amtStr} USDC`,
      `Exécuté : ${usdc != null && Number.isFinite(usdc) ? usdc.toFixed(2) : '?'} USDC (remplissage ${fr})`,
      hasFilled ? `Prix moyen ~${avg}` : '',
      `conditionId : ${cid}…`,
      orderId ? `orderID : ${orderId}` : '',
      `Fin marché (UTC) : ${endStr}`,
      hasFilled ? `Position : outcome acheté — à suivre jusqu’à résolution / redeem.` : `Position : non confirmée (remplissage = 0 / ou en cours)`,
    ];
    if (hasFilled && mtmLine) lines.push(mtmLine);
    if (clobStatus) lines.push(`CLOB status : ${String(clobStatus)}`);
    if (clobSuccess != null) lines.push(`CLOB success : ${clobSuccess}`);
    if (Number.isFinite(totalLatencyMs) && totalLatencyMs > 0) {
      lines.push(`Latence totale : ${Math.round(totalLatencyMs)} ms`);
    }
    if (Number.isFinite(placeOrderMs) && placeOrderMs >= 0) {
      lines.push(`placeOrder : ${Math.round(placeOrderMs)} ms`);
    }
    if (latencyRatio != null) {
      lines.push(`ratio placeOrder/total : ${(latencyRatio * 100).toFixed(1)}%`);
    }
    lines.push(
      orderData?.simulationTrade
        ? `Solde paper (après trade) : ${balanceAfter != null ? balanceAfter.toFixed(2) : '?'} USDC`
        : `Solde CLOB (après trade) : ${balanceAfter != null ? balanceAfter.toFixed(2) : '?'} USDC`,
    );
    if (deltaLine) lines.push(deltaLine);

    await sendTelegramAlert(lines.filter(Boolean).join('\n'));
  } catch (e) {
    console.warn('[Telegram] notify trade:', e?.message || e);
  }
}

/**
 * @param {{ ok: boolean, conditionId: string, hash?: string, detail?: string, error?: string, viaRelayer?: boolean }} p
 */
/** Échec redeem : au plus un message Telegram par `conditionId` (retries et backoff silencieux côté Telegram). */
async function notifyTelegramRedeemFailureOnce(cid, fields) {
  if (!telegramRedeemAlertsEnabled()) return;
  const k = String(cid || '').trim();
  if (!k || redeemTelegramFailureNotified.has(k)) return;
  redeemTelegramFailureNotified.add(k);
  await notifyTelegramRedeemEvent({ ok: false, conditionId: cid, ...fields });
}

async function notifyTelegramRedeemEvent(p) {
  if (!telegramRedeemAlertsEnabled()) return;
  try {
    if (p?.simulationTrade) {
      const bal = simulationTrade.getPaperBalanceUsd(BOT_DIR);
      const cid = String(p.conditionId || '').slice(0, 22);
      const payout = Number(p.paperPayoutUsd);
      const payoutStr = Number.isFinite(payout) ? `${payout.toFixed(2)} USDC` : '?';
      const winner = p.winnerGamma != null ? String(p.winnerGamma) : '?';
      const side = p.takeSide != null ? String(p.takeSide) : '?';
      const msg = [
        `[PAPER] ✅ Résolution marché (simulation)`,
        `conditionId : ${cid}…`,
        `gagnant Gamma : ${winner} · ta position : ${side}`,
        `crédit paper : ${payoutStr}`,
        `Solde paper après : ${bal.toFixed(2)} USDC`,
      ].join('\n');
      await sendTelegramAlert(msg);
      return;
    }
    const beforeSnap = await getUsdcBalanceForTelegramAlerts();
    const balBefore = beforeSnap.balance;
    noteSessionBaselineIfNeeded(balBefore);

    let bal = balBefore;
    let labelSource = beforeSnap.source;
    if (p?.ok) {
      // CLOB + RPC peuvent mettre quelques centaines de ms à refléter le redeem (surtout via relayer).
      const pollStart = Date.now();
      const POLL_TOTAL_MS = 8_000;
      const POLL_STEP_MS = 400;
      const MIN_DELTA_USDC = 0.005;

      while (Date.now() - pollStart < POLL_TOTAL_MS) {
        await new Promise((r) => setTimeout(r, POLL_STEP_MS));
        const snap = await getUsdcBalanceForTelegramAlerts();
        const candidate = snap.balance;
        if (candidate == null || !Number.isFinite(candidate)) continue;
        if (balBefore != null && Number.isFinite(balBefore)) {
          if (Math.abs(candidate - balBefore) >= MIN_DELTA_USDC) {
            bal = candidate;
            labelSource = snap.source;
            break;
          }
        } else {
          bal = candidate;
          labelSource = snap.source;
          break;
        }
      }
      const finalSnap = await getUsdcBalanceForTelegramAlerts();
      if (finalSnap.balance != null && Number.isFinite(finalSnap.balance)) {
        bal = finalSnap.balance;
        labelSource = finalSnap.source;
      }
    } else {
      const snap = await getUsdcBalanceForTelegramAlerts();
      bal = snap.balance;
      labelSource = snap.source;
    }

    const deltaLine = formatSessionDeltaLine(bal);
    const cid = String(p.conditionId || '').slice(0, 22);
    const balanceLabel =
      labelSource === 'clob' ? 'Solde CLOB (après redeem)' : 'Solde USDC wallet (RPC, après redeem)';
    let msg;
    if (p.ok) {
      msg = [
        `✅ Redeem OK`,
        `conditionId : ${cid}…`,
        p.hash ? `Tx : ${p.hash}` : '',
        p.viaRelayer != null ? `Via relayer : ${p.viaRelayer ? 'oui' : 'non'}` : '',
        `${balanceLabel} : ${bal != null ? bal.toFixed(2) : '?'} USDC`,
        deltaLine || '',
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      const failLabel =
        labelSource === 'clob' ? 'Solde CLOB' : 'Solde USDC wallet (RPC)';
      msg = [
        `⚠️ Redeem échoué ou en attente`,
        `conditionId : ${cid}…`,
        p.detail ? `Détail : ${p.detail}` : '',
        p.error ? `Erreur : ${String(p.error).slice(0, 400)}` : '',
        p.viaRelayer != null ? `Via relayer : ${p.viaRelayer ? 'oui' : 'non'}` : '',
        `${failLabel} : ${bal != null ? bal.toFixed(2) : '?'} USDC`,
        deltaLine || '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    await sendTelegramAlert(msg);
  } catch (e) {
    console.warn('[Telegram] notify redeem:', e?.message || e);
  }
}

/** Digest solde périodique si ALERT_TELEGRAM_BALANCE_EVERY_MS > 0 */
async function maybeTelegramBalanceDigest(balanceAfter) {
  const iv = telegramBalanceDigestMs();
  if (!iv || !telegramAlertsConfigured()) return;
  const now = Date.now();
  if (now - lastTelegramBalanceDigestMs < iv) return;
  lastTelegramBalanceDigestMs = now;
  noteSessionBaselineIfNeeded(balanceAfter);
  const delta = formatSessionDeltaLine(balanceAfter);
  const body = [
    `📊 Solde USDC (cycle)`,
    balanceAfter != null && Number.isFinite(balanceAfter) ? `${balanceAfter.toFixed(2)} USDC` : 'indisponible',
    delta || '',
  ]
    .filter(Boolean)
    .join('\n');
  await sendTelegramAlert(body);
}

function loadTelegramDigestState() {
  try {
    const j = JSON.parse(fs.readFileSync(TELEGRAM_DIGEST_STATE_FILE, 'utf8'));
    return {
      morningSentFor: String(j?.morningSentFor || '').trim(),
      afternoonSentFor: String(j?.afternoonSentFor || '').trim(),
      fullDaySentFor: String(j?.fullDaySentFor || '').trim(),
    };
  } catch (_) {
    try {
      const j = JSON.parse(fs.readFileSync(MIDDAY_DIGEST_LAST_FILE, 'utf8'));
      const d = String(j?.date || '').trim();
      return { morningSentFor: d, afternoonSentFor: '', fullDaySentFor: '' };
    } catch (_) {
      return { morningSentFor: '', afternoonSentFor: '', fullDaySentFor: '' };
    }
  }
}

function saveTelegramDigestState(state) {
  fs.writeFileSync(
    TELEGRAM_DIGEST_STATE_FILE,
    JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      0,
    ) + '\n',
    'utf8',
  );
}

/**
 * Résumés Telegram : 00h–12h (à l’heure midi), 12h–00h + journée complète (à minuit, jour écoulé).
 */
async function tryTelegramPerformanceDigests() {
  if (!telegramMiddayDigestEnabled()) return;
  const tz = TELEGRAM_MIDDAY_DIGEST_TZ;
  const { hour, minute } = getLocalHourMinute(tz);
  const todayYmd = getCalendarDateYmd(tz);
  const yesterdayYmd = getYesterdayYmdInTz(tz);

  const isNoonSlot =
    hour === TELEGRAM_MIDDAY_DIGEST_HOUR && minute === TELEGRAM_MIDDAY_DIGEST_MINUTE;
  const isMidnightSlot =
    hour === TELEGRAM_MIDNIGHT_DIGEST_HOUR && minute === TELEGRAM_MIDNIGHT_DIGEST_MINUTE;

  if (!isNoonSlot && !isMidnightSlot) return;

  let state = loadTelegramDigestState();
  let changed = false;
  const raw = readOrdersLogSafe(ORDERS_LOG_FILE);

  if (isNoonSlot && state.morningSentFor !== todayYmd) {
    const win = getMidnightToNoonWindowMs(tz, todayYmd);
    if (win) {
      const stats = computeMiddayDigestStats(raw, win.startMs, win.endMs);
      const msg = formatMiddayDigestMessage(stats, {
        timeZone: tz,
        dateStr: todayYmd,
        windowLabel: '00h00–12h00',
        streakContextLabel: 'midi',
      });
      await sendTelegramAlert(msg);
      state.morningSentFor = todayYmd;
      changed = true;
    }
  }

  if (isMidnightSlot && yesterdayYmd) {
    if (state.afternoonSentFor !== yesterdayYmd) {
      const winPm = getNoonToMidnightWindowMs(tz, yesterdayYmd);
      if (winPm) {
        const stats = computeMiddayDigestStats(raw, winPm.startMs, winPm.endMs);
        const msg = formatMiddayDigestMessage(stats, {
          timeZone: tz,
          dateStr: yesterdayYmd,
          windowLabel: '12h00–24h00',
          streakContextLabel: 'minuit',
        });
        await sendTelegramAlert(msg);
        state.afternoonSentFor = yesterdayYmd;
        changed = true;
      }
    }
    if (state.fullDaySentFor !== yesterdayYmd) {
      const winDay = getFullDayWindowMs(tz, yesterdayYmd);
      if (winDay) {
        const stats = computeMiddayDigestStats(raw, winDay.startMs, winDay.endMs);
        const msg = formatMiddayDigestMessage(stats, {
          timeZone: tz,
          dateStr: yesterdayYmd,
          windowLabel: 'journée complète 00h00–24h00',
          streakContextLabel: 'fin',
        });
        await sendTelegramAlert(msg);
        state.fullDaySentFor = yesterdayYmd;
        changed = true;
      }
    }
  }

  if (changed) {
    try {
      saveTelegramDigestState(state);
    } catch (e) {
      console.warn('[telegram-digest] écriture état impossible:', e?.message || e);
    }
  }
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

/**
 * Sortie stop-loss en simulation : crédit USDC paper au prix worst (même logique de prix que le CLOB, sans POST).
 */
async function executePaperStopLossExit(p) {
  const {
    conditionId,
    tokenId,
    takeSide,
    endMs,
    entryPriceP,
    bestBid,
    drawdownPct,
    triggerByPrice,
    triggerByDrawdown,
    tokensToSell,
  } = p;
  const minRawAmount = 1;
  const minRawSafe = 2;
  const rawMaker = tokensToSell * 1e6;
  if (!(rawMaker >= minRawAmount)) {
    logJson('warn', 'Stop-loss PAPER: tokens trop petits', { conditionId: conditionId.slice(0, 18) + '…', takeSide, tokensToSell });
    return;
  }
  const minWorstPriceForValidTakerP = minRawAmount / (tokensToSell * 1e6);
  let bestBidLive = bestBid;
  let drawdownPctLive = drawdownPct;
  
  // Calcul du prix de sortie pour limiter la perte à 25% du stake initial
  let worstPricePUsed = Math.max(stopLossWorstPriceP, minWorstPriceForValidTakerP);
  
  // Si on connait le stake initial, calculer le prix pour réaliser 25% de perte
  const originalStakeUsd = Number(p.originalStakeUsd);
  if (Number.isFinite(originalStakeUsd) && originalStakeUsd > 0) {
    const maxLossPct = 0.25; // 25% de perte
    const targetRevenue = originalStakeUsd * (1 - maxLossPct); // 75% du stake
    const targetExitPrice = Math.max(minWorstPriceForValidTakerP, targetRevenue / tokensToSell);
    worstPricePUsed = Math.min(targetExitPrice, stopLossTriggerPriceP);
  } else {
    worstPricePUsed = Math.min(worstPricePUsed, stopLossTriggerPriceP);
  }
  
  if (Number.isFinite(bestBidLive) && bestBidLive > 0 && bestBidLive < 1) {
    worstPricePUsed = Math.min(worstPricePUsed, bestBidLive);
  }
  worstPricePUsed = Math.min(0.99, Math.max(0.001, worstPricePUsed));
  const rawTakerLoop = tokensToSell * worstPricePUsed * 1e6;
  if (!(rawTakerLoop >= minRawAmount) || rawMaker < minRawSafe || rawTakerLoop < minRawSafe) {
    stopLossNextAttemptByCondition.set(conditionId, Date.now() + STOP_LOSS_RETRY_BACKOFF_MS);
    return;
  }

  const stopLossTriggeredAtMs = Date.now();
  if (!stopLossFirstTriggeredAtByCondition.has(conditionId)) {
    stopLossFirstTriggeredAtByCondition.set(conditionId, stopLossTriggeredAtMs);
    recordStopLossMetric('triggered', { conditionId, takeSide });
  }
  void notifyTelegramStopLossTriggered({
    conditionId,
    takeSide,
    triggerReason: triggerByPrice ? 'price_below_threshold' : 'drawdown_limit',
    entryPriceP,
    bestBidP: bestBidLive,
    drawdownPct: drawdownPctLive,
    stopLossTriggerPriceP,
    stopLossMaxDrawdownPct: stopLossDrawdownEnabled ? Math.abs(stopLossMaxDrawdownPct) : null,
    stopLossWorstPricePUsed: worstPricePUsed,
    simulationTrade: true,
  });

  const totalFilledTokens = tokensToSell;
  const totalFilledUsdc = Math.round(tokensToSell * worstPricePUsed * 1e6) / 1e6;
  simulationTrade.adjustPaperBalance(BOT_DIR, totalFilledUsdc);
  simulationTrade.markPaperRedeemed(BOT_DIR, conditionId);

  const nowIso = new Date().toISOString();
  const exitOrder = {
    at: nowIso,
    conditionId,
    tokenId,
    takeSide,
    orderID: `sim-sl-${Date.now()}`,
    stopLossTriggerPriceP: Math.round(stopLossTriggerPriceP * 1e6) / 1e6,
    stopLossMaxDrawdownPct: stopLossDrawdownEnabled ? -Math.abs(stopLossMaxDrawdownPct) : null,
    stopLossTriggerReason: triggerByPrice ? 'price_below_threshold' : 'drawdown_limit',
    stopLossObservedDrawdownPct: Math.round(drawdownPctLive * 100) / 100,
    stopLossEntryPriceP: Math.round(entryPriceP * 1e6) / 1e6,
    stopLossBestBidP: Math.round(bestBidLive * 1e6) / 1e6,
    stopLossWorstPricePUsed: Math.round(worstPricePUsed * 1e6) / 1e6,
    marketEndMs: endMs,
    clobSignerAddress: wallet?.address ?? null,
    clobSignatureType: CLOB_SIGNATURE_TYPE,
    clobFunderAddress: clobFunderAddress ?? null,
    stopLossPartialFillRetries: 0,
    stopLossRemainingOutcomeTokens: 0,
    stopLossExit: true,
    simulationTrade: true,
    filledOutcomeTokens: totalFilledTokens,
    filledUsdc: totalFilledUsdc,
    fillRatio: 1,
    averageFillPriceP: totalFilledTokens > 0 ? totalFilledUsdc / totalFilledTokens : null,
    clobStatus: 'simulated',
    clobSuccess: true,
  };

  recordStopLossMetric('filled', {
    conditionId,
    fillRatio: 1,
    retries: 0,
    remainingTokens: 0,
    triggeredAtMs: stopLossTriggeredAtMs,
    triggerPriceP: stopLossTriggerPriceP,
    averageFillPriceP: totalFilledTokens > 0 ? totalFilledUsdc / totalFilledTokens : null,
  });

  writeLastOrder(exitOrder);
  appendOrderLog(exitOrder);
  stopLossTelegramExitFailedNotified.delete(conditionId);
  stopLossTelegramEscalatedNotified.delete(conditionId);
  stopLossTelegramRecoveredNotified.delete(conditionId);
  stopLossFirstTriggeredAtByCondition.delete(conditionId);
  stopLossNextAttemptByCondition.delete(conditionId);
  executionCooldownByCondition.set(conditionId, (endMs != null && Number.isFinite(endMs) ? endMs : Date.now()) + 60_000);

  void notifyTelegramStopLossFilled({
    conditionId,
    takeSide,
    filledUsdc: totalFilledUsdc,
    filledOutcomeTokens: totalFilledTokens,
    fillRatio: 1,
    orderID: exitOrder.orderID,
    simulationTrade: true,
  });

  logJson('warn', 'Stop-loss PAPER: sortie simulée', {
    conditionId: conditionId.slice(0, 18) + '…',
    takeSide,
    worstPricePUsed: Math.round(worstPricePUsed * 1e6) / 1e6,
    filledUsdc: totalFilledUsdc,
  });
}

/** 
 * 7.13.1 : Surveille et clôture une position spécifique (SL/TP/Time-Exit). 
 */
async function processSinglePositionExit(pos, clobClient) {
  if (pos.resolved || pos.stopLossExit === true) return false;
  if (!pos.simulationTrade && !clobClient) return false;

  const conditionId = String(pos.conditionId || '').trim();
  const tokenId = String(pos.tokenId || '').trim();
  const takeSide = pos.takeSide === 'Up' || pos.takeSide === 'Down' ? pos.takeSide : null;
  if (!conditionId || !tokenId || !takeSide) return false;

  const endMs = parseMarketEndDateToMs(pos.marketEndMs ?? pos.endDate);
  const nowMs = Date.now();
  if (Number.isFinite(endMs) && nowMs >= endMs) return false;
  
  const nextAllowed = stopLossNextAttemptByCondition.get(conditionId) || 0;
  if (nowMs < nextAllowed) return false;

  const entryPriceP = Number(pos.averageFillPriceP || pos.pricePrompt || 0.5);
  if (!(entryPriceP > 0)) return false;

  const bestBid = await getBestBid(tokenId);
  if (!(bestBid > 0 && bestBid < 1)) return false;

  const secondsLeft = endMs ? Math.max(0, (endMs - nowMs) / 1000) : 300;
  
  // 1. Take Profit : Convergence ou Edge d'entrée
  const entryFair = Number(pos.entryFair || pos.probFairAtEntry);
  const netProfitPct = (bestBid - entryPriceP) / entryPriceP;
  const targetProfitPct = Math.min(0.20, Math.max(0.025, Number(pos.edge || 0.05)));
  const triggerTP = (netProfitPct >= targetProfitPct) || (entryFair > 0 && bestBid >= entryFair * 0.98);

  // 2. Stop Loss Hard Stop -5% (Miroir SL désactivé temporairement pour stabilité v7.13)
  const triggerHardSL = (netProfitPct <= -0.05);

  // 3. Time-Based Exit : Force close avant l'expiration (v7.13.0)
  const triggerTimeForce = secondsLeft < 30;
  const triggerTimeCut = secondsLeft < 60 && netProfitPct < 0;

  const triggered = triggerTP || triggerHardSL || triggerTimeForce || triggerTimeCut;
  if (!triggered) {
    stopLossNextAttemptByCondition.set(conditionId, nowMs + 10000);
    return false;
  }

  const triggerReason = triggerTP ? 'CONVERGENCE_TP' : 
                       triggerHardSL ? 'HARD_STOP_LOSS' :
                       triggerTimeForce ? 'TIME_FORCE_EXIT' : 'TIME_CUT_LOSS';

  const drawdownPct = netProfitPct * 100;
  let tokensToSell = Number(pos.filledOutcomeTokens);
  if (!(Number.isFinite(tokensToSell) && tokensToSell > 0)) {
     tokensToSell = (Number(pos.filledUsdc || pos.amountUsd) || 10) / entryPriceP;
  }

  if (pos.simulationTrade) {
     await executePaperStopLossExit({
        conditionId, tokenId, takeSide, endMs, entryPriceP, bestBid, drawdownPct,
        triggerByPrice: true, triggerByDrawdown: false, tokensToSell,
        originalStakeUsd: Number(pos.filledUsdc || pos.amountUsd),
     });
     return true;
  }

  // --- EXECUTION CLOB REELLE ---
  const spendableTokensFromClob = await getOutcomeSpendableViaClob(clobClient, tokenId);
  const adjustedSellAmount = resolveSellAmountFromSpendable(tokensToSell, spendableTokensFromClob, 0.00001);
  if (adjustedSellAmount != null) tokensToSell = adjustedSellAmount;
  
  if (!(Number.isFinite(tokensToSell) && tokensToSell > 0)) {
    stopLossNextAttemptByCondition.set(conditionId, nowMs + 30000);
    return false;
  }

  return await executeClobExit(clobClient, pos, tokensToSell, bestBid, drawdownPct, triggerReason, endMs);
}

/** Boucle principale de monitoring (v7.13.1 Multi-Asset) */
async function tryDynamicExitForOpenPosition(clobClient) {
  if (!walletConfigured || !wallet) return;
  const active = readActivePositions();
  if (!active || active.length === 0) return;

  for (const pos of active) {
    try {
      await processSinglePositionExit(pos, clobClient);
    } catch (err) {
      logJson('error', 'Echec monitoring position', { underlying: pos.underlying, err: err.message });
    }
  }
}

async function executeClobExit(clobClient, pos, tokensToSell, bestBid, drawdownPct, triggerReason, endMs) {
  const conditionId = pos.conditionId;
  const tokenId = pos.tokenId;
  const takeSide = pos.takeSide;
  const entryPriceP = Number(pos.averageFillPriceP || 0.5);

  const minRawAmount = 1;
  const rawMaker = tokensToSell * 1e6;
  if (!(rawMaker >= minRawAmount)) return false;

  const minWorstPriceForValidTakerP = minRawAmount / (tokensToSell * 1e6);
  let bestBidLive = bestBid;
  let drawdownPctLive = drawdownPct;
  let worstPricePUsed = 0;
  let exitFilledOk = false;
  let totalFilledTokens = 0;
  let totalFilledUsdc = 0;

  for (let immediateAttempt = 0; immediateAttempt <= STOP_LOSS_IMMEDIATE_RETRY_MAX; immediateAttempt++) {
    if (immediateAttempt > 0) {
      await sleep(STOP_LOSS_IMMEDIATE_RETRY_DELAY_MS);
      const freshBid = await getBestBid(tokenId);
      if (!(freshBid > 0 && freshBid < 1)) break;
      bestBidLive = freshBid;
      drawdownPctLive = ((bestBidLive - entryPriceP) / entryPriceP) * 100;
    }

    worstPricePUsed = Math.max(stopLossWorstPriceP, minWorstPriceForValidTakerP);
    worstPricePUsed = Math.min(worstPricePUsed, stopLossTriggerPriceP);
    if (bestBidLive > 0) worstPricePUsed = Math.min(worstPricePUsed, bestBidLive);
    worstPricePUsed = Math.min(0.99, Math.max(0.001, worstPricePUsed));

    try {
      const result = await placeLimitOrder(clobClient, {
        price: worstPricePUsed,
        size: tokensToSell - totalFilledTokens,
        side: Side.SELL,
        tokenId,
      });
      const fill = await waitForOrderFill(clobClient, result?.orderID);
      if (fill?.clobSuccess) {
        totalFilledTokens += Number(fill.filledOutcomeTokens || 0);
        totalFilledUsdc += Number(fill.filledUsdc || 0);
        if (totalFilledTokens >= tokensToSell * 0.99) { exitFilledOk = true; break; }
      }
    } catch (e) {
      logJson('warn', 'Fail retry SL immediate', { err: e.message });
    }
  }

  const exitOrder = {
    at: new Date().toISOString(),
    conditionId,
    tokenId,
    underlying: pos.underlying,
    takeSide,
    event: 'stop_loss_exit',
    stopLossExit: exitFilledOk,
    triggerReason,
    triggerPriceP: entryPriceP,
    averageFillPriceP: totalFilledTokens > 0 ? totalFilledUsdc / totalFilledTokens : null,
    totalFilledUsdc,
    totalFilledTokens,
  };

  if (exitFilledOk) {
    pos.resolved = true;
    pos.stopLossExit = true;
    updateActivePosition(pos);
    writeLastOrder(exitOrder);
    appendOrderLog(exitOrder);
    notifyTelegramStopLossExit(exitOrder);
    return true;
  }
  return false;
}


/**
 * Surveille les signaux vus en mode "Watch" (sans ordre) pour tracker s'ils auraient touché un SL virtuel.
 */
async function tryStopLossForVirtualWatchEntries() {
  if (!stopLossEnabled || virtualWatchEntries.size === 0) return;
  const now = Date.now();
  for (const [cid, entry] of virtualWatchEntries.entries()) {
    // Purge auto si le créneau est fini ou si le signal est trop vieux (> 4h par sécurité)
    if ((entry.endMs && now >= entry.endMs) || now - entry.at > 4 * 60 * 60 * 1000) {
      virtualWatchEntries.delete(cid);
      continue;
    }
    // Ne pas vérifier trop souvent (Throttle interne 15s pour le watch SL)
    const lastCheck = entry.lastCheckAt || 0;
    if (now - lastCheck < 15_000) continue;
    entry.lastCheckAt = now;

    try {
      const bestBid = await getBestBid(entry.tokenId);
      if (!(bestBid > 0 && bestBid < 1)) continue;

      const drawdownPct = ((bestBid - entry.entryPriceP) / entry.entryPriceP) * 100;
      const triggerByPrice = bestBid < stopLossTriggerPriceP;
      const triggerByDrawdown = stopLossDrawdownEnabled && drawdownPct <= -Math.abs(stopLossMaxDrawdownPct);

      if (triggerByPrice || triggerByDrawdown) {
        logStopLossTouchedWatch({
          conditionId: cid,
          tokenId: entry.tokenId,
          takeSide: entry.takeSide,
          bestBid,
          entryPriceP: entry.entryPriceP,
          drawdownPct,
          triggerByPrice,
          triggerByDrawdown,
        });
        // Une fois touché, on peut choisir soit de le garder (re-log périodique) soit de le supprimer.
        // On le garde pour que le dashboard live continue de l'afficher si le prix reste bas.
        // On augmente le throttle pour cet entry précis.
        entry.lastCheckAt = now + 45_000; 
      }
    } catch (_) {}
  }
}

/** Exécute une passe stop-loss avec verrou anti-chevauchement. Retourne un client CLOB réutilisable pour le cycle. */
async function runStopLossPass() {
  if (!walletConfigured || !wallet || !stopLossEnabled) return null;
  if (stopLossPassBusy) return null;
  stopLossPassBusy = true;
  try {
    let clobClient = null;
    try {
      clobClient = await buildClobClientCachedCreds();
    } catch (err) {
      try {
        const lo = readLastOrder();
        if (lo?.simulationTrade === true) {
          console.warn('[stop_loss_pass] CLOB indisponible — tentative SL PAPER sans client.');
        } else {
          throw err;
        }
      } catch {
        throw err;
      }
    }
    await tryDynamicExitForOpenPosition(clobClient);
    await tryStopLossForVirtualWatchEntries();
    return clobClient;
  } catch (err) {
    notePolymarketIncidentError('stop_loss_pass', err);
    warnClobClientIfThrottled(err);
    return null;
  } finally {
    stopLossPassBusy = false;
  }
}

/**
 * Fin de marché par `conditionId` : `marketEndMs` ou `endDate` dans orders.log puis last-order.json (dernier écrase).
 * Utilisé avec REDEEM_AFTER_MARKET_END_MS pour ne pas tenter le redeem avant la cloche (+ délai).
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
    if (ms == null || !Number.isFinite(ms) || ms <= 0) {
      ms = parseMarketEndDateToMs(obj.endDate);
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
 * Résolution marché en mode paper : crédit USDC si le côté acheté gagne (Gamma), sans tx chain.
 */
async function trySimulationPaperRedeem() {
  if (!simulationTradeEnabled) return;
  const tradedIds = getTradedConditionIds();
  const marketEndByCid =
    REDEEM_AFTER_MARKET_END_MS > 0 ? getLatestMarketEndMsByConditionId() : null;
  const nowMs = Date.now();
  for (const cid of tradedIds) {
    if (!simulationTrade.conditionHasSimulationTrade(ORDERS_LOG_FILE, cid)) continue;
    if (simulationTrade.isPaperRedeemed(BOT_DIR, cid)) continue;
    const lastEv = simulationTrade.ordersLogLastEntryForCondition(ORDERS_LOG_FILE, cid);
    if (!lastEv || lastEv.simulationTrade !== true) continue;
    if (lastEv.paperResolution === true || lastEv.event === 'resolution_redeem_paper') {
      if (!simulationTrade.isPaperRedeemed(BOT_DIR, cid)) simulationTrade.markPaperRedeemed(BOT_DIR, cid);
      continue;
    }
    if (lastEv.stopLossExit === true) {
      simulationTrade.markPaperRedeemed(BOT_DIR, cid);
      continue;
    }
    if (marketEndByCid) {
      const endMs = marketEndByCid.get(String(cid).trim());
      if (endMs == null || !Number.isFinite(endMs)) {
        if (!REDEEM_ALLOW_UNKNOWN_MARKET_END_MS) continue;
      } else if (nowMs < endMs + REDEEM_AFTER_MARKET_END_MS) {
        continue;
      }
    }
    let market;
    try {
      market = await simulationTrade.fetchGammaMarketForCondition(cid);
    } catch (e) {
      logJson('warn', 'PAPER redeem: Gamma indisponible', {
        cid: cid.slice(0, 14),
        err: String(e?.message || e).slice(0, 120),
      });
      continue;
    }
    if (!simulationTrade.isGammaMarketClosed(market)) continue;
    const winner = simulationTrade.winnerFromGammaMarket(market);
    const takeSide = lastEv.takeSide === 'Up' || lastEv.takeSide === 'Down' ? lastEv.takeSide : null;
    const tokens = Number(lastEv.filledOutcomeTokens);
    const tok = Number.isFinite(tokens) && tokens > 0 ? tokens : null;
    let payoutUsd = 0;
    if (winner && takeSide && tok != null) {
      payoutUsd = winner === takeSide ? tok * 1 : 0;
    }
    payoutUsd = Math.round(payoutUsd * 1e6) / 1e6;
    simulationTrade.adjustPaperBalance(BOT_DIR, payoutUsd);
    simulationTrade.markPaperRedeemed(BOT_DIR, cid);
    const at = new Date().toISOString();
    const resolutionLog = {
      at,
      conditionId: cid,
      simulationTrade: true,
      event: 'resolution_redeem_paper',
      outcome: payoutUsd > 0 ? 'win' : 'lose',
      winnerGamma: winner,
      takeSide,
      payoutUsd,
      filledOutcomeTokens: tok,
    };
    appendOrderLog(resolutionLog);
    writeLastOrder({
      ...resolutionLog,
      paperResolution: true,
      stopLossExit: false,
    });
    await notifyTelegramRedeemEvent({
      ok: true,
      conditionId: cid,
      simulationTrade: true,
      paperPayoutUsd: payoutUsd,
      winnerGamma: winner,
      takeSide,
    });
    logJson('info', 'PAPER redeem résolution', { conditionId: cid.slice(0, 18), payoutUsd, winner });
  }
}

/**
 * 3.0 : Parcourt les positions actives, vérifie si elles sont résolues sur Gamma,
 * calcule le PnL réel et met à jour les stats journalières.
 */
async function resolveActivePositionsAnalytics() {
  const active = readActivePositions();
  if (active.length === 0) return;

  const nowMs = Date.now();
  let changed = false;
  const stats = readDailyStats();

  for (const pos of active) {
    if (pos.resolved) continue;

    // On attend au moins 1 minute après la fin théorique du marché pour éviter les race conditions
    const marketEndMs = pos.marketEndMs ?? pos.endDate;
    if (marketEndMs && nowMs < marketEndMs + 60000) continue;

    try {
      const market = await simulationTrade.fetchGammaMarketForCondition(pos.conditionId);
      if (!simulationTrade.isGammaMarketClosed(market)) continue;

      const winner = simulationTrade.winnerFromGammaMarket(market);
      if (!winner) continue;

      const isWin = pos.takeSide === winner;
      // PnL Simplifié : Si Win => Mise * (1/Prix - 1). Si Loss => -Mise.
      const entryPrice = pos.avgFillPrice || pos.pricePrompt || 0.5;
      const pnl = isWin ? (pos.amountUsd * (1/entryPrice - 1)) : -pos.amountUsd;

      pos.resolved = true;
      pos.payout = Math.round(pnl * 100) / 100;
      pos.winner = winner;
      changed = true;

      // Mise à jour des Stats Journalières pour le Circuit Breaker
      stats.dailyPnl += pos.payout;
      if (isWin) {
        stats.consecutiveLosses = 0;
      } else {
        stats.consecutiveLosses += 1;
      }

      // Log Analytics pour feedback futur
      fs.appendFileSync(ANALYTICS_LOG_FILE, JSON.stringify({
        at: new Date().toISOString(),
        slug: pos.eventSlug,
        side: pos.takeSide,
        winner,
        pnl: pos.payout,
        netGapAtEntry: pos.netGapAtEntry,
        spotAtEntry: pos.spotAtEntry,
        strike: pos.strike
      }) + '\n');

      console.log(`[Analytics 3.0] Position résolue: ${pos.eventSlug} | Résultat: ${isWin ? 'Gagné' : 'Perdu'} | PnL: ${pos.payout} USDC`);
    } catch (err) {
      // Gamma peut être lent ou 404 temporairement
    }
  }

  if (changed) {
    writeActivePositions(active);
    writeDailyStats(stats);
  }
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
    if (simulationTrade.conditionHasSimulationTrade(ORDERS_LOG_FILE, cid)) continue;
    const conditionIdBytes32 = conditionIdToBytes32(cid);
    if (!conditionIdBytes32) continue;
    if (getRedeemedConditionIdsSet().has(String(cid).trim())) continue;
    if (isRedeemSkippedByEnv(cid)) continue;
    if (marketEndByCid) {
      const endMs = marketEndByCid.get(String(cid).trim());
      if (endMs == null || !Number.isFinite(endMs)) {
        if (!REDEEM_ALLOW_UNKNOWN_MARKET_END_MS) continue;
      } else if (nowMs < endMs + REDEEM_AFTER_MARKET_END_MS) {
        continue;
      }
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
          await notifyTelegramRedeemEvent({
            ok: true,
            conditionId: cid,
            hash: result.transactionHash,
            viaRelayer: true,
          });
          appendOrderLog({
            at: new Date().toISOString(),
            event: 'resolution_redeem',
            outcome: 'win',
            conditionId: cid,
            viaRelayer: true,
            transactionHash: result.transactionHash,
          });
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
          await notifyTelegramRedeemFailureOnce(cid, { detail, viaRelayer: true });
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
          await notifyTelegramRedeemEvent({ ok: true, conditionId: cid, hash: receipt.hash, viaRelayer: false });
          appendOrderLog({
            at: new Date().toISOString(),
            event: 'resolution_redeem',
            outcome: 'win',
            conditionId: cid,
            viaRelayer: false,
            transactionHash: receipt.hash,
          });
        } else {
          noteRedeemFailureBackoff(cid);
          await notifyTelegramRedeemFailureOnce(cid, {
            detail: `receipt status=${receipt?.status ?? '?'}`,
            viaRelayer: false,
          });
        }
      }
    } catch (err) {
      const em = String(err.message || err);
      if (/no positions to redeem|nothing to redeem|payout of zero|already been redeemed/i.test(em)) {
        markConditionRedeemedSuccess(cid);
      } else {
        noteRedeemFailureBackoff(cid);
        await notifyTelegramRedeemFailureOnce(cid, { error: em, viaRelayer: !!relayerClient });
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
/** Récupère le carnet d'ordres complet (Limit Order Book) pour un token. */
async function getLOBForSignal(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 3000 });
    return {
      asks: Array.isArray(data?.asks) ? data.asks : [],
      bids: Array.isArray(data?.bids) ? data.bids : [],
    };
  } catch (err) {
    notePolymarketIncidentError('clob_book_lob', err);
    return null;
  }
}

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
 * - 15m : **même règle que le dashboard** — pas les 6 premières / 4 dernières minutes de chaque quart d’heure **ET** (:00,:15,:30,:45).
 * - horaire : 5 dernières minutes avant fin événement Gamma.
 */


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
async function fetchGammaEventsCached(slugMatch, eventsTimeoutMs = 15000, options = {}) {
  const cacheKey = getGammaEventsCacheKey(slugMatch);
  const now = Date.now();
  const preferCurrentSlotOnly = options?.preferCurrentSlotOnly === true;
  const currentSlug = MARKET_MODE === '15m' ? getCurrent15mEventSlug() : getCurrentHourlyEventSlug();
  const currentSlugLower = String(currentSlug || '').toLowerCase();
  const cached = gammaEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  const profile = {
    usedEvents: false,
    eventsMsTotal: null,
    eventsRetryUsed: false,
    hasMatchingSlugAfterEvents: null,
    fallbackSlugOk: null,
    fallbackSlugMs: null,
    fastPath: null,
  };

  // Fast-path fetchSignals: si on ne veut que le créneau courant, réutiliser le cache slug direct.
  if (preferCurrentSlotOnly && currentSlugLower) {
    const slotCached = gammaSlotEventCache.get(currentSlugLower);
    if (slotCached && slotCached.expiresAt > now) {
      const out = {
        expiresAt: now + Math.min(GAMMA_EVENTS_CACHE_MS, 2000),
        events: [slotCached.event],
        profile: {
          ...profile,
          usedEvents: false,
          hasMatchingSlugAfterEvents: true,
          fallbackSlugOk: true,
          fallbackSlugMs: 0,
          fastPath: 'slot_cache_hit',
        },
      };
      gammaEventsCache.set(cacheKey, out);
      return out;
    }
    try {
      const tDirect0 = Date.now();
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(currentSlugLower)}`, {
        timeout: GAMMA_DIRECT_SLUG_TIMEOUT_MS,
      });
      const slugOk = (ev?.slug ?? '').toLowerCase().includes(slugMatch);
      if (ev && slugOk) {
        gammaSlotEventCache.set(currentSlugLower, {
          expiresAt: computeGammaSlotEventCacheExpiresAt(currentSlugLower, now),
          event: ev,
        });
        const out = {
          expiresAt: now + Math.min(GAMMA_EVENTS_CACHE_MS, 2000),
          events: [ev],
          profile: {
            ...profile,
            usedEvents: false,
            hasMatchingSlugAfterEvents: true,
            fallbackSlugOk: true,
            fallbackSlugMs: Date.now() - tDirect0,
            fastPath: 'direct_slug_first',
          },
        };
        gammaEventsCache.set(cacheKey, out);
        return out;
      }
    } catch (_) {
      // On continue sur la stratégie liste complète.
    }
  }

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
      const slug = currentSlug;
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        events = [ev];
        profile.fallbackSlugOk = true;
        gammaSlotEventCache.set(String(slug).toLowerCase(), {
          expiresAt: computeGammaSlotEventCacheExpiresAt(String(slug).toLowerCase(), now),
          event: ev,
        });
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
      const slug = currentSlug;
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
      if (ev && (ev.slug ?? '').toLowerCase().includes(slugMatch)) {
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

  const out = { expiresAt: now + GAMMA_EVENTS_CACHE_MS, events, profile };
  gammaEventsCache.set(cacheKey, out);
  return out;
}



/** Vérifie si l’IP est autorisée à trader (geoblock). */
async function checkGeoblockStatus() {
  try {
    const { data } = await axios.get('https://polymarket.com/api/geoblock', { timeout: 5000 });
    if (data?.isRestricted) {
      console.error('❌ ERREUR CRITIQUE : Cette adresse IP est restreinte par Polymarket (Geoblock).');
      return false;
    }
    console.log('✅ Geoblock Check : IP Autorisée.');
    return true;
  } catch (err) {
    console.warn('⚠️ Impossible de vérifier le Geoblock:', err.message);
    return true; // On continue par défaut si le check échoue (parfois endpoint instable)
  }
}

/** Vérifie si nous sommes dans la fenêtre de maintenance Polymarket (Mardi ~13h Paris / 7h ET). */
function isMaintenanceWindow() {
  const now = new Date();
  // Mardi (getUTCDay 2)
  if (now.getUTCDay() !== POLYMARKET_MAINTENANCE_DAY_UTC) return false;
  
  // Fenêtre 7:00 AM ET - 7:15 AM ET (soit 11:00-11:15 UTC ou 12:00-12:15 UTC selon DST).
  // On couvre la plage 11:00-11:15 UTC pour la sécurité.
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  if (hour === 11 && min < 15) return true;
  if (hour === 12 && min < 15) return true; // Cas DST décalé
  
  return false;
}

/** Vérifie si un Cooldown 425 est actif (120 secondes). */
function isCooldown425() {
  if (last425ErrorAt === 0) return false;
  const elapsed = Date.now() - last425ErrorAt;
  return elapsed < 120000; // 2 minutes
}
/** Récupère les token IDs des marchés actifs (Up + Down) pour s'abonner au WebSocket CLOB. Retourne { tokenIds, tokenToSignal }. */
async function getActiveMarketTokensForWs() {
  const tokenIds = [];
  const tokenToSignal = new Map();

  const collectForAsset = async (asset) => {
    let slugMatch = BITCOIN_UP_DOWN_SLUG;
    if (MARKET_MODE === '15m') {
      if (asset === 'ETH') slugMatch = ETHEREUM_UP_DOWN_15M_SLUG;
      else if (asset === 'SOL') slugMatch = SOLANA_UP_DOWN_15M_SLUG;
      else slugMatch = BITCOIN_UP_DOWN_15M_SLUG;
    } else {
      if (asset === 'ETH') slugMatch = ETHEREUM_UP_DOWN_SLUG;
      else if (asset === 'SOL') slugMatch = SOLANA_UP_DOWN_SLUG;
      else slugMatch = BITCOIN_UP_DOWN_SLUG;
    }

    const gammaOut = await fetchGammaEventsCached(slugMatch, 15000);
    let events = gammaOut.events;
    if (MARKET_MODE === '15m') {
      const r = await resolve15mEventsForTrading(events, Date.now(), asset);
      events = r.events;
    }

    for (const ev of events) {
      if (!ev?.markets?.length) continue;
      const eventSlug = (ev.slug ?? '').toLowerCase();
      if (!eventSlug.includes(slugMatch.toLowerCase())) continue;
      const marketEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
      for (const m of ev.markets) {
        const endDate = m.endDate ?? m.end_date_iso ?? marketEndDate;
        const merged = mergeGammaEventMarketForUpDown(ev, m);
        const { tokenIdUp, tokenIdDown } = getAlignedUpDownTokenIds(merged);
        if (tokenIdUp) {
          tokenIds.push(tokenIdUp);
          tokenToSignal.set(tokenIdUp, {
            market: merged,
            asset,
            tokenIdUp,
            tokenIdDown,
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
            asset,
            tokenIdUp,
            tokenIdDown,
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
  };

  for (const asset of SUPPORTED_ASSETS) {
    await collectForAsset(asset);
  }
  return { tokenIds: [...new Set(tokenIds)], tokenToSignal };
}

/** Slug du créneau 15m ouvert : `{prefix}-{eventStartSec}` (Gamma). */
function getCurrent15mEventSlug(asset = 'BTC') {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotStart = Math.floor(nowSec / 900) * 900;
  let prefix = BITCOIN_UP_DOWN_15M_SLUG;
  if (asset === 'ETH') prefix = ETHEREUM_UP_DOWN_15M_SLUG;
  if (asset === 'SOL') prefix = SOLANA_UP_DOWN_15M_SLUG;
  return `${prefix}-${slotStart}`;
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
async function resolve15mEventsForTrading(events, nowMs = Date.now(), asset = 'BTC') {
  const expectedSlug = getCurrent15mEventSlug(asset).toLowerCase();
  const searchPrefix = (asset === 'ETH') ? ETHEREUM_UP_DOWN_15M_SLUG : (asset === 'SOL') ? SOLANA_UP_DOWN_15M_SLUG : BITCOIN_UP_DOWN_15M_SLUG;
  
  const relevantEvents = events.filter((e) => (e.slug ?? '').toLowerCase().includes(searchPrefix));
  
  if (relevantEvents.length > 0) {
    return { events: relevantEvents, resolveStrategy: 'filter_active_15m', slugMismatch: false, expectedSlug };
  }

  // Fallback si la liste est vide : essai direct par slug (API GET /event/slug)
  try {
    const url = `${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(expectedSlug)}`;
    const { data: ev } = await axios.get(url, { timeout: 8000 });
    if (ev?.markets?.length) {
      return { events: [ev], resolveStrategy: 'direct_slug', slugMismatch: false, expectedSlug };
    }
  } catch (_) {}
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

/** Récupère tous les créneaux actifs (15m ou 1h) sans filtre de prix pour tous les assets. */
async function fetchActiveWindows() {
  const results = [];
  const seenKeys = new Set();
  
  for (const asset of SUPPORTED_ASSETS) {
    let slugMatch = BITCOIN_UP_DOWN_SLUG;
    if (MARKET_MODE === '15m') {
       if (asset === 'ETH') slugMatch = ETHEREUM_UP_DOWN_15M_SLUG;
       else if (asset === 'SOL') slugMatch = SOLANA_UP_DOWN_15M_SLUG;
       else slugMatch = BITCOIN_UP_DOWN_15M_SLUG;
    } else {
       if (asset === 'ETH') slugMatch = ETHEREUM_UP_DOWN_SLUG;
       else if (asset === 'SOL') slugMatch = SOLANA_UP_DOWN_SLUG;
       else slugMatch = BITCOIN_UP_DOWN_SLUG;
    }

    const { events } = await fetchGammaEventsCached(slugMatch, 15000);
    for (const ev of events) {
      if (!ev?.markets?.length) continue;
      const eventSlug = (ev.slug ?? '').toLowerCase();
      if (!eventSlug.includes(slugMatch.toLowerCase())) continue;
      const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
      for (const m of ev.markets) {
        const key = m.conditionId ?? m.condition_id ?? '';
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
        results.push({ market: m, ev, endDate: marketEndDate, key, asset });
      }
    }
  }
  return results;
}

/** Slug horaire au format Gamma `{prefix}-1h-{eventStartSec}`. */
function getCurrentHourlyEventSlug(asset = 'BTC') {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotStart = Math.floor(nowSec / 3600) * 3600;
  let prefix = BITCOIN_UP_DOWN_SLUG;
  if (asset === 'ETH') prefix = ETHEREUM_UP_DOWN_SLUG;
  if (asset === 'SOL') prefix = SOLANA_UP_DOWN_SLUG;
  return `${prefix}-1h-${slotStart}`;
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
const ABSOLUTE_MIN_USD = 1.0;

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
    // Blindage 2026 : Proactive Throttling avant chaque tentative
    const throttleMs = checkRateLimitProactive();
    if (throttleMs > 0) await sleep(throttleMs);

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
        const worstPrice = options.worstPrice || marketWorstPriceP;
        const userMarketOrder = { tokenID: tokenIdToBuy, amount: size, side: options?.side || Side.BUY, price: worstPrice };
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
        return {
          ok: true,
          orderID: result?.orderID ?? result?.id,
          preSignCacheHit,
          clobResponse,
          ...(Array.isArray(result?.clobResponses) ? { clobResponses: result.clobResponses } : {}),
          ...fill,
        };
      }
      const userOrder = { tokenID: tokenIdToBuy, price: roundedPrice, size, side: options?.side || Side.BUY };
      // Ordre limite : create + sign puis POST (même pattern que achat/vente).
      const signedOrderLimit = await client.createOrder(userOrder, options);
      const result = await client.postOrder(signedOrderLimit, OrderType.GTC);
      const fill = parsePolymarketPostOrderFill(result, { orderSide: options?.side || Side.BUY, requestedUsd: size });
      const clobResponse = serializeClobPostOrderResponseForLog(result);
      consecutiveOrderErrors = 0;
      return {
        ok: true,
        orderID: result?.orderID ?? result?.id,
        preSignCacheHit: false,
        clobResponse,
        ...(Array.isArray(result?.clobResponses) ? { clobResponses: result.clobResponses } : {}),
        ...fill,
      };
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

    // --- Kill-Switch Instantané v5.3.0 (Adverse Selection) ---
    // Si après le 1er passage, le prix a bougé de plus de 0.1c (ou seuil configuré), on abandonne.
    const lastFillPrice = lastOk?.averageFillPriceP;
    if (lastFillPrice != null) {
      const currentBestAsk = latestPrices.get(signal.tokenIdToBuy)?.bestAsk;
      const killSwitchSlippage = Number(process.env.KILL_SWITCH_SLIPPAGE_THRESHOLD) || 0.001; // 0.1c
      
      if (currentBestAsk != null && Math.abs(currentBestAsk - lastFillPrice) > killSwitchSlippage) {
        logJson('warn', 'Kill-Switch Adverse Selection: Slippage excessif détecté sur reliquat.', {
          lastFillPrice,
          currentBestAsk,
          slippage: Math.abs(currentBestAsk - lastFillPrice),
          threshold: killSwitchSlippage
        });
        break; 
      }
    }
    // --- Fin Kill-Switch ---

    // --- GRADIENT DE PRIX v5.0.0 (Dégradation 0.1% par tentative) ---
    const side = options?.side || Side.BUY;
    let worstPrice = options.worstPrice || marketWorstPriceP;
    const degradation = 0.001 * (extra + 1); // 0.1% cumulé
    
    if (side === Side.BUY) {
      worstPrice = Math.min(0.999, worstPrice * (1 + degradation));
    } else {
      worstPrice = Math.max(0.001, worstPrice * (1 - degradation));
    }

    if (partialFillRetryRevalidatePrice && signal?.tokenIdToBuy) {
      try {
        const ask = await getBestAsk(signal.tokenIdToBuy);
        if (ask == null || ask < MIN_P || ask > MAX_P) {
          logJson('info', 'Complément FAK: best ask hors fenêtre signal, arrêt', { ask, extra });
          break;
        }

        // v5.2.2 : Revalidation OFI au sein du retry (Audit Compliance)
        const currentOfi = ofiState.get(signal.tokenIdToBuy)?.ofi || 0;
        if (side === Side.BUY && currentOfi < -0.1) { // Pression adverse détectée
          logJson('info', 'Complément FAK: OFI Adverse détecté, abandon', { ofi: currentOfi, extra });
          break;
        }

        // v5.2.2 : Revalidation Persistance du GAP (Audit Compliance)
        // On utilise le chainlinkSpotPrice global pour un check rapide
        if (chainlinkSpotPrice > 0 && signal.strikePrice) {
          const nowTs = Math.floor(Date.now() / 1000);
          const marketEndTs = Math.floor(signal.endDate / 1000);
          const secondsLeft = Math.max(0, marketEndTs - nowTs);
          const currentProbFair = calculateFairProbability(chainlinkSpotPrice, signal.strikePrice, secondsLeft, null);
          
          const currentGap = side === Side.BUY ? (currentProbFair - ask) : (ask - currentProbFair);
          if (currentGap < ARBITRAGE_GAP_THRESHOLD * 0.3) { // Seuil de survie du GAP à 30% (Audit v5.2.2)
            logJson('info', 'Complément FAK: GAP évaporé sur retry, abandon', { currentGap, extra });
            break;
          }
        }

        // En mode dégradé, on prend le freshAsk et on lui applique la dégradation
        if (side === Side.BUY) worstPrice = Math.min(0.999, ask * (1 + degradation));
        else worstPrice = Math.max(0.001, ask * (1 - degradation));
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
    const next = await placeOrder(signal, requestUsd, clientOrNull, { ...options, allowBelowMin, worstPrice });
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

async function tryPlaceOrderForSignal(signal, source = 'ws') {
  if (!signal?.tokenIdToBuy) return;
  const asset = signal.asset || 'BTC';
  // v7.16.0 : Unified Strike Injection (Poll & WS)
  if (signal.strike == null) {
      const slug = signal.slug || signal.eventSlug;
      const start = signal.m?.startDate || signal.startDate;
      signal.strike = lookupBoundaryStrike(asset, start, null, slug);
  }
  const key = getSignalKey(signal);

  // --- OFI DYNAMIC THRESHOLD (v5.7.1) ---
  const ofiMultiplier = getOfiThresholdMultiplier(asset, signal.ofiScore || 0, signal.takeSide);
  const adjustedThreshold = ARBITRAGE_GAP_THRESHOLD * ofiMultiplier;


  if (shouldSkipTradeTiming(signal)) {
    const timingDetails = getTimingForbiddenDetails();
    recordSkipReason('timing_forbidden', source, {
      conditionId: key,
      tokenId: signal.tokenIdToBuy,
      takeSide: signal.takeSide,
      bestAskP: pickSignalBestAskP(signal),
      ...timingDetails,
    });
    logSignalInRangeButNoOrder(source, 'timing_forbidden', signal, { ...timingDetails });
    return;
  }
  if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) {
    const r = !walletConfigured ? 'wallet_not_configured' : !autoPlaceEnabled ? 'auto_place_disabled' : 'kill_switch';
    logSignalInRangeButNoOrder(source, r, signal, {});
    return;
  }

  // --- Correlation Guard BTC/ETH ---
  const MAX_CONCURRENT_CORRELATED_POSITIONS = 1;
  const correlatedGroup = ["BTC", "ETH"];
  if (correlatedGroup.includes(signal.asset)) {
    const activePositions = readActivePositions();
    const now = Date.now();
    const activeCorrelated = activePositions.filter(p => 
      correlatedGroup.includes(p.asset) && (p.marketEndMs ? p.marketEndMs > now : true)
    ).length;
    if (activeCorrelated >= MAX_CONCURRENT_CORRELATED_POSITIONS) {
        console.log(`⛔ [${signal.asset}] Exposition BTC/ETH déjà active (${activeCorrelated} pos) — [${source}] skip.`);
        recordSkipReason('correlation_limit', source, { asset: signal.asset, activeCorrelated });
        return;
    }
  }

  const cooldownRemainingMs = getExecutionCooldownRemainingMs(key);
  if (cooldownRemainingMs > 0 && !(signal.edge > 0.35)) {
    recordSkipReason('cooldown_active', source, { conditionId: key, remainingMs: cooldownRemainingMs });
    return;
  }

  if (inPolymarketDegradedMode() && incidentBehavior === 'pause') {
    recordSkipReason('degraded_mode_pause', source, { conditionId: key });
    return;
  }

  const t0 = Date.now();
  const timingsMs = { bestAsk: null, creds: null, balance: null, book: null, placeOrder: null };
  let bestAskLive = null;
  const wsEventAtMs = Number(signal?._wsReceivedAtMs) || 0;

  // 1. PHASE PRIX (WS ou REST)
  if (USE_WS_PRICE_ONLY) {
    const wsBestAsk = signal.takeSide === 'Up' ? signal.priceUp : signal.priceDown;
    if (wsBestAsk == null || wsBestAsk < MIN_P || wsBestAsk > MAX_P) return;
    bestAskLive = wsBestAsk;
    timingsMs.bestAsk = 1;
    const wsAgeMs = wsEventAtMs > 0 ? Date.now() - wsEventAtMs : null;
    if (wsAgeMs != null && wsAgeMs > wsFreshnessMaxMs) {
      const restAsk = await getBestAsk(signal.tokenIdToBuy);
      if (!restAsk || Math.abs(restAsk - wsBestAsk) > wsPriceMismatchMaxP) return;
      bestAskLive = restAsk;
    }
  } else {
    bestAskLive = await getBestAsk(signal.tokenIdToBuy);
    if (!bestAskLive) return;
  }

  // 2. PHASE CONNECTION (CLOB)
  let clobClient = null;
  try {
    const tCreds0 = Date.now();
    clobClient = await buildClobClientCachedCreds();
    timingsMs.creds = Math.max(1, Date.now() - tCreds0);
  } catch (err) {
    console.warn('WebSocket tryPlace: CLOB client:', err.message);
    return;
  }

  // 3. PHASE MESURE (Balance & Book)
  const tBal0 = Date.now();
  let balance;
  if (simulationTradeEnabled) {
    balance = simulationTrade.getPaperBalanceUsd(BOT_DIR);
  } else {
    balance = (await getUsdcSpendableViaClob(clobClient)) ?? (await getUsdcBalanceRpc());
  }
  timingsMs.balance = Math.max(1, Date.now() - tBal0);

  let liquidity = null;
  let maxUsdAvg = null;
  if (needLiquidityBook) {
    const tBook0 = Date.now();
    liquidity = await getLiquidityAtTargetUsd(signal.tokenIdToBuy);
    timingsMs.book = Math.max(1, Date.now() - tBook0);
    if (useAvgPriceSizing && bestAskLive != null) {
      maxUsdAvg = await getMaxUsdForAvgPrice(signal.tokenIdToBuy, bestAskLive + avgPriceTolP);
    }
  }

  // 4. PHASE SIZING (Kelly, SOL, Caps)
  const balanceForSizing = budgetModeReserveExcessFromStart ? (balance != null ? getEffectiveBalanceForSizing(balance) : balance) : balance;
  let amountUsd = orderSizeUsd;
  if (USE_KELLY_SIZING && balanceForSizing != null && signal.netGap != null) {
    const activePositions = readActivePositions();
    const lockedCapital = activePositions.filter(p => !p.resolved).reduce((sum, p) => sum + (p.filledUsdc || p.amountUsd || 0), 0);
    amountUsd = calculateKellyStake(signal.netGap, bestAskLive, Math.max(0, balanceForSizing - lockedCapital), signal.ofiScore || 0, signal.takeSide);
  } else if (useBalanceAsSize) {
    amountUsd = balanceForSizing ?? orderSizeUsd;
  }

  if (signal.asset === 'SOL') {
    amountUsd *= 0.5;
    console.log(`[Risk] 📉 SOL detected. Stake adjusted to ${(amountUsd).toFixed(2)} USDC.`);
  }

  if (liquidity != null && useLiquidityCap && amountUsd > liquidity) amountUsd = liquidity;
  if (maxUsdAvg != null && useAvgPriceSizing && amountUsd > maxUsdAvg) amountUsd = maxUsdAvg;
  amountUsd = applyMaxStakeUsd(amountUsd);

  // 5. PHASE VALIDATION (Safety, Exposure, VWAP)
  const safety = isTradeAllowedBySafety(signal.asset || 'BTC', signal.strike, calculateConsensusPrice(signal.asset || 'BTC'));
  if (!safety.ok) return;

  const activePositions = readActivePositions();
  const assetLimit = MAX_POSITIONS_PER_ASSET[signal.asset] || 10;
  if (activePositions.filter(p => !p.resolved && (p.underlying === signal.asset)).length >= assetLimit) return;

  if (amountUsd < orderSizeMinUsd) {
    logSignalInRangeButNoOrder('ws', 'amount_below_min', signal, { amountUsd, balance });
    return;
  }

  const vwapPrice = await calculateVWAPPrice(signal.tokenIdToBuy, amountUsd, clobClient);
  if (vwapPrice == null) return;

  const spotPrice = calculateConsensusPrice(asset);
  const strikePrice = Number(signal.strike);

  if (!Number.isFinite(strikePrice) || strikePrice <= 0) {
    recordSkipReason('missing_strike_data', source, { asset, strike: signal.strike });
    return;
  }
  
  if (spotPrice <= 0) {
    recordSkipReason('missing_spot_price', source, { asset, spotPrice });
    return;
  }

  const endDateMs = new Date(signal.m?.endDate || signal.endDate || 0).getTime();
  const secondsLeft = Math.max(0, (endDateMs - Date.now()) / 1000);
  const probFairLive = calculateFairProbability(spotPrice, strikePrice, secondsLeft, null, asset);

  // v7.14.6 : Injection de la probabilité Fair live pour le calcul de l'edge
  signal.probFairAtEntry = probFairLive;
  const fairValue = signal.takeSide === 'Up' ? probFairLive : (1 - probFairLive);
  const netEdge = (fairValue - vwapPrice) - 0.005; 

  // v7.14.5 : Hard Price Protection (Slippage/Book Guard)
  if (vwapPrice > 0.98) {
    recordSkipReason('price_protection_triggered', 'ws', { vwapPrice, asset });
    return;
  }

  if (netEdge < adjustedThreshold) {
    // --- LOG DECISION MATRIX (v7.14.7 : Moved after calculation) ---
    logDecision({
        at: new Date().toISOString(),
        source,
        asset,
        slug: signal.slug || signal.eventSlug,
        side: signal.takeSide,
        prob: probFairLive,
        ask: vwapPrice,
        edge: Number(netEdge.toFixed(4)),
        strike: signal.strike,
        ofi: signal.ofiScore || 0,
        adjThreshold: Number(adjustedThreshold.toFixed(4))
    });
    recordSkipReason('insufficient_net_edge', source, { netEdge, threshold: adjustedThreshold });
    return;
  }

  // 6. PHASE EXECUTION
  placedKeys.add(key);
  const tPlace0 = Date.now();
  let result;
  if (simulationTradeEnabled) {
    result = simulationTrade.buildSimulatedBuyFill({ amountUsd, bestAskP: vwapPrice, conditionId: key });
    if (result.ok) simulationTrade.adjustPaperBalance(BOT_DIR, -result.filledUsdc);
  } else {
    result = await placeMarketOrderWithPartialFillRetries(signal, amountUsd, clobClient, { forceSingleAttempt: inPolymarketDegradedMode() });
  }
  timingsMs.placeOrder = Date.now() - tPlace0;

  if (result.ok) {
    const time = new Date().toISOString();
    const orderData = {
      at: time,
      asset: signal.asset || 'BTC',
      underlying: signal.asset || 'BTC',
      takeSide: signal.takeSide,
      amountUsd,
      conditionId: key,
      strike: signal.strike,
      tokenId: signal.tokenIdToBuy,
      orderID: result.orderID,
      latencyMs: Date.now() - t0,
      timingsMs,
      ...pickFillFieldsForLog(result),
      edge: netEdge,
      simulationTrade: !!result.simulationTrade
    };

    activePositions.push({ ...orderData, resolved: false, entryTime: time });
    writeActivePositions(activePositions.slice(-50));
    writeLastOrder(orderData);
    appendOrderLog(orderData);
    void notifyTelegramTradeSuccess(source, orderData, simulationTradeEnabled ? null : clobClient);
    
    const retryInfo = (result.partialFillRetries ?? 0) > 0 ? ` — ${result.partialFillRetries} complément(s) FAK sur reliquat` : '';
    const fillConsole = formatFillConsoleSuffix(result);
    const cacheHitInfo = result.preSignCacheHit ? ' [cache pré-sign hit]' : '';

    console.log(
      `[${time}] [${source.toUpperCase()}] Ordre placé ${brandEmoji(signal.asset)} ${signal.asset} — ${amountUsd.toFixed(2)} USDC demandés${fillConsole}${retryInfo} — orderID: ${result.orderID} (latence ~${Math.round(orderData.latencyMs)} ms)${cacheHitInfo}`
    );
  } else {
    const isInsufficient = isInsufficientBalanceOrAllowanceError(result?.error);
    if (!isInsufficient) placedKeys.delete(key);
    if (isRetryableExecutionError(result?.error) || isInsufficient) {
      setExecutionCooldown(key, result.error);
      notePolymarketIncidentError('ws_order_failure', result.error);
    }
    logSignalInRangeButNoOrder(source, 'place_order_failed', signal, {
      bestAskP: bestAskLive,
      amountUsd: Math.round(amountUsd * 100) / 100,
      error: String(result?.error || '').slice(0, 240),
    });
    logJson('error', `Erreur ordre ${source.toUpperCase()}`, { takeSide: signal.takeSide, error: result.error });
    console.error(`[${time}] [${source.toUpperCase()}] Erreur ${signal.takeSide}: ${result.error}`);
  }
}

// ——— Boucle principale ———
const placedKeys = new Set();
/** Signaux "Watch" (sans ordre) pour lesquels on simule un Stop-Loss dans le dashboard. key -> { entryPrice, tokenId, takeSide, endMs } */
const virtualWatchEntries = new Map();
/** Fenêtres pour lesquelles on a déjà enregistré un relevé de liquidité (une fois par créneau = montant max par fenêtre pour le dashboard). */
const recordedLiquidityWindows = new Map(); // key (getSignalKey) -> endDateMs (pour purger les anciennes)
/** Dernier enregistrement de liquidité (lors d'un trade) pour aligner le throttle. */
let lastLiquidityRecordTime = 0;
/** v7.15.0 : mémorisation de la minute capturée (00, 15, 30, 45). */
let lastBoundaryMinute = null;

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
    // Abonnement aux meilleurs Bid/Ask (existant)
    ws.send(JSON.stringify({
      type: 'market',
      assets_ids: tokenIds,
      custom_feature_enabled: true,
    }));
    // Abonnement au carnet d'ordres L2 (nouveau - pour l'OFI)
    ws.send(JSON.stringify({
      type: 'book',
      assets_ids: tokenIds,
    }));
    // v7.10.0: Abonnement aux Fills en temps réel
    if (walletConfigured && wallet) {
      ws.send(JSON.stringify({
        type: 'orders',
        user: wallet.address.toLowerCase()
      }));
    }
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
    wsLastBidAskAtMs = 0;
    wsLastBidAskHealthWriteMs = 0;
    writeHealth({
      wsConnected: true,
      wsLastChangeAt: at,
      wsLastConnectedAt: at,
      wsLastBidAskAt: null,
    });
    console.log('WebSocket CLOB connecté — abonnement best_bid_ask (temps réel).');
    await refreshWsSubscriptions(clobWs);
    console.log(`[WS] Abonnements : ${wsState.tokenIds.length} jeton(s) (best_bid_ask attendu si marché actif).`);
    wsRefreshTimer = setInterval(() => refreshWsSubscriptions(clobWs), WS_REFRESH_SUBSCRIPTIONS_MS);
    wsPingTimer = setInterval(() => { if (clobWs?.readyState === WebSocket.OPEN) clobWs.ping(); }, WS_PING_INTERVAL_MS);
  });
  clobWs.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      
      // --- Traitement du canal 'book' pour l'OFI ---
      if (data?.event_type === 'book') {
        const assetId = String(data.asset_id ?? '');
        if (!assetId) return;
        
        const bids = data.bids || [];
        const asks = data.asks || [];
        if (!bids.length || !asks.length) return;

        const bestBid = bids[0];
        const bestAsk = asks[0];
        const bidPrice = parseFloat(bestBid.price);
        const bidSize = parseFloat(bestBid.size);
        const askPrice = parseFloat(bestAsk.price);
        const askSize = parseFloat(bestAsk.size);

        let state = ofiState.get(assetId) || { 
            prevBidPrice: bidPrice, prevBidSize: bidSize, 
            prevAskPrice: askPrice, prevAskSize: askSize, 
            ofi: 0 
        };

        // Calcul de l'Imbalance (OFI simple)
        let bidComponent = 0;
        if (bidPrice > state.prevBidPrice) bidComponent = bidSize;
        else if (bidPrice < state.prevBidPrice) bidComponent = -state.prevBidSize;
        else bidComponent = bidSize - state.prevBidSize;

        let askComponent = 0;
        if (askPrice < state.prevAskPrice) askComponent = askSize;
        else if (askPrice > state.prevAskPrice) askComponent = -state.prevAskSize;
        else askComponent = askSize - state.prevAskSize;

        // OFI = Delta Bid - Delta Ask
        const currentOfi = bidComponent - askComponent;
        
        // Accumulateur pondéré (lissage court terme)
        state.ofi = (state.ofi * 0.7) + (currentOfi * 0.3);
        
        state.prevBidPrice = bidPrice;
        state.prevBidSize = bidSize;
        state.prevAskPrice = askPrice;
        state.prevAskSize = askSize;
        ofiState.set(assetId, state);
        return;
      }

      // --- Traitement des Fills en temps réel (v7.10.0) ---
      if (data?.event_type === 'fill' || data?.event_type === 'order_fill') {
         const fill = data.fill || data;
         const assetId = String(fill.asset_id || '');
         const sig = wsState.tokenToSignal.get(assetId);
         await updateActivePositionsFromFill({
            ...fill,
            asset: sig?.asset || 'BTC'
         });
         return;
      }

      if (data?.event_type !== 'best_bid_ask') {
        if (clobWs._wsNonBookLogged == null) clobWs._wsNonBookLogged = 0;
        if (clobWs._wsNonBookLogged < 8) {
          clobWs._wsNonBookLogged += 1;
          const et = data?.event_type ?? data?.type ?? '(aucun)';
          console.log(`[WS] message hors best_bid_ask (aperçu) event_type=${et}`);
        }
        return;
      }
      wsLastBidAskAtMs = Date.now();
      if (wsLastBidAskAtMs - wsLastBidAskHealthWriteMs >= 2000) {
        wsLastBidAskHealthWriteMs = wsLastBidAskAtMs;
        writeHealth({ wsLastBidAskAt: new Date(wsLastBidAskAtMs).toISOString() });
      }
      
      // v6.2.0 : Capturer la latence WS (approximative via temps système depuis dernier message si dispo)
      // Note: Polymarket n'envoie pas de TS serveur précis dans best_bid_ask, on log juste l'activité.
      addLatencyHistorySample('ws', 20); // Placeholder "santé" active
      const assetId = String(data.asset_id ?? '');
      const bestAsk = parseFloat(data.best_ask);
      const bestBid = parseFloat(data.best_bid);

      if (assetId && Number.isFinite(bestBid)) {
        latestPrices.set(assetId, { bestBid, bestAsk });
        
        // v5.1.0 : Capture du lag Polymarket (CLOB)
        // On récupère les prix des deux côtés (Up/Down) pour consigner l'état du carnet
        const sig = wsState.tokenToSignal.get(assetId);
        if (sig) {
            const upP = latestPrices.get(sig.tokenIdUp)?.bestAsk || 0;
            const downP = latestPrices.get(sig.tokenIdDown)?.bestAsk || 0;
            lagRecorder.onPolyUpdate(sig.asset || 'BTC', upP, downP);
        }
      }

      if (!assetId || !Number.isFinite(bestAsk) || bestAsk < MIN_P || bestAsk > MAX_P) return;
      const sig = wsState.tokenToSignal.get(assetId);
      if (!sig) return;

      // Injection de l'OFI dans le signal
      const assetOfi = ofiState.get(assetId)?.ofi || 0;

      const signal = {
        ...sig,
        priceUp: sig.takeSide === 'Up' ? bestAsk : 1 - bestAsk,
        priceDown: sig.takeSide === 'Down' ? bestAsk : 1 - bestAsk,
        ofiScore: assetOfi,
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
  // Sécurité 2.1.2 : Maintenance Polymarket (Option B : Blindage 2026)
  if (isMaintenanceWindow() || isCooldown425()) {
    const reason = isMaintenanceWindow() ? 'Fenêtre hebdo' : 'Cooldown Post-425';
    console.log(`[Maintenance] ${reason} détectée. Suspension temporaire.`);
    return;
  }

  // v7.15.2 : Boundary Strike Capture (00, 15, 30, 45) - Moved to start for better timing
  const nowTrigger = new Date();
  const mins = nowTrigger.getMinutes();
  if ([0, 15, 30, 45].includes(mins) && mins !== lastBoundaryMinute) {
      lastBoundaryMinute = mins;
      for (const asset of SUPPORTED_ASSETS) {
          const price = getChainlinkPriceCached(asset) || calculateConsensusPrice(asset);
          if (price > 0) {
              saveBoundaryStrike(asset, price);
          }
      }
  }

  const cycleStartMs = Date.now();
  const profiler = createCycleProfiler();
  let clobClient = null;

  try {
    clobClient = await profiler.measure('stop_loss_fastpath', () => runStopLossPass());
    const balance = simulationTradeEnabled ? simulationTrade.getPaperBalanceUsd(BOT_DIR) : await getBalance();
    let totalUsd = balance;
    try { totalUsd = await calculateTotalValue(clobClient); } catch(_) {}
    if (totalUsd === 0) totalUsd = balance;

    let gasBalance = null;
    try { gasBalance = await checkNativeGasBalance(clobClient); } catch(_) {}

    const lastRedeem = currentHealthState?.lastRedeemAt ? new Date(currentHealthState.lastRedeemAt).getTime() : 0;
    if (Date.now() - lastRedeem > 43200000) {
        await runAutoRedeem(clobClient);
        writeHealth({ lastRedeemAt: new Date().toISOString() });
    }

    writeHealth({
      balance: balance.toFixed(2),
      totalUsd: totalUsd.toFixed(2),
      gasBalance: gasBalance != null ? gasBalance.toFixed(4) : '—',
      activeConditions: OPEN_LIMIT_ORDERS.size
    }, { totalUsd });

    let totalSignalsCount = 0;
    for (const asset of SUPPORTED_ASSETS) {
      const res = await profiler.measure(`fetchSignals_${asset}`, () => 
        fetchSignals(asset, { MARKET_MODE, getCurrent15mEventSlug, getCurrentHourlyEventSlug, FETCH_SIGNALS_CACHE_MS })
      );
      
      const signals = res.signals || [];
      totalSignalsCount += signals.length;
      const slug = res.slug;
      const hasEvent = res.hasEvent;

      if (hasEvent && slug) {
        const state = getAssetState(asset);
        if (!state.currentSlotStrike || state.currentSlotStrike.slotSlug !== slug) {
           state.currentSlotStrike = await captureStrikeAtSlotOpen(asset, slug);
        }
      }
      
      if (signals.length === 0) continue;

      await profiler.measure(`redeem_${asset}`, () => trySimulationPaperRedeem(asset));

      if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) continue;

      await profiler.measure(`place_orders_${asset}`, async () => {
        for (const s of signals) {
          await tryPlaceOrderForSignal(s, 'poll');
        }
      });
    }

    await profiler.measure('redeem_global', () => tryRedeemResolvedPositions());
    await profiler.measure('stale_orders_v7', () => checkAndCancelStaleOrders(clobClient));

    // v7.1.0 : Rewards Monitor (tous les 5 mins)
    if (Date.now() - lastRewardsFetch > 300000) {
       await profiler.measure('fetch_rewards', async () => {
         const data = await fetchRewardsUserPercentages(clobClient);
         if (data) {
           cachedRewardsData = data;
           lastRewardsFetch = Date.now();
         }
       });
    }

    await profiler.measure('analytics_3_0', () => resolveActivePositionsAnalytics());

    // getBalance removed from nested scope (v7.12.0 Fix)

  } finally {
    if (CYCLE_PROFILER) profiler.log();
    const cycleDuration = Date.now() - cycleStartMs;
    // v6.2.0 : Historisation de la latence de boucle (Poll)
    addLatencyHistorySample('poll', cycleDuration);

    appendCycleLatencyHistory({
      cycleMs: cycleDuration,
      ok: true,
      mode: MARKET_MODE,
      signalsCount: typeof signalsCount !== 'undefined' ? signalsCount : 0,
      cycleProfileMs: profiler.getTimings(),
    });
  }
}


/**
 * Flux Binance Temps Réel (Multi-Assets v5.4.0)
 */
function startBinanceWs() {
  if (binanceWs) return;
  const streams = SUPPORTED_ASSETS.map(a => `${a.toLowerCase()}usdt@aggTrade`).join('/');
  console.log(`[Binance] Connexion WebSocket pour [${SUPPORTED_ASSETS}]...`);
  try {
    binanceWs = new WebSocket(BINANCE_WS_URL + streams);
  } catch (err) {
    console.warn('[Binance] Erreur de création WS:', err.message);
    setTimeout(startBinanceWs, 5000);
    return;
  }

  binanceWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const data = msg.data;
      if (data && data.s && data.p) {
        const asset = data.s.replace('USDT', '').toUpperCase();
          perpState.get(asset).binance = parseFloat(data.p);
          perpState.get(asset).binanceTs = Date.now();
          lagRecorder.onPerpUpdate(asset, parseFloat(data.p));
          updateAssetPriceHistory(asset, perpState.get(asset).binance);
          
          // v6.2.0 : Latence Binance (E = Event Time)
          if (data.E) addLatencyHistorySample('ws', Date.now() - Number(data.E));
      }
    } catch (_) {}
  });

  binanceWs.on('close', () => {
    console.warn('[Binance] WebSocket fermé. Reconnexion...');
    binanceWs = null;
    setTimeout(startBinanceWs, 5000);
  });

  binanceWs.on('error', (err) => {
    console.error('[Binance] Erreur WebSocket:', err.message);
  });
}

/** Flux OKX Public (Multi-Assets v5.4.0) */
function startOkxWs() {
  if (okxWs) return;
  console.log(`[OKX] Connexion WebSocket pour [${SUPPORTED_ASSETS}]...`);
  try {
    okxWs = new WebSocket(OKX_WS_URL);
  } catch (err) {
    setTimeout(startOkxWs, 5000);
    return;
  }

  okxWs.on('open', () => {
    const args = SUPPORTED_ASSETS.map(a => ({ channel: 'tickers', instId: `${a}-USDT-SWAP` }));
    okxWs.send(JSON.stringify({ op: 'subscribe', args }));
  });

  okxWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data && data.arg?.channel === 'tickers' && data.data?.[0]?.last) {
        const asset = data.arg.instId.split('-')[0];
        const state = perpState.get(asset);
        if (state) {
          const price = parseFloat(data.data[0].last);
          state.okx = price;
          state.okxTs = Date.now();
          lagRecorder.onPerpUpdate(asset, price);
        }
      }
    } catch (_) {}
  });

  okxWs.on('close', () => { okxWs = null; setTimeout(startOkxWs, 5000); });
  okxWs.on('error', () => {});
}

/** Flux Hyperliquid (v5.3.0) */
function startHyperliquidWs() {
  if (hyperliquidWs) return;
  console.log('[Hyperliquid] Connexion WebSocket...');
  try {
    hyperliquidWs = new WebSocket(HYPERLIQUID_WS_URL);
  } catch (err) {
    setTimeout(startHyperliquidWs, 5000);
    return;
  }

  hyperliquidWs.on('open', () => {
    SUPPORTED_ASSETS.forEach(asset => {
      hyperliquidWs.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: asset } }));
    });
  });

  hyperliquidWs.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data && data.channel === 'l2Book' && data.data?.levels?.[0]?.length >= 2) {
        const asset = data.data.coin;
        const bids = data.data.levels[0];
        const asks = data.data.levels[1];
        if (bids[0] && asks[0]) {
          const bid = parseFloat(bids[0].px);
          const ask = parseFloat(asks[0].px);
          const state = perpState.get(asset);
          if (state) {
            const price = (bid + ask) / 2;
            state.hyper = price;
            state.hyperTs = Date.now();
            lagRecorder.onPerpUpdate(asset, price);
          }
        }
      }
    } catch (_) {}
  });

  hyperliquidWs.on('close', () => { hyperliquidWs = null; setTimeout(startHyperliquidWs, 5000); });
  hyperliquidWs.on('error', () => {});
}

/** 
 * Ajoute un échantillon de prix au buffer (max 60 échantillons, un toutes les 60s env).
 */
let lastSampleMs = 0;
function updateAssetPriceHistory(asset, price) {
  const now = Date.now();
  if (now - lastSampleMs < 60_000) return; // 1 échantillon par minute
  lastSampleMs = now;
  const state = getAssetState(asset);
  state.priceHistory.push(price);
  if (state.priceHistory.length > 60) state.priceHistory.shift(); 
  
  if (state.priceHistory.length >= 10) {
    state.vol = calculateAnnualizedVolatility(state.priceHistory);
  }
}

/**
 * Calcule la volatilité annualisée à partir de l'historique des prix.
 */
function calculateAnnualizedVolatility(prices) {
  if (prices.length < 2) return BTC_ANNUALIZED_VOLATILITY;
  
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  
  // Annualisation : stdDev * sqrt(nombre de minutes dans une année)
  // car nous travaillons avec des retours minute par minute.
  const minutesPerYear = 365 * 24 * 60;
  return stdDev * Math.sqrt(minutesPerYear);
}

/**
 * Calculateur de Probabilité Théorique (Loi Normale CDF)
 * @param {number} currentPrice Prix actuel du BTC
 * @param {number} strikePrice Prix cible du marché
 * @param {number} timeToExpirySec Temps restant en secondes
 * @param {number} vol Volatilité annualisée (ex: 0.20)
 * @returns {number} Probabilité de finir au dessus (0.0 à 1.0)
 */
/**
 * Calcule la probabilité "Fair" avec ajustement de Skew.
 */
/**
 * Calcule la Volatilité Parkinson (24h) basée sur le High/Low de Binance.
 * Plus robuste qu'une simple constante car s'adapte à la peur du marché.
 */
function calculateParkinsonVol(high, low) {
  if (!high || !low || high <= low) return BTC_ANNUALIZED_VOLATILITY;
  const vol = Math.sqrt((1 / (4 * Math.log(2))) * Math.pow(Math.log(high / low), 2));
  return Math.min(2.0, Math.max(0.2, vol * Math.sqrt(365))); // Annualisée
}

/**
 * Calcule le VWAP (Pessimiste) sur le carnet d'ordres Polymarket.
 * Simule l'achat total du montant 'amountUsd' pour trouver le vrai prix d'exécution.
 */
async function calculateVWAPPrice(tokenId, amountUsd, clobClient) {
  try {
    const book = await clobClient.getOrderBook(tokenId);
    if (!book || !book.asks || book.asks.length === 0) return null;
    
    let remainingUsd = amountUsd;
    let totalShares = 0;
    let filledUsd = 0;
    
    for (const ask of book.asks) {
      const price = Number(ask.price);
      const size = Number(ask.size);
      const availableUsd = price * size;
      
      const takeUsd = Math.min(remainingUsd, availableUsd);
      totalShares += takeUsd / price;
      filledUsd += takeUsd;
      remainingUsd -= takeUsd;
      
      if (remainingUsd <= 0.01) break;
    }
    
    if (filledUsd < amountUsd * 0.95) return null; // Liquidité insuffisante
    return filledUsd / totalShares;
  } catch (err) {
    return null;
  }
}

/**
 * Calcule le Skew dynamique selon le régime de volatilité (Audit v5.2.1).
 * Marché calme (<10% vol) -> Skew -1%
 * Marché normal (<25% vol) -> Skew -3%
 * Marché explosif (>=25% vol) -> Skew -6%
 */
function getDynamicSkew(vol) {
  if (vol < 0.10) return -0.01;
  if (vol < 0.25) return -0.03;
  return -0.06;
}

// v7.12.0 Fix: Add asset parameter
function calculateFairProbability(currentPrice, strikePrice, timeToExpirySec, volOverwrite, asset = 'BTC') {
  if (timeToExpirySec <= 0) return currentPrice > strikePrice ? 1.0 : 0.0;
  
  // v3.9.2 : Volatilité Hybride (Max entre 24h et 60min)
  const state = getAssetState(asset);
  let vol = volOverwrite ?? BTC_ANNUALIZED_VOLATILITY;
  if (!volOverwrite) {
    const parkinson = (binanceHigh24h && binanceLow24h) ? calculateParkinsonVol(binanceHigh24h, binanceLow24h) : 0;
  const state = getAssetState(asset);
  const realized = Number(state.vol) || 0;
    vol = Math.max(parkinson, realized, BTC_ANNUALIZED_VOLATILITY);
  }

  // v5.2.1 : Skew dynamique selon la volatilité actuelle
  const skew = getDynamicSkew(vol);
  
  const timeInYears = timeToExpirySec / (365 * 24 * 3600);
  const sqrtT = Math.sqrt(timeInYears);
  const sigmaRootT = vol * sqrtT;
  
  // Intégration du Skew dans le d1 (Biais directionnel)
  const d1 = (Math.log(currentPrice / strikePrice) + (skew * vol) * sqrtT) / sigmaRootT;
  
  return normalCDF(d1);
}

/**
 * Calcule le prix effectif moyen (VWAP) pour une mise donnée en USDC,
 * en parcourant les niveaux du carnet d'ordres (LOB).
 */
function getEffectivePriceFromLevels(levels, stakeUsdc = DEFAULT_STAKE_USDC) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let totalCost = 0;
  let remaining = stakeUsdc;
  
  for (const level of levels) {
    const price = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
    const size = parseFloat(level?.size ?? level?.s ?? level?.[1] ?? 0);
    if (!Number.isFinite(price) || price <= 0 || size <= 0) continue;
    
    const levelCapUsdc = price * size;
    const fill = Math.min(remaining, levelCapUsdc);
    totalCost += fill;
    remaining -= fill;
    
    if (remaining <= 0) break;
  }
  
  if (remaining > 0) {
    const fillRatio = (stakeUsdc - remaining) / stakeUsdc;
    if (fillRatio < 0.3) return null; // Liquidité critique
    return (totalCost / (stakeUsdc - remaining)) * 1.05; // Pénalité
  }
  return totalCost / stakeUsdc;
}

/**
 * Calcule les frais Taker exacts selon la formule Polymarket CLOB 2026 :
 * Fee = Shares * Rate * price * (1 - price) per share.
 * Pour obtenir le pourcentage du capital investi : (Rate * (1 - price)) * SafetyBuffer.
 */
function calculatePolymarketTakerFee(price) {
  if (!price || price <= 0 || price >= 1) return 0;
  // Blindage 2026 : Courbe parabolique (Rate * (1 - P)) avec 5% de marge.
  const basePct = POLYMARKET_FEE_RATE * (1 - price);
  return basePct * FEE_SAFETY_BUFFER;
}
/**
 * v6.3.0 : Analyseur de Performance PnL
 * Scanne les 500 derniers ordres pour calculer les stats de session.
 */
async function calculateSessionStats() {
  try {
    if (!fs.existsSync(ORDERS_LOG_FILE)) return null;
    const lines = fs.readFileSync(ORDERS_LOG_FILE, 'utf8').split('\n').filter(l => l.trim() !== '');
    const lastLines = lines.slice(-500);
    
    let totalVolume = 0;
    let netProfit = 0;
    let trades = 0;
    let wins = 0;

    for (const line of lastLines) {
      try {
        const o = JSON.parse(line);
        if (!o.filledUsdc) continue;
        
        trades++;
        const stake = Number(o.filledUsdc);
        totalVolume += stake;
        
        // Si c'est une sortie (exit/sold), on calcule le profit
        if (o.message?.includes('sold') || o.message?.includes('Take-profit') || o.message?.includes('Stop-loss')) {
          const revenue = Number(o.revenue || o.filledUsdc);
          const profit = revenue - Number(o.originalStakeUsd || stake);
          netProfit += profit;
          if (profit > 0) wins++;
        }
      } catch (err) { /* ignore malformed lines */ }
    }

    return {
      totalVolume: Math.round(totalVolume),
      netProfit: Number(netProfit.toFixed(2)),
      winRatePct: trades > 0 ? Math.round((wins / trades) * 100) : 0,
      tradeCount: trades,
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('[PnL] Error calculating stats:', err.message);
    return null;
  }
}

/**
 * Calcule le seuil GAP adaptatif selon la volatilité actuelle.
 */
function getAdaptiveThreshold(vol, baseThreshold = ARBITRAGE_GAP_THRESHOLD) {
  const volBaseline = 0.50;
  const ratio = vol / volBaseline;
  return baseThreshold * Math.min(Math.max(ratio, 1.0), 2.0);
}

/**
 * Calcule la mise optimale via le Critère de Kelly (Engine 3.0 / v5.8.0).
 * f* = (edge / odds) * fraction (dynamique via OFI)
 */
function calculateKellyStake(netGap, tokenPrice, bankroll, ofiScore = 0, side = 'Up') {
  if (!Number.isFinite(netGap) || netGap <= 0 || !Number.isFinite(tokenPrice) || tokenPrice <= 0 || tokenPrice >= 1) return 0;
  if (!Number.isFinite(bankroll) || bankroll <= 0) return 0;
  
  // odds = (1 / price) - 1. Ex: prix 0.54 => odds 0.85
  const odds = (1 / tokenPrice) - 1;
  if (!Number.isFinite(odds) || odds <= 0) return 0;
  const kelly = netGap / odds;
  
  // Appliquer la fraction dynamique basée sur l'OFI (v5.8.0 / v5.8.2 : Momentum-Weighted Kelly)
  let dynamicFraction = KELLY_FRACTION;
  if (isOfiSideMatch(side, ofiScore)) {
      const absOfi = Math.abs(ofiScore);
      if (absOfi > 20) {
          // On scale de 0.25 à 0.40 entre OFI 20 et 50 (Bonus max +0.15)
          const bonus = Math.min(0.15, (absOfi - 20) * (0.15 / 30));
          dynamicFraction += bonus;
      }
  }
  
  let stake = kelly * dynamicFraction * bankroll;
  
  // 1. Plafonner à la limite de bankroll par trade (ex: 25%)
  const maxBankrollStake = bankroll * KELLY_MAX_BANKROLL_PCT;
  stake = Math.min(stake, maxBankrollStake);

  // 2. Plafonner au Cap Absolu (v5.8.0)
  stake = Math.min(stake, ABSOLUTE_MAX_STAKE_USD);
  
  return Math.max(0, Math.round(stake * 100) / 100);
}




/**
 * Vérifie si le trade est autorisé par les garde-fous 3.0.
 */
function isTradeAllowedBySafety(asset, strike, currentPrice) {
  // 1. Dérive du Strike
  if (strike && currentPrice > 0) {
    const drift = Math.abs(currentPrice - strike) / strike;
    if (drift > STRIKE_DRIFT_THRESHOLD) {
      logJson('warn', `[${asset}] Trade rejeté (Drift Strike excessif)`, { strike, currentPrice, drift });
      return { ok: false, reason: `Strike Drift (${(drift * 100).toFixed(1)}% > ${STRIKE_DRIFT_THRESHOLD * 100}%)` };
    }
  }

  // 2. Circuit Breaker Journalier
  const stats = readDailyStats();
  if (stats.dailyPnl <= -MAX_DAILY_LOSS_USDC) {
     return { ok: false, reason: `Daily Loss Limit reached (${stats.dailyPnl} USDC) triggered by ${asset}` };
  }
  
  return { ok: true };
}

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.821256 + t * 1.330274))));
  const res = x > 0 ? 1 - p : p;
  return Math.min(1, Math.max(0, res));
}

function extractStrikeFromQuestion(question) {
  if (!question) return null;
  
  // 1. Extraire tous les nombres avec leurs suffixes (ex: $70k, $70,500)
  const matches = question.match(/\$?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?k?/gi);
  if (!matches) return null;
  
  const candidates = matches.map(m => {
    let val = m.toLowerCase().replace(/[$,\s]/g, '');
    if (val.endsWith('k')) {
      return parseFloat(val) * 1000;
    }
    return parseFloat(val);
  }).filter(v => Number.isFinite(v) && v > 1000); // Filtre pour ignorer les petits chiffres (comme la date)

  if (candidates.length === 0) return null;
  
  // 2. Choisir le candidat le plus proche du prix actuel du BTC (Validation Heuristique)
  if (binanceBtcPrice > 0) {
    return candidates.reduce((prev, curr) => 
      Math.abs(curr - binanceBtcPrice) < Math.abs(prev - binanceBtcPrice) ? curr : prev
    );
  }
  
  return candidates[0];
}

/**
 * Journalise chaque décision du bot pour calibration.
 */
function logDecision(data) {
  try {
    fs.appendFileSync(DECISION_LOG_FILE, JSON.stringify(data) + '\n', 'utf8');
  } catch (_) {}
}

async function main() {
  loadOpenOrders(); // v7.1.0 Persistence
  console.log('Bot Polymarket Bitcoin Up or Down — démarrage 24/7');
  simulationTrade.initPaperBalanceIfNeeded(BOT_DIR);
  if (simulationTradeEnabled) {
    console.warn(
      `⚠️ SIMULATION_TRADE_ENABLED=true — aucun ordre réel sur le CLOB ; solde virtuel (départ ${simulationTrade.getSimulationStartUsd()} USDC, fichier simulation-paper.json). Les alertes Telegram sont préfixées [PAPER].`,
    );
  }
  console.log(
    `Marché: ${MARKET_MODE === '15m' ? '15 min (btc-updown-15m)' : 'horaire (bitcoin-up-or-down)'} | Pas de trade: ${
      MARKET_MODE === '15m'
        ? `grille ET : ${ENTRY_FORBID_FIRST_MIN_RESOLVED} premières + ${ENTRY_FORBID_LAST_MIN_RESOLVED} dernières min du quart (ENTRY_FORBIDDEN_*_MIN)`
        : '5 min avant fin'
    }`
  );
  console.log(
    `Prix signal (poll / fetchSignals): ${signalPriceSource} — ${signalPriceSource === 'clob' ? 'best ask CLOB par token' : 'outcomePrices Gamma'} (SIGNAL_PRICE_SOURCE=gamma|clob pour forcer)`
  );
  console.log(`fetchSignals cache: ${FETCH_SIGNALS_CACHE_MS} ms (FETCH_SIGNALS_CACHE_MS).`);
  if (entryFastPathEnabled) {
    console.log('Entry fast-path: activé (relevés liquidité reportés quand signal présent).');
  }
  if (walletConfigured && wallet) {
    const sizeMode = useBalanceAsSize ? 'taille = solde USDC (réinvestissement)' : `fixe ${orderSizeUsd} USDC`;
    console.log(`Wallet: ${wallet.address} | Auto: ${autoPlaceEnabled} | Ordre: ${useMarketOrder ? 'marché' : 'limite'} | ${sizeMode} | Poll: ${pollIntervalSec}s`);
    if (hasMaxStakeUsd) {
      console.log(
        `Mise max par ordre: ${maxStakeUsd} USDC (MAX_STAKE_USD) — chaque ordre = min(solde disponible, ${maxStakeUsd})${useBalanceAsSize ? " (réinvestissement jusqu'au plafond)" : ''}.`
      );
    } else {
      console.log('Mise max par ordre: aucun plafond (MAX_STAKE_USD=0).');
    }
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
        `Stop-loss: activé | trigger bid < ${(stopLossTriggerPriceP * 100).toFixed(2)}¢${
          stopLossDrawdownEnabled ? ` OU drawdown <= -${Math.abs(stopLossMaxDrawdownPct)}%` : ''
        } | worst SELL ${(stopLossWorstPriceP * 100).toFixed(2)}¢`
      );
      if (STOP_LOSS_IMMEDIATE_RETRY_MAX > 0) {
        console.log(
          `Stop-loss FAK: jusqu'à ${STOP_LOSS_IMMEDIATE_RETRY_MAX + 1} tentative(s) dans la même passe si « no match », pause ${STOP_LOSS_IMMEDIATE_RETRY_DELAY_MS} ms (STOP_LOSS_IMMEDIATE_RETRY_MAX / STOP_LOSS_IMMEDIATE_RETRY_DELAY_MS).`
        );
      }
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

  // Audit Géographique au démarrage
  const allowed = await checkGeoblockStatus();
  if (!allowed) {
    console.error('❌ Bot arrêté : Votre IP est bloquée par Polymarket (Geoblock).');
    process.exit(1);
  }

  console.log('—');

  logJson('info', 'Bot démarré — boucle poll', {
    pid: process.pid,
    mode: MARKET_MODE,
    simulationTradeEnabled,
    autoPlaceEnabled,
    recordLiquidityHistory,
    signalVisibilityLog,
    signalVisibilityLogMs: signalVisibilityLog ? SIGNAL_VISIBILITY_LOG_MS : null,
    botLogPath: BOT_JSON_LOG_FILE,
  });

  if (useWebSocket) {
    startClobWs();
    startBinanceWs();
    startOkxWs(); // v5.3.0
    startHyperliquidWs(); // v5.3.0
  }

  const pollMs = pollIntervalSec * 1000;
  if (walletConfigured && stopLossEnabled && STOP_LOSS_FAST_INTERVAL_MS > 0) {
    setInterval(() => {
      void runStopLossPass();
    }, STOP_LOSS_FAST_INTERVAL_MS);
    console.log(`Stop-loss fast loop: activée (${STOP_LOSS_FAST_INTERVAL_MS} ms, indépendante du poll).`);
  }
  if (telegramMiddayDigestEnabled()) {
    setInterval(() => {
      void tryTelegramPerformanceDigests();
    }, 25_000);
    console.log(
      `Résumés Telegram performance : activés (${TELEGRAM_MIDDAY_DIGEST_TZ} — demi-journée ${String(TELEGRAM_MIDDAY_DIGEST_HOUR).padStart(2, '0')}:${String(TELEGRAM_MIDDAY_DIGEST_MINUTE).padStart(2, '0')} + minuit ${String(TELEGRAM_MIDNIGHT_DIGEST_HOUR).padStart(2, '0')}:${String(TELEGRAM_MIDNIGHT_DIGEST_MINUTE).padStart(2, '0')} — ALERT_TELEGRAM_MIDDAY_DIGEST=true).`
    );
  }
  for (;;) {
    try {
      lastHeartbeatMs = Date.now(); // Mise à jour watchdog
      await run();
    } catch (err) {
      logJson('error', 'Erreur boucle', { error: err.message });
      console.error(new Date().toISOString(), 'Erreur boucle:', err.message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main();
