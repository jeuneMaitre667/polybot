/**
 * v16.16.1: Risk & Capital Management (FIXED v27.7)
 * Logic: Fixed Bet (Safe Mode)
 */

const INITIAL_BET_USD = parseFloat(process.env.ORDER_SIZE_USD || '1.5');
const MAX_BET_USD = parseFloat(process.env.MAX_STAKE_USD || '100');
const SESSION_MAX_LOSS = parseFloat(process.env.MAX_LOSS || '0.10');

let sessionStartingBalance = null;

export function calculateTradeSize(availableBalance) {
    // v30.0: Aggressive Scaling Logic (10% of capital)
    let scaledSize = availableBalance * 0.10;
    
    // Respect bounds: Start at 10$ (INITIAL_BET_USD), Max 100$ (MAX_BET_USD)
    let finalSize = Math.max(INITIAL_BET_USD, Math.min(scaledSize, MAX_BET_USD));
    
    // Absolute Safety buffer (don't go to zero)
    if (finalSize > availableBalance * 0.95) {
        finalSize = availableBalance * 0.95;
    }

    console.log('[RiskManager] Mode: AGGRESSIVE | Balance: $' + availableBalance.toFixed(2) + ' | Next Trade: $' + finalSize.toFixed(2));
    return finalSize;
}

export function shouldTriggerStopLoss(buyPrice, currentAsk) {
    if (!buyPrice || !currentAsk) return false;
    const pnlPct = (currentAsk - buyPrice) / buyPrice;
    if (pnlPct <= -SESSION_MAX_LOSS) {
        console.warn('[RiskManager] ⚠️ STOP LOSS TRIGGERED: Buy price was ' + buyPrice + ', Current is ' + currentAsk + ' (PnL: ' + (pnlPct * 100).toFixed(2) + '%)');
        return true;
    }
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}
