import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
    SUPPORTED_ASSETS, 
    MARKET_MODE, 
    GAMMA_EVENT_BY_SLUG_URL,
    BITCOIN_UPDOWN_5M_PREFIX,
    POLYMARKET_FEE_RATE,
    FEE_SAFETY_BUFFER
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STRIKES_FILE = path.resolve(__dirname, 'boundary-strikes.json');

/**
 * Moteur de Signaux Polymarket (v5.4.0 — BTC 5m Only)
 * Gère la récupération, le filtrage et le sizing (LOB depth) pour BTC.
 */

const signalCache = new Map(); // asset -> { data, ts }
const FETCH_SIGNALS_CACHE_MS = 200;

/**
 * Récupère les signaux Gamma pour BTC 5m.
 */
export async function fetchSignals(asset, context = {}) {
    const now = Date.now();
    if (signalCache.has(asset)) {
        const c = signalCache.get(asset);
        const cacheMs = context.FETCH_SIGNALS_CACHE_MS || FETCH_SIGNALS_CACHE_MS;
        if (now - c.ts < cacheMs) return c.data;
    }

    const { getCurrent5mEventSlug } = context;
    let slug = null;
    if (getCurrent5mEventSlug) {
        slug = getCurrent5mEventSlug(asset);
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
            
            // v5.4.1: Handle clobTokenIds (plural array) for 5m markets
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
        
        // v2026 Docs Alignment: Filter by market status and fee availability
        const signals = signalsRaw.filter(s => {
            if (!s.tokenIdToBuy) return false;
            
            // On vérifie les flags d'activité de Polymarket (m est l'objet market brut de Gamma)
            const isActive = s.m.active === true;
            const isClosed = s.m.closed === true;
            const feesEnabled = s.m.feesEnabled === true;

            if (!isActive || isClosed) {
                console.warn(`[${asset}] Signal REJECTED: Market is not active or already closed. (active:${isActive}, closed:${isClosed})`);
                return false;
            }

            if (!feesEnabled) {
                console.warn(`[${asset}] Signal REJECTED: Fees are not enabled on this market.`);
                return false;
            }

            return true;
        });
        
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
    // v2026 : Focalisation absolue sur le BTC 5m
    return BITCOIN_UPDOWN_5M_PREFIX;
}

/**
 * Génère une clé unique pour un signal (conditionId).
 */
export function getSignalKey(s) {
    return s.conditionId;
}

/**
 * Garde-fou temporel (Double-check avec entry timing).
 */
export function shouldSkipTradeTiming(s) {
    // Logique simplifiée : ici on pourrait importer isSlotEntryTimeForbiddenNow
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
        // v9.8.12 : Priorité ABSOLUE au timestamp extrait du slug pour le matching 5m
        if (marketSlug && marketSlug.includes('-')) {
            const parts = marketSlug.split('-');
            const lastPart = parts[parts.length - 1];
            if (/^\d+$/.test(lastPart)) {
                startTime = parseInt(lastPart) * 1000;
                console.log(`[Strike] Extracted slot time from slug for ${asset}: ${startTime}`);
            }
        }
        
        // Fallback sur startDateStr uniquement si pas de slug
        if (!startTime && startDateStr) {
            startTime = new Date(startDateStr).getTime();
        }
        
        if (!startTime) return null;

        // v7.16.21 : Normalisation Ms (13 digits) vs Sec (10 digits)
        let normalizedTime = String(startTime);
        if (normalizedTime.length === 10) normalizedTime += '000';
        
        const targetKey = `${normalizedTime}_${asset.trim().toUpperCase()}`;
        
        if (fs.existsSync(STRIKES_FILE)) {
            const raw = fs.readFileSync(STRIKES_FILE, 'utf8');
            const data = JSON.parse(raw);
            // v7.16.8 : Recherche absolue (loose match pour éviter tout caractère invisible)
            // v9.8.11 : Recherche par ID ou par Timestamp (fallback)
            const cleanKey = Object.keys(data).find(k => {
                const k1 = k.replace(/[^0-9A-Z_]/gi, '');
                const k2 = targetKey.replace(/[^0-9A-Z_]/gi, '');
                return k1 === k2 && k1.length > 0;
            });
            
            if (!cleanKey && asset.includes('BTC')) {
                // v9.8.11 High-Fidelity Fallback : Essayer de trouver une borne récente (+- 2 min)
                const now = Date.now();
                const nearbyKey = Object.keys(data).find(k => {
                    const ts = parseInt(k.split('_')[0]);
                    return Math.abs(ts - now) < 120000 && k.includes(asset);
                });
                if (nearbyKey) return data[nearbyKey];
            }
            
            if (cleanKey) {
                const captured = data[cleanKey];
                console.log(`[Strike] MATCH for ${asset}: ${captured} (Key: ${targetKey})`);
                return captured;
            } else {
                console.warn(`[Strike] NO MATCH for ${asset} (${targetKey}). Available: ${Object.keys(data).slice(-5).join(',')}`);
            }
        } else {
            console.warn(`[Strike] Strikes file missing at: ${STRIKES_FILE}`);
        }
    } catch (err) {
        console.error('[Strike] Error lookup:', err.message);
    }
    return null;
}
