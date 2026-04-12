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
 * Moteur de Signaux Polymarket (v5.4.0 â€” BTC 5m Only)
 * GÃ¨re la rÃ©cupÃ©ration, le filtrage et le sizing (LOB depth) pour BTC.
 */

const signalCache = new Map(); // asset -> { data, ts }
const FETCH_SIGNALS_CACHE_MS = 200;

/**
 * RÃ©cupÃ¨re les signaux Gamma pour BTC 5m.
 */
export async function fetchSignals(asset, context = {}) {
    const now = Date.now();
    if (signalCache.has(asset)) {
        const c = signalCache.get(asset);
        const cacheMs = context.FETCH_SIGNALS_CACHE_MS || FETCH_SIGNALS_CACHE_MS;
        if (now - c.ts < cacheMs) return c.data;
    }

    // v17.29.19: Recherche la plus large possible pour garantir l'inclusion des 5m dans les résultats
    const targetSeriesSlug = asset === 'BTC' ? 'btc-up-or-down-5m' : `${asset.toLowerCase()}-up-or-down-5m`;
    const discoveryUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&search=${asset === 'BTC' ? 'Bitcoin' : asset}`;
    
    const startFetch = Date.now();
    try {
        console.log(`[${asset}] Scanning for 5m markets in series: ${targetSeriesSlug}`);
        const res = await axios.get(discoveryUrl, { timeout: 5000 });

        const events = res.data;
        if (!events || !Array.isArray(events) || events.length === 0) {
            console.warn(`[${asset}] No active events found via discovery.`);
            return { signals: [], slug: null, hasEvent: false };
        }

        // v17.30.0: Filtrage laser multi-critères (Le "Viseur Sniper")
        const nowMs = Date.now();
        const maxFutureMs = 15 * 60 * 1000; 

        const validEvents = events.filter(e => {
            // 1. Uniquement la série officielle 5 minutes
            if (e.seriesSlug !== targetSeriesSlug) return false;
            
            // 2. Verrou temporel (Évite les marchés de 2026/2027)
            const endMs = new Date(e.endDate).getTime();
            const timeDiff = endMs - nowMs;
            if (timeDiff <= 0 || timeDiff > maxFutureMs) return false;
            
            // 3. Validation par titre (Sécurité visuelle)
            if (!String(e.title).includes("5 minutes")) return false;
            
            return true;
        });

        if (validEvents.length === 0) {
            console.warn(`[${asset}] 🛡️ SCAN RESULTS: ${events.length} events found, but ZERO matched the 5m Sniper filters. (Check if 2026 markets were excluded).`);
            return { signals: [], slug: null, hasEvent: false };
        }

        const targetSlug = context.getCurrent5mEventSlug ? context.getCurrent5mEventSlug(asset) : getSlotSlugForAsset(asset);
        // On prend le marché le plus imminant de la série validée
        const event = validEvents.find(e => e.slug === targetSlug) || validEvents[0];
        
        const slug = event.slug;
        console.log(`[${asset}] 🎯 SNIPER LOCKED: ${event.title} | Slot End: ${event.endDate} | Slug: ${slug}`);
        
        if (!event.markets) return [];

        const signalsRaw = event.markets.map(m => {
            const outcomePrices = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
            const yesPrice = parseFloat(outcomePrices[0]);
            const noPrice = parseFloat(outcomePrices[1]);
            
            // On cherche le "Yes" (Upper) ou "No" (Lower)
            // Note: m.groupItemTitle contient souvent "Yes" ou "No"
            const takeSide = m.groupItemTitle || "Yes";
            
            // v5.4.1: Handle clobTokenIds (Yes/No pair) for 5m markets
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
            
            // Fallback for older market formats
            if (!tokenIdYes) tokenIdYes = m.clobTokenId || m.conditionId;

            console.log(`[${asset}] Signal detect: ${takeSide} @ ${m.outcomePrices} -> Yes:${tokenIdYes} | No:${tokenIdNo}`);

            return {
                asset,
                slug,
                conditionId: m.conditionId,
                tokenIdToBuy: tokenIdYes, // Maintain backward compatibility
                tokenIdYes,
                tokenIdNo,
                strike: lookupBoundaryStrike(asset, m.startDate, parseFloat(m.line), slug) || extractStrikeFromQuestion(m.question || m.groupItemTitle),
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
            
            // On vÃ©rifie les flags d'activitÃ© de Polymarket (m est l'objet market brut de Gamma)
            const isActive = s.m.active === true;
            const isClosed = s.m.closed === true;
            const feesEnabled = s.m.feesEnabled === true;

            if (!isActive || isClosed) {
                // Console log for debug (will show in dashboard or bot log)
                console.warn(`[${asset}] Signal REJECTED: Market is not active or already closed.`);
                return false;
            }

            // v2026 : Fees might be missing on high-frequency 5m markets.
            if (s.m.active === false) return false;

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

export function getSlotSlugForAsset(asset) {
    const now = Date.now();
    const prefix = asset.toLowerCase() === 'btc' ? 'btc-updown-5m' : `${asset.toLowerCase()}-updown-5m`;
    
    // v17.22.17: Revert to START-time slot convention (Math.floor)
    const slotSec = Math.floor(now / 300000) * 300; 
    return `${prefix}-${slotSec}`;
}

/**
 * GÃ©nÃ¨re une clÃ© unique pour un signal (conditionId).
 */
export function getSignalKey(s) {
    return s.conditionId;
}

/**
 * Garde-fou temporel (Double-check avec entry timing).
 */
export function shouldSkipTradeTiming(s) {
    // Logique simplifiÃ©e : ici on pourrait importer isSlotEntryTimeForbiddenNow
    return false; 
}

/**
 * Calcule la mise optimale en fonction de la profondeur du carnet.
 */
export function calculateOptimalStake(asset, side, book, targetPrice) {
    if (!book || !book.asks || book.asks.length === 0) return 0;
    
    let totalAvailableUsdc = 0;
    const maxSlippage = targetPrice * 1.02; // TolÃ©rance 2%

    for (const ask of book.asks) {
        const p = parseFloat(ask.price);
        const size = parseFloat(ask.size);
        if (p > maxSlippage) break;
        totalAvailableUsdc += (p * size);
    }

    // SÃ©curitÃ© : on ne prend que 80% de la liquiditÃ© immÃ©diate pour Ã©viter de vider le carnet
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
        // Normaliser le timestamp Ã  la borne la plus proche (passÃ©e)
        const date = new Date(timestamp);
        date.setSeconds(0);
        date.setMilliseconds(0);
        const minutes = date.getMinutes();
        const boundaryMinutes = Math.floor(minutes / 15) * 15;
        date.setMinutes(boundaryMinutes);
        
        const key = `${date.getTime()}_${asset}`;
        data[key] = price;
        
        // Garder seulement les 48 derniÃ¨res heures (3 actifs * 4 par heure * 48h = 576 entrÃ©es)
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
        // v9.8.12 : PrioritÃ© ABSOLUE au timestamp extrait du slug pour le matching 5m
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
            // v7.16.8 : Recherche absolue (loose match pour Ã©viter tout caractÃ¨re invisible)
            // v9.8.11 : Recherche par ID ou par Timestamp (fallback)
            const cleanKey = Object.keys(data).find(k => {
                const k1 = k.replace(/[^0-9A-Z_]/gi, '');
                const k2 = targetKey.replace(/[^0-9A-Z_]/gi, '');
                return k1 === k2 && k1.length > 0;
            });
            
            if (!cleanKey) {
                // v9.8.11 High-Fidelity Fallback : Essayer de trouver une borne rÃ©cente (+- 2 min)
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
                if (nearbyKey) {
                    console.log(`[Strike] NEARBY MATCH for ${asset}: ${data[nearbyKey]} (Key: ${nearbyKey}, target ${targetKey})`);
                    return data[nearbyKey];
                }

                // v9.8.11 High-Fidelity Fallback : Essayer de trouver une borne récente (+- 2 min)
                const now = Date.now();
                const btcNearbyKey = Object.keys(data).find(k => {
                    const ts = parseInt(k.split('_')[0]);
                    return Math.abs(ts - now) < 120000 && k.includes(asset);
                });
                if (btcNearbyKey) return data[btcNearbyKey];
            }
            
            if (cleanKey) {
                const captured = data[cleanKey];
                return captured;
            } else {
                // v17.20.0: Non-blocking miss
                return null;
            }
        } else {
            console.warn(`[Strike] Strikes file missing at: ${STRIKES_FILE}`);
        }
    } catch (err) {
        console.error('[Strike] Error lookup:', err.message);
    }
    return null;
}

/**
 * v2027 : Extraction robuste du Strike depuis le texte Gamma (fallback line=0).
 */
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
    return candidates[0]; // Simplifié pour le moteur de signal (le filtre 1000 suffit pour BTC)
}
