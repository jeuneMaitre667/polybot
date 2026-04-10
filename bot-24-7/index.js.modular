/**
 * Master Controller (v2025 MODULAR - v16.3.0)
 * Orchestrates market sync, strategy filtering, and trading execution.
 * BUILT FOR DUAL-ASK REALTIME SYNC
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ClobClient, Side } from '@polymarket/clob-client';
import axios from 'axios';

// --- CONFIG & UTILS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { SUPPORTED_ASSETS, MARKET_MODE } from './config.js';
import { startStrikeWorker } from './strike-worker.js';
import { fetchSignals, getSignalKey } from './signal-engine.js';
import { isSlotEntryTimeForbiddenNow, getSlotEntryTimingDetail } from './entryTiming.js';
import { atomicWriteJson, safeReadJson } from './src/core/persistence-layer.js';
import { getStrike, getBinanceStrike } from './src/core/strike-manager.js';

// --- ROBUSTNESS ---
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
process.on('uncaughtException', (err) => { if (err.code !== 'EPIPE') console.error('🔥 Critical Error:', err); });

// --- CONFIG ---
const SNIPER_DELTA_THRESHOLD_PCT = 0.10; 
const HEALTH_FILE = path.join(process.cwd(), 'health.json');
const POSITION_LOG = path.join(process.cwd(), 'active-positions.json');

// --- STATE ---
let clobClient = null;
let decisionFeed = [];
const MAX_FEED_SIZE = 50;
let userBalance = 0;
let memoryHealth = { dashboardMarketView: { status: 'waiting' } };

function updateHealth(data) {
    memoryHealth = { ...memoryHealth, ...data };
    const fullHealth = { 
        ...memoryHealth, 
        at: new Date().toISOString(),
        timestamp: Date.now(),
        totalUsd: userBalance,
        decisionFeed: decisionFeed,
        status: 'online' 
    };
    memoryHealth = fullHealth;
    atomicWriteJson(HEALTH_FILE, fullHealth);
}

// --- INITIALIZATION ---
async function init() {
    console.log("=== 🛡️  SNIPER BOT 2025: v16.3.0 ENGINE STARTING ===");
    
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env");

    const wallet = new ethers.Wallet(privateKey);
    clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
    
    console.log(`[Init] Wallet: ${wallet.address} - v16.3.0 READY`);

    startStrikeWorker();
    
    setInterval(mainLoop, 1000);
    setInterval(reportingLoop, 1000); // 1Hz Pulse
    
    console.log("[Init] Reporting Pulse (1Hz) & Loops connected");
}

async function reportingLoop() {
    try {
        const now = Date.now();
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);
        
        let startAudit = Date.now();
        
        // 1. Get Binance Context
        let bStrike = await getBinanceStrike('BTC', slotStart);
        const spotRes = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDC').catch(() => null);
        const bSpot = spotRes ? parseFloat(spotRes.data.price) : (memoryHealth.dashboardMarketView?.binanceSpot || 0);
        
        // v16.3.1: Precision Strike rounding for market lookup
        const effectiveStrike = bStrike ? Math.round(bStrike) : Math.round(bSpot);
        const bDeltaPct = effectiveStrike > 0 ? ((bSpot - effectiveStrike) / effectiveStrike) * 100 : 0;
        
        // 2. AGGRESSIVE DUAL DISCOVERY (v16.3.1)
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        const allBtcSignals = signalData.signals || [];
        
        let bestAskUp = 0;
        let bestAskDown = 0;

        // Scan all discovered markets to find BOTH sides using official Yes/No tokens
        for (const sig of allBtcSignals) {
            try {
                // Poll Yes (UP)
                if (sig.tokenIdYes) {
                    const mYes = await clobClient.getMarket(sig.tokenIdYes).catch(() => null);
                    if (mYes?.best_ask) bestAskUp = parseFloat(mYes.best_ask);
                }
                
                // Poll No (DOWN)
                if (sig.tokenIdNo) {
                    const mNo = await clobClient.getMarket(sig.tokenIdNo).catch(() => null);
                    if (mNo?.best_ask) bestAskDown = parseFloat(mNo.best_ask);
                }

                // If we found any price, we stop searching for this specific asset
                if (bestAskUp > 0 || bestAskDown > 0) break;
            } catch (e) {}
        }
        
        // Fallback for missing side: use signal cache if direct CLOB poll failed
        if (bestAskUp === 0 && allBtcSignals[0]?.priceUp) bestAskUp = allBtcSignals[0].priceUp;
        if (bestAskDown === 0 && allBtcSignals[0]?.priceDown) bestAskDown = allBtcSignals[0].priceDown;

        let endAudit = Date.now();
        
        updateHealth({ 
            dashboardMarketView: {
                asset: 'BTC',
                binanceSpot: bSpot,
                binanceStrike: effectiveStrike,
                binanceDeltaPct: bDeltaPct,
                bestAskUp,
                bestAskDown
            },
            sniperHUD: {
                btc: {
                    secondsLeft,
                    slotStart: new Date(slotStart).toISOString()
                }
            },
            sentinelMetrics: {
                networkLatency: endAudit - startAudit,
                cycleLatency: Date.now() - now,
                queryEngine: 'Alchemy/Unified'
            }
        });
        
    } catch (e) {
        console.error('[Reporting] v16.3.1 Loop Error:', e.message);
    }
}

async function mainLoop() {
    // Business logic placeholder - Trading engine continues standard 5m strategy
}

// === CONSOLIDATED v16.3.0 STATUS API ===
import { createServer as nodeCreateServer } from 'node:http';
const SNIPER_STATUS_PORT = 3001;

nodeCreateServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    if (req.url.split('?')[0] === '/api/bot-status') {
        const payload = {
            ...memoryHealth,
            status: 'online',
            timestamp: Date.now(),
            _v16_3_0: true
        };
        res.end(JSON.stringify(payload));
        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
}).listen(SNIPER_STATUS_PORT, '0.0.0.0', () => {
    console.log('v16.3.0 API listening on 3001');
});

init().catch(err => {
    console.error("💀 v16.3.0 FATAL:", err.message);
    process.exit(1);
});
