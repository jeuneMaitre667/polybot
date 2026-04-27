/**
 * v46.1.0 High-Cap Risk Manager
 * Removed 100$ cap to enable House Money Strategy.
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
    const PERCENT_STAKE = 0.10; // 10% pure
    let finalStake = balance * PERCENT_STAKE;
    if (finalStake < 5) finalStake = 5;
    // v46.1.0: Removed the 100$ CAP
    return parseFloat(finalStake.toFixed(2));
}
