import axios from 'axios';
import { 
    SUPPORTED_ASSETS, 
    MARKET_MODE, 
    GAMMA_EVENT_BY_SLUG_URL,
    BITCOIN_UP_DOWN_15M_SLUG,
    BITCOIN_UP_DOWN_SLUG,
    ETHEREUM_UP_DOWN_15M_SLUG,
    SOLANA_UP_DOWN_15M_SLUG,
    POLYMARKET_FEE_RATE,
    FEE_SAFETY_BUFFER
} from './config.js';

/**
 * Moteur de Signaux Polymarket (v5.4.0)
 * Gère la récupération, le filtrage et le sizing (LOB depth) pour tous les actifs.
 */

const signalCache = new Map(); // asset -> { data, ts }
const FETCH_SIGNALS_CACHE_MS = 200;

/**
 * Récupère les signaux Gamma pour un actif donné.
 */
export async function fetchSignals(asset, context = {}) {
    const now = Date.now();
    if (signalCache.has(asset)) {
        const c = signalCache.get(asset);
        const cacheMs = context.FETCH_SIGNALS_CACHE_MS || FETCH_SIGNALS_CACHE_MS;
        if (now - c.ts < cacheMs) return c.data;
    }

    const { MARKET_MODE, getCurrent15mEventSlug, getCurrentHourlyEventSlug } = context;
    let slug = null;
    if (MARKET_MODE === '15m' && getCurrent15mEventSlug) {
        slug = getCurrent15mEventSlug(asset);
    } else if (MARKET_MODE === 'hourly' && getCurrentHourlyEventSlug) {
        slug = getCurrentHourlyEventSlug(asset);
    } else {
        slug = getSlotSlugForAsset(asset);
    }

    const startFetch = Date.now();
    try {
        const url = `${GAMMA_EVENT_BY_SLUG_URL}/${slug}`;
        console.log(`[${asset}] Fetching signals from: ${url}`);
        const res = await axios.get(url, { timeout: 5000 });

        const event = res.data;
        if (!event || !event.markets) return [];

        const signals = event.markets.map(m => {
            const outcomePrices = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
            const yesPrice = parseFloat(outcomePrices[0]);
            const noPrice = parseFloat(outcomePrices[1]);
            
            // On cherche le "Yes" (Upper) ou "No" (Lower)
            // Note: m.groupItemTitle contient souvent "Yes" ou "No"
            const takeSide = m.groupItemTitle || "Yes";
            
            // v5.4.1: Handle clobTokenIds (plural array) for 15m markets
            let tokenIdToBuy = m.clobTokenId;
            if (!tokenIdToBuy && m.clobTokenIds) {
                try {
                    const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
                    if (Array.isArray(ids) && ids.length > 0) tokenIdToBuy = ids[0];
                } catch (e) {
                    // fallback to conditionId
                }
            }
            if (!tokenIdToBuy) tokenIdToBuy = m.conditionId;

            console.log(`[${asset}] Signal detect: ${takeSide} @ ${m.outcomePrices} -> tokenId: ${tokenIdToBuy}`);

            return {
                asset,
                conditionId: m.conditionId,
                tokenIdToBuy: tokenIdToBuy,
                strike: parseFloat(m.line),
                takeSide,
                priceUp: yesPrice,
                priceDown: noPrice,
                m
            };
        });

        const profile = { totalMs: Date.now() - startFetch };
        const result = signals.filter(s => s.tokenIdToBuy != null);
        result._fetchSignalsProfile = profile;
        
        signalCache.set(asset, { data: result, ts: now });
        return result;
    } catch (err) {
        console.error(`[${asset}] Erreur fetchSignals:`, err.message);
        return [];
    }
}

function getSlotSlugForAsset(asset) {
    if (MARKET_MODE === '15m') {
        if (asset === 'BTC') return BITCOIN_UP_DOWN_15M_SLUG;
        if (asset === 'ETH') return ETHEREUM_UP_DOWN_15M_SLUG;
        if (asset === 'SOL') return SOLANA_UP_DOWN_15M_SLUG;
    }
    return BITCOIN_UP_DOWN_SLUG;
}

/**
 * Génère une clé unique pour un signal (conditionId).
 */
export function getSignalKey(s) {
    return s.conditionId;
}

/**
 * Garde-fou temporel (Double-check avec et15mEntryTiming).
 */
export function shouldSkipTradeTiming(s) {
    // Logique simplifiée : ici on pourrait importer is15mSlotEntryTimeForbiddenNow
    return false; 
}

/**
 * Calcule la mise optimale en fonction de la profondeur du carnet.
 */
export function calculateOptimalStake(asset, side, book, targetPrice) {
    if (!book || !book.asks || book.asks.length === 0) return 0;
    
    let totalAvailableUsdc = 0;
    const maxSlippage = targetPrice * 1.02; // Tolérance 2%

    for (const ask of book.asks) {
        const p = parseFloat(ask.price);
        const size = parseFloat(ask.size);
        if (p > maxSlippage) break;
        totalAvailableUsdc += (p * size);
    }

    // Sécurité : on ne prend que 80% de la liquidité immédiate pour éviter de vider le carnet
    const optimal = totalAvailableUsdc * 0.8;
    
    // Frais inclus
    const netStake = optimal / (1 + (POLYMARKET_FEE_RATE * FEE_SAFETY_BUFFER));
    return Math.floor(netStake * 100) / 100;

}
