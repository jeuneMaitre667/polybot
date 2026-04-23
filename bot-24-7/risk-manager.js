/**
 * v41.0 The Tank Risk Manager
 * Pure Price-Based SL with Persistence Filter to ignore fake dips.
 */

let lastNetPnl = 0;
let failCount = 0;

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const FIXED_STOP_LOSS = 0.12; // 12%

    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // --- 🚨 PERSISTENCE FILTER (The Anti-Mèche) ---
    // The price must be below the SL for at least 2 consecutive checks to trigger.
    if (netPnlPct <= -FIXED_STOP_LOSS) {
        failCount++;
        if (failCount >= 3) { // Requires ~1.5 to 2 seconds of bad price
            console.warn(`[RiskManager] 🚨 CONFIRMED SL: PnL ${(netPnlPct * 100).toFixed(2)}% (Confirmed over 3 checks)`);
            return true;
        } else {
            console.log(`[RiskManager] 🛡️ Ignoring potential flash-mèche (${(netPnlPct * 100).toFixed(2)}%). Count: ${failCount}`);
            return false;
        }
    } else {
        failCount = 0; // Reset if price recovers
    }
    
    return false;
}

export function initSession(initialBalance) {
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}

export function calculateTradeSize(balance) {
    const DEFAULT_STAKE = 100.0;
    const PERCENT_STAKE = 0.10;
    let suggestedStake = balance * PERCENT_STAKE;
    let finalStake = Math.min(DEFAULT_STAKE, suggestedStake);
    if (finalStake < 5) finalStake = 5;
    return parseFloat(finalStake.toFixed(2));
}
