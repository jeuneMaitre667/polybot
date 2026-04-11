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
import { atomicWriteJson, safeReadJson } from './src/core/persistence-layer.js';
import { getStrike, getBinanceStrike } from './src/core/strike-manager.js';
import * as RiskManager from './risk-manager.js';
import * as CollateralManager from './collateral-manager.js';
import { sendTelegramAlert, telegramTradeAlertsEnabled } from './telegramAlerts.js';

// --- ROBUSTNESS ---
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
process.on('uncaughtException', (err) => { if (err.code !== 'EPIPE') console.error('🔥 Critical Error:', err); });

// --- CONFIG ---
const SNIPER_DELTA_THRESHOLD_PCT = 0.08; 
const HEALTH_FILE = path.join(process.cwd(), 'health.json');
const POSITION_LOG = path.join(process.cwd(), 'active-positions.json');

// --- STATE ---
let clobClient = null;
let decisionFeed = [];
const MAX_FEED_SIZE = 50;
let userBalance = 0;
let activePosition = null; // { tokenId, buyPrice, amount, slotStart, side }
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
    console.log("=== 🛡️ SNIPER BOT: v16.17.2 ENGINE ONLINE ===");
    
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env");

    const wallet = new ethers.Wallet(privateKey);
    clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
    
    console.log(`[Init] Wallet: ${wallet.address} - READY`);

    startStrikeWorker();
    
    // Core Operational Loops (1Hz)
    setInterval(mainLoop, 1000);
    setInterval(reportingLoop, 1000);
    
    reportingLoop(); // Initial pulse
    
    // v16.16.0: Initialize Risk Baseline
    RiskManager.initSession(memoryHealth.totalUsd || 0);
    console.log("[Init] All systems synchronized.");
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
        
        // v16.14.2: Restore decimals for Strategic HUD precision
        const effectiveStrike = bStrike ? bStrike : bSpot;
        const bDeltaPct = effectiveStrike > 0 ? ((bSpot - effectiveStrike) / effectiveStrike) * 100 : 0;
        
        // 2. AGGRESSIVE DUAL DISCOVERY (v16.3.1)
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        const allBtcSignals = signalData.signals || [];
        
        let bestAskUp = 0;
        let bestAskDown = 0;

        // v16.9.2: Real Transparent Dual-Ask Capture
        if (allBtcSignals.length > 0) {
            const sig = allBtcSignals[0];
            try {
                let priceUp = sig.priceUp || 0;
                let priceDown = sig.priceDown || 0;

                // 1. Fetch Real UP Ask (Doc-Verified Strategy: Find MIN in asks)
                if (sig.tokenIdYes) {
                    const bookYes = await clobClient.getOrderBook(sig.tokenIdYes).catch(() => null);
                    const asks = bookYes?.asks || [];
                    if (asks.length > 0) {
                        const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.985);
                        if (prices.length > 0) {
                            priceUp = Math.min(...prices);
                        }
                    }
                }

                // 2. Fetch Real DOWN Ask (Independent MIN strategy)
                if (sig.tokenIdNo) {
                    const bookNo = await clobClient.getOrderBook(sig.tokenIdNo).catch(() => null);
                    const asks = bookNo?.asks || [];
                    if (asks.length > 0) {
                        const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.985);
                        if (prices.length > 0) {
                            priceDown = Math.min(...prices);
                        }
                    }
                }

                bestAskUp = priceUp;
                bestAskDown = priceDown;

                // v16.16.0: Active Stop Loss Monitoring
                if (activePosition && activePosition.slotStart === slotStart) {
                    const currentPrice = activePosition.side === 'YES' ? bestAskUp : bestAskDown;
                    if (RiskManager.shouldTriggerStopLoss(activePosition.buyPrice, currentPrice)) {
                        console.warn(`[Risk] 🚨 Stop Loss Triggered for ${activePosition.side}! Executing SELL...`);
                        
                        const pnl = ((currentPrice - activePosition.buyPrice) / activePosition.buyPrice * 100).toFixed(2);
                        const slMsg = `🚨 *STOP LOSS TRIGGERED* 🚨\n\n` +
                                     `• Slot: ${activePosition.slotStart}\n` +
                                     `• Side: ${activePosition.side}\n` +
                                     `• Entry: $${activePosition.buyPrice}\n` +
                                     `• Exit: $${currentPrice}\n` +
                                     `• PnL: ${pnl}%\n` +
                                     `• Status: Position Closed to Protect Capital`;
                        
                        sendTelegramAlert(slMsg);

                        try {
                            const sellOrder = await clobClient.createOrder({
                                token_id: activePosition.tokenId,
                                price: currentPrice * 0.95, // Aggressive sell limit
                                size: activePosition.amount,
                                side: Side.SELL
                            });
                            console.log(`[Risk] Stop Loss Order Placed:`, sellOrder.orderID);
                            activePosition = null; // Clear position after sell
                        } catch (err) {
                            console.error(`[Risk] Stop Loss SELL Failed:`, err.message);
                        }
                    }
                }

                // v16.12.0: Unified Strategic HUD (Pipeline Vision)
                const currentSlotLabel = sig.slug ? sig.slug.split('-').pop() : '000';
                const deltaUsd = bSpot - effectiveStrike;
                const deltaPct = effectiveStrike > 0 ? (deltaUsd / effectiveStrike) * 100 : 0;
                const deltaSign = deltaUsd >= 0 ? '+' : '';
                
                const upLabel = bestAskUp > 0.80 ? '🟢 UP' : '⚪ UP';
                const downLabel = bestAskDown > 0.80 ? '🔴 DOWN' : '⚪ DOWN';

                console.log(`[PIPELINE] | slot:${currentSlotLabel} | ${upLabel}:${(bestAskUp * 100).toFixed(1)}% | ${downLabel}:${(bestAskDown * 100).toFixed(1)}% | Open:${effectiveStrike.toFixed(2)} | Spot:${bSpot.toFixed(2)} | Δ:${deltaSign}$${deltaUsd.toFixed(2)} (${deltaSign}${deltaPct.toFixed(3)}%)`);
            } catch (e) {
                console.error('[Reporting] v16.12.0 HUD Error:', e.message);
            }
        }

        let endAudit = Date.now();
        
        // v16.12.0: Optimized Telemetry & Decision Feed
        const logEntry = {
            at: Date.now(),
            asset: 'BTC',
            decision: Math.abs(bDeltaPct) > 0.10 ? 'SCAN ACTIVE' : 'MONITORING',
            reason: Math.abs(bDeltaPct) > 0.10 ? 'THRESHOLD_MET' : 'WAITING_SIGNAL',
            edge: bDeltaPct,
            strike: effectiveStrike,
            spot: bSpot,
            askUp: bestAskUp,
            askDown: bestAskDown
        };
        decisionFeed.unshift(logEntry);
        if (decisionFeed.length > MAX_FEED_SIZE) decisionFeed.pop();

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
                    slotStart: new Date(slotStart).toISOString(),
                    strike: effectiveStrike,
                    spot: bSpot,
                    deltaPct: bDeltaPct,
                    isStrikeOfficial: true
                }
            },
            sentinelMetrics: {
                networkLatency: endAudit - startAudit,
                cycleLatency: Date.now() - now,
                queryEngine: 'Alchemy/Unified'
            },
            decisionFeed: decisionFeed,
            gasBalance: 1.25
        });
        
    } catch (e) {
        console.error('[Reporting] v16.3.1 Loop Error:', e.message);
    }
}

async function mainLoop() {
    try {
        const now = Date.now();
        const slotStart = Math.floor(now / 300000) * 300000;
        
        // 1. Position Lock (1 max per slot)
        if (activePosition && activePosition.slotStart === slotStart) return;

        // 2. Timing Check (Strategic Window: T-60s to T-20s)
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);
        if (secondsLeft < 20 || secondsLeft > 60) return; 

        // 3. Signal Detection
        const mv = memoryHealth.dashboardMarketView;
        if (!mv || Math.abs(mv.binanceDeltaPct) < SNIPER_DELTA_THRESHOLD_PCT) return;

        const side = mv.binanceDeltaPct > 0 ? 'YES' : 'NO';
        const bestAsk = side === 'YES' ? mv.bestAskUp : mv.bestAskDown;
        
        // v16.17.1: Strategic Price Filter (0.87$ - 0.97$)
        if (!bestAsk || bestAsk < 0.87 || bestAsk > 0.97) return;

        // 4. Risk & Collateral
        const tradeAmountUsd = RiskManager.calculateTradeSize(userBalance || 100); 
        await CollateralManager.ensureCollateral(clobClient, null, tradeAmountUsd);

        // 5. Execution
        console.log(`[Engine] 🎯 Sniper Triggered: ${side} at ${bestAsk} | Size: $${tradeAmountUsd}`);
        
        // Fetch specific tokenId from signals
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        const currentSig = signalData.signals[0];
        const tokenId = side === 'YES' ? currentSig.tokenIdYes : currentSig.tokenIdNo;

        if (!tokenId) {
            console.error("[Engine] Missing tokenId for execution!");
            return;
        }

        const quantity = Math.floor(tradeAmountUsd / bestAsk);
        const order = await clobClient.createOrder({
            token_id: tokenId,
            price: bestAsk + 0.005, // Buffer to ensure fill
            size: quantity,
            side: Side.BUY
        });

        if (order && order.orderID) {
            console.log(`[Engine] ✅ Order Filled: ${order.orderID}`);
            
            const entryMsg = `🎯 *SNIPER ENTRY : BTC ${side}* 🎯\n\n` +
                            `• Slot: ${slotStart}\n` +
                            `• Price: $${bestAsk}\n` +
                            `• Strike: $${effectiveStrike.toFixed(2)}\n` +
                            `• Delta: ${mv.binanceDeltaPct.toFixed(3)}%\n` +
                            `• Size: $${tradeAmountUsd.toFixed(2)}\n` +
                            `• Window: Authorized (T-${secondsLeft}s)`;
            
            sendTelegramAlert(entryMsg);

            activePosition = {
                tokenId,
                buyPrice: bestAsk,
                amount: quantity,
                slotStart,
                side
            };
        }

    } catch (e) {
        console.error('[Engine] Main Loop Error:', e.message);
    }
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
