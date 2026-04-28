/**
 * v46.2.4 Anti-Glitch Shield (Master Recovery)
 * Base stake is fixed at 100$ to ensure consistency.
 * SL tightened to 15%. Spread filter removed for safety.
 */

const FIXED_STOP_LOSS = 0.15; // 15%

export function shouldTriggerStopLoss(buyPrice, currentBid, currentAsk, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);

    // 1. Calculate PnL on the Ticket
    const entryFee = 0.018;
    const exitFee = 0.018;
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // 2. Ticket Price Violation?
    return netPnlPct <= -FIXED_STOP_LOSS;
}

export function initSession(initialBalance) {
    console.log('[RiskManager] 🛡️⚓ Anti-Glitch Shield v46.2.4 (SL 15% + Timer) Active.');
}

export function calculateTradeSize(balance) {
    const FIXED_BASE_STAKE = 100.0;
    return FIXED_BASE_STAKE;
}




