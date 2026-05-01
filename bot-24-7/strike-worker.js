/**
 * Strike Worker (v2.0.0)
 * Logic isolated to ensure 100% reliability for 5-minute hi-fidelity captures.
 * v2026 : Added Polymarket Gamma API as primary strike source.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { captureStrikeAtSlotOpen } from './chainlink-price.js';
import { saveStrike } from './src/core/strike-manager.js';
import { SUPPORTED_ASSETS } from './config.js';

let lastCapturedMinute = -1;

export const runBoundaryCapture = async (isStartup = false) => {
    try {
        const now = new Date();
        const m = now.getMinutes();
        const isFiveMinBoundary = (m % 5 === 0);
        
        // v50.5.4: COLD-START (Fetch current slot strike even if not on boundary)
        if (!isFiveMinBoundary && !isStartup) return;
        
        // For startup, we target the current slot (floor to 5min)
        const effectiveM = isFiveMinBoundary ? m : Math.floor(m / 5) * 5;
        
        if (!isStartup && lastCapturedMinute === effectiveM) return;
        
        if (!isStartup) lastCapturedMinute = effectiveM;
        
        const targetSlotStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), effectiveM, 0, 0).getTime();
        
        console.log(`[Strike-Worker] 🎯 ${isStartup ? "COLD-START" : "TRIGGER"} detected for slot ${new Date(targetSlotStartMs).toISOString()}`);

        // --- 🔵 BINANCE USDC ALIGNMENT ---
        for (const asset of SUPPORTED_ASSETS) {
            try {
                const symbol = `${asset.toUpperCase()}USDC`;
                
                // On récupère le kline 5m pour avoir l' "Ouverture" exacte du graphique
                const kRes = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${targetSlotStartMs}&limit=1`, { 
                    timeout: 5000,
                    httpsAgent: null 
                });
                
                if (kRes.data && kRes.data[0]) {
                    const openPrice = parseFloat(kRes.data[0][1]); // Index 1 is Open Price
                    global.lastBinanceOpen = openPrice; // v50.7.2: Atomic Sync with slot-awareness
                    global.lastBinanceOpenSlot = targetSlotStartMs;
                    saveBinanceStrike(asset, openPrice, targetSlotStartMs);
                    console.log(`[Strike-Worker] 🔸 BINANCE USDC OPEN: ${openPrice.toFixed(2)} (${asset})`);
                } else {
                    // Fallback Tick si kline pas encore prêt
                    const bRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { 
                        timeout: 5000,
                        httpsAgent: null 
                    });
                    const bPrice = parseFloat(bRes.data.price);
                    global.lastBinanceOpen = bPrice; // v50.7.2: Immediate memory sync for fallback
                    global.lastBinanceOpenSlot = targetSlotStartMs;
                    saveBinanceStrike(asset, bPrice, targetSlotStartMs);
                    console.log(`[Strike-Worker] ⚠️ BINANCE TICK (Kline Fail): ${bPrice.toFixed(2)}`);
                }
            } catch (e) {
                console.error(`[Strike-Worker] ❌ BINANCE CAPTURE FAILED:`, e.message);
            }
        }

        // v50.7.9: Polymarket Gamma Sync Loop REMOVED (Binance-Only Strategy)

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
        if (data[asset].some(p => p.at === timestamp)) return;
        data[asset].push({ at: timestamp, price });
        data[asset] = data[asset].slice(-50);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn("[Strike-Worker] Fail to save binance-strikes", e.message);
    }
}

export const startStrikeWorker = () => {
    console.log('[Strike-Worker] 🚀 Starting High-Precision 5m Capture Sync (v50.5.4 COLD-START Enabled)...');
    setInterval(() => runBoundaryCapture(false), 5000);
    setTimeout(() => runBoundaryCapture(true), 2000);
};
