/**
 * v16.16.1: Risk & Capital Management (FIXED v27.7)
 * Logic: Fixed Bet (Safe Mode)
 */

const INITIAL_BET_USD = parseFloat(process.env.ORDER_SIZE_USD || '1.5');
const MAX_BET_USD = parseFloat(process.env.MAX_STAKE_USD || '100');
const SESSION_MAX_LOSS = parseFloat(process.env.MAX_LOSS || '0.10');

let sessionStartingBalance = null;

export function calculateTradeSize(availableBalance) {
    // v31.8: Full Compounding Logic (100% of capital reinvested)
    let scaledSize = availableBalance; // Reinvest everything
    
    // Respect bounds: Start at 10$ (INITIAL_BET_USD), Max 100$ (MAX_BET_USD)
    let finalSize = Math.max(INITIAL_BET_USD, Math.min(scaledSize, MAX_BET_USD));
    
    // Absolute Safety buffer (don't go to zero)
    if (finalSize > availableBalance * 0.98) {
        finalSize = availableBalance * 0.98;
    }

    console.log('[RiskManager] Mode: AGGRESSIVE | Balance: $' + availableBalance.toFixed(2) + ' | Next Trade: $' + finalSize.toFixed(2));
    return finalSize;
}

export function shouldTriggerStopLoss(buyPrice, currentBid) {
    if (!buyPrice || !currentBid) return false;
    
    // v31.0 Swiss Guard: Fee-Aware Net PnL
    // Estimate 1.8% fee on entry and 1.8% on exit (Total approx 3.6% overhead)
    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = buyPrice * (1 + entryFee);
    const effectiveExit = currentBid * (1 - exitFee);
    
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;
    
    if (netPnlPct <= -SESSION_MAX_LOSS) {
        console.warn(`[RiskManager] 🛡️ SWISS GUARD TRIGGER: Net PnL is ${(netPnlPct * 100).toFixed(2)}% (Limit: -${(SESSION_MAX_LOSS * 100).toFixed(2)}% | Entry: ${buyPrice} | Bid: ${currentBid})`);
        return true;
    }
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}
