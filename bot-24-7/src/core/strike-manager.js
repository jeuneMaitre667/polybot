import { atomicWriteJson, safeReadJson } from './persistence-layer.js';
import path from 'path';

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
            if (now - lastLog > 120000) { // 2 minutes
                console.log(`[Strike] [HIT] ${key}: ${strike}`);
                getStrike.lastLogTs = { ...(getStrike.lastLogTs || {}), [key]: now };
            }
            return strike;
        }
        
        const availableKeys = Object.keys(data).join(', ');
        console.warn(`[Strike] [MISS] key="${key}" (startTime=${startTime}). Dispo: [${availableKeys}]`);
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
