import { atomicWriteJson, safeReadJson } from './persistence-layer.js';
import path from 'path';
import axios from 'axios';

const STRIKES_FILE = path.join(process.cwd(), 'boundary-strikes.json');

/**
 * getStrike(asset, startTime)
 * v8.0.0 : Normalized lookup with millisecond handling
 */
export const getStrike = (asset, startTime) => {
    try {
        const data = safeReadJson(STRIKES_FILE);
        const cleanAsset = asset.trim().toUpperCase();
        
        // Normalisation ms/sec
        const ms = startTime < 10000000000 ? startTime * 1000 : startTime;
        const key = `${ms}_${cleanAsset}`;
        
        const strike = data[key];
        if (strike) {
            // Throttling console feedback (v8.1.1 : Quiet mode)
            const now = Date.now();
            const lastLog = getStrike.lastLogTs?.[key] || 0;
            if (now - lastLog > 300000) { // 5 minutes (plus calme)
                console.log(`[Strike] [HIT] ${key}: ${strike}`);
                getStrike.lastLogTs = { ...(getStrike.lastLogTs || {}), [key]: now };
            }
            return strike;
        }
        
        const now = Date.now();
        const lastMissLog = getStrike.lastMissLogTs?.[key] || 0;
        if (now - lastMissLog > 600000) { // 10 minutes pour les MISS
            const availableKeys = Object.keys(data).slice(-3).join(', ');
            console.warn(`[Strike] [MISS] key="${key}". Dispo: [...${availableKeys}]`);
            getStrike.lastMissLogTs = { ...(getStrike.lastMissLogTs || {}), [key]: now };
        }
        return null;
    } catch (e) {
        console.error('[Strike] Lookup Error:', e.message);
        return null;
    }
};

/**
 * saveStrike(asset, price, slotOverride)
 * v8.0.0 : Atomic save with slot calculation
 * v8.1.0 : Added slotOverride for 5m precision
 */
export const saveStrike = (asset, price, slotOverride = null) => {
    try {
        const data = safeReadJson(STRIKES_FILE);
        const slot = slotOverride || (Math.floor(Date.now() / 300000) * 300000);
        const cleanAsset = asset.trim().toUpperCase();
        const key = `${slot}_${cleanAsset}`;
        
        data[key] = price;
        atomicWriteJson(STRIKES_FILE, data);
        
        console.log(`[Strike] [SAVED] ${key}: ${price}`);
        return { slot, price };
    } catch (e) {
        console.error('[Strike] Save Error:', e.message);
        return null;
    }
};

/**
 * resolveStrikeLate(asset, startTime)
 * v2026 : REST Fallback via Chainlink if local cache is empty.
 * Triggered only once per asset/slot.
 */
const lateResolveMemory = new Set();
export const resolveStrikeLate = async (asset, startTime, getChainlinkPrice) => {
    const ms = startTime < 10000000000 ? startTime * 1000 : startTime;
    const key = `${ms}_${asset.trim().toUpperCase()}`;
    
    if (lateResolveMemory.has(key)) return null;
    lateResolveMemory.add(key);

    console.log(`[Strike] [LATE-CATCH] Attempting REST recovery for ${key}...`);
    try {
        const result = await getChainlinkPrice(asset);
        if (result.price != null) {
            saveStrike(asset, result.price, ms);
            return result.price;
        }
    } catch (e) {
        console.error(`[Strike] [LATE-CATCH] Failed: ${e.message}`);
    }
    return null;
};

/**
 * fetchStrikeFromPolymarket(asset, startTime)
 * v10.0.0 : Direct metadata sync with robust retry loop (60s)
 */
export const fetchStrikeFromPolymarket = async (asset, startTime) => {
    const cleanAsset = asset.trim().toUpperCase();
    const sec = startTime > 10000000000 ? Math.floor(startTime / 1000) : startTime;
    const slug = `${cleanAsset.toLowerCase()}-updown-5m-${sec}`;
    const url = `https://gamma-api.polymarket.com/events/slug/${slug}`;

    console.log(`[Strike] [API] Synchronisation via Polymarket Gamma pour ${slug}...`);

    // Retry loop : tenter toutes les 10s pendant 3 minutes (18 tentatives)
    for (let attempt = 1; attempt <= 18; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            const strike = response.data?.eventMetadata?.priceToBeat;

            if (strike != null) {
                const numericStrike = Number(strike);
                console.log(`[Strike] [API] ✅ SUCCÈS (Tentative ${attempt}) : Strike extrait = ${numericStrike}`);
                saveStrike(asset, numericStrike, sec * 1000);
                return numericStrike;
            }

            if (attempt < 18) {
                console.warn(`[Strike] [API] ⏳ Tentative ${attempt}/18 : Strike non encore publié. Attente 10s...`);
                await new Promise(r => setTimeout(r, 10000));
            }
        } catch (e) {
            console.warn(`[Strike] [API] ❌ Tentative ${attempt}/18 échouée (${e.message}).`);
            if (attempt < 18) await new Promise(r => setTimeout(r, 10000));
        }
    }

    console.error(`[Strike] [API] 💀 Échec définitif pour ${slug} après 3 minutes.`);
    return null;
};

/**
 * getBinanceStrike(asset, startTime)
 * v2025 : Récupère le prix d'ouverture Binance.
 * v2025.1 : Ajout d'un fallback REST pour backfill l'opening si le worker a raté le slot.
 */
export const getBinanceStrike = async (asset, startTime) => {
    try {
        const filePath = path.join(process.cwd(), 'binance-strikes.json');
        const data = safeReadJson(filePath);
        const ms = startTime < 10000000000 ? startTime * 1000 : startTime;
        
        if (data && data[asset]) {
            const match = data[asset].find(p => Math.abs(p.at - ms) < 10000);
            if (match) return match.price;
        }

        // --- FALLBACK: Backfill via Binance Klines API ---
        console.log(`[Strike] [BACKFILL] Fetching ${asset} open price for ${new Date(ms).toISOString()}...`);
        const symbol = `${asset.trim().toUpperCase()}USDT`;
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${ms}&limit=1`);
        
        if (res.data && res.data[0]) {
            const openPrice = parseFloat(res.data[0][1]); // 1 is Open Price
            console.log(`[Strike] [BACKFILL] Recovered ${asset} Open: ${openPrice}`);
            return openPrice;
        }
    } catch (e) {
        console.warn('[Strike] Binance Backfill Fail:', e.message);
    }
    return null;
};
