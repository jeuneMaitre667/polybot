/**
 * v46.1.2 Fixed Base Risk Manager
 * Base stake is fixed at 100$ to ensure consistency.
 * House Money (streakProfit) is added on top in index.js.
 */

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const FIXED_STOP_LOSS = 0.20; // 20%

    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // --- 🚨 IMMEDIATE STOP LOSS (NO FILTERS) ---
    if (netPnlPct <= -FIXED_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 IMMEDIATE SL: PnL ${(netPnlPct * 100).toFixed(2)}%`);
        return true;
    }
    
    return false;
}

export function initSession(initialBalance) {
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}

export function calculateTradeSize(balance) {
    // v46.1.2: Fixed base stake at 100$ as per USER request.
    const FIXED_BASE_STAKE = 100.0;
    return FIXED_BASE_STAKE;
}
