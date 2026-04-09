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
        const slot = slotOverride || (Math.floor(Date.now() / 900000) * 900000);
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
            // Optionnel : vérifier result.updatedAt pour être sûr qu'on n'est pas trop loin du début du slot
            // Mais pour un Sniper v2026, la tolérance est de quelques minutes.
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
 * v9.0.0 : Direct metadata sync from Gamma API
 */
export const fetchStrikeFromPolymarket = async (asset, startTime) => {
    try {
        const cleanAsset = asset.trim().toUpperCase();
        // Normalisation en secondes pour le slug
        const sec = startTime > 10000000000 ? Math.floor(startTime / 1000) : startTime;
        const slug = `${cleanAsset.toLowerCase()}-updown-5m-${sec}`;
        const url = `https://gamma-api.polymarket.com/events/slug/${slug}`;

        console.log(`[Strike] [API] Synchronisation via Polymarket Gamma pour ${slug}...`);
        
        const response = await axios.get(url, { timeout: 10000 }); // Augmenté à 10s pour être sûr
        const strike = response.data?.eventMetadata?.priceToBeat;

        if (strike != null) {
            const numericStrike = Number(strike);
            console.log(`[Strike] [API] ✅ SUCCÈS : Strike extrait = ${numericStrike}`);
            saveStrike(asset, numericStrike, sec * 1000);
            return numericStrike;
        }

        console.warn(`[Strike] [API] ⚠️ Champ 'priceToBeat' non trouvé pour ${slug}.`);
        return null;
    } catch (e) {
        console.warn(`[Strike] [API] ❌ Échec récupération (${e.message}).`);
        return null;
    }
};
