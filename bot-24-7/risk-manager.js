/**
 * v40.2 Pure Sniper Risk Manager
 * Simplified Fixed Stop Loss at 12% with Robust Binance Veto.
 */

let sessionStartingBalance = 0;

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v40.2: Strong Numeric Enforcement (Fix String Comparison Bug)
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const sPrice = parseFloat(strikePrice || 0);
    const aPriceCurrent = parseFloat(currentAssetPrice || 0);

    const FIXED_STOP_LOSS = 0.12; // Strict 12% Net Loss

    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // --- 🛡️ THE BINANCE VETO (Numeric Edition) ---
    if (sPrice > 0 && aPriceCurrent > 0) {
        const isUp = (side === 'UP' || side === 'YES' || side === 'BUY');
        const isWinningOnBinance = isUp ? (aPriceCurrent > sPrice) : (aPriceCurrent < sPrice);
        
        if (isWinningOnBinance) {
            // VETO: We are winning on the underlying asset. 
            // We ignore Polymarket noise even if it crashes to 0.01.
            return false; 
        }
    }

    // --- 🚨 FIXED STOP LOSS (ONLY IF NOT VETOED) ---
    if (netPnlPct <= -FIXED_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 SL TRIGGERED: PnL ${(netPnlPct * 100).toFixed(2)}% | Binance confirms we are NOT winning.`);
        return true;
    }
    
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}

export function calculateTradeSize(balance) {
    const DEFAULT_STAKE = 100.0;
    const PERCENT_STAKE = 0.10; // 10% du capital
    
    let suggestedStake = balance * PERCENT_STAKE;
    let finalStake = Math.min(DEFAULT_STAKE, suggestedStake);
    if (finalStake < 5) finalStake = 5;
    
    return parseFloat(finalStake.toFixed(2));
}
