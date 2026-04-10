/**
 * Strike Worker (v1.0.0)
 * Logic isolated to ensure 100% reliability for 5-minute hi-fidelity captures.
 */
import { captureStrikeAtSlotOpen } from './chainlink-price.js';
import { saveStrike } from './src/core/strike-manager.js';
import { SUPPORTED_ASSETS } from './config.js';

let lastCapturedMinute = -1;

export const runBoundaryCapture = async () => {
    try {
        const now = new Date();
        const m = now.getMinutes();
        const s = now.getSeconds();
        
        // v2026 : Déclenchement strict sur les multiples de 5 (indépendant du mode config)
        const isFiveMinBoundary = (m % 5 === 0);
        
        if (!isFiveMinBoundary) return;
        if (lastCapturedMinute === m) return;
        
        lastCapturedMinute = m;
        const targetSlotStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), m, 0, 0).getTime();
        
        console.log(`[Strike-Worker] 🎯 TRIGGER detected at ${m}m ${s}s. Target: ${new Date(targetSlotStartMs).toISOString()}`);

        for (const asset of SUPPORTED_ASSETS) {
            try {
                const strikeData = await captureStrikeAtSlotOpen(asset, 'system_capture', targetSlotStartMs);
                if (strikeData && strikeData.price) {
                    saveStrike(asset, strikeData.price, targetSlotStartMs);
                    console.log(`[Strike-Worker] ✅ SUCCESS ${asset} price=${strikeData.price.toFixed(2)} offset=${strikeData.updatedAt - targetSlotStartMs}ms`);
                }
            } catch (err) {
                console.error(`[Strike-Worker] ❌ ERROR ${asset}:`, err.message);
            }
        }

    } catch (e) {
        console.error('[Strike-Worker] 💀 CRITICAL:', e.message);
    }
};

export const startStrikeWorker = () => {
    console.log('[Strike-Worker] 🚀 Starting High-Precision 5m Capture Sync...');
    setInterval(runBoundaryCapture, 5000);
    setTimeout(runBoundaryCapture, 2000); // Startup trigger
};
