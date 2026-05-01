import fs from 'fs';
import { CONFIG, STATE } from './config.js';
import { ensureClobClient } from './clob.js';
import { getUnifiedMarketState, validateSniperConditions } from './strategy.js';
import { executeTrade } from './execution.js';
import { fetchSignals } from '../../signal-engine.js';
import BinanceWS from '../../binance-ws.js';
import { sendTelegramAlert } from '../../telegramAlerts.js';
import * as RiskManager from '../../risk-manager.js';
import { getVirtualBalance } from '../../src/core/virtual-wallet.js';
import { timeKeeper } from '../../src/core/ntp-client.js';

const slotStrikeLock = new Map();

async function mainLoop() {
    if (STATE.isMainLoopRunning) return;
    STATE.isMainLoopRunning = true;

    try {
        const now = timeKeeper.getNow();
        const slotStart = Math.floor(now / 300000) * 300000;
        const secondsLeft = Math.floor((slotStart + 300000 - now) / 1000);

        // 1. Get Unified Market State
        const marketState = await getUnifiedMarketState('BTC', slotStrikeLock);
        if (marketState) {
            global.lastBinanceSpot = marketState.bSpot;
        }

        // 2. Persistent Slot Lock Check
        if (STATE.lastExecutedSlot === slotStart) return;
        
        try {
            if (fs.existsSync(CONFIG.LAST_TRADE_FILE)) {
                const last = JSON.parse(fs.readFileSync(CONFIG.LAST_TRADE_FILE, 'utf8'));
                if (last.slot === slotStart) {
                    STATE.lastExecutedSlot = slotStart;
                    return;
                }
            }
        } catch (e) {}

        // 3. Strategy Validation (Delta & Window)
        const condition = validateSniperConditions(marketState, secondsLeft);
        if (!condition.isValid) {
            if (now % 30000 < 1000) {
                console.log(`[Engine] Skip: ${condition.reason}`);
            }
            return;
        }

        // 4. Execution Readiness
        if (!(await ensureClobClient())) {
            console.error("[Engine] 🛡️⚠️ SKIP: Wallet not ready.");
            return;
        }

        // 5. Risk & Sizing
        const baseBalance = CONFIG.IS_SIMULATION_ENABLED ? getVirtualBalance() : STATE.userBalance;
        if (baseBalance === null) return;
        
        const tradeAmountUsd = RiskManager.calculateTradeSize(baseBalance);
        if (tradeAmountUsd < 1.0) return;

        // 6. Signal Fetch & Execution
        const signalData = await fetchSignals('BTC').catch(() => ({ signals: [] }));
        
        STATE.lastExecutedSlot = slotStart;
        try {
            fs.writeFileSync(CONFIG.LAST_TRADE_FILE, JSON.stringify({ slot: slotStart, time: new Date().toISOString() }));
        } catch (e) {}

        await executeTrade(marketState, signalData, tradeAmountUsd);

    } catch (e) {
        console.error('[Engine] Main Loop Error:', e.message);
    } finally {
        STATE.isMainLoopRunning = false;
    }
}

async function scheduledMainLoop() {
    try {
        await mainLoop();
    } catch (err) {} finally {
        const jitter = Math.floor(Math.random() * 100) + 500;
        setTimeout(scheduledMainLoop, jitter);
    }
}

import { reportingLoop } from './reporting.js';
import { turboSentinel } from './sentinel.js';

async function init() {
    console.log("=== 🛡️⚓ ENGINE V2 ONLINE ===");
    BinanceWS.start();
    await ensureClobClient();
    
    // Pulse Loops
    setTimeout(scheduledMainLoop, 500);
    reportingLoop();
    turboSentinel();
}

init().then(async () => {
    await timeKeeper.sync();
    setInterval(() => timeKeeper.sync(), 12 * 60 * 60 * 1000);
}).catch(err => console.error("FATAL:", err.message));
