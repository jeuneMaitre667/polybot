/**
 * Strike Worker (v2.0.0)
 * Logic isolated to ensure 100% reliability for 5-minute hi-fidelity captures.
 * v2026 : Added Polymarket Gamma API as primary strike source.
 */
import { captureStrikeAtSlotOpen } from './chainlink-price.js';
import { saveStrike, fetchStrikeFromPolymarket } from './src/core/strike-manager.js';
import { SUPPORTED_ASSETS } from './config.js';

let lastCapturedMinute = -1;

export const runBoundaryCapture = async () => {
    try {
        const now = new Date();
        const m = now.getMinutes();
        const isFiveMinBoundary = (m % 5 === 0);
        
        if (!isFiveMinBoundary) return;
        if (lastCapturedMinute === m) return;
        
        lastCapturedMinute = m;
        const targetSlotStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), m, 0, 0).getTime();
        
        console.log(`[Strike-Worker] 🎯 TRIGGER detected for slot ${new Date(targetSlotStartMs).toISOString()}`);

        // Attente de sécurité (15s) pour laisser Polymarket publier le nouveau Strike via l'API Gamma
        console.log('[Strike-Worker] ⏳ Waiting 15s for Polymarket API to populate strike...');
        await new Promise(r => setTimeout(r, 15000));

        for (const asset of SUPPORTED_ASSETS) {
            try {
                // TENTATIVE 1 : API Polymarket (Source de vérité absolue)
                const apiStrike = await fetchStrikeFromPolymarket(asset, targetSlotStartMs);
                
                if (apiStrike != null) {
                    console.log(`[Strike-Worker] 🏆 API SYNC SUCCESS for ${asset}: ${apiStrike}`);
                    // Save is already handled in fetchStrikeFromPolymarket
                    continue; 
                }

                // TENTATIVE 2 : Fallback Chainlink (Si l'API est trop lente ou absente)
                console.warn(`[Strike-Worker] ⚠️ API Fallback for ${asset}. Switching to Chainlink...`);
                const strikeData = await captureStrikeAtSlotOpen(asset, 'system_capture', targetSlotStartMs);
                if (strikeData && strikeData.price) {
                    saveStrike(asset, strikeData.price, targetSlotStartMs);
                    console.log(`[Strike-Worker] ✅ CHAINLINK SUCCESS ${asset} price=${strikeData.price.toFixed(2)}`);
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
    console.log('[Strike-Worker] 🚀 Starting High-Precision 5m Capture Sync (API + Chainlink Fallback)...');
    setInterval(runBoundaryCapture, 5000);
    setTimeout(runBoundaryCapture, 2000); // Startup trigger
};
