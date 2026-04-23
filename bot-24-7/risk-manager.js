/**
 * v42.0 Lightning SL Risk Manager
 * Immediate Stop Loss at 12% (No filters, no Binance).
 */

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const FIXED_STOP_LOSS = 0.10; // 10%

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
    const DEFAULT_STAKE = 100.0;
    const PERCENT_STAKE = 0.10;
    let suggestedStake = balance * PERCENT_STAKE;
    let finalStake = Math.min(DEFAULT_STAKE, suggestedStake);
    if (finalStake < 5) finalStake = 5;
    return parseFloat(finalStake.toFixed(2));
}
