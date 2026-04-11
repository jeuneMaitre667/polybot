/**
 * Strike Worker (v2.0.0)
 * Logic isolated to ensure 100% reliability for 5-minute hi-fidelity captures.
 * v2026 : Added Polymarket Gamma API as primary strike source.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
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

        // --- 🔵 BINANCE USDC ALIGNMENT ---
        // Capture du prix "Ouverture" (Open) de la bougie
        for (const asset of SUPPORTED_ASSETS) {
            try {
                // On utilise USDC comme demandé
                const symbol = `${asset.toUpperCase()}USDC`;
                
                // On récupère le kline 5m pour avoir l' "Ouverture" exacte du graphique
                const kRes = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${targetSlotStartMs}&limit=1`);
                
                if (kRes.data && kRes.data[0]) {
                    const openPrice = parseFloat(kRes.data[0][1]); // Index 1 is Open Price
                    saveBinanceStrike(asset, openPrice, targetSlotStartMs);
                    console.log(`[Strike-Worker] 🔸 BINANCE USDC OPEN: ${openPrice.toFixed(2)} (${asset})`);
                } else {
                    // Fallback Tick si kline pas encore prêt
                    const bRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
                    const bPrice = parseFloat(bRes.data.price);
                    saveBinanceStrike(asset, bPrice, targetSlotStartMs);
                    console.log(`[Strike-Worker] ⚠️ BINANCE TICK (Kline Fail): ${bPrice.toFixed(2)}`);
                }
            } catch (e) {
                console.error(`[Strike-Worker] ❌ BINANCE CAPTURE FAILED:`, e.message);
            }
        }

        // v17.21.0: Real-time sync (No more 15s wait)
        // We fetch the AI/Gamma Strike in the background to avoid delaying the Binance pulse
        (async () => {
            for (const asset of SUPPORTED_ASSETS) {
                try {
                    const apiStrike = await fetchStrikeFromPolymarket(asset, targetSlotStartMs);
                    if (apiStrike != null) {
                        console.log(`[Strike-Worker] 🏆 API SYNC SUCCESS for ${asset}: ${apiStrike}`);
                        continue; 
                    }
                    const strikeData = await captureStrikeAtSlotOpen(asset, 'system_capture', targetSlotStartMs);
                    if (strikeData && strikeData.price) {
                        saveStrike(asset, strikeData.price, targetSlotStartMs);
                    }
                } catch (err) {
                    console.error(`[Strike-Worker] ❌ ERROR ${asset}:`, err.message);
                }
            }
        })();

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
