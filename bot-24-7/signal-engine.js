import { gotScraping } from 'got-scraping';
import axios from 'axios';
import { getStealthProfile, logStealthMode } from './stealth-config.js';
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

    // v49.0.0: DIRECT SLUG DISCOVERY — Remplace keyset?series_id qui ne retourne que les 20 premiers marchés
    // et rate tous les marchés récents. On construit le slug directement depuis l'heure UTC actuelle.
    const targetSeriesSlug = asset === 'BTC' ? 'btc-up-or-down-5m' : `${asset.toLowerCase()}-up-or-down-5m`;
    const nowMs = Date.now();
    const SLOT_MS = 300000; // 5 minutes
    // Cherche les 3 prochains slots (slot courant + 2 slots suivants)
    const slotsToFetch = [0, 1, 2].map(offset => Math.floor(nowMs / SLOT_MS) * SLOT_MS + offset * SLOT_MS);
    
    const startFetch = Date.now();
    try {
        // Requêtes parallèles pour les 3 slugs cibles
        const slugRequests = slotsToFetch.map(slotMs => {
            const slotSec = Math.floor(slotMs / 1000);
            const slug = `btc-updown-5m-${slotSec}`;
            const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
            return axios.get(url, { timeout: 5000, httpsAgent: null })
                .then(r => r.data?.[0] || null)
                .catch(() => null);
        });
        
        const results = await Promise.all(slugRequests);
        const events = results.filter(Boolean); // Filtre les slugs non encore publiés

        if (events.length === 0) {
            console.warn(`[${asset}] 🛡️ SCAN RESULTS: Direct slug discovery found no active markets for slots: ${slotsToFetch.map(s => Math.floor(s/1000)).join(', ')}`);
            return { signals: [], slug: null, hasEvent: false };
        }

        // Filtre supplémentaire: on n'accepte que les marchés qui se terminent dans le futur
        const validEvents = events.filter(e => {
            const endMs = new Date(e.endDate).getTime();
            return endMs > nowMs;
        });

        const targetSlug = context.getCurrent5mEventSlug ? context.getCurrent5mEventSlug(asset) : getSlotSlugForAsset(asset);
        const primaryEvent = validEvents.find(e => e.slug === targetSlug) || validEvents[0];
        
        console.log(`[${asset}] 📡 Discovery: ${validEvents.length} imminent markets found. Primary target: ${primaryEvent.slug}`);
        
        // v21.5.0: Aggregate signals from ALL valid imminent events
        const allSignals = [];
        for (const event of validEvents) {
            if (!event.markets) continue;
            
            const eventSignals = event.markets.map(m => {
                const outcomePrices = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
                const yesPrice = parseFloat(outcomePrices[0]);
                const noPrice = parseFloat(outcomePrices[1]);
                const takeSide = m.groupItemTitle || "Yes";
                
                let tokenIdYes = null;
                let tokenIdNo = null;
                if (m.clobTokenIds) {
                    try {
                        const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
                        if (Array.isArray(ids)) {
                            tokenIdYes = ids[0];
                            tokenIdNo = ids[1] || null;
                        }
                    } catch (e) {}
                }
                if (!tokenIdYes) tokenIdYes = m.clobTokenId || m.conditionId;

                return {
                    asset,
                    slug: event.slug, 
                    conditionId: m.conditionId,
                    tokenIdToBuy: tokenIdYes,
                    tokenIdYes,
                    tokenIdNo,
                    strike: lookupBoundaryStrike(asset, m.startDate, parseFloat(m.line), event.slug) || extractStrikeFromQuestion(m.question || m.groupItemTitle),
                    takeSide,
                    priceUp: yesPrice,
                    priceDown: noPrice,
                    m
                };
            });
            allSignals.push(...eventSignals);
        }

        const profile = { totalMs: Date.now() - startFetch };
        
        const signals = allSignals.filter(s => {
            if (!s.tokenIdToBuy) return false;
            const isActive = s.m.active === true;
            const isClosed = s.m.closed === true;
            if (!isActive || isClosed) return false;
            return true;
        });
        
        const result = {
            signals,
            slug: primaryEvent.slug, // Used for the default pipeline display
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

export function getSlotSlugForAsset(asset) {
    const now = Date.now();
    const prefix = asset.toLowerCase() === 'btc' ? 'btc-updown-5m' : `${asset.toLowerCase()}-updown-5m`;
    
    // v17.36.0: Return the CURRENT active slot for pipeline reporting (Math.floor).
    const slotSec = Math.floor(now / 300000) * 300; 
    return `${prefix}-${slotSec}`;
}

/**
 * Génère une clé unique pour un signal (conditionId).
 */
export function getSignalKey(s) {
    return s.conditionId;
}

/**
 * Garde-fou temporel.
 */
export function shouldSkipTradeTiming(s) {
    return false; 
}

/**
 * Calcule la mise optimale en fonction de la profondeur du carnet.
 */
export function calculateOptimalStake(asset, side, book, targetPrice, feeRate = null) {
    if (!book || !book.asks || book.asks.length === 0) return 0;
    
    let totalAvailableUsdc = 0;
    const maxSlippage = targetPrice * 1.02; // Tolérance 2%

    for (const ask of book.asks) {
        const p = parseFloat(ask.price);
        const size = parseFloat(ask.size);
        if (p > maxSlippage) break;
        totalAvailableUsdc += (p * size);
    }

    const currentFeeRate = feeRate || POLYMARKET_FEE_RATE;
    const optimal = totalAvailableUsdc * 0.8;
    const netStake = optimal / (1 + (currentFeeRate * FEE_SAFETY_BUFFER));
    return Math.floor(netStake * 100) / 100;
}

/**
 * Persistance des prix aux bornes (00, 15, 30, 45).
 */
export function saveBoundaryStrike(asset, price, timestamp = Date.now()) {
    try {
        const data = fs.existsSync(STRIKES_FILE) ? JSON.parse(fs.readFileSync(STRIKES_FILE, 'utf8') || '{}') : {};
        const date = new Date(timestamp);
        date.setSeconds(0);
        date.setMilliseconds(0);
        const minutes = date.getMinutes();
        const boundaryMinutes = Math.floor(minutes / 15) * 15;
        date.setMinutes(boundaryMinutes);
        
        const key = `${date.getTime()}_${asset}`;
        data[key] = price;
        
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
        if (marketSlug && marketSlug.includes('-')) {
            const parts = marketSlug.split('-');
            const lastPart = parts[parts.length - 1];
            if (/^\d+$/.test(lastPart)) {
                startTime = parseInt(lastPart) * 1000;
            }
        }
        
        if (!startTime && startDateStr) {
            startTime = new Date(startDateStr).getTime();
        }
        
        if (!startTime) return null;

        let normalizedTime = String(startTime);
        if (normalizedTime.length === 10) normalizedTime += '000';
        
        const targetKey = `${normalizedTime}_${asset.trim().toUpperCase()}`;
        
        if (fs.existsSync(STRIKES_FILE)) {
            const raw = fs.readFileSync(STRIKES_FILE, 'utf8');
            const data = JSON.parse(raw);
            const cleanKey = Object.keys(data).find(k => {
                const k1 = k.replace(/[^0-9A-Z_]/gi, '');
                const k2 = targetKey.replace(/[^0-9A-Z_]/gi, '');
                return k1 === k2 && k1.length > 0;
            });
            
            if (!cleanKey) {
                const targetMs = Number(normalizedTime);
                const targetAsset = asset.trim().toUpperCase();
                const nearbyKey = Object.keys(data).find((k) => {
                    const [tsStr, ...rest] = k.split('_');
                    const ts = Number(tsStr);
                    if (!Number.isFinite(ts)) return false;
                    if (Math.abs(ts - targetMs) > 5 * 60 * 1000) return false;
                    const keyAsset = rest.join('_').toUpperCase();
                    return keyAsset.includes(targetAsset);
                });
                if (nearbyKey) return data[nearbyKey];

                const now = Date.now();
                const btcNearbyKey = Object.keys(data).find(k => {
                    const ts = parseInt(k.split('_')[0]);
                    return Math.abs(ts - now) < 120000 && k.includes(asset);
                });
                if (btcNearbyKey) return data[btcNearbyKey];
            }
            
            if (cleanKey) return data[cleanKey];
            return null;
        }
    } catch (err) {
        console.error('[Strike] Error lookup:', err.message);
    }
    return null;
}

function extractStrikeFromQuestion(text) {
    if (!text) return null;
    const matches = text.match(/\$?\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?k?/gi);
    if (!matches) return null;
    const candidates = matches.map(m => {
        let val = m.toLowerCase().replace(/[$,\s]/g, '');
        if (val.endsWith('k')) return parseFloat(val) * 1000;
        return parseFloat(val);
    }).filter(v => Number.isFinite(v) && v > 1000);
    if (candidates.length === 0) return null;
    return candidates[0];
}
