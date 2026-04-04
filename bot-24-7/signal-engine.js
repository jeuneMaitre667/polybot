import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRIKES_FILE = path.join(__dirname, 'boundary-strikes.json');

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

        const signalsRaw = event.markets.map(m => {
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
                slug,
                conditionId: m.conditionId,
                tokenIdToBuy: tokenIdToBuy,
                strike: lookupBoundaryStrike(asset, m.startDate, parseFloat(m.line), slug),
                takeSide,
                priceUp: yesPrice,
                priceDown: noPrice,
                m
            };
        });

        const profile = { totalMs: Date.now() - startFetch };
        const signals = signalsRaw.filter(s => s.tokenIdToBuy != null);
        
        const result = {
            signals,
            slug,
            hasEvent: true,
            _fetchSignalsProfile: profile
        };
        
        signalCache.set(asset, { data: result, ts: now });
        return result;
    } catch (err) {
        console.error(`[${asset}] Erreur fetchSignals:`, err.message);
        return { signals: [], slug: null, hasEvent: false };
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

/**
 * Persistance des prix aux bornes (00, 15, 30, 45).
 */
export function saveBoundaryStrike(asset, price, timestamp = Date.now()) {
    try {
        const data = fs.existsSync(STRIKES_FILE) ? JSON.parse(fs.readFileSync(STRIKES_FILE, 'utf8') || '{}') : {};
        // Normaliser le timestamp à la borne la plus proche (passée)
        const date = new Date(timestamp);
        date.setSeconds(0);
        date.setMilliseconds(0);
        const minutes = date.getMinutes();
        const boundaryMinutes = Math.floor(minutes / 15) * 15;
        date.setMinutes(boundaryMinutes);
        
        const key = `${date.getTime()}_${asset}`;
        data[key] = price;
        
        // Garder seulement les 48 dernières heures (3 actifs * 4 par heure * 48h = 576 entrées)
        const keys = Object.keys(data).sort();
        if (keys.length > 800) {
            const keysToDelete = keys.slice(0, keys.length - 800);
            keysToDelete.forEach(k => delete data[k]);
        }
        
        fs.writeFileSync(STRIKES_FILE, JSON.stringify(data, null, 2));
        console.log(`[Strike] SUCCESSFULLY saved boundary for ${asset}: ${price} @ ${date.toISOString()} (Key: ${key})`);
    } catch (err) {
        console.error('[Strike] Error saving boundary:', err.message);
    }
}

export function lookupBoundaryStrike(asset, startDateStr, apiLine, marketSlug) {
    if (Number.isFinite(apiLine) && apiLine > 0) return apiLine;
    
    try {
        let startTime = null;
        
        // v7.15.3 : Extraire l'Epoch du slug (ex: ...-1775265300)
        if (marketSlug && marketSlug.includes('-')) {
            const parts = marketSlug.split('-');
            const lastPart = parts[parts.length - 1];
            if (/^\d+$/.test(lastPart)) {
                startTime = parseInt(lastPart) * 1000;
            }
        }
        
        // Fallback sur startDateStr si pas de slug (mais Gamma startDate est souvent erroné pour 15m)
        if (!startTime && startDateStr) startTime = new Date(startDateStr).getTime();
        if (!startTime) return null;

        const targetKey = `${startTime}_${asset.trim().toUpperCase()}`;
        
        if (fs.existsSync(STRIKES_FILE)) {
            const raw = fs.readFileSync(STRIKES_FILE, 'utf8');
            const data = JSON.parse(raw);
            // v7.16.1 : Recherche résiliente (match insensible aux espaces)
            const cleanKey = Object.keys(data).find(k => k.trim() === targetKey);
            if (cleanKey) {
                const captured = data[cleanKey];
                console.log(`[Strike] Found locally captured strike for ${asset} (Key: ${targetKey}): ${captured}`);
                return captured;
            } else {
                console.log(`[Strike] Key not found: ${targetKey}. Available keys: [${Object.keys(data).map(k => '"' + k + '"').join(', ')}]`);
            }
        } else {
            console.warn(`[Strike] Strikes file missing at: ${STRIKES_FILE}`);
        }
    } catch (err) {
        console.error('[Strike] Error lookup:', err.message);
    }
    return null;
}
