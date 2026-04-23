/**
 * v40.0 Pure Sniper Risk Manager
 * Simplified Fixed Stop Loss at 12%.
 */

let sessionStartingBalance = 0;

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v40.0: Pure Price Stop Loss (No Binance Shadow)
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);

    const FIXED_STOP_LOSS = 0.12; // Strict 12% Net Loss

    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // --- 🚨 PURE STOP LOSS TRIGGER ---
    if (netPnlPct <= -FIXED_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 FIXED SL TRIGGERED: PnL ${(netPnlPct * 100).toFixed(2)}%`);
        return true;
    }
    
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}

/**
 * Calcule la taille du trade (10% du capital, max 100$)
 */
export function calculateTradeSize(balance) {
    const DEFAULT_STAKE = 100.0;
    const PERCENT_STAKE = 0.10; // 10% du capital
    
    let suggestedStake = balance * PERCENT_STAKE;
    
    // On prend le min entre 10% du capital et 100$
    let finalStake = Math.min(DEFAULT_STAKE, suggestedStake);
    
    // Minimum technique de 5$
    if (finalStake < 5) finalStake = 5;
    
    return parseFloat(finalStake.toFixed(2));
}
