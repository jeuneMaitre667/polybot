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

    // Retry loop : tenter toutes les 10s pendant 1 minute (6 tentatives)
    for (let attempt = 1; attempt <= 6; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            const strike = response.data?.eventMetadata?.priceToBeat;

            if (strike != null) {
                const numericStrike = Number(strike);
                console.log(`[Strike] [API] ✅ SUCCÈS (Tentative ${attempt}) : Strike extrait = ${numericStrike}`);
                saveStrike(asset, numericStrike, sec * 1000);
                return numericStrike;
            }

            if (attempt < 6) {
                console.warn(`[Strike] [API] ⏳ Tentative ${attempt}/6 : Strike non encore publié. Attente 10s...`);
                await new Promise(r => setTimeout(r, 10000));
            }
        } catch (e) {
            console.warn(`[Strike] [API] ❌ Tentative ${attempt}/6 échouée (${e.message}).`);
            if (attempt < 6) await new Promise(r => setTimeout(r, 10000));
        }
    }

    console.error(`[Strike] [API] 💀 Échec définitif pour ${slug} après 1 minute.`);
    return null;
};

// v24.2.4: High-Speed Memory Cache (Zero Disk Lag)
const binanceStrikeCache = {};

/**
 * getBinanceStrike(asset, startTime)
 * v2025 : Récupère le prix d'ouverture Binance.
 * v24.2.4 : Cache RAM pour éliminer la latence disque des scans 1Hz.
 */
export const getBinanceStrike = async (asset, startTime) => {
    const ms = startTime < 10000000000 ? startTime * 1000 : startTime;
    const cleanAsset = asset.trim().toUpperCase();
    const cacheKey = `${ms}_${cleanAsset}`;

    // 1. Check RAM first (Fastest)
    if (binanceStrikeCache[cacheKey]) return binanceStrikeCache[cacheKey];

    try {
        const filePath = path.join(process.cwd(), 'binance-strikes.json');
        const data = safeReadJson(filePath);
        
        if (data && data[cleanAsset]) {
            const match = data[cleanAsset].find(p => Math.abs(p.at - ms) < 10000);
            if (match) {
                binanceStrikeCache[cacheKey] = match.price; // Hydrate cache
                return match.price;
            }
        }

        // --- FALLBACK: Backfill via Binance Klines API ---
        console.log(`[Strike] [BACKFILL] Fetching ${asset} open price (USDC) for ${new Date(ms).toISOString()}...`);
        const symbol = `${cleanAsset}USDC`;
        const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${ms}&limit=1`, { timeout: 5000 });
        
        if (res.data && res.data[0]) {
            const openPrice = parseFloat(res.data[0][1]); // 1 is Open Price
            console.log(`[Strike] [BACKFILL] Recovered ${asset} USDC Open: ${openPrice}`);
            
            // v24.2.0: PERSISTENCE - Don't ask again!
            const currentData = safeReadJson(filePath);
            if (!currentData[cleanAsset]) currentData[cleanAsset] = [];
            currentData[cleanAsset].push({ at: ms, price: openPrice });
            atomicWriteJson(filePath, currentData);
            
            binanceStrikeCache[cacheKey] = openPrice; // Save in cache
            return openPrice;
        }
    } catch (e) {
        console.warn('[Strike] Binance Backfill Fail:', e.message);
    }
    return null;
};
