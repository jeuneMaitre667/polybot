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
import axios from 'axios';

/** Dossier du bot (où se trouve index.js), pour que balance.json et last-order.json soient toujours dans ~/bot-24-7 même si PM2 a été lancé depuis un autre répertoire. */
const BOT_DIR = path.resolve(__dirname);
const LAST_ORDER_FILE = path.join(BOT_DIR, 'last-order.json');
const BALANCE_FILE = path.join(BOT_DIR, 'balance.json');
const BALANCE_HISTORY_FILE = path.join(BOT_DIR, 'balance-history.json');
const ORDERS_LOG_FILE = path.join(BOT_DIR, 'orders.log');
const BOT_JSON_LOG_FILE = path.join(BOT_DIR, 'bot.log');
const LIQUIDITY_HISTORY_FILE = path.join(BOT_DIR, 'liquidity-history.json');
const BALANCE_HISTORY_MAX = 500;
const LIQUIDITY_HISTORY_DAYS = 3;

/** Log structuré JSON (une ligne par événement) dans bot.log pour analyse ou envoi vers un outil de log. */
function logJson(level, message, meta = {}) {
  try {
    fs.appendFileSync(BOT_JSON_LOG_FILE, JSON.stringify({ level, message, ts: new Date().toISOString(), ...meta }) + '\n', 'utf8');
  } catch (_) {}
}

function writeLastOrder(data) {
  try {
    fs.writeFileSync(LAST_ORDER_FILE, JSON.stringify(data), 'utf8');
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
const CLOB_HOST = 'https://clob.polymarket.com';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';
const CHAIN_ID = 137;
const MAX_PRICE_LIQUIDITY = 0.97;
const MIN_P = 0.968;
const MAX_P = 0.97;
const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';
const ONE_MINUTE_MS = 60 * 1000;
const NO_TRADE_LAST_MS_15M = 4 * 60 * 1000; // 4 min pour le marché 15m

/** hourly = créneaux 1h (bitcoin-up-or-down), 15m = créneaux 15 min (btc-updown-15m). Défaut hourly. */
const MARKET_MODE = (process.env.MARKET_MODE || 'hourly').toLowerCase() === '15m' ? '15m' : 'hourly';

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
const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC) || 3;
/** Placer les ordres en auto (défaut: true). Mettre à false pour faire tourner le bot sans trader. */
const autoPlaceEnabled = process.env.AUTO_PLACE_ENABLED !== 'false';
/** Tenter de redeem les tokens gagnants (marchés résolus) en USDC au début de chaque cycle. Sinon le solde ne inclut pas les gains tant qu'on n'a pas redeem. */
const redeemEnabled = process.env.REDEEM_ENABLED !== 'false';
/** Plafonner la mise à la liquidité disponible à ≤97 % = mise max pour ne pas dégrader les profits (prix d'entrée). USE_LIQUIDITY_CAP=false pour désactiver. */
const useLiquidityCap = process.env.USE_LIQUIDITY_CAP !== 'false';
const walletConfigured = !!privateKey;

// ——— Wallet & provider ———
// ethers v6 : 2e argument = chainId (number), pas un objet { chainId }
let provider = new ethers.JsonRpcProvider(polygonRpc, CHAIN_ID);
const wallet = walletConfigured
  ? new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey, provider)
  : null;

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
  const ids = market.clobTokenIds ?? market.clob_token_ids;
  if (Array.isArray(ids) && ids[idx]) return String(ids[idx]);
  const tokens = market.tokens;
  if (Array.isArray(tokens) && tokens[idx]?.token_id) return String(tokens[idx].token_id);
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
    console.log(`Liquidité enregistrée: ${Number(liquidityUsd).toFixed(0)} USD (${arr.length} relevés sur 3 j)`);
  } catch (e) {
    console.error('Erreur enregistrement liquidité:', e?.message ?? e);
  }
}

/** Récupère la liquidité (USD) disponible à ≤97 % pour un token (carnet d'ordres). Retourne null en cas d'erreur. */
async function getLiquidityAtTargetUsd(tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(CLOB_BOOK_URL, { params: { token_id: tokenId }, timeout: 5000 });
    const asks = data?.asks ?? [];
    if (!Array.isArray(asks)) return null;
    let totalUsd = 0;
    for (const level of asks) {
      const p = parseFloat(level?.price ?? level?.[0] ?? 0);
      const s = parseFloat(level?.size ?? level?.[1] ?? 0);
      if (p <= MAX_PRICE_LIQUIDITY && s > 0) totalUsd += p * s;
    }
    return totalUsd > 0 ? totalUsd : null;
  } catch (_) {
    return null;
  }
}

/** Pas de trade si l'événement se termine dans moins de X ms (1 min horaire, 4 min 15m). */
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
  const thresholdMs = MARKET_MODE === '15m' ? NO_TRADE_LAST_MS_15M : ONE_MINUTE_MS;
  return Date.now() >= endMs - thresholdMs;
}

/** Récupère les signaux 96,8–97 % depuis l’API Gamma. */
async function fetchSignals() {
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
  return results;
}

/** Vérifie si l’IP est autorisée à trader (geoblock). */
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
        const clientWithoutCreds = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
        const creds = await clientWithoutCreds.createOrDeriveApiKey();
        client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
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
        const userMarketOrder = { tokenID: tokenIdToBuy, amount: size, side: Side.BUY };
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
      const is429 = String(err.message || err.response?.status).includes('429') || err.response?.status === 429;
      const isRetryable = is429 || /timeout|network|ECONNRESET/i.test(String(err.message));
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

// ——— Boucle principale ———
const placedKeys = new Set();
/** Fenêtres pour lesquelles on a déjà enregistré un relevé de liquidité (une fois par créneau = montant max par fenêtre pour le dashboard). */
const recordedLiquidityWindows = new Map(); // key (getSignalKey) -> endDateMs (pour purger les anciennes)
/** Dernier enregistrement de liquidité (lors d'un trade) pour aligner le throttle. */
let lastLiquidityRecordTime = 0;

async function run() {
  const signals = await fetchSignals();

  // Relevé du montant max (liquidité à 97 %) pour chaque fenêtre, même sans trade — une fois par créneau pour avoir la moyenne "mise max par fenêtre".
  const liquidityCutoff = Date.now() - LIQUIDITY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, endMs] of recordedLiquidityWindows) {
    if (endMs < liquidityCutoff) recordedLiquidityWindows.delete(key);
  }
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
      const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy);
      if (liquidity != null && liquidity > 0) {
        appendLiquidityHistory(liquidity);
        recordedLiquidityWindows.set(key, endMs);
      }
    } catch (_) {
      // ne pas faire échouer le cycle
    }
    await new Promise((r) => setTimeout(r, 150)); // éviter de surcharger l'API CLOB
  }

  if (!walletConfigured || !autoPlaceEnabled || killSwitchActive) return;

  // Redeem des tokens gagnants (marchés résolus) en USDC pour que le solde inclue les gains au prochain trade
  await tryRedeemResolvedPositions();

  // Client CLOB une fois par cycle : solde via API balance-allowance (doc Polymarket), plus d’erreur RPC "could not detect network"
  let clobClient = null;
  try {
    const clientWithoutCreds = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    const creds = await clientWithoutCreds.createOrDeriveApiKey();
    clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds);
  } catch (err) {
    console.warn('CLOB client (solde/ordres):', err.message);
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

    if (useBalanceAsSize) {
      const balance = await getBalance();
      amountUsd = balance != null ? balance : orderSizeUsd;
      if (amountUsd < orderSizeMinUsd) break;
    }

    let allowBelowMin = false;
    const liquidity = await getLiquidityAtTargetUsd(s.tokenIdToBuy);
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
        console.log(`Mise max (liquidité 97 %) : ${amountUsd.toFixed(2)} $ — ordre plafonné pour ne pas dégrader les profits${allowBelowMin ? ' (sous min, ordre quand même)' : ''}`);
      }
    } else if (liquidity === null || liquidity === 0) {
      console.warn('Liquidité non enregistrée: book CLOB sans offre ≤97 % pour ce créneau (ou erreur API)');
    }

    placedKeys.add(key);
    const result = await placeOrder(s, amountUsd, clobClient, { allowBelowMin });
    const time = new Date().toISOString();
    if (result.ok) {
      const orderData = { at: time, takeSide: s.takeSide, amountUsd, conditionId: key, orderID: result.orderID };
      writeLastOrder(orderData);
      appendOrderLog(orderData);
      logJson('info', 'Ordre placé', { takeSide: s.takeSide, amountUsd, orderID: result.orderID });
      const miseMaxInfo = liquidity != null && liquidity > 0 ? ` | Mise max 97 % : ${liquidity.toFixed(0)} $` : '';
      console.log(`[${time}] Ordre placé ${s.takeSide} — ${amountUsd.toFixed(2)} USDC${miseMaxInfo} — ${key?.slice(0, 10)}… — orderID: ${result.orderID}`);
    } else {
      logJson('error', 'Erreur ordre', { takeSide: s.takeSide, error: result.error });
      console.error(`[${time}] Erreur ${s.takeSide}: ${result.error}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

async function main() {
  console.log('Bot Polymarket Bitcoin Up or Down — démarrage 24/7');
  console.log(`Marché: ${MARKET_MODE === '15m' ? '15 min (btc-updown-15m)' : 'horaire (bitcoin-up-or-down)'} | Pas de trade: ${MARKET_MODE === '15m' ? '4 min avant fin' : '1 min avant fin'}`);
  if (walletConfigured && wallet) {
    const sizeMode = useBalanceAsSize ? 'taille = solde USDC (réinvestissement)' : `fixe ${orderSizeUsd} USDC`;
    console.log(`Wallet: ${wallet.address} | Auto: ${autoPlaceEnabled} | Ordre: ${useMarketOrder ? 'marché' : 'limite'} | ${sizeMode} | Poll: ${pollIntervalSec}s`);
    if (useLiquidityCap) console.log('Mise max : plafonnée à la liquidité 97 % pour ne pas dégrader les profits (USE_LIQUIDITY_CAP=true).');
  } else {
    console.log('Wallet: non configuré — pas de placement d’ordres. Ajoute PRIVATE_KEY dans .env puis redémarre (pm2 restart polymarket-bot).');
  }
  if (walletConfigured && !autoPlaceEnabled) {
    console.log('AUTO_PLACE_ENABLED=false — le bot tourne sans placer d\'ordres.');
  }

  const allowed = await checkGeoblock();
  if (!allowed) {
    process.exit(1);
  }
  console.log('—');

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
