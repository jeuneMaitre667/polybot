/**
 * Bot Polymarket Bitcoin Up or Down — exécution 24/7 (Node.js)
 *
 * Étapes :
 * 1. Connexion wallet Polygon (clé privée)
 * 2. Boucle : récupérer les signaux Gamma (prix 96,8–97 %)
 * 3. Pour chaque signal : si pas dans la dernière minute avant fin → placer ordre CLOB (marché ou limite)
 * 4. Ne pas placer deux fois pour le même créneau (mémorisation par conditionId)
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

function writeLastOrder(data) {
  try {
    fs.writeFileSync(LAST_ORDER_FILE, JSON.stringify(data), 'utf8');
  } catch (_) {}
}

function writeBalance(balanceUsd) {
  try {
    fs.writeFileSync(BALANCE_FILE, JSON.stringify({ balance: balanceUsd, at: new Date().toISOString() }), 'utf8');
  } catch (_) {}
}

// ——— Config ———
const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const MIN_P = 0.968;
const MAX_P = 0.97;
const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const ONE_MINUTE_MS = 60 * 1000;

const privateKeyRaw = process.env.PRIVATE_KEY?.trim();
const isPlaceholder = !privateKeyRaw || privateKeyRaw === 'your_hex_private_key_here' || /^0x?REMPLACE/i.test(privateKeyRaw);
const privateKey = isPlaceholder ? '' : privateKeyRaw;
/** RPC Polygon : par défaut publicnode (plus fiable depuis un VPS). polygon-rpc.com provoque souvent NETWORK_ERROR. */
const polygonRpc = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const polygonRpcFallbacks = (process.env.POLYGON_RPC_FALLBACK || 'https://polygon-rpc.com,https://rpc.ankr.com/polygon').split(',').map((u) => u.trim()).filter(Boolean);
/** Réseau Polygon explicite (chainId seul pour max compatibilité ethers). */
const polygonNetwork = { chainId: CHAIN_ID };
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
const walletConfigured = !!privateKey;

// ——— Wallet & provider ———
let provider = new ethers.providers.JsonRpcProvider(polygonRpc, polygonNetwork);
const wallet = walletConfigured
  ? new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey, provider)
  : null;

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
/** USDC sur Polygon (USDC.e bridged, 6 decimals). */
const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const ORDER_RETRY_ATTEMPTS = 3;
const ORDER_RETRY_BASE_MS = 1000;

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
        const bn = ethers.BigNumber.from(hex);
        return Number(ethers.utils.formatUnits(bn, 6));
      }
      return 0;
    } catch (err) {
      if (i === 0) console.warn('Solde USDC (RPC secours):', err.message);
    }
  }
  return null;
}

/** Pas de trade si l’événement se termine dans moins d’une minute. */
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
  return Date.now() >= endMs - ONE_MINUTE_MS;
}

/** Récupère les signaux 96,8–97 % depuis l’API Gamma. */
async function fetchSignals() {
  const { data } = await axios.get(GAMMA_EVENTS_URL, {
    params: { active: true, closed: false, limit: 150 },
    timeout: 15000,
  });
  const events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
  const results = [];
  for (const ev of events) {
    if (!ev?.markets?.length) continue;
    const eventSlug = (ev.slug ?? '').toLowerCase();
    if (!eventSlug.includes(BITCOIN_UP_DOWN_SLUG)) continue;
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

/** Place un ordre sur le CLOB (marché ou limite), avec retry sur 429 / erreur réseau. amountUsd = taille du trade. clientOrNull = client CLOB déjà créé (évite de recréer les creds). */
async function placeOrder(signal, amountUsd, clientOrNull = null) {
  if (!walletConfigured || !wallet) {
    return { ok: false, error: 'Wallet non configuré. Ajoute PRIVATE_KEY dans .env puis redémarre.' };
  }
  const size = Number(amountUsd) || orderSizeUsd;
  if (size < orderSizeMinUsd) {
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
      const options = { tickSize: '0.01', negRisk: false };

      if (useMarketOrder) {
        const userMarketOrder = { tokenID: tokenIdToBuy, amount: size, side: Side.BUY };
        const result = await client.createAndPostMarketOrder(userMarketOrder, options, OrderType.FOK);
        return { ok: true, orderID: result?.orderID ?? result?.id };
      }
      const userOrder = { tokenID: tokenIdToBuy, price: Number(price), size, side: Side.BUY };
      const result = await client.createAndPostOrder(userOrder, options, OrderType.GTC);
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
  return { ok: false, error: lastError };
}

// ——— Boucle principale ———
const placedKeys = new Set();

async function run() {
  const signals = await fetchSignals();
  if (!walletConfigured || !autoPlaceEnabled) return;

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
    if (amountUsd < orderSizeMinUsd) return;
    if (balance != null) writeBalance(balance);
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

    placedKeys.add(key);
    const result = await placeOrder(s, amountUsd, clobClient);
    const time = new Date().toISOString();
    if (result.ok) {
      writeLastOrder({ at: time, takeSide: s.takeSide, amountUsd, conditionId: key, orderID: result.orderID });
      console.log(`[${time}] Ordre placé ${s.takeSide} — ${amountUsd.toFixed(2)} USDC — ${key?.slice(0, 10)}… — orderID: ${result.orderID}`);
    } else {
      console.error(`[${time}] Erreur ${s.takeSide}: ${result.error}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

async function main() {
  console.log('Bot Polymarket Bitcoin Up or Down — démarrage 24/7');
  if (walletConfigured && wallet) {
    const sizeMode = useBalanceAsSize ? 'taille = solde USDC (réinvestissement)' : `fixe ${orderSizeUsd} USDC`;
    console.log(`Wallet: ${wallet.address} | Auto: ${autoPlaceEnabled} | Ordre: ${useMarketOrder ? 'marché' : 'limite'} | ${sizeMode} | Poll: ${pollIntervalSec}s`);
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
      console.error(new Date().toISOString(), 'Erreur boucle:', err.message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main();
