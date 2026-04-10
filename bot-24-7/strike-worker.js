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

        // --- 🟢 NOUVELLE LOGIQUE BINANCE HYBRIDE ---
        // Capture immédiate du prix Binance à la seconde 0 (ou proche)
        for (const asset of SUPPORTED_ASSETS) {
            try {
                const bRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDT`);
                const bPrice = parseFloat(bRes.data.price);
                if (bPrice > 0) {
                    saveBinanceStrike(asset, bPrice, targetSlotStartMs);
                    console.log(`[Strike-Worker] 🔸 BINANCE OPEN captured for ${asset}: ${bPrice.toFixed(2)}`);
                }
            } catch (e) {
                console.error(`[Strike-Worker] ❌ BINANCE CAPTURE FAILED for ${asset}:`, e.message);
            }
        }

        // Attente de sécurité (15s) pour laisser Polymarket publier le nouveau Strike via l'API Gamma (Rétrocompatibilité)
        console.log('[Strike-Worker] ⏳ Waiting 15s for Polymarket API to populate strike...');
        await new Promise(r => setTimeout(r, 15000));
        
        // ... (Reste de la logique Polymarket existante pour la continuité des données)
        for (const asset of SUPPORTED_ASSETS) {
            try {
                const apiStrike = await fetchStrikeFromPolymarket(asset, targetSlotStartMs);
                if (apiStrike != null) {
                    console.log(`[Strike-Worker] 🏆 API SYNC SUCCESS for ${asset}: ${apiStrike}`);
                    continue; 
                }
                // Fallback Chainlink
                const strikeData = await captureStrikeAtSlotOpen(asset, 'system_capture', targetSlotStartMs);
                if (strikeData && strikeData.price) {
                    saveStrike(asset, strikeData.price, targetSlotStartMs);
                }
            } catch (err) {
                console.error(`[Strike-Worker] ❌ ERROR ${asset}:`, err.message);
            }
        }

    } catch (e) {
        console.error('[Strike-Worker] 💀 CRITICAL:', e.message);
    }
};

function saveBinanceStrike(asset, price, timestamp) {
    const filePath = './binance-strikes.json';
    try {
        let data = {};
        if (fs.existsSync(filePath)) {
            data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        if (!data[asset]) data[asset] = [];
        data[asset].push({ at: timestamp, price });
        // Garder les 50 derniers points
        data[asset] = data[asset].slice(-50);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn("[Strike-Worker] Fail to save binance-strikes", e.message);
    }
}

export const startStrikeWorker = () => {
    console.log('[Strike-Worker] 🚀 Starting High-Precision 5m Capture Sync (API + Chainlink Fallback)...');
    setInterval(runBoundaryCapture, 5000);
    setTimeout(runBoundaryCapture, 2000); // Startup trigger
};
