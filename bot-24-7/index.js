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
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';

// --- CONFIG & UTILS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { SUPPORTED_ASSETS, MARKET_MODE } from './config.js';
import { startStrikeWorker } from './strike-worker.js';
import { fetchSignals, getSignalKey } from './signal-engine.js';
import { atomicWriteJson, safeReadJson, runAtomicUpdate } from './src/core/persistence-layer.js';
import { getStrike, getBinanceStrike } from './src/core/strike-manager.js';
import * as RiskManager from './risk-manager.js';
import * as CollateralManager from './collateral-manager.js';
import * as SLSentinel from './sl-sentinel.js';
import * as Analytics from './analytics-engine.js';
import { sendTelegramAlert, telegramTradeAlertsEnabled, telegramMiddayDigestEnabled } from './telegramAlerts.js';
import { getVirtualBalance, updateVirtualBalance } from './src/core/virtual-wallet.js'; // v17.36.0
import { 
    computeMiddayDigestStats, 
    getMidnightToNoonWindowMs, 
    getNoonToMidnightWindowMs, 
    getFullDayWindowMs, 
    formatMiddayDigestMessage,
    getCalendarDateYmd,
    getLocalHourMinute
} from './middayDigest.js';
import { timeKeeper } from './src/core/ntp-client.js'; // v17.52.0: Software NTP Sync

// --- ROBUSTNESS ---
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
process.on('uncaughtException', (err) => { if (err.code !== 'EPIPE') console.error('🔥 Critical Error:', err); });

// --- CONFIG ---
// ---// v17.56.0: Removed fixed VIRTUAL_BALANCE constant in favor of dynamic getVirtualBalance()
const SNIPER_DELTA_THRESHOLD_PCT = parseFloat(process.env.SNIPER_DELTA_THRESHOLD_PCT || "0.08"); 
const SNIPER_WINDOW_START = parseInt(process.env.SNIPER_WINDOW_START_S || "90");
const SNIPER_WINDOW_END = parseInt(process.env.SNIPER_WINDOW_END_S || "30");
const SNIPER_PRICE_MIN = parseFloat(process.env.SNIPER_PRICE_MIN || "0.87");
const SNIPER_PRICE_MAX = parseFloat(process.env.SNIPER_PRICE_MAX || "0.97");
const IS_SIMULATION_ENABLED = (process.env.SIMULATION_TRADE_ENABLED || '').trim() === 'true';
const BALANCE_REFRESH_MS = parseInt(process.env.BALANCE_REFRESH_MS || "45000");
const PRIMARY_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const FAILOVER_RPC = process.env.POLYGON_RPC_URL_FAILOVER || 'https://rpc.ankr.com/polygon';
const VIRTUAL_BALANCE = parseFloat(process.env.VIRTUAL_BALANCE || "1000"); // v17.35.0

const HEALTH_FILE = path.join(__dirname, 'health-v17.json');
const POSITION_LOG = path.join(__dirname, 'active-positions.json');
const HEARTBEAT_FILE = path.join(__dirname, 'heartbeat.json'); // v17.51.0: Heartbeat for watchdog
const LAST_TRADE_FILE = path.join(__dirname, 'last-trade.json'); // v17.54.0: Total persistence

const CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const USDC_E_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
];
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// --- STATE ---
let lastExecutedSlot = 0; // Track slot to avoid spamming multiple triggers per 5m
let lastExecutedCid = null;
let lastResolvedCids = new Set(); // Track resolved markets to avoid double alerts
let lastDigestDate = ''; // YYYY-MM-DD
let lastDigestWindow = ''; // 'morning' | 'night'
let clobClient = null;
let decisionFeed = [];
const MAX_FEED_SIZE = 50;
let userBalance = null; // v17.7.0: Null-Init to avoid sending 0 before first fetch
let maticBalance = null; 
let wallet = null; // v16.21.1: Global scope fix
let activePosition = null; // { tokenId, buyPrice, amount, slotStart, side }
let lastPulseTime = Date.now(); // v17.24.0: For Watchdog monitoring
let lastHeartbeatSlot = 0; // v17.60.0: Unique alert per 5m slot
let lastBalanceFetchTime = 0; // v17.80.0: Alchemy CU Optimization
let memoryHealth = { dashboardMarketView: { status: 'waiting' } };
let riskSessionInitialized = false; // v17.70.0: Track RiskManager baseline

function updateHealth(data) {
    memoryHealth = { ...memoryHealth, ...data };
    
    // v17.7.0: Atomic Balance Guard
    const displayBalance = userBalance !== null ? userBalance : (memoryHealth.totalUsd || 0);

    const fullHealth = { 
        ...memoryHealth, 
        dashboardMarketView: data.dashboardMarketView || memoryHealth.dashboardMarketView || null, // v17.10.0: Forced Visibility
        at: new Date().toISOString(),
        timestamp: Date.now(),
        totalUsd: displayBalance,
        balanceUsd: displayBalance, // Sync second alias
        decisionFeed: decisionFeed,
        status: 'online',
        version: 'v17.7.0' // Traceability badge
    };
    memoryHealth = fullHealth;
    atomicWriteJson(HEALTH_FILE, fullHealth);
}

// v17.46.7: Atomic sequence for positions
function loadActivePositions() {
    return safeReadJson(POSITION_LOG, []);
}

async function saveActivePositions(positions) {
    return runAtomicUpdate(POSITION_LOG, () => {
        return positions;
    });
}

async function addPosition(pos) {
    return runAtomicUpdate(POSITION_LOG, (list = []) => {
        list.push(pos);
        return list;
    });
}

/**
 * checkFastResolution(currentPrice)
 * v17.36.85: Zero-latency local resolution for fast compounding.
 * Releases simulated funds as soon as the slot ends.
 */
async function checkFastResolution(currentPrice) {
    if (!IS_SIMULATION_ENABLED) return;
    
    const positions = loadActivePositions();
    if (positions.length === 0) return;
    
    const now = Date.now();
    let changed = false;
    
    for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        if (!pos.isSimulated || !pos.slotEnd || !pos.strike) continue;
        
        // Fast resolution window: End reached + 2s margin
        if (now > pos.slotEnd + 2000) {
            // v17.59.1: Aggressive fallback -> Use saved strike immediately if official is late
            const usedStrike = pos.officialStrike || pos.strike;
            const isUp = currentPrice >= usedStrike;
            const winningSide = isUp ? 'YES' : 'NO';
            const isWin = pos.side === winningSide;
            
            const strikeSource = pos.officialStrike ? 'OFFICIAL' : 'LOCAL-SNAPSHOT';
            console.log(`[FastResolution] 🏁 Resolving ${pos.slug} | Source:${strikeSource} | Strike:${usedStrike} | FinalPrice:${currentPrice} | Result:${isWin ? 'WIN' : 'LOSS'}`);
            
            if (isWin) {
                const payout = pos.amount;
                const profitNet = payout - (pos.buyPrice * pos.amount);
                const result = await updateVirtualBalance(payout);
                const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                
                console.log(`[FastResolution] 🏆 Compound Boost: +$${profitNet.toFixed(2)} | Capital Released: $${finalBal.toFixed(2)}`);
                await sendTelegramAlert(`🟢 *FAST COMPOUND* 💰\n\n• Profit: +$${profitNet.toFixed(2)} 💹\n• Solde actuel: $${finalBal.toFixed(2)} 💵\n• Source: ${strikeSource} ⚙️`);
            } else {
                const result = await getVirtualBalance();
                const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                console.log(`[FastResolution] 🔴 Capital Fixed. Balance: $${finalBal.toFixed(2)}`);
                await sendTelegramAlert(`🛑 *FAST LOSS* 💀\n• Solde fixe: $${finalBal.toFixed(2)} 💵\n• Source: ${strikeSource} ⚙️`);
            }
            
            lastResolvedCids.add(pos.tokenId);
            positions.splice(i, 1);
            changed = true;
        }
    }
    
    if (changed) {
        saveActivePositions(positions);
        // Refresh local activePosition state if it was the one we just resolved
        if (activePosition && !positions.find(p => p.tokenId === activePosition.tokenId)) {
            activePosition = null;
        }
    }
}

/**
 * v17.75.0: Self-Healing Wallet Validator
 * Ensures the CLOB client is fully initialized with a valid wallet address.
 */
async function ensureClobClient() {
    try {
        if (!wallet || !wallet.address) {
            const pk = process.env.PRIVATE_KEY;
            if (!pk) throw new Error("PRIVATE_KEY missing for self-healing");
            wallet = new ethers.Wallet(pk);
        }

        if (!clobClient) {
            // v18.0.0: Strict Type Enforcement for Signature Type
            let sigTypeRaw = process.env.CLOB_SIGNATURE_TYPE;
            let sigType = 0; // Default to EOA
            
            if (sigTypeRaw === "1" || sigTypeRaw === "POLY_PROXY") {
                sigType = 1;
            } else if (sigTypeRaw === "2" || sigTypeRaw === "POLY_GNOSIS_SAFE") {
                sigType = 2;
            }

            const funderAddr = (process.env.CLOB_FUNDER_ADDRESS || wallet.address).trim();
            
            console.log(`[Audit] 🛡️ Initializing CLOB Client:`);
            console.log(`[Audit] • Signer EOA: ${wallet.address}`);
            console.log(`[Audit] • Funder: ${funderAddr}`);
            console.log(`[Audit] • SigType: ${sigType} (${sigType === 1 ? 'Proxy' : 'EOA'})`);

            // v21.2.0: Derive API credentials (required for createAndPostOrder)
            const tempClient = new ClobClient("https://clob.polymarket.com", 137, wallet, undefined, sigType, funderAddr);
            let apiCreds;
            try {
                apiCreds = await tempClient.deriveApiKey();
                console.log(`[Audit] • API Key derived: ${apiCreds.key ? apiCreds.key.substring(0, 8) + '...' : 'FAIL'}`);
            } catch (deriveErr) {
                console.warn(`[Audit] ⚠️ deriveApiKey failed: ${deriveErr.message}. Trying createOrDeriveApiKey...`);
                try {
                    apiCreds = await tempClient.createOrDeriveApiKey();
                    console.log(`[Audit] • API Key created: ${apiCreds.key ? apiCreds.key.substring(0, 8) + '...' : 'FAIL'}`);
                } catch (createErr) {
                    console.error(`[Audit] ❌ All API key methods failed: ${createErr.message}`);
                    throw createErr;
                }
            }

            clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet, apiCreds, sigType, funderAddr);
            console.log(`[Self-Healing] ✅ ClobClient initialized with API credentials`);
        }
        return true;
    } catch (err) {
        console.error(`[Self-Healing] ❌ FAILED to restore wallet:`, err.message);
        return false;
    }
}

// --- INITIALIZATION ---
async function init() {
    console.log("=== 🛡️ SNIPER BOT: v16.17.2 ENGINE ONLINE ===");
    
    // v17.16.0: Initial Heartbeat Pulse (Eliminate Dashboard Skeletons)
    updateHealth({ status: 'starting', sniperHUD: 'INITIALIZING...' });

    // v17.36.0: Initialize RiskManager with Virtual or Real Balance
    const initialBal = IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance || 0);
    RiskManager.initSession(initialBal);
    console.log(`[Init] 🏆 Risk Strategy: ${IS_SIMULATION_ENABLED ? 'LAB (Virtual $'+initialBal+')' : 'LIVE (Real)'}`);

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env");

    const success = await ensureClobClient();
    if (!success) throw new Error("CRITICAL: Failed to initialize wallet client");
    
    console.log(`[Init] Wallet: ${wallet.address} - READY`);

    startStrikeWorker();
    
    // Core Operational Loops (1Hz)
    setInterval(mainLoop, 1000);
    setInterval(reportingLoop, 1000);
    setInterval(performanceLoop, 60000); // Check every minute for resolution/digest
    
    // Initial triggers
    mainLoop();
    reportingLoop();
    
    // v17.24.0: Stability Watchdog (Reset engine if it hangs for > 60s)
    setInterval(() => {
        const stallTime = Date.now() - lastPulseTime;
        if (stallTime > 60000) {
            console.error(`[Watchdog] 💀 SILENT HANG DETECTED (${Math.floor(stallTime/1000)}s). Restarting...`);
            process.exit(1); // PM2 or Shell will restart it
        }
    }, 10000);
    
    // v16.16.0: Initialize Risk Baseline
    RiskManager.initSession(memoryHealth.totalUsd || 0);
    console.log("[Init] All systems synchronized.");
}


// v17.22.0: Unified Market Context (Synchronized Decision Logic)
async function getUnifiedMarketState(asset = 'BTC') {
    const now = Date.now();
    const slotStart = Math.floor(now / 300000) * 300000;
    
    // 1. Fetch Binance Spot (Current) - v17.24.0: Added Timeout
    const spotRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDC`, { timeout: 5000 }).catch(() => null);
    const bSpot = spotRes ? parseFloat(spotRes.data.price) : (memoryHealth.dashboardMarketView?.binanceSpot || 0);
    
    // 2. Fetch or Backfill Strike
    let bStrike = await getBinanceStrike(asset, slotStart);
    const source = bStrike ? 'OFFICIAL' : 'MISSING';
    const effectiveStrike = bStrike; // v20.2.0: NEVER fallback to bSpot (prevents Delta 0% error)
    
    // 3. Calculate Delta
    let bDeltaPct = 0;
    if (effectiveStrike && effectiveStrike > 0 && bSpot > 0) {
        bDeltaPct = ((bSpot - effectiveStrike) / effectiveStrike) * 100;
    } else {
        if (now % 60000 < 1000) console.warn(`[Lookup] ⚠️ Strike missing for ${asset} at ${slotStart}. Delta calculation suspended.`);
    }
    
    return {
        asset,
        slotStart,
        bSpot,
        effectiveStrike,
        bDeltaPct,
        source,
        timestamp: now
    };
}

async function reportingLoop() {

    try {
        const now = Date.now();
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);
        
        let startAudit = Date.now();
        
        // 0. Fetch Real Blockchain Balance (v17.85.0: Ethers v5 syntax)
        if (now - lastBalanceFetchTime > BALANCE_REFRESH_MS || userBalance === null) {
            try {
                const rpcUrl = (userBalance === null) ? PRIMARY_RPC : FAILOVER_RPC;
                const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, 137);
                const usdc = new ethers.Contract(USDC_E_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
                
                const [usdcRaw, maticRaw] = await Promise.all([
                    usdc.balanceOf(process.env.CLOB_FUNDER_ADDRESS || wallet.address),
                    provider.getBalance(wallet.address)
                ]);

                userBalance = parseFloat(ethers.utils.formatUnits(usdcRaw, 6));
                maticBalance = parseFloat(ethers.utils.formatEther(maticRaw));
                lastBalanceFetchTime = now;

                // v17.70.0: Initialize Risk Baseline on FIRST successful balance fetch
                if (!riskSessionInitialized && userBalance !== null) {
                    RiskManager.initSession(IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance);
                    riskSessionInitialized = true;
                    console.log(`[Risk] 💎 Session Baseline Locked: $${(IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance).toFixed(2)}`);
                }
            } catch (err) {
                console.error('[Reporting] v17.80.0 RPC Error (Switching...):', err.message);
                // On next loop it will try again, possibly with null catch-all
            }
        }

        // 1. Get Unified Market State (v17.22.0 Sync)
        const marketState = await getUnifiedMarketState('BTC');
        const { bSpot, effectiveStrike, bDeltaPct, source } = marketState;

        // v17.20.0: Aggressive Pure Binance Strategy logic remains identical but now uses marketState

        
        // 2. AGGRESSIVE DUAL DISCOVERY
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        const allBtcSignals = signalData.signals || [];
        
        let bestAskUp = 0;
        let bestAskDown = 0;

        // v17.25.0: Strict Reporting Guard (Ensure we only show data for the CURRENT slot)
        const currentSlotSec = Math.floor(slotStart / 1000);
        const sig = allBtcSignals.find(s => s.slug && s.slug.endsWith(String(currentSlotSec)));

        if (sig) {
            try {
                let priceUp = 0;
                let priceDown = 0;

                // 1. Fetch Real UP Ask
                if (sig.tokenIdYes) {
                    const bookYes = await clobClient.getOrderBook(sig.tokenIdYes).catch(() => null);
                    const asks = bookYes?.asks || [];
                    if (asks.length > 0) {
                        const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
                        if (prices.length > 0) priceUp = Math.min(...prices);
                    }
                }

                // 2. Fetch Real DOWN Ask
                if (sig.tokenIdNo) {
                    const bookNo = await clobClient.getOrderBook(sig.tokenIdNo).catch(() => null);
                    const asks = bookNo?.asks || [];
                    if (asks.length > 0) {
                        const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
                        if (prices.length > 0) priceDown = Math.min(...prices);
                    }
                }

                // v17.3.5: Extreme Price Calibration (Cross-Inference)
                // If one side has 0 liquidity but the other is extremely cheap, infer the expensive side
                if (priceUp > 0 && priceUp < 0.05 && priceDown === 0) priceDown = 0.99;
                if (priceDown > 0 && priceDown < 0.05 && priceUp === 0) priceUp = 0.99;
                
                // Final fallback only if both are empty (unlikely during active slot)
                bestAskUp = priceUp || sig.priceUp || 0.5;
                bestAskDown = priceDown || sig.priceDown || 0.5;

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
                
                // v17.57.0: Unified Actionable Signals (Prob + Delta consistency)
                const isDeltaMet = Math.abs(deltaPct) >= SNIPER_DELTA_THRESHOLD_PCT;
                const upLabel = (bestAskUp > 0.80 && isDeltaMet && deltaPct > 0) ? '🟢 UP' : '⚪ UP';
                const downLabel = (bestAskDown > 0.80 && isDeltaMet && deltaPct < 0) ? '🔴 DOWN' : '⚪ DOWN';

                const displayBalance = IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance;
                
                // v17.39.12: Continuous Double-Strike TÃ©lÃ©mÃ©try
                // Prioritize active position strike, fallback to lookup, then signal's internal value
                let polyStrike = activePosition?.officialStrike;
                if (!polyStrike) {
                    // Check local cache
                    polyStrike = getStrike('BTC', currentSlotSec);
                }
                if (!polyStrike && sig?.m?.eventMetadata?.priceToBeat) {
                    // v17.39.12: Direct extraction from fresh signal metadata
                    polyStrike = Number(sig.m.eventMetadata.priceToBeat);
                }
                const officialLabel = polyStrike ? `(Poly:${polyStrike.toFixed(2)})` : '';
                
                console.log(`[PIPELINE] | slot:${currentSlotLabel} | ${upLabel}:${(bestAskUp * 100).toFixed(1)}% | ${downLabel}:${(bestAskDown * 100).toFixed(1)}% | Bal:$${displayBalance.toFixed(2)} | Open:${effectiveStrike.toFixed(2)}${officialLabel} | Spot:${bSpot.toFixed(2)} | Δ:${deltaSign}$${deltaUsd.toFixed(2)} (${deltaSign}${deltaPct.toFixed(3)}%)`);
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

        const stats = Analytics.computePerformanceStats();

        updateHealth({ 
            dashboardMarketView: {
                asset: 'BTC',
                binanceSpot: bSpot,
                binanceStrike: effectiveStrike,
                binanceDeltaPct: bDeltaPct,
                strikeSource: source, // v17.22.0: New source tag
                bestAskUp,
                bestAskDown,
                // v17.7.0: Legacy Compatibility Aliases (Wake-up call for old UI)
                priceUp: bestAskUp,
                priceDown: bestAskDown,
                variationPct: bDeltaPct,
                thresholdPct: SNIPER_DELTA_THRESHOLD_PCT // v17.22.0: Dynamic threshold for UI
            },
            performance: stats,
            sniperHUD: {
                btc: {
                    secondsLeft,
                    slotStart: new Date(slotStart).toISOString(),
                    strike: effectiveStrike,
                    spot: bSpot,
                    deltaPct: bDeltaPct,
                    isStrikeOfficial: source === 'OFFICIAL'
                }
            },
            currentSlot: slotStart,
            wsConnected: SLSentinel.isConnected(),
            sentinelMetrics: {
                networkLatency: endAudit - startAudit,
                cycleLatency: Date.now() - now,
                queryEngine: 'Alchemy/Unified'
            },
            decisionFeed: decisionFeed,
            gasBalance: maticBalance !== null ? maticBalance.toFixed(4) : "---"
        });
    } catch (e) {
        console.error('[Reporting] v16.3.1 Loop Error:', e.message);
    }
}

async function mainLoop() {
    const cycleStart = Date.now();
    let order = null; // v17.62.9: Global scope for the entire loop
    try {
        // v17.61.0: INDEPENDENT REAL-TIME HEARTBEAT (Bypass NTP Lag)
        const hbNow = Date.now();
        const slotStartLocal = Math.floor(hbNow / 300000) * 300000;
        const hbSecondsLeft = Math.floor((slotStartLocal + 300000 - hbNow) / 1000);
        const displayTime = new Date(hbNow).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        if (hbSecondsLeft <= 90 && hbSecondsLeft >= 10 && lastHeartbeatSlot !== slotStartLocal) {
            lastHeartbeatSlot = slotStartLocal; // Lock immediately
            console.log(`[PID:${process.pid}] [Telegram] Indep-Heartbeat Triggered (T-${hbSecondsLeft}s)`);
            
            const currentBal = (IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance || 0));
            const hbMsg = `🛰️ *SNIPER STATUS : ${displayTime}*\n\n` +
                          `• Window: OPEN ✅\n` +
                          `• Capital: $${currentBal.toFixed(2)} 🏦\n` +
                          `• Engine: READY ⚡`;
            
            const token = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
            const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();
            const url = `https://api.telegram.org/bot${token}/sendMessage`;

            axios.post(url, { chat_id: chatId, text: hbMsg, disable_web_page_preview: true }, { timeout: 10000 })
                .then(() => console.log(`[Telegram] Indep-Heartbeat Success.`))
                .catch(hErr => console.error('[Telegram] Indep-Heartbeat Failed:', hErr.message));
        }

        const now = timeKeeper.getNow();
        lastPulseTime = now;
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);

        // v17.51.0: Physical Heartbeat for PM2 Watchdog
        try {
            fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ timestamp: now, version: 'v17.61.1' }));
        } catch (e) {
            console.error('[Heartbeat] Write failed:', e.message);
        }
        
        // v17.59.0: Ultra-High-Priority Resolution (Compound Engine)
        const marketState = await getUnifiedMarketState('BTC');
        if (IS_SIMULATION_ENABLED && marketState) {
            await checkFastResolution(marketState.bSpot);
        }
        const mv = marketState;

        // v17.22.17: Revert to START-time slot convention (Math.floor)
        // Variables slotStart et secondsLeft déjà définies au sommet du loop
        // mv déjà défini au sommet du loop
        // v17.44.1: Persistent Slot Lock (v17.54.0 Expanded)
        if (lastExecutedSlot === slotStart) return;
        
        const alreadyDone = (() => {
            try {
                if (fs.existsSync(LAST_TRADE_FILE)) {
                    const last = JSON.parse(fs.readFileSync(LAST_TRADE_FILE, 'utf8'));
                    if (last.slot === slotStart) return true;
                }
            } catch (e) {}
            // Level 2: check active positions just in case
            return loadActivePositions().some(p => p.slotStart === slotStart);
        })();

        if (alreadyDone) {
            lastExecutedSlot = slotStart; // Sync memory
            return;
        }

        // 2. Timing Check (Dynamic Window: T-start to T-end)

        if (secondsLeft < SNIPER_WINDOW_END || secondsLeft > SNIPER_WINDOW_START) {
            if (now % 30000 < 1000) { // Periodic log only (every 30s) to avoid log spam
                console.log(`[Engine] Skip: Timing window closed (T-${secondsLeft}s)`);
            }
            return; 
        }

        // 3. Unified Decision Path (v17.22.0)
        // Fresh context check already done at top of loop for resolution
        
        if (Math.abs(mv.bDeltaPct) < SNIPER_DELTA_THRESHOLD_PCT) {
            if (secondsLeft % 30 === 0) {
                console.log(`[PID:${process.pid}] [Engine] Pulse: Monitoring BTC (Delta: ${mv.bDeltaPct.toFixed(3)}% | Target: ${SNIPER_DELTA_THRESHOLD_PCT}%)`);
            }
            return;
        }

        const bDeltaPct = mv.bDeltaPct; // Local variable for logging
        const side = bDeltaPct > 0 ? 'YES' : 'NO';
        
        // v17.22.13: FORCED REAL-TIME DEPTH (Eliminate 3s Health-Sync Lag)
        // D'Ã¨s que le signal Binance est bon, on va chercher le prix REEL sur l'Orderbook
        console.log(`[Engine] 🔍 Binance Signal Met (${bDeltaPct.toFixed(3)}%). Checking Polymarket Depth for ${side}...`);
        
        // Fetch specific tokenId from signals
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        
        // v17.25.0: Strict Slot Matching (REMOVED unsafe fallback to ensure zero "Invalid token id" errors)
        const currentSlotSec = Math.floor(slotStart / 1000);
        const currentSig = signalData.signals.find(s => s.slug && s.slug.endsWith(String(currentSlotSec)));
        
        if (!currentSig) {
            if (now % 30000 < 1000) {
                console.warn(`[Engine] Skip: Target market (slug ends with ${currentSlotSec}) not published yet by Polymarket.`);
            }
            return;
        }

        const tokenId = side === 'YES' ? currentSig.tokenIdYes : currentSig.tokenIdNo;
        
        // v17.22.15: Strict Token Validation
        if (!tokenId || String(tokenId).length < 20 || !/^\d+$/.test(String(tokenId))) {
            console.error(`[Engine] ❌ CRITICAL: Invalid Token ID detected for ${side}: "${tokenId}" (Market: ${currentSig?.slug || 'Unknown'})`);
            return;
        }

        // v17.22.22: Dual-Source Price Discovery (Realtime Orderbook + Gamma Fallback)
        let bestAsk = 0;
        try {
            const book = await clobClient.getOrderBook(tokenId).catch(() => null);
            const asks = book?.asks || [];
            if (asks.length > 0) {
                const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
                if (prices.length > 0) bestAsk = Math.min(...prices);
            }
        } catch (err) {
            console.error(`[Engine] CLOB Orderbook error for ${tokenId}:`, err.message);
        }

        // Fallback to Gamma Price if Orderbook is empty (prevents missing trades due to API lag)
        if (bestAsk === 0) {
            const gammaPrice = side === 'YES' ? parseFloat(currentSig.priceYes || 0) : parseFloat(currentSig.priceNo || 0);
            if (gammaPrice > 0) {
                console.log(`[Engine] ⚠️ Orderbook empty. Using Gamma Fallback: $${gammaPrice}`);
                bestAsk = gammaPrice;
            }
        }

        // v16.17.1: Dynamic Price Filter
        if (!bestAsk || bestAsk < SNIPER_PRICE_MIN || bestAsk > SNIPER_PRICE_MAX) {
            console.warn(`[Engine] Skip: Price outside range ($${bestAsk} for ${side})`);
            return;
        }

        // v17.75.0: Final Wallet Integrity Check relative to current tir
        if (!(await ensureClobClient())) {
            console.error("[Engine] ❌ SKIP: Wallet not ready despite self-healing attempt.");
            sendTelegramAlert("🚨 *WALLET ERROR*: Sniper skipped trade due to client amnesia.");
            return;
        }

        // 4. Risk & Collateral
        const baseBalance = IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance || 0);
        let tradeAmountUsd = RiskManager.calculateTradeSize(baseBalance); 
        
        // v17.0.4: Hard-cap safety (never trade more than actual USDC balance - 0.10 buffer)
        const safetyFactor = 0.98; // Leave a tiny bit for precision safety
        const availableMax = IS_SIMULATION_ENABLED ? getVirtualBalance() : Math.max(0, (userBalance || 0) * safetyFactor);
        
        if (tradeAmountUsd > availableMax) {
            console.log(`[Risk] Capping trade size from $${tradeAmountUsd.toFixed(2)} to $${availableMax.toFixed(2)} due to balance limits.`);
            tradeAmountUsd = availableMax;
        }

        if (tradeAmountUsd < 1.0) {
            console.warn(`[Engine] Skip: Balance too low even for minimum trade ($${baseBalance.toFixed(2)})`);
            return;
        }

        if (!IS_SIMULATION_ENABLED) {
            await CollateralManager.ensureCollateral(clobClient, null, tradeAmountUsd);
        }

        // 5. Execution
        console.log(`[Engine] 🎯 Sniper Triggered: ${side} at ${bestAsk} | Size: $${tradeAmountUsd.toFixed(2)} | Balance: $${userBalance?.toFixed(2)}`);
        
        // v17.29.5: High visibility on target market expiration
        console.log(`[Engine] 🛡️ Execution ID: ${tokenId} | Market: ${currentSig.slug} | Ends: ${currentSig.m?.endDate} | Side: ${side}`);

        const quantity = Math.floor(tradeAmountUsd / bestAsk);
        
        // Mark slot as processed (v17.54.0 Persistent)
        lastExecutedSlot = slotStart;
        try {
            fs.writeFileSync(LAST_TRADE_FILE, JSON.stringify({ slot: slotStart, time: new Date().toISOString() }));
        } catch (e) {}

        if (IS_SIMULATION_ENABLED) {
            // ... (simulation logic same)
            const totalLatency = Date.now() - cycleStart;
            console.log(`[Engine] 🧪 SIMULATION: Order placed | Latency: ${totalLatency}ms`);
            const currentSimBal = getVirtualBalance();
            const simEntryMsg = `🧪 *SIMULATION ENTRY : BTC ${side}* 🎯\n\n` +
                                `• Side: ${side} 🏹\n` +
                                `• Price: $${bestAsk} 💵\n` +
                                `• Size: -$${tradeAmountUsd.toFixed(2)} 💸\n` +
                                `• Capital: $${currentSimBal.toFixed(2)} 🏦`;
            try { await sendTelegramAlert(simEntryMsg); } catch (e) {}
        } else {
            const startExec = Date.now();
            let order = null;
            try {
                // v18.0.0: Atomic check for NaN before sending to SDK
                const safePrice = Number(bestAsk) + 0.005;
                const safeQty = Math.floor(Number(quantity));

                if (isNaN(safePrice) || isNaN(safeQty) || safeQty <= 0 || !isFinite(safePrice)) {
                    throw new Error(`CRITICAL: NaN detected in order math! Price=${safePrice}, Qty=${safeQty}`);
                }

                const orderData = {
                    tokenID: String(tokenId).trim(),
                    price: Number(safePrice.toFixed(6)), // MUST BE NUMBER
                    size: Number(safeQty),              // MUST BE NUMBER
                    side: Side.BUY
                };

                // Final verification of orderData to prevent any hidden NaN objects
                for (const [key, val] of Object.entries(orderData)) {
                    if (val === "NaN" || val === "undefined" || (typeof val === 'number' && isNaN(val))) {
                        throw new Error(`CRITICAL: Invalid ${typeof val} detected in order ${key}: ${val}`);
                    }
                }

                console.log(`[Engine] 📡 SDK EXECUTION (v21.0.0 createAndPostOrder): Sending ${JSON.stringify(orderData)}`);
                order = await clobClient.createAndPostOrder(
                    orderData,
                    { tickSize: "0.01", negRisk: false },
                    OrderType.GTC
                );
                
                const latency = Date.now() - startExec;
                console.log(`[Engine] ✅ Order POSTED: ${JSON.stringify(order)} | Latency: ${latency}ms`);
            } catch (err) {
                console.error(`[Engine] ❌ RELAYER EXECUTION FAILED:`, err.message);
                sendTelegramAlert(`🚨 *EXECUTION ERROR*\nTrade failed for ${side}: ${err.message}`);
                return; // Stop here
            }
            
            // currentOrder reflects 'order' if it was submitted
        }

        // --- COMMON STATE TRACKING (v20.4.0: Accept any non-null order response) ---
        if (IS_SIMULATION_ENABLED || (order && typeof order === 'object')) {
            // v17.38.2: Non-blocking fetch of Official Strike (Background)
            fetchStrikeFromPolymarket('BTC', slotStart).then(os => {
                if (os && activePosition && activePosition.slotStart === slotStart) {
                    activePosition.officialStrike = os;
                    const list = loadActivePositions();
                    const idx = list.findIndex(p => p.tokenId === activePosition.tokenId);
                    if (idx !== -1) {
                        list[idx].officialStrike = os;
                        saveActivePositions(list);
                        console.log(`[Engine] 🎯 Official Strike Updated: ${os}`);
                    }
                }
            });

            activePosition = {
                tokenId,
                conditionId: currentSig.conditionId,
                buyPrice: bestAsk,
                strike: currentSig.strike, // Binance reference (Signal)
                officialStrike: currentSig.strike, // Temp fallback
                amount: quantity,
                slotStart,
                side,
                asset: 'BTC',
                slug: currentSig.slug,
                slotEnd: slotStart + 300000,
                isSimulated: IS_SIMULATION_ENABLED
            };

            // v17.42.3: SAVE POSITION FIRST (Transactional Safety)
            await addPosition(activePosition);

            // v17.58.0: Send Telegram FIRST to ensure delivery even if balance calculation crashes
            const totalLatency = Date.now() - cycleStart;
            if (IS_SIMULATION_ENABLED) {
                const simEntryMsg = `🧪 *SIMULATION ENTRY : BTC ${side}* 🧪\n\n` +
                                    `• Price: $${bestAsk}\n• Latency: ${totalLatency}ms\n• Size: $${tradeAmountUsd.toFixed(2)}`;
                sendTelegramAlert(simEntryMsg);
                
                // Then update balance and log it
                const result = await updateVirtualBalance(-tradeAmountUsd);
                const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                console.log(`[Engine] 🧪 SIMULATION: Order placed | New Bal: $${finalBal.toFixed(2)}`);
            } else {
                const entryMsg = `🎯 *SNIPER ENTRY : BTC ${side}* 🎯\n\n` +
                                `• Price: $${bestAsk}\n• Size: $${tradeAmountUsd.toFixed(2)}`;
                sendTelegramAlert(entryMsg);
            }

            // v17.1.0: Launch Stop Loss Sentinel
            const stopLossPct = parseFloat(process.env.STOP_LOSS_PCT || "0.10"); // Locked at 10%
            SLSentinel.startMonitoring(
                tokenId, 
                bestAsk, 
                side, 
                stopLossPct, 
                async (info) => {
                    await executeEmergencyExit(info);
                }
            );
        }

    } catch (e) {
        console.error('[Engine] Main Loop Error:', e.message);
    }
}

/**
 * Sentinel Loop (v16.19.0)
 * Gère les résumés de 12h et détecte les marchés résolus (Redeems).
 */
async function performanceLoop() {
    const tz = process.env.TELEGRAM_MIDDAY_DIGEST_TZ || 'Europe/Paris';
    const { hour, minute } = getLocalHourMinute(tz);
    const dateStr = getCalendarDateYmd(tz);

    // --- 📊 12H DIGEST SCHEDULER ---
    if (telegramMiddayDigestEnabled()) {
        let window = null;
        let windowName = '';

        // Midi (12:00 - 12:15)
        if (hour === 12 && minute < 15 && (lastDigestDate !== dateStr || lastDigestWindow !== 'morning')) {
            window = getMidnightToNoonWindowMs(tz, dateStr);
            windowName = 'Matin';
            lastDigestWindow = 'morning';
            lastDigestDate = dateStr;
        }
        // Minuit (00:00 - 00:15)
        else if (hour === 0 && minute < 15 && (lastDigestDate !== dateStr || lastDigestWindow !== 'night')) {
            window = getNoonToMidnightWindowMs(tz, dateStr);
            windowName = 'Soir';
            lastDigestWindow = 'night';
            lastDigestDate = dateStr;
        }

        if (window) {
            try {
                const logs = fs.readFileSync(path.join(process.cwd(), 'orders.log'), 'utf8');
                const stats = computeMiddayDigestStats(logs, window.startMs, window.endMs);
                const msg = formatMiddayDigestMessage(stats, { 
                    timeZone: tz, 
                    dateStr, 
                    windowLabel: windowName, 
                    streakContextLabel: lastDigestWindow === 'morning' ? 'midi' : 'minuit' 
                });
                await sendTelegramAlert(msg);
                console.log(`[Sentinel] Digest ${windowName} envoyé.`);
            } catch (err) {
                console.error(`[Sentinel] Erreur digest:`, err.message);
            }
        }
    }

    // --- 🏆 WINNER WATCHER (REDEEM) ---
    try {
        const positions = loadActivePositions();
        if (positions.length === 0) return;

        const now = Date.now();
        let changed = false;

        for (let i = positions.length - 1; i >= 0; i--) {
            const pos = positions[i];
            if (pos.resolved || pos.redeemed) continue;

            // v17.44.2: Support multiple redeems per slot if accidentally duplicated
            if (pos.slotEnd && (now > pos.slotEnd + 2000)) { 
                const url = `https://gamma-api.polymarket.com/events?slug=${pos.slug}&closed=true`;
                const res = await axios.get(url).catch(() => null);
                
                if (res && res.data && Array.isArray(res.data) && res.data.length > 0) {
                    const event = res.data[0];
                    
                    if (event.closed) {
                        console.log(`[Sentinel] 🏁 Resolution Found for ${pos.slug}`);
                        const market = event.markets.find(m => 
                            m.conditionId === pos.conditionId || 
                            (m.clobTokenIds && (m.clobTokenIds.includes(pos.tokenId) || m.clobTokenIds.includes(pos.tokenIdYes) || m.clobTokenIds.includes(pos.tokenIdNo)))
                        );
                        
                        if (market && market.closed) {
                            const winningIndex = parseInt(market.winningOutcomeIndex);
                            let isWin = false;

                            if (winningIndex === 0 && pos.side === 'YES') isWin = true;
                            if (winningIndex === 1 && pos.side === 'NO') isWin = true;

                            if (isWin) {
                                if (pos.isSimulated) {
                                    // SIMULATION: update virtual balance
                                    const payout = pos.amount; 
                                    const cost = pos.buyPrice * pos.amount;
                                    const profitNet = payout - cost;
                                    const result = await updateVirtualBalance(payout);
                                    const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                                    
                                    const winMsg = `🧪 *SIMULATED REDEEM (WIN)* 💰\n\n` +
                                                   `• Profit: +$${profitNet.toFixed(2)}\n` +
                                                   `• Capital: $${finalBal.toFixed(2)}\n` +
                                                   `• Statut: simulation gagnante`;
                                    
                                    console.log(`[VirtualRedeem] 🏆 Simulated WIN. New Balance: $${finalBal.toFixed(2)}`);
                                    await sendTelegramAlert(winMsg);
                                } else {
                                    // v20.3.0: REAL TRADE REDEEM via Gasless Relayer
                                    console.log(`[Redeem] 🏆 REAL WIN detected for ${pos.slug}. Initiating gasless redeem...`);
                                    try {
                                        await executeRedeemOnChain(pos.conditionId);
                                        const payout = pos.amount;
                                        const cost = pos.buyPrice * pos.amount;
                                        const profitNet = payout - cost;
                                        const winMsg = `🏆 *REDEEM SUCCESS (WIN)* 💰\n\n` +
                                                       `• Marché: ${pos.slug}\n` +
                                                       `• Profit: +$${profitNet.toFixed(2)}\n` +
                                                       `• Statut: Gasless Redeem ✅`;
                                        await sendTelegramAlert(winMsg);
                                    } catch (redeemErr) {
                                        console.error(`[Redeem] ❌ Gasless redeem failed:`, redeemErr.message);
                                        await sendTelegramAlert(`⚠️ *REDEEM FAILED*\n${pos.slug}\n${redeemErr.message}\nRéclamez manuellement sur polymarket.com`);
                                    }
                                }
                            } else {
                                if (pos.isSimulated) {
                                    const result = await getVirtualBalance();
                                    const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                                    console.log(`[VirtualRedeem] 💀 Simulated LOSS. Balance: $${finalBal.toFixed(2)}`);
                                    await sendTelegramAlert(`🛑 *SIMULATED LOSS* 💀\n• Solde final: $${finalBal.toFixed(2)} 💵`);
                                } else {
                                    console.log(`[Redeem] 💀 REAL LOSS for ${pos.slug}. No redeem needed.`);
                                    await sendTelegramAlert(`🛑 *LOSS* 💀\n• Marché: ${pos.slug}\n• Mise perdue: $${(pos.buyPrice * pos.amount).toFixed(2)}`);
                                }
                            }

                            lastResolvedCids.add(pos.tokenId);
                            positions.splice(i, 1);
                            changed = true;
                        }
                    }
                }
            }
        }

        if (changed) {
            saveActivePositions(positions);
        }
    } catch (err) {
        console.error(`[Sentinel] Resolution Error:`, err.message);
    }
}

/**
 * Automate the "Redeem" transaction via Polymarket Gasless Relayer (v17.0.0)
 * Uses EIP-712 Meta-transactions to avoid MATIC fees.
 */
async function executeRedeemOnChain(conditionId) {
    try {
        console.log(`[Redeem] 🛡️ Starting GASLESS redemption for ${conditionId}...`);
        
        const proxyWallet = process.env.CLOB_FUNDER_ADDRESS;
        const signerAddress = wallet.address;
        const apiKey = process.env.RELAYER_API_KEY;

        if (!proxyWallet || !apiKey) {
            throw new Error("Missing RELAYER_API_KEY or CLOB_FUNDER_ADDRESS in .env");
        }

        // 1. Get Nonce from Relayer
        const nonceRes = await axios.get(`${RELAYER_URL}/nonce?address=${proxyWallet}`);
        const nonce = nonceRes.data.nonce;
        console.log(`[Redeem] Current Safe Nonce: ${nonce}`);

        // 2. Encode CTF Call
        const ctfInterface = new ethers.utils.Interface(CTF_ABI);
        const callData = ctfInterface.encodeFunctionData("redeemPositions", [
            USDC_E_ADDRESS,
            ethers.constants.HashZero,
            conditionId,
            [1, 2]
        ]);

        // 3. Prepare EIP-712 Safe Transaction
        const domain = {
            name: "Gnosis Safe",
            version: "1.3.0",
            chainId: 137,
            verifyingContract: proxyWallet
        };

        const types = {
            SafeTx: [
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "data", type: "bytes" },
                { name: "operation", type: "uint8" },
                { name: "safeTxnGas", type: "uint256" },
                { name: "baseGas", type: "uint256" },
                { name: "gasPrice", type: "uint256" },
                { name: "gasToken", type: "address" },
                { name: "refundReceiver", type: "address" },
                { name: "nonce", type: "uint256" }
            ]
        };

        const message = {
            to: CTF_CONTRACT_ADDRESS,
            value: 0,
            data: callData,
            operation: 0,
            safeTxnGas: 0,
            baseGas: 0,
            gasPrice: 0,
            gasToken: ethers.constants.AddressZero,
            refundReceiver: ethers.constants.AddressZero,
            nonce: parseInt(nonce)
        };

        // 4. Sign (v5 standard)
        const signature = await wallet._signTypedData(domain, types, message);

        // 5. Submit to Relayer
        const submitPayload = {
            from: signerAddress,
            to: CTF_CONTRACT_ADDRESS,
            proxyWallet: proxyWallet,
            data: callData,
            nonce: nonce.toString(),
            signature: signature,
            signatureParams: {
                gasPrice: "0",
                operation: "0",
                safeTxnGas: "0",
                baseGas: "0",
                gasToken: ethers.constants.AddressZero,
                refundReceiver: ethers.constants.AddressZero
            },
            type: "SAFE"
        };

        const submitRes = await axios.post(`${RELAYER_URL}/submit`, submitPayload, {
            headers: {
                'RELAYER_API_KEY': apiKey,
                'RELAYER_API_KEY_ADDRESS': signerAddress
            }
        });

        if (submitRes.data && submitRes.data.transactionHash) {
            console.log(`[Relayer] ✅ Redeem transaction submitted: ${submitRes.data.transactionHash}`);
        } else {
            console.warn(`[Relayer] ⚠️ Redeem submitted but no txHash returned.`);
        }

    } catch (err) {
        console.error(`[Redeem] ❌ Relayer Error:`, err.response?.data || err.message);
    }
}

/**
 * Emergency Sell Execution via Relayer (v17.1.0)
 * Gasless and Ultra-Fast sub-1s exit.
 */
async function executeEmergencyExit(info) {
    try {
        console.log(`[Emergency] 🚨 EXECUTION: Handling exit for ${info.tokenId}...`);
        
        // Fetch current quantity from active position
        const positions = loadActivePositions();
        const pos = positions.find(p => p.tokenId === info.tokenId);
        if (!pos) throw new Error("Position data not found for exit.");

        // v17.36.10: IMMUNE TO NETWORK CALLS IN SIMULATION
        if (pos.isSimulated) {
            const remainingValue = info.currentPrice * pos.amount;
            const newBalValue = await updateVirtualBalance(remainingValue);
            const finalBal = typeof newBalValue === 'number' ? newBalValue : (newBalValue?.balance || 0);

            console.log(`[Emergency] SIMULATION EXIT: Price $${info.currentPrice} (Recovery: +$${remainingValue.toFixed(2)})`);
            
            // v17.53.0: CLEANUP FIRST, ALERT LATER (Robustness)
            activePosition = null;
            await saveActivePositions(positions.filter(p => p.tokenId !== info.tokenId));
            SLSentinel.stopMonitoring();

            const exitMsg = `--- SORTIE SIMULEE (STOP LOSS) ---\n\n` +
                            `• Slot: ${pos.slotStart}\n` +
                            `• Entry: $${pos.buyPrice}\n` +
                            `• Exit: $${info.currentPrice}\n` +
                            `• Pnl: ${(info.pnlPct * 100).toFixed(2)}%\n` +
                            `• Recupere : +${remainingValue.toFixed(2)}$\n` +
                            `• Capital actuel : $${finalBal.toFixed(2)}`;
            
            try {
                await sendTelegramAlert(exitMsg);
            } catch (teleErr) {
                console.error('[Emergency] Telegram Alert failed but exit was successful.');
            }
            return;
        }

        const proxyWallet = process.env.CLOB_FUNDER_ADDRESS;
        const apiKey = process.env.RELAYER_API_KEY;

        // 1. Get Nonce - v17.24.0: Added Timeout
        const nonceRes = await axios.get(`${RELAYER_URL}/nonce?address=${proxyWallet}`, { timeout: 5000 });
        const nonce = nonceRes.data.nonce;

        console.log(`[Emergency] 📡 Sending SELL order to CLOB for ${pos.tokenId}...`);
        await ensureClobClient(); // Safety first
        
        // v17.95.0: Triple-check input validity for emergency exit
        const safePrice = Number(info.currentPrice) * 0.98;
        const safeQty = Math.floor(Number(pos.amount));

        if (!isFinite(safePrice) || !isFinite(safeQty) || safeQty <= 0) {
            throw new Error(`Invalid Emergency Data: Price=${safePrice}, Qty=${safeQty}`);
        }

        const orderData = {
            tokenID: pos.tokenId,
            price: Number(safePrice.toFixed(6)), // MUST BE NUMBER
            size: Number(safeQty),              // MUST BE NUMBER
            side: Side.SELL
        };

        console.log(`[Emergency] 🚨 SDK EXECUTION (v21.0.0 createAndPostOrder): Sending ${JSON.stringify(orderData)}`);
        const orderRes = await clobClient.createAndPostOrder(
            orderData,
            { tickSize: "0.01", negRisk: false },
            OrderType.GTC
        );

        if (orderRes && orderRes.orderID) {
            console.log(`[Emergency] ✅ EXIT SUCCESS: ${orderRes.orderID}`);
            
            // v17.3.2: Record Losing/Neutral Trade
            Analytics.recordTrade({
                asset: pos.asset || 'BTC',
                side: pos.side,
                entryPrice: pos.buyPrice,
                exitPrice: info.currentPrice,
                quantity: pos.amount,
                pnlUsd: (info.currentPrice - pos.buyPrice) * pos.amount
            });

            // Cleanup
            activePosition = null;
            saveActivePositions(positions.filter(p => p.tokenId !== info.tokenId));
            SLSentinel.stopMonitoring();
            
            const exitMsg = `🚨 *SORTIE D'URGENCE (STOP LOSS)* 🚨\n\n` +
                            `• PnL: ${(info.pnlPct * 100).toFixed(2)}%\n` +
                            `• Prix Sortie: $${info.currentPrice}\n` +
                            `• Reactivity: <500ms (WS Sentinel)\n` +
                            `• Statut: Sécurisé (Gasless)`;
            
            await sendTelegramAlert(exitMsg);
        }

    } catch (err) {
        console.error(`[Emergency] ❌ Exit Failed:`, err.message);
        await sendTelegramAlert(`❌ *ERREUR SORTIE D'URGENCE*\nLe bot n'a pas pu sortir : ${err.message}`);
    }
}



/**
 * fetchStrikeFromPolymarket(asset, slotStartMs)
 * v17.62.8: Fetches the official strike price from the Gamma API.
 */
async function fetchStrikeFromPolymarket(asset, slotStartMs) {
    try {
        const slotSec = Math.floor(slotStartMs / 1000);
        const url = `https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${slotSec}`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data[0] && res.data[0].markets) {
            const m = res.data[0].markets[0];
            const strike = m?.eventMetadata?.priceToBeat;
            return strike ? parseFloat(strike) : null;
        }
    } catch (err) {
        console.error(`[Lookup] Strike fetch failed for ${slotStartMs}:`, err.message);
    }
    return null;
}

init().then(async () => {
    // v17.52.0: Final Industrialization Step - NTP Software Sync
    await timeKeeper.sync();
    // Refresh every 12 hours
    setInterval(() => timeKeeper.sync(), 12 * 60 * 60 * 1000);
}).catch(err => {
    console.error("💀 v17.10.0 FATAL:", err.message);
    process.exit(1);
});
