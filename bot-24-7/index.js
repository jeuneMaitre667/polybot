/**
 * Master Controller (v2025 MODULAR - v50.4.2 LIQUIDITY-PUMP)
 * Orchestrates market sync, strategy filtering, and trading execution.
 * BUILT FOR DUAL-ASK REALTIME SYNC
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2';
import { signOrderManual } from './ManualSigner.js';
import https from 'https';
import http from 'http';
import crypto from 'crypto'; // v22.8.0: Required for manual HMAC signing
import { gotScraping } from 'got-scraping';
import axios from 'axios';
import { getStealthProfile, getJitter, logStealthMode } from './stealth-config.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

// v23.0.0: Dublin-Ghost Protocol (Surgical & Stable)
const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
if (proxyAgent) {
    // v26.3.0: Prevent circular JSON when SDK tries to serialize the agent in error logs
    proxyAgent.toJSON = () => '[DublinProxy]';
    
    // v26.3.0: Set axios defaults so the SDK's bare axios() calls go through Dublin.
    // The SDK's http-helpers/index.js uses `axios({ method, url, ... })` without any agent.
    axios.defaults.httpsAgent = proxyAgent;
    axios.defaults.httpAgent = proxyAgent;
    console.log(`[Dublin-Ghost] 🛡️🛰️⚓ Global axios defaults set. All SDK requests routed through Dublin.`);
}


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
import BinanceWS from './binance-ws.js'; // v49.9.0: Ultra-low latency stream
import * as Analytics from './analytics-engine.js';
import { getChainlinkPrice, getChainlinkPriceCached } from './chainlink-price.js';
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

const fmt = (val, dec = 2) => (val !== null && val !== undefined && !isNaN(val)) ? Number(val).toFixed(dec) : "0.00";

// --- ROBUSTNESS ---
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
process.on('uncaughtException', (err) => { if (err.code !== 'EPIPE') console.error('🛡️⚓ Critical Error:', err); });

// --- CONFIG ---
// ---// v17.56.0: Removed fixed VIRTUAL_BALANCE constant in favor of dynamic getVirtualBalance()
const SNIPER_DELTA_THRESHOLD_PCT = parseFloat(process.env.SNIPER_DELTA_THRESHOLD_PCT || "0.07"); 
const SNIPER_WINDOW_START = parseInt(process.env.SNIPER_WINDOW_START_S || "90");
const SNIPER_WINDOW_END = parseInt(process.env.SNIPER_WINDOW_END_S || "30");
const SNIPER_PRICE_MIN = parseFloat(process.env.SNIPER_PRICE_MIN || "0.88");
const SNIPER_PRICE_MAX = parseFloat(process.env.SNIPER_PRICE_MAX || "0.95");
const IS_SIMULATION_ENABLED = (process.env.SIMULATION_TRADE_ENABLED || '').trim() === 'true';
const BALANCE_REFRESH_MS = parseInt(process.env.BALANCE_REFRESH_MS || "45000");
const PRIMARY_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const FAILOVER_RPC = process.env.POLYGON_RPC_URL_FAILOVER || 'https://polygon-rpc.com';
const VIRTUAL_BALANCE = parseFloat(process.env.VIRTUAL_BALANCE || "1000"); // v17.35.0

const HEALTH_FILE = path.join(__dirname, 'health-v17.json');
const POSITION_LOG = path.join(__dirname, 'active-positions.json');
const HEARTBEAT_FILE = path.join(__dirname, 'heartbeat.json'); // v17.51.0: Heartbeat for watchdog
const LAST_TRADE_FILE = path.join(__dirname, 'last-trade.json'); // v17.54.0: Total persistence

const CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const PUSD_ADDRESS = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb'; // V2: pUSD (Polymarket USD) - verified on PolygonScan
const USDC_E_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'; // Legacy reference

// --- STATE ---
let lastExecutedSlot = 0; // Track slot to avoid spamming multiple triggers per 5m
let lastAlertedSlot = 0; // v34.3.6: Dedicated alert de-duplicator
let activePosition = null;
let lastFeeRefreshTime = 0; // v49.1.0: Fee rotation tracker
let globalFeeRate = 0.036; // Default fallback (v2: ~3.6% feeRate => 1.8% at p=0.5)
const FEE_REFRESH_INTERVAL_MS = 3600000; // Refresh once per hour (Protocol fees change rarely)
let isResolving = false; // v33.0 Mutex lock for resolution logic
let isReporting = false; // v34.0 Mutex lock for Telegram reporting
let isMainLoopRunning = false; // v34.3.6: Global loop concurrency lock
const lastResolvedCids = new Set();
 // Track resolved markets to avoid double alerts
let lastDigestDate = ''; // YYYY-MM-DD
let lastDigestWindow = ''; // 'morning' | 'night'
let clobClient = null;
let clobCreds = null; // v22.8.0: Store API credentials for manual posting
let decisionFeed = [];
const MAX_FEED_SIZE = 50;
let userBalance = null; // v17.7.0: Null-Init to avoid sending 0 before first fetch
let maticBalance = null; 
let wallet = null; // v16.21.1: Global scope fix
let lastPulseTime = Date.now(); // v17.24.0: For Watchdog monitoring
let isPerformanceLoopRunning = false; // v24.2.0: Mutex for overlap protection
let lastHeartbeatSlot = 0; // v17.60.0: Unique alert per 5m slot
let lastLogSkipTime = 0; // v34.2
let lastLogPulseTime = 0; // v34.2
let lastBalanceFetchTime = 0; // v17.80.0: Alchemy CU Optimization
let memoryHealth = { dashboardMarketView: { status: 'waiting' } };
let riskSessionInitialized = false; // v17.70.0: Track RiskManager baseline

// v46.0.4: Turbo-Switch Momentum Engine (House Money Mode)
let streakCount = 0;
let streakProfit = 0; // v46.0.5: Track profits to bet them back
const STREAK_FILE = path.join(__dirname, 'streak-state.json');
try {
    const data = JSON.parse(fs.readFileSync(STREAK_FILE, 'utf8'));
    streakCount = data.streak || 0;
    streakProfit = data.profit || 0;
    console.log(`[Momentum] 🛰️⚓ Streak loaded: ${streakCount} | Accumulated Profit: $${streakProfit.toFixed(2)}`);
} catch (e) {}

function updateStreak(isWin, profit = 0) {
    if (isWin) {
        streakCount++;
        streakProfit += Math.max(0, profit);
        console.log(`[Momentum] 🔥 WIN! Streak: ${streakCount} | Streak Profit: +$${streakProfit.toFixed(2)}`);
    } else {
        streakCount = 0;
        streakProfit = 0;
        console.log(`[Momentum] ❄️ LOSS. Streak & Profits reset to 0. Mode: STEADY`);
    }
    try { fs.writeFileSync(STREAK_FILE, JSON.stringify({ streak: streakCount, profit: streakProfit })); } catch (e) {}
}

const AUTO_STOP_TIME = null; // V2: Maintenance complete, no auto-stop needed

/**
 * v22.8.0: Manual CLOB Header Generator
 * Bypasses SDK to ensure 100% proxy tunneling and zero IP leaks.
 */
/**
 * v25.0.0: Official SDK Shielded Pulse
 * (createClobHeaders removed: SDK now handles authentication natively via Proxy Agent)
 */
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
    if (!IS_SIMULATION_ENABLED || isResolving) return; 
    
    isResolving = true;
    try {
        const positions = loadActivePositions();
        if (positions.length === 0) return;
        
        const now = Date.now();
        
        for (const pos of [...positions]) { // Iteration on clone
            if (!pos.isSimulated || !pos.slotEnd) continue;
            
            // v34.4: Simplified Binance-Centric Resolution (Zero Patience Mode)
            // User Request: No SL trigger = Systematic Win for simulation compounding efficiency
            if (now > pos.slotEnd + 2000) {
                // ATOMIC CLAIM: Remove from log before resolving
                let claimed = false;
                await runAtomicUpdate(POSITION_LOG, (list = []) => {
                    const idx = list.findIndex(p => String(p.tokenId) === String(pos.tokenId)); // Force string matching
                    if (idx !== -1) {
                        list.splice(idx, 1);
                        claimed = true;
                    }
                    return list;
                });

                if (!claimed) continue;

                // Simplified logic: If we reached expiry without SL, it's a WIN.
                const isWin = true; 
                
                if (isWin) {
                    const payout = pos.amount;
                    const cost = parseFloat((pos.buyPrice * pos.amount).toFixed(2));
                    const profitNet = payout - cost;
                    const result = await updateVirtualBalance(payout);
                    const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance || 0) : (result || 0));
                    
                    console.log(`[FastResolution] 🛡️⚓ ATOMIC Compound Boost: +${profitNet.toFixed(2)} | Capital Released: ${finalBal.toFixed(2)}`);
                    
                    // v34.4.12: Archival FIRST (Priority #1) - FastResolution WIN
                    updateStreak(true, profitNet); // v46.0.5: Capture profit for House Money
                    try {
                        Analytics.recordTrade({
                            asset: pos.asset || 'BTC',
                            slug: pos.slug,
                            isSimulated: true,
                            side: pos.side,
                            entryPrice: pos.buyPrice,
                            exitPrice: 1.0,
                            quantity: pos.amount,
                            pnlUsd: profitNet,
                            isWin: true
                        });
                    } catch (e) { console.error('[ArchivalError] FastResolution WIN Sync failed:', e.message); }

                    // ALERT SECOND (Non-blocking)
                    await sendTelegramAlert(`🛡️⚓ *SIMULATED WIN (BINANCE)* 🛡️⚓\n\n• Profit: +${profitNet.toFixed(2)} 🛡️⚓\n• Solde actuel: ${finalBal.toFixed(2)} 🛡️⚓\n• Precision: 2 decimals ⚖️`);
                } 
                
                if (activePosition && String(activePosition.tokenId) === String(pos.tokenId)) activePosition = null;
            }
        }
    } finally {
        isResolving = false;
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
            // v47.0.0: CLOB V2 Migration — viem signer + options object constructor
            const { createWalletClient, http: viemHttp } = await import('viem');
            const { privateKeyToAccount } = await import('viem/accounts');
            const { polygon } = await import('viem/chains');

            const account = privateKeyToAccount(process.env.PRIVATE_KEY);
            const walletClient = createWalletClient({
                account,
                chain: polygon,
                transport: viemHttp()
            });

            console.log(`[Audit] 🛡️🛰️⚓ Initializing CLOB V2 Client:`);
            console.log(`[Audit] • Signer EOA: ${wallet.address}`);
            console.log(`[Audit] • Protocol: CLOB V2 (pUSD)`);

            // v22.5.1: Ghost-Shield - Multi-layer proxy injection
            const proxyUrl = process.env.PROXY_URL;
            let proxyAgent = null;
            if (proxyUrl) {
                proxyAgent = new HttpsProxyAgent(proxyUrl);
                console.log(`[Audit] 🛡️🛰️⚓ Shielding SDK with Irish Proxy tunnel...`);
            }

            // Step 1: Create initial client for key derivation
            const tempClient = new ClobClient({
                host: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
                chain: 137,
                signer: walletClient,
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent
            });

            let apiCreds;
            try {
                apiCreds = await tempClient.deriveApiKey();
                console.log(`[Audit] • API Key derived: ${apiCreds.key ? apiCreds.key.substring(0, 8) + '...' : 'FAIL'}`);
            } catch (deriveErr) {
                console.warn(`[Audit] 🛡️🛰️⚓ deriveApiKey failed: ${deriveErr.message}. Trying createOrDeriveApiKey...`);
                try {
                    apiCreds = await tempClient.createOrDeriveApiKey();
                    console.log(`[Audit] • API Key created: ${apiCreds.key ? apiCreds.key.substring(0, 8) + '...' : 'FAIL'}`);
                } catch (createErr) {
                    console.error(`[Audit] 🛡️⚠️ All API key methods failed: ${createErr.message}`);
                    throw createErr;
                }
            }

            clobCreds = apiCreds;

            // Step 2: Create fully authenticated client
            clobClient = new ClobClient({
                host: process.env.CLOB_API_URL || 'https://clob.polymarket.com', // v49.1.7: Unified Stable Host
                chain: 137,
                signer: walletClient,
                creds: apiCreds,
                signatureType: parseInt(process.env.CLOB_SIGNATURE_TYPE || '2'),
                funderAddress: process.env.CLOB_FUNDER_ADDRESS,
                // v49.1.7: FORCE PROXY ROUTING (Shield SDK from Geoblock 405/403)
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent
            });
            
            // v49.1.3: Removed legacy updateBalanceAllowance() (V2 incompatible)
            console.log(`[Self-Healing] 🛡️🛰️⚓ ClobClient V2 initialized (V2-MIGRATED)`);

            console.log(`[Self-Healing] 🛡️🛰️⚓ ClobClient V2 initialized with API credentials (DUBLIN-AXIOM PROTOCOL)`);
        }
        return true;
    } catch (err) {
        console.error(`[Self-Healing] 🛡️⚠️ FAILED to restore wallet:`, err.message);
        return false;
    }
}

/**
 * v21.3.0: Mandatory Geoblock Verification
 * Checks if the current IP/Proxy is authorized to trade on Polymarket.
 */
async function validateGeoblockStatus() {
    console.log(`[Geoblock] 🛡️🛰️⚓ Verifying Ghost-Shield integrity...`);
    try {
        // v22.5.1: Pre-Flight IP Verification (Absolute security)
        const proxyUrl = process.env.PROXY_URL;
        if (proxyUrl) {
            const agent = new HttpsProxyAgent(proxyUrl);
            const ipLookup = await axios.get('https://api.ipify.org?format=json', { 
                timeout: 5000,
                httpsAgent: null // v34.3: Direct connection for IP check
            }).catch(() => null);
            
            if (ipLookup && ipLookup.data && ipLookup.data.ip) {
                console.log(`[Geoblock] 🛡️🛰️⚓🛡️🛰️⚓ Bot Public IP: ${ipLookup.data.ip} (Dublin Tunnel Verified)`);
            } else {
                console.warn(`[Geoblock] 🛡️🛰️⚓ IP Lookup failed, but proceeding with caution...`);
            }
        }

        // v21.3.0: We use a private authenticated endpoint that is strictly geoblocked for trading.
        await clobClient.getOpenOrders();
        console.log(`[Geoblock] 🛡️🛰️⚓ Access Authorized. Ready for trading.`);
        return true;
    } catch (err) {
        const isRestricted = err.message?.includes("restricted") || 
                            (err.response?.data?.error?.includes("restricted")) ||
                            err.response?.status === 403;
        
        if (isRestricted) {
            const errorMsg = "🛡️🛰️⚓ GHOST-SHIELD FAILURE: Trading is restricted in your region. IP Leak detected!";
            console.error(`[Geoblock] 🛡️⚠️ ERROR: ${errorMsg}`);
            await sendTelegramAlert(errorMsg);
            return false;
        }
        
        // Other errors (auth, net) handled separately, but we still warn
        console.warn(`[Geoblock] 🛡️🛰️⚓ Warning during check:`, err.message);
        return true; // We don't block for minor network issues here
    }
}

// --- INITIALIZATION ---
async function init() {
    console.log("=== 🛡️⚓ SNIPER BOT: v50.3.0 BOOST-MODE ONLINE ===");
    
    // v49.9.0: Activate Binance Real-Time Stream
    BinanceWS.start();
    
    // v17.16.0: Initial Heartbeat Pulse (Eliminate Dashboard Skeletons)
    updateHealth({ status: 'starting', sniperHUD: 'INITIALIZING...' });

    // v17.36.0: Initialize RiskManager with Virtual or Real Balance
    const initialBal = IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance || 0);
    RiskManager.initSession(initialBal);
    console.log(`[Init] 🛡️🛰️⚓ Risk Strategy: ${IS_SIMULATION_ENABLED ? 'LAB (Virtual $' + initialBal + ')' : 'LIVE (Real)'}`);

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY is missing in .env");

    const success = await ensureClobClient();
    if (!success) throw new Error("CRITICAL: Failed to initialize wallet client");
    
    // v21.3.0: Startup Geoblock Pulse
    const geoPassed = await validateGeoblockStatus();
    if (!geoPassed && !IS_SIMULATION_ENABLED) {
        throw new Error("CRITICAL: Geoblock test failed. Engine aborted for safety.");
    }

    console.log(`[Init] Wallet: ${wallet.address} - READY`);

    startStrikeWorker();
    
    // Core Operational Loops (1Hz)
    // v22.0.0: Ghost Protocol Start
    console.log(`[Ghost] 🛡️🛰️⚓ Protocol Active | Initializing Stealth Engine...`);
    
    // Start the loops with organic timing
    setTimeout(scheduledMainLoop, getJitter(500, 100));
    reportingLoop();
    setInterval(performanceLoop, 1000); // v49.4.0: 10x faster resolution/SL check (1s)
    
    // Initial triggers
    mainLoop();
    
    // v17.24.0: Stability Watchdog (Reset engine if it hangs for > 60s)

    setInterval(() => {
        const stallTime = Date.now() - lastPulseTime;
        if (stallTime > 60000) {
            console.error(`[Watchdog] 🛡️🛰️⚓ SILENT HANG DETECTED (${Math.floor(stallTime/1000)}s). Restarting...`);
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
    // v22.1.0: Cibler le slot qui a COMMENCÉ au début de ces 5 minutes (Real-Sync)
    const slotStart = Math.floor(now / 300000) * 300000;
    
    // v24.0.0: True-Mirror Sync (1:1 Chart Parity)
    // Switched from Inverse-Perp (DAPI) to Spot (API) to match User Dashboard Chart
    const binanceSignalSymbol = "BTCUSDC";
    const binanceSpotUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSignalSymbol}`;
    const binanceKlinesUrl = `https://api.binance.com/api/v3/klines?symbol=${binanceSignalSymbol}`;
    
    // 1. Fetch Binance Spot (Optimized v49.9.0)
    let bSpot = 0;
    let source = 'WS';

    if (BinanceWS.isReady()) {
        bSpot = BinanceWS.getPrice();
    } else {
        // Fallback to Polling if WS is down
        try {
            const bResp = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 2000 });
            bSpot = parseFloat(bResp.data.price);
            source = 'POLL';
        } catch (e) {
            console.error('[MarketState] Binance Poll Error:', e.message);
        }
    }

    if (!bSpot) bSpot = (memoryHealth.dashboardMarketView?.binanceSpot || 0);
    
    // v35.0.0: Global export for SLSentinel & RiskManager
    global.lastBinanceSpot = bSpot;

    // 2. Fetch or Backfill Strike (v24.3.0: PURE BINANCE REFERENCE)
    const strikeTime = slotStart; 
    let bStrike = await getBinanceStrike(asset, strikeTime);
    
    // v24.3.0: Strategy strictly follows Binance Open for better signal sensitivity
    const effectiveStrike = bStrike;
    const strikeSource = bStrike ? 'BINANCE-SPOT-OPEN' : 'MISSING';
    source = `${strikeSource} (${source})`;
    
    // 3. Calculate Delta
    let bDeltaPct = 0;
    if (effectiveStrike && effectiveStrike > 0 && bSpot > 0) {
        bDeltaPct = ((bSpot - effectiveStrike) / effectiveStrike) * 100;
    } else {
        if (now % 60000 < 1000) console.warn(`[Lookup] 🛡️🛰️⚓ Strike missing for ${asset} at ${slotStart}. Delta calculation suspended.`);
    }
    
    // v24.2.4: Fast-Signal Detection (Log early even before trade window)
    if (Math.abs(bDeltaPct) > 0.05) {
        process.stdout.write(`\r[SIGNAL] 🛡️🛰️⚓ Delta spike detected: ${bDeltaPct > 0 ? '+' : ''}${bDeltaPct.toFixed(3)}% | Time: ${new Date().toLocaleTimeString()}\n`);
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

/**
 * v34.0: Recursive Reporting (Anti-Overlap)
 */
async function reportingLoop() {
    if (isReporting) {
        setTimeout(reportingLoop, 1000); // Try again next second
        return;
    }

    isReporting = true;
    try {
        const now = Date.now();
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);
        
        let startAudit = Date.now();
        
        // 0. Fetch Real Blockchain Balance (v17.85.0: Ethers v5 syntax)
        if (now - lastBalanceFetchTime > BALANCE_REFRESH_MS || userBalance === null) {
            try {
                const rpcUrl = PRIMARY_RPC;
                const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, 137);
                const funder = process.env.CLOB_FUNDER_ADDRESS || wallet.address;

                // v47.3.0: Direct on-chain pUSD balance read (no SDK auth needed)
                const pusd = new ethers.Contract(PUSD_ADDRESS, ["function balanceOf(address owner) view returns (uint256)"], provider);
                const [pusdRaw, maticRaw] = await Promise.all([
                    pusd.balanceOf(funder),
                    provider.getBalance(wallet.address)
                ]);
                const pusdBalance = parseFloat(ethers.utils.formatUnits(pusdRaw, 6));

                if (!IS_SIMULATION_ENABLED && Math.random() < 0.05) {
                    console.log(`[Balance] 🛡️🛰️⚓ pUSD On-Chain Balance: ${pusdBalance.toFixed(6)} (Proxy: ${funder})`);
                }

                userBalance = IS_SIMULATION_ENABLED ? getVirtualBalance() : pusdBalance; 
                maticBalance = parseFloat(ethers.utils.formatEther(maticRaw));
                lastBalanceFetchTime = now;

                // v17.70.0: Initialize Risk Baseline on FIRST successful balance fetch
                if (!riskSessionInitialized && userBalance !== null) {
                    RiskManager.initSession(IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance);
                    riskSessionInitialized = true;
                    console.log(`[Risk] 🛡️🛰️⚓ Session Baseline Locked: ${(IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance).toFixed(2)}`);
                }
            } catch (err) {
                console.error('[Reporting] v27.7.2 RPC Error:', err.message);
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
                // v49.1.0: DYNAMIC PROTOCOL FEE SYNC (Zero-API cost)
                const mkt = sig.markets ? sig.markets[0] : null;
                if (mkt && mkt.feeSchedule) {
                    const sched = mkt.feeSchedule;
                    const baseRate = parseFloat(sched.rate);
                    const exponent = parseInt(sched.exponent);
                    const protocolFeeRate = baseRate * Math.pow(10, -exponent);
                    
                    // v49.1.2: Calculate effective PnL fee (relative % at p=0.5 for SL safety)
                    // Formula: feeRate * (1-p) => 0.072 * 0.5 = 0.036 (3.6%)
                    const effectivePnlFee = protocolFeeRate * 0.5; 
                    
                    if (effectivePnlFee !== globalFeeRate) {
                        globalFeeRate = effectivePnlFee;
                        RiskManager.setDynamicFees(globalFeeRate);
                        if (Math.random() < 0.01) console.log(`[Protocol] 🛡️🛰️⚓ Fees Synced: ${(globalFeeRate * 100).toFixed(3)}% (Market: ${sig.slug})`);
                    }
                }

                let bestBidUp = 0;
                let bestBidDown = 0;
                let priceUp = 0;
                let priceDown = 0;

                const stealthOpts = getStealthProfile();
                if (process.env.PROXY_URL) {
                    stealthOpts.proxyUrl = process.env.PROXY_URL;
                }
                
                // 1. Fetch Real UP Bids/Asks via Stealth Got
                if (sig.tokenIdYes) {
                    const bookUrl = `https://clob.polymarket.com/book?token_id=${sig.tokenIdYes}`;
                    const res = await gotScraping.get(bookUrl, {
                        ...stealthOpts,
                        retry: { limit: 2 }
                    }).catch(() => null);
                    if (res) {
                        const book = res.body;
                        const asks = book?.asks || [];
                        const bids = book?.bids || [];
                        if (asks.length > 0) {
                            const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
                            if (prices.length > 0) priceUp = Math.min(...prices);
                        }
                        if (bids.length > 0) {
                            const bPrices = bids.map(b => parseFloat(b.price)).filter(p => p > 0.001);
                            if (bPrices.length > 0) bestBidUp = Math.max(...bPrices);
                        }
                    }
                }

                // 2. Fetch Real DOWN Bids/Asks via Stealth Got
                if (sig.tokenIdNo) {
                    const bookUrl = `https://clob.polymarket.com/book?token_id=${sig.tokenIdNo}`;
                    const res = await gotScraping.get(bookUrl, {
                        ...stealthOpts,
                        retry: { limit: 2 }
                    }).catch(() => null);
                    if (res) {
                        const book = res.body;
                        const asks = book?.asks || [];
                        const bids = book?.bids || [];
                        if (asks.length > 0) {
                            const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
                            if (prices.length > 0) priceDown = Math.min(...prices);
                        }
                        if (bids.length > 0) {
                            const bPrices = bids.map(b => parseFloat(b.price)).filter(p => p > 0.001);
                            if (bPrices.length > 0) bestBidDown = Math.max(...bPrices);
                        }
                    }
                }

                // v17.3.5: Extreme Price Calibration (Cross-Inference)
                if (priceUp > 0 && priceUp < 0.05 && priceDown === 0) priceDown = 0.99;
                if (priceDown > 0 && priceDown < 0.05 && priceUp === 0) priceUp = 0.99;
                
                // Final fallback only if both are empty (unlikely during active slot)
                bestAskUp = priceUp || sig.priceYes || 0.5;
                bestAskDown = priceDown || sig.priceNo || 0.5;

                // Sync Bids if book was empty
                if (bestBidUp === 0) bestBidUp = Math.max(0.01, bestAskUp - 0.01);
                if (bestBidDown === 0) bestBidDown = Math.max(0.01, bestAskDown - 0.01);

                // v16.16.0: Active Stop Loss Monitoring (Precision Bid-Based)
                if (activePosition && activePosition.slotStart === slotStart) {
                    // v28.0: TRIGGER ON BID (Real sell price)
                    const currentBid = activePosition.side === 'YES' ? bestBidUp : bestBidDown;
                    const currentAsk = activePosition.side === 'YES' ? bestAskUp : bestAskDown;
                    
                    const isViolated = RiskManager.shouldTriggerStopLoss(
                        activePosition.buyPrice, 
                        currentBid, 
                        currentAsk,
                        activePosition.side, 
                        activePosition.entryAssetPrice, 
                        global.lastBinanceSpot,
                        activePosition.officialStrike
                    );

                    if (isViolated) {
                        if (!activePosition.slViolationStart) {
                            activePosition.slViolationStart = Date.now();
                            console.log(`[Shield] 🛡️⚓ Violation detected. Starting 1.5s confirmation timer...`);
                        }

                        const violationDuration = Date.now() - activePosition.slViolationStart;
                        if (violationDuration >= 1500 && !activePosition.isExiting) {
                            console.warn(`[Risk] 🚨 Stop Loss CONFIRMED after ${violationDuration}ms! Bid:$${currentBid} | Exiting...`);
                            activePosition.isExiting = true; 

                            try {
                                const pnlVal = ((currentBid - activePosition.buyPrice) / activePosition.buyPrice * 100);
                                await executeEmergencyExit({
                                    tokenId: activePosition.tokenId,
                                    currentPrice: currentBid,
                                    pnlPct: pnlVal / 100
                                });
                            } catch (err) {
                                console.error(`[Risk] Stop Loss SELL Failed:`, err.message);
                                activePosition.isExiting = false; 
                            }
                        }
                    } else {
                        if (activePosition.slViolationStart) {
                            console.log(`[Shield] 🛡️⚓ Price RECOVERED. Timer reset.`);
                            activePosition.slViolationStart = null;
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
                const upLabel = (bestAskUp > 0.80 && isDeltaMet && deltaPct > 0) ? '🛡️🛰️⚓ UP' : '🛡️🛰️⚓ UP';
                const downLabel = (bestAskDown > 0.80 && isDeltaMet && deltaPct < 0) ? '🛡️🛰️⚓ DOWN' : '🛡️🛰️⚓ DOWN';

                const displayBalance = IS_SIMULATION_ENABLED ? getVirtualBalance() : userBalance;
                
                // v17.39.12: Continuous Double-Strike TryTryTry
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
                // v21.6.0: Safe Reporting (Null-Safety guard)
                
                const officialLabel = ''; 
                
                console.log(`[PIPELINE] | T-${secondsLeft}s | slot:${currentSlotLabel} | ${upLabel}:${fmt(bestAskUp * 100, 1)}% | ${downLabel}:${fmt(bestAskDown * 100, 1)}% | Bal:$${fmt(displayBalance, 2)} | Open:${fmt(effectiveStrike, 2)} | Spot:${fmt(bSpot, 2)} | Δ:${deltaSign}$${fmt(deltaUsd, 2)} (${deltaSign}${fmt(deltaPct, 3)}%)`);
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
    } catch (err) {
        console.error('[Reporting] Critical loop failure:', err.message);
    } finally {
        isReporting = false;
        setTimeout(reportingLoop, 1000); // v34.0: Schedule next run only AFTER completion
    }
}

/**
 * v22.0.0: Ghost Protocol Wrapper
 * Ensures each loop has a unique, random delay to evade pattern detection.
 */
async function scheduledMainLoop() {
    try {
        await mainLoop();
    } catch (err) {
        console.error(`[Ghost] Main loop catch:`, err.message);
    } finally {
        const jitter = getJitter(500, 100);
        setTimeout(scheduledMainLoop, jitter);
    }
}

async function mainLoop() {
    if (isMainLoopRunning) return; // v34.3.6: Prevent parallel execution

    // v46.0.4: AUTO-STOP GUARD
    if (AUTO_STOP_TIME && Date.now() >= AUTO_STOP_TIME) {
        console.log(`[Master] 🛑 AUTO-STOP REACHED (${new Date(AUTO_STOP_TIME).toLocaleString()}). Shutting down for maintenance.`);
        await sendTelegramAlert(`🛑 *ARRÊT AUTOMATIQUE*\nLe bot s'est arrêté proprement pour la maintenance (12h00 Paris).`);
        process.exit(0);
    }

    isMainLoopRunning = true;
    
    const cycleStart = Date.now();
    let order = null; 
    try {
        // v17.61.0: INDEPENDENT REAL-TIME HEARTBEAT (Bypass NTP Lag)
        const hbNow = Date.now();
        const slotStartLocal = Math.floor(hbNow / 300000) * 300000;
        const hbSecondsLeft = Math.floor((slotStartLocal + 300000 - hbNow) / 1000);
        const displayTime = new Date(hbNow).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        if (hbSecondsLeft <= 90 && hbSecondsLeft >= 10 && lastHeartbeatSlot !== slotStartLocal) {
            lastHeartbeatSlot = slotStartLocal; // Lock immediately
            console.log(`[PID:${process.pid}] [Telegram] Indep-Heartbeat Triggered (T-${hbSecondsLeft}s)`);
            
            const hbBal = await updateVirtualBalance(0); // Force fresh check or return current
            const currentBal = (IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance !== null ? userBalance : 0));
            const engineStatus = (userBalance === null && !IS_SIMULATION_ENABLED) ? "SYNCING... ⏳" : "READY 🛡️🛰️⚓";
            const hbMsg = `🛡️🛰️⚓ *SNIPER STATUS : ${displayTime}*🛡️🛰️⚓\n\n` +
                          `• Window: OPEN 🛡️🛰️⚓\n` +
                          `• Capital: $${(userBalance === null && !IS_SIMULATION_ENABLED) ? "---" : currentBal.toFixed(2)} 🛡️🛰️⚓\n` +
                          `• Engine: ${engineStatus}`;
            
            const token = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
            const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();
            const url = `https://api.telegram.org/bot${token}/sendMessage`;

            axios.post(url, { chat_id: chatId, text: hbMsg, disable_web_page_preview: true }, { 
                timeout: 10000,
                httpsAgent: null, // v34.3: Bypass global proxy for Telegram
                httpAgent: null   // v34.3: Bypass global proxy for Telegram
            })
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
        
        // v50.0.0: High-Frequency Position Monitoring
        const marketState = await getUnifiedMarketState('BTC');
        if (marketState) {
            global.lastBinanceSpot = marketState.bSpot;
            await monitorPositionsFast(marketState);
        }
        
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
            if (now - lastLogSkipTime > 30000) { // v34.2: Fixed throttle (30s)
                lastLogSkipTime = now;
                console.log(`[Engine] Skip: Timing window closed (T-${secondsLeft}s)`);
            }
            return; 
        }

        // 3. Unified Decision Path (v17.22.0)
        // Fresh context check already done at top of loop for resolution
        
        if (Math.abs(mv.bDeltaPct) < SNIPER_DELTA_THRESHOLD_PCT) {
            if (now - lastLogPulseTime > 30000) { // v34.2: Fixed throttle (30s)
                lastLogPulseTime = now;
                console.log(`[PID:${process.pid}] [Engine] Pulse: Monitoring BTC (Delta: ${fmt(mv.bDeltaPct, 3)}% | Target: ${SNIPER_DELTA_THRESHOLD_PCT}%)`);
            }
            return;
        }

        const bDeltaPct = mv.bDeltaPct; // Local variable for logging
        const side = bDeltaPct > 0 ? 'YES' : 'NO';
        
        // v17.22.13: FORCED REAL-TIME DEPTH (Eliminate 3s Health-Sync Lag)
        // Dès que le signal Binance est bon, on va chercher le prix REEL sur l'Orderbook
        console.log(`[Engine] 🛡️🛰️⚓ Binance Signal Met (${fmt(bDeltaPct, 3)}%). Checking Polymarket Depth for ${side}...`);
        
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
            console.error(`[Engine] 🛡️⚠️ CRITICAL: Invalid Token ID detected for ${side}: "${tokenId}" (Market: ${currentSig?.slug || 'Unknown'})`);
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
                console.log(`[Engine] 🛡️🛰️⚓ Orderbook empty. Using Gamma Fallback: $${gammaPrice}`);
                bestAsk = gammaPrice;
            }
        }

        // v22.4.1: Final Strike (Orderbook Priority with Gamma Fallback)
        const liveClobPrice = bestAsk;
        const staleGammaPrice = side === 'YES' ? parseFloat(currentSig.priceUp || 0) : parseFloat(currentSig.priceDown || 0);
        
        // v49.8.0: Spread Filter Removed per user request. 
        // We still fetch currentBestBid for logging/sync purposes.
        let currentBestBid = 0;
        try {
            const book = await clobClient.getOrderBook(tokenId).catch(() => null);
            if (book && book.bids && book.bids.length > 0) {
                currentBestBid = parseFloat(book.bids[0].price);
            }
        } catch (e) {}

        // v49.8.1: Restore dashboardPrice definition (Critical fix for entry regression)
        const dashboardPrice = (liveClobPrice > 0) ? liveClobPrice : staleGammaPrice;
        console.log(`[Engine] 🛡️⚓ Signal Price Sync (TURBO+): CLOB=$${liveClobPrice.toFixed(3)} | Dashboard=$${staleGammaPrice.toFixed(3)} | Bid=$${currentBestBid.toFixed(3)} | Target=$${dashboardPrice.toFixed(3)}`);

        // v22.4.1: CRITICAL TRIGGER DECISION (Non-blocking fallback)
        if (!dashboardPrice || dashboardPrice < SNIPER_PRICE_MIN || dashboardPrice > SNIPER_PRICE_MAX) {
            if (now % 20000 < 1000) {
                console.warn(`[Engine] Skip: Integrated Price ($${dashboardPrice.toFixed(3)}) outside safety range ($${SNIPER_PRICE_MIN}-$${SNIPER_PRICE_MAX})`);
            }
            return;
        }

        const executionPrice = dashboardPrice;

        // v17.75.0: Final Wallet Integrity Check relative to current tir
        if (!(await ensureClobClient())) {
            console.error("[Engine] 🛡️⚠️ SKIP: Wallet not ready despite self-healing attempt.");
            sendTelegramAlert("🚨 *WALLET ERROR*: Sniper skipped trade due to client amnesia.");
            return;
        }

        // 4. Risk & Collateral
        const baseBalance = IS_SIMULATION_ENABLED ? getVirtualBalance() : (userBalance || 0);
        let tradeAmountUsd = RiskManager.calculateTradeSize(baseBalance); 
        
// v46.2.0: Turbo Mode deactivated. Fixed 100$ active.
        
        // v17.0.4: Hard-cap safety (never trade more than actual USDC balance - 0.10 buffer)
        const safetyFactor = 0.98; // Leave a tiny bit for precision safety
        const availableMax = IS_SIMULATION_ENABLED ? getVirtualBalance() : Math.max(0, (userBalance || 0) * safetyFactor);
        
        // Critical Fix: Prevent $0 trades
        if (!executionPrice || executionPrice <= 0) {
            console.error(`[Engine] 🛡️⚠️ ABORT: Price discovery failed ($${executionPrice}). Trade skipped.`);
            return;
        }

        if (tradeAmountUsd > availableMax) {
            console.log(`[Risk] Capping trade size from $${tradeAmountUsd.toFixed(2)} to $${availableMax.toFixed(2)} due to balance limits.`);
            tradeAmountUsd = availableMax;
        }

        // v17.0.4.1: HARD SAFETY CAP (Max $100 per position, regardless of balance)
        // v46.1.1: HARD_MAX_STAKE removed for House Money strategy.

        if (tradeAmountUsd < 1.0) {
            console.warn(`[Engine] Skip: Balance too low even for minimum trade ($${baseBalance.toFixed(2)})`);
            return;
        }

        // --- NEW: TAKER AGGRESSION & DYNAMIC FEES (v21.4.0.1) ---
        // 1. Crossing the spread (+0.02$) for instant execution
        const safePrice = Math.min(0.99, Number(executionPrice) + 0.02);

        // 2. Dynamic Fee Calculation (Polymarket v2026 Formula)
        // Fee = Theta * qty * price * (1 - price) | Theta Crypto approx 0.036 (1.8% peak)
        // Effective price per unit = price * (1 + 0.036 * (1 - price))
        const theta = (globalFeeRate / 0.5) || 0.072; // Recover raw feeRate from SL percentage
        const effectivePrice = safePrice * (1 + (theta * (1 - safePrice)));
        // v49.1.9: Enforcement of Polymarket V2 Minimum Order Size (5 contracts)
        // v49.1.12: REVERTED upscaling. Real-world tests show 1-3 contracts pass on CLOB V2.
        let safeQty = Math.floor(tradeAmountUsd / effectivePrice);

        if (safeQty <= 0) {
            console.warn(`[Engine] Skip: Amount too low after fees to purchase even 1 contract.`);
            return;
        }


        if (!IS_SIMULATION_ENABLED) {
            await CollateralManager.ensureCollateral(clobClient, null, tradeAmountUsd);
        }

        // 5. Execution
        console.log(`[Engine] 🎯 Sniper Triggered! Dashboard=$${dashboardPrice.toFixed(3)} | BestAsk=$${executionPrice.toFixed(3)} | Side:${side} | Size:$${tradeAmountUsd.toFixed(2)}`);
        
        // v17.29.5: High visibility on target market expiration
        console.log(`[Engine] 🛡️🛰️⚓ Execution ID: ${tokenId} | Market: ${currentSig.slug} | Ends: ${currentSig.m?.endDate} | Side: ${side}`);

        // Mark slot as processed (v17.54.0 Persistent)
        lastExecutedSlot = slotStart;
        try {
            fs.writeFileSync(LAST_TRADE_FILE, JSON.stringify({ slot: slotStart, time: new Date().toISOString() }));
        } catch (e) {}

        if (IS_SIMULATION_ENABLED) {
            // ... (simulation logic same)
            const totalLatency = Date.now() - cycleStart;
            console.log(`[Engine] 🧪 SIMULATION: Order placed | Latency: ${totalLatency}ms`);
        } else {
            const startExec = Date.now();
            let orderData = null;
            
            try {
                // v25.0.0: Official SDK Injection (Mode Shielded)
                console.log(`[Engine] 🏹 Placing OFFICIAL order via Shielded SDK...`);
                
                // v25.3.0: Dynamic Precision Recovery
                let tSize = "0.01";
                try {
                    tSize = await clobClient.getTickSize(tokenId) || "0.01";
                    if (Number(tSize) >= 1) {
                        console.warn(`[Engine] 🛡️🛰️⚓ Warning: API returned erroneous tickSize ${tSize}. Forcing to 0.01.`);
                        tSize = "0.01";
                    }
                } catch (e) {
                    console.warn(`[Engine] 🛡️🛰️⚓ Tick lookup failed, using fallback: ${tSize}`);
                }

                // v25.3.0: Surgical Price Rounding & Boundary Shield
                const divisor = 1 / parseFloat(tSize);
                const rounded = Math.round(safePrice * divisor) / divisor;
                
                // Never allow price to hit 1.0 (invalid for CLOB)
                // Also respect the user's SNIPER_PRICE_MAX
                const maxAllowed = Math.min(0.99, SNIPER_PRICE_MAX);
                const finalPrice = Math.min(parseFloat(rounded.toFixed(4)), maxAllowed);
                
                console.log(`[Engine] 🎯 Price Aligned: Raw=$${safePrice} -> Final=$${finalPrice} (Tick:${tSize}, Cap:${maxAllowed})`);

                const response = await clobClient.createAndPostOrder(
                    {
                        tokenID: tokenId,
                        price: finalPrice,
                        size: safeQty,
                        side: Side.BUY
                    },
                    {
                        tickSize: tSize,
                        negRisk: currentSig.m?.negRisk ?? (tokenId.length > 50)
                    },
                    OrderType.GTC // v49.1.8: Reverted FOK -> GTC for maximum V2 compatibility
                );

                if (response && response.orderID) {
                    order = response; // For common state tracking below
                    const latency = Date.now() - startExec;
                    console.log(`[Engine] ✅ OFFICIAL Order Accepted: ${response.orderID} | Latency: ${latency}ms`);
                } else {
                    throw new Error(JSON.stringify(response));
                }
            } catch (err) {
                const errorData = err.response?.data?.error || err.message;
                
                // v48.0.1: FALSE-FAILURE SHIELD (Order actually went through but API reported balance lag)
                if (errorData.includes("not enough balance") && errorData.includes("sum of matched orders")) {
                    console.log(`[Engine] 🛡️🛰️⚓ Detected LATE-SUCCESS: Order matched but balance report lagged. Treating as success.`);
                    order = { orderID: "MATCHED_LATE", status: "FILLED" };
                } else {
                    console.error(`[Engine] 🛡️⚠️ SDK EXECUTION FAILED:`, errorData);
                    
                    if (err.response?.status === 403) {
                        console.error(`[Engine] 🛡️🛰️⚓ Geoblock persistent. Proxy Ireland check required.`);
                    }
                    
                    sendTelegramAlert(`🚨 *OFFICIAL SDK ERROR*\nOrder failed for ${side}: ${errorData}`);
                    return;
                }
            }
        }

        // --- COMMON STATE TRACKING (v20.4.0: Accept any non-null order response) ---
        if (IS_SIMULATION_ENABLED || (order && typeof order === 'object')) {
            fetchStrikeFromPolymarket('BTC', slotStart).then(os => {
                if (os && activePosition && activePosition.slotStart === slotStart) {
                    activePosition.officialStrike = os;
                    const list = loadActivePositions();
                    const idx = list.findIndex(p => p.tokenId === activePosition.tokenId);
                    if (idx !== -1) {
                        list[idx].officialStrike = os;
                        saveActivePositions(list);
                    }
                }
            });

            activePosition = {
                tokenId: String(tokenId), // v34.4: Force String for SL Sentinel reliability
                conditionId: currentSig.conditionId,
                buyPrice: executionPrice,
                strike: currentSig.strike, // Binance reference (Signal)
                officialStrike: currentSig.strike, // Temp fallback
                entryAssetPrice: mv.bSpot, // v35.0.0: Binance Shadow Reference
                amount: safeQty,
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
                // v34.3.6: One alert per slot, period.
                if (lastAlertedSlot !== slotStart) {
                    const sideLabel = side === 'YES' ? 'UP' : 'DOWN';
                    const simEntryMsg = `🧪 *SIMULATION ENTRY : BTC ${sideLabel}* 🧪\n\n` +
                                        `• Side: ${side === 'YES' ? 'UP 🚀' : 'DOWN 📉'}\n` +
                                        `• Price: $${executionPrice} (Taker)\n` +
                                        `• Qty: ${safeQty} 📦\n` +
                                        `• Mise: $${tradeAmountUsd.toFixed(2)} 🏦\n` +
                                        `• Latency: ${totalLatency}ms ⚡`;
                    sendTelegramAlert(simEntryMsg);
                    lastAlertedSlot = slotStart;
                }
                
                // v31.6 True North: Accounting Precision
                const actualCost = safeQty * executionPrice;
                const change = tradeAmountUsd - actualCost;
                
                const result = await updateVirtualBalance(-actualCost);
                const finalBal = parseFloat((typeof result === 'object' && result !== null) ? (result.balance ?? 0) : (result ?? 0));
                console.log(`[Engine] 🧪 SIMULATION: Order placed | Cost: $${actualCost.toFixed(3)} | New Bal: $${finalBal.toFixed(2)} (Change kept: $${change.toFixed(3)})`);
            } else {
                if (lastAlertedSlot !== slotStart) {
                    const sideLabel = side === 'YES' ? 'UP' : 'DOWN';
                    const entryMsg = `🎯 *SNIPER ENTRY : BTC ${sideLabel}* 🎯\n\n` +
                                    `• Side: ${side === 'YES' ? 'UP 🚀' : 'DOWN 📉'}\n` +
                                    `• Price: $${executionPrice}\n` +
                                    `• Qty: ${safeQty} 📦\n` +
                                    `• Mise: $${tradeAmountUsd.toFixed(2)} 🏦\n` +
                                    `• Latency: ${totalLatency}ms ⚡`;
                    sendTelegramAlert(entryMsg);
                    lastAlertedSlot = slotStart;
                }
            }

            // v37.0.0: Launch Strike-Aware Stop Loss Sentinel
            const stopLossPct = parseFloat(process.env.STOP_LOSS_PCT || "0.14"); // Locked at 14%
            SLSentinel.startMonitoring(
                String(tokenId), 
                executionPrice, 
                side, 
                stopLossPct, 
                mv.bSpot, 
                currentSig.strike, 
                async (info) => {
                    await executeEmergencyExit(info);
                }
            );
        }

    } catch (e) {
        console.error('[Engine] Main Loop Error:', e.message);
    } finally {
        isMainLoopRunning = false; // v34.3.6: Release loop lock
    }
}

/**
 * Sentinel Loop (v16.19.0)
 * Gère les résumés de 12h et détecte les marchés résolus (Redeems).
 */
async function performanceLoop() {
    if (isPerformanceLoopRunning) return; // v24.2.0: Prevent stacked execution
    isPerformanceLoopRunning = true;
    
    try {
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
            // Minuit (00:05 - 00:20)
            else if (hour === 0 && minute >= 5 && minute < 20 && (lastDigestDate !== dateStr || lastDigestWindow !== 'night')) {
                window = getNoonToMidnightWindowMs(tz, dateStr);
                windowName = 'Soir';
                lastDigestWindow = 'night';
                lastDigestDate = dateStr;
            }

            if (window) {
                try {
                    const logPath = path.join(process.cwd(), 'orders.log');
                    if (fs.existsSync(logPath)) {
                        const stats = fs.statSync(logPath);
                        const sizeMb = stats.size / (1024 * 1024);
                        if (sizeMb < 1.0) {
                            const logs = fs.readFileSync(logPath, 'utf8');
                            const digestStats = computeMiddayDigestStats(logs, window.startMs, window.endMs);
                            const msg = formatMiddayDigestMessage(digestStats, { 
                                timeZone: tz, 
                                dateStr, 
                                windowLabel: windowName, 
                                streakContextLabel: lastDigestWindow === 'morning' ? 'midi' : 'minuit' 
                            });
                            await sendTelegramAlert(msg);
                            fs.writeFileSync(logPath, '', 'utf8');
                            console.log(`[Sentinel] Digest ${windowName} envoyé et logs tronqués.`);
                        }
                    }
                } catch (digestErr) {
                    console.error(`[Sentinel] Erreur digest:`, digestErr.message);
                }
            }
        }

        // --- 📊 REPORTING & PULSE (Every 1s) ---
    } catch (globalErr) {
        console.error(`[Sentinel] Global Loop Error:`, globalErr.message);
    } finally {
        isPerformanceLoopRunning = false;
    }
}

// Relayer & Redeem functions removed in v49.2.0 in favor of Early Exit Strategy.

/**
 * v32.0: Smart Orderbook Sweep Logic
 * Calculates the price level needed to clear the entire quantity.
 */
function calculateSellSweepPrice(qty, bids) {
    if (!bids || bids.length === 0) return null;
    let remaining = qty;
    let worstPrice = parseFloat(bids[0].price);
    
    for (const bid of bids) {
        const p = parseFloat(bid.price);
        const s = parseFloat(bid.size);
        const take = Math.min(remaining, s);
        remaining -= take;
        worstPrice = p;
        if (remaining <= 0) break;
    }
    return worstPrice;
}

/**
 * Emergency Sell Execution via Relayer (v17.1.0)
 * Gasless and Ultra-Fast sub-1s exit.
 */
async function executeEmergencyExit(info) {
    try {
        const exitStart = Date.now();
        console.log(`[Emergency] 🚨 EXECUTION: Handling exit for ${info.tokenId}...`);
        
        // Fetch current quantity from active position
        const positions = loadActivePositions();
        const pos = positions.find(p => String(p.tokenId) === String(info.tokenId));
        if (!pos) throw new Error(`Position data not found for exit: ${info.tokenId}`);

        // v17.36.10: IMMUNE TO NETWORK CALLS IN SIMULATION
        if (pos.isSimulated) {
            // v31.0: Real-world Fee Deduction (Approx 1.8% exit fee)
            const exitFee = 0.018;
            const remainingValue = (info.currentPrice * (1 - exitFee)) * pos.amount;
            
            const newBalValue = await updateVirtualBalance(remainingValue);
            const finalBal = typeof newBalValue === 'number' ? newBalValue : (newBalValue?.balance || 0);

            console.log(`[Emergency] SIMULATION EXIT: Price $${info.currentPrice} | Recovery: +$${remainingValue.toFixed(2)} (Fees incl.)`);
            
            // v34.4.6: Immediate Archival for Emergency EXIT
            try {
                Analytics.recordTrade({
                    asset: pos.asset || 'BTC',
                    slug: pos.slug || 'BTC-EMERGENCY',
                    isSimulated: true,
                    side: pos.side,
                    entryPrice: pos.buyPrice,
                    exitPrice: info.currentPrice,
                    quantity: pos.amount,
                    pnlUsd: remainingValue - (pos.buyPrice * pos.amount),
                    isWin: (remainingValue > (pos.buyPrice * pos.amount))
                });
            } catch (e) { console.error('[ArchivalError] Emergency Sync failed:', e.message); }
            
            // v17.53.0: CLEANUP FIRST, ALERT LATER (Robustness)
            activePosition = null;
            await saveActivePositions(positions.filter(p => p.tokenId !== info.tokenId));
            SLSentinel.stopMonitoring();

            const exitLatency = Date.now() - exitStart;
            const exitMsg = `--- SORTIE SIMULEE (STOP LOSS) ---\n\n` +
                            `• Slot: ${pos.slotStart}\n` +
                            `• Entry: $${pos.buyPrice}\n` +
                            `• Exit: $${info.currentPrice}\n` +
                            `• Pnl: ${(info.pnlPct * 100).toFixed(2)}%\n` +
                            `• Recupere : +${remainingValue.toFixed(2)}$\n` +
                            `• Capital actuel : $${finalBal.toFixed(2)}\n` +
                            `• Latency: ${exitLatency}ms ⚡`;
            
            // v46.0.1: ENSURE PERSISTENCE FOR AUDIT
            try {
                Analytics.recordTrade({
                    asset: pos.asset || 'BTC',
                    slug: pos.slug,
                    isSimulated: true,
                    side: pos.side,
                    entryPrice: pos.buyPrice,
                    exitPrice: info.currentPrice,
                    quantity: pos.amount,
                    pnlUsd: info.pnlUsd,
                    pnlPct: info.pnlPct,
                    isWin: false
                });
            } catch (e) { console.error('[ArchivalError] SL Sync failed:', e.message); }

            try {
                await sendTelegramAlert(exitMsg);
            } catch (teleErr) {
                console.error('[Emergency] Telegram Alert failed but exit was successful.');
            }
            return;
        }

        const proxyWallet = process.env.CLOB_FUNDER_ADDRESS;
        const apiKey = process.env.RELAYER_API_KEY;

        // v24.0.0: High-Precision Spot Fetch
        const priceResp = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDC", { timeout: 8000, httpsAgent: null });
        const currentSpot = parseFloat(priceResp.data.price);

        console.log(`[Emergency] 🛡️🛰️⚓ Sending SELL order to CLOB for ${pos.tokenId}...`);
        await ensureClobClient(); // Safety first
        
        // v17.95.0: Triple-check input validity for emergency exit
        const safePrice = Number(info.currentPrice) * 0.98;
        const safeQty = Math.floor(Number(pos.amount));

        if (!isFinite(safePrice) || !isFinite(safeQty) || safeQty <= 0) {
            throw new Error(`Invalid Emergency Data: Price=${safePrice}, Qty=${safeQty}`);
        }

        // v25.0.0: Official SDK Shielded Exit
        try {
            console.log(`[Emergency] 🏹 Placing OFFICIAL EXIT via Shielded SDK...`);
            
                // v25.2.0: Dynamic Emergency Precision
                let emergencyTickSize = "0.01";
                try {
                    emergencyTickSize = await clobClient.getTickSize(pos.tokenId) || "0.01";
                    if (Number(emergencyTickSize) >= 1) {
                        emergencyTickSize = "0.01";
                    }
                } catch (e) { }

                // v49.1.4: ULTRA-AGGRESSIVE EMERGENCY EXIT
                let success = false;
                const maxAttempts = 5; 
                let lastError = "";
                
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        const book = await clobClient.getOrderBook(pos.tokenId).catch(() => null);
                        const bids = book?.bids || [];
                        
                        if (bids.length === 0 && attempt < 3) {
                            console.warn(`[Emergency] ⚠️ Attempt ${attempt}/${maxAttempts}: Orderbook empty. Retrying in 400ms...`);
                            await new Promise(r => setTimeout(r, 400));
                            continue;
                        }

                        // v49.1.4: Be increasingly aggressive on price
                        const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : info.currentPrice;
                        const sweepPrice = calculateSellSweepPrice(safeQty, bids);
                        
                        let exitPrice;
                        let useFOK = (attempt <= 2); // Use FOK for first 2 attempts, then GTC to force fill

                        if (attempt === 1) {
                            // v50.4.2: If bestBid is 0, force 0.01 immediately to avoid price=0 error
                            exitPrice = sweepPrice 
                                ? Math.max(0.01, parseFloat((sweepPrice * 0.99).toFixed(4)))
                                : (bestBid > 0 ? Math.max(0.01, parseFloat((bestBid * 0.98).toFixed(4))) : 0.01);
                        } else if (attempt <= 4) {
                            // Aggressive discount
                            exitPrice = Math.max(0.01, parseFloat((bestBid * 0.80).toFixed(4)));
                        } else {
                            // Last resort: Nuclear exit at floor price to match ANY bid
                            exitPrice = 0.01;
                            useFOK = false;
                        }
                        
                        console.log(`[Emergency] 🎯 Attempt ${attempt}/${maxAttempts} | Mode: ${useFOK ? 'FOK' : 'GTC'} | Bid: $${bestBid} | Exit: $${exitPrice} | Qty: ${safeQty}`);

                        const response = await clobClient.createAndPostOrder(
                            {
                                tokenID: pos.tokenId,
                                price: exitPrice,
                                size: safeQty,
                                side: Side.SELL
                            },
                            {
                                tickSize: emergencyTickSize,
                                negRisk: pos.negRisk ?? (pos.tokenId.length > 50)
                            },
                            useFOK ? OrderType.FOK : OrderType.GTC
                        );

                        if (response && response.orderID) {
                            console.log(`[Emergency] ✅ OFFICIAL EXIT ACCEPTED on attempt ${attempt}: ${response.orderID}`);
                            
                            updateStreak(false); // v46.0.9: Mandatory momentum reset on SL
                            // Cleanup
                            activePosition = null;
                            await saveActivePositions(positions.filter(p => p.tokenId !== info.tokenId));
                            SLSentinel.stopMonitoring();
                            
                            const exitLatency = Date.now() - exitStart;
                            const pnlSign = info.pnlUsd >= 0 ? "+" : "";
                            const finalBal = await getClobBalance().catch(() => 0);
                            
                            const exitMsg = `🚨 *SORTIE D'URGENCE (STOP LOSS)* 🚨\n\n` +
                                            `📦 *Market*: \`${pos.slug}\`\n` +
                                            `• Side: ${pos.side === 'YES' ? 'UP 🚀' : 'DOWN 📉'}\n` +
                                            `• Entry: $${pos.buyPrice}\n` +
                                            `• Exit: $${exitPrice}\n` +
                                            `📉 *PnL*: ${pnlSign}$${info.pnlUsd.toFixed(2)} (${(info.pnlPct * 100).toFixed(2)}%)\n` +
                                            `🏦 *Solde*: **$${parseFloat(finalBal).toFixed(2)}**\n` +
                                            `• Latency: ${exitLatency}ms ⚡`;
                            
                            // v46.0.1: ENSURE PERSISTENCE FOR AUDIT
                            updateStreak(false, 0); // v46.0.4: RESET ON SL
                            try {
                                Analytics.recordTrade({
                                    asset: pos.asset || 'BTC',
                                    slug: pos.slug,
                                    isSimulated: false,
                                    side: pos.side,
                                    entryPrice: pos.buyPrice,
                                    exitPrice: exitPrice,
                                    quantity: pos.amount,
                                    pnlUsd: info.pnlUsd,
                                    pnlPct: info.pnlPct,
                                    isWin: false
                                });
                            } catch (e) { console.error('[ArchivalError] Real SL Sync failed:', e.message); }

                            await sendTelegramAlert(exitMsg);
                            success = true;
                            break; // EXIT LOOP ON SUCCESS
                        }
                    } catch (attemptErr) {
                        lastError = attemptErr.message;
                        console.warn(`[Emergency] ⚠️ Attempt ${attempt}/${maxAttempts} FAILED: ${lastError}`);
                        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 300));
                    }
                }

                if (!success) {
                    throw new Error(`All exit attempts failed. Last error: ${lastError || 'Empty Orderbook'}`);
                }
        } catch (err) {
            console.error(`[Emergency] 🛡️⚠️ SDK Exit Failed:`, err.message);
            throw err;
        }

    } catch (err) {
        console.error(`[Emergency] 🛡️⚠️ Exit Process Failed:`, err.message);
        await sendTelegramAlert(`🛡️⚠️ *ERREUR SORTIE D'URGENCE*\nLe bot n'a pas pu sortir : ${err.message}`);
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
        const res = await axios.get(url, { 
            httpsAgent: proxyAgent,
            timeout: 5000 
        });
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
    console.error("🛡️⚠️ v17.10.0 FATAL:", err.message);
    process.exit(1);
});

// --- v50.1.0: Glitch-Proof Position Monitoring ---
const slConfirmations = new Map();

async function monitorPositionsFast(mv) {
    try {
        const positions = loadActivePositions();
        if (positions.length === 0) return;

        const now = Date.now();
        let changed = false;

        for (let i = positions.length - 1; i >= 0; i--) {
            const pos = positions[i];
            if (pos.resolved || pos.redeemed) continue;

            try {
                // 1. Fetch Real-time Depth
                const book = await clobClient.getOrderBook(pos.tokenId).catch(() => null);
                const bids = book?.bids || [];
                const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
                
                let currentPrice = bestBid;
                if (currentPrice === 0) {
                    const mInfo = await clobClient.getMarket(pos.conditionId);
                    const targetToken = mInfo.tokens.find(t => String(t.token_id) === String(pos.tokenId));
                    currentPrice = targetToken ? parseFloat(targetToken.price) : 0;
                }

                if (currentPrice === 0) continue;

                // 2. STOP LOSS CHECK (v50.4.0: GHOST-DECISION - Decision on Gamma/Theoretical price)
                const bSpot = mv ? mv.bSpot : (global.lastBinanceSpot || 0);
                
                // v50.4.0: We use currentPrice (Integrated) instead of waiting for a real bid.
                // This ensures SL triggers even during a "Liquidity Hole".
                const isViolated = RiskManager.shouldTriggerStopLoss(
                    pos.buyPrice,
                    currentPrice, // Using Integrated Price for decision
                    currentPrice, 
                    pos.side,
                    pos.entryAssetPrice,
                    bSpot,
                    pos.strike
                );

                if (isViolated) {
                    // v50.1.0: 500ms Confirmation Timer (Enough to skip 1ms empty book glitches)
                    const firstSeen = slConfirmations.get(pos.tokenId) || now;
                    if (!slConfirmations.has(pos.tokenId)) slConfirmations.set(pos.tokenId, now);
                    
                    if (now - firstSeen >= 500) {
                        const pnlPct = (currentPrice - pos.buyPrice) / pos.buyPrice;
                        console.log(`[Sentinel] 🚨 STOP LOSS CONFIRMED for ${pos.slug} | Bid: $${bestBid} (PnL: ${(pnlPct * 100).toFixed(2)}%)`);
                        await executeEmergencyExit({
                            tokenId: pos.tokenId,
                            currentPrice: currentPrice,
                            pnlUsd: (currentPrice * pos.amount) - (pos.buyPrice * pos.amount),
                            pnlPct: pnlPct
                        });
                        positions.splice(i, 1);
                        slConfirmations.delete(pos.tokenId);
                        changed = true;
                        continue;
                    } else {
                        if (now % 1000 < 100) console.log(`[Sentinel] ⏳ SL Pending confirmation for ${pos.slug}...`);
                    }
                } else {
                    slConfirmations.delete(pos.tokenId);
                }

                // 3. INSTANT TAKE PROFIT / EARLY EXIT
                const timeUntilEnd = pos.slotEnd - now;
                const isInstantTP = currentPrice >= 0.99;
                
                // v50.2.3: Only try to sell BEFORE the slot ends. After T=0, it's too late to sell.
                const isTimeExit = (timeUntilEnd <= 10000 && timeUntilEnd > 0);

                if (isInstantTP || isTimeExit) {
                    const reason = isInstantTP ? "INSTANT_TP_99" : `EARLY_EXIT_T${Math.round(timeUntilEnd/1000)}s`;
                    console.log(`[Sentinel] 🚀 ${reason} Triggered for ${pos.slug}. Selling at $${currentPrice}...`);
                    
                    const response = await clobClient.createAndPostOrder({
                        tokenID: pos.tokenId,
                        price: 0.01,
                        size: pos.amount,
                        side: Side.SELL
                    });

                    // v50.2.3: Check if order actually succeeded
                    const orderID = response?.orderID || response?.id || null;
                    
                    if (orderID) {
                        console.log(`[Sentinel] ✅ SOLD (${reason}): ${pos.slug} | Order: ${orderID}`);
                        
                        const pnlUsd = (currentPrice * pos.amount) - (pos.buyPrice * pos.amount);
                        const pnlPct = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
                        const pnlSign = pnlUsd >= 0 ? "+" : "";
                        
                        const finalBal = await getClobBalance().catch(() => 0);
                        
                        await sendTelegramAlert(`${pnlUsd >= 0 ? '💰' : '📉'} *VENTE ${pnlUsd >= 0 ? 'PROFIT' : 'STOP LOSS'} (${isInstantTP ? 'TP 99c' : 'T-10s'})*\n\n` +
                            `📦 *Market*: \`${pos.slug}\`\n` +
                            `💵 *Prix*: $${currentPrice.toFixed(3)}\n` +
                            `📈 *PnL*: ${pnlSign}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)\n` +
                            `🏦 *Solde*: **$${parseFloat(finalBal).toFixed(2)}**\n\n` +
                            `🆔 *Order*: \n\`${orderID}\``);

                        Analytics.recordTrade({
                            asset: pos.asset || 'BTC',
                            slug: pos.slug,
                            isSimulated: !!pos.isSimulated,
                            side: pos.side,
                            entryPrice: pos.buyPrice,
                            exitPrice: currentPrice,
                            quantity: pos.amount,
                            pnlUsd: pnlUsd,
                            isWin: currentPrice > 0.5,
                            note: reason
                        });
                        
                        positions.splice(i, 1);
                        changed = true;
                        continue;
                    } else {
                        console.warn(`[Sentinel] ⚠️ Order failed for ${pos.slug}:`, response);
                        // If it failed because market is closed, archive it
                        if (timeUntilEnd < 0) {
                            positions.splice(i, 1);
                            changed = true;
                        }
                    }
                }
                
                // Fallback: Emergency Archive
                if (now > pos.slotEnd + 600000) {
                    console.log(`[Sentinel] 🛡️⚠️ Emergency Archive for ${pos.slug}`);
                    positions.splice(i, 1);
                    changed = true;
                }
            } catch (err) {}
        }
        if (changed) saveActivePositions(positions);
    } catch (e) {}
}
