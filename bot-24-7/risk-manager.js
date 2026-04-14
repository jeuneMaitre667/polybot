/**
 * v16.16.1: Risk & Capital Management (FIXED v27.7)
 * Logic: Fixed Bet (Safe Mode)
 */

const INITIAL_BET_USD = parseFloat(process.env.ORDER_SIZE_USD || '1.5');
const MAX_BET_USD = parseFloat(process.env.MAX_STAKE_USD || '100');
const SESSION_MAX_LOSS = parseFloat(process.env.MAX_LOSS || '0.10');

let sessionStartingBalance = null;

/**
 * Calculates the next trade size
 * In SAFE MODE v27.7, we strictly use INITIAL_BET_USD to avoid profit miscalculation.
 * @param {number} availableBalance - The current USDC balance
 * @returns {number} The size of the next trade in USD
 */
export function calculateTradeSize(availableBalance) {
    // We strictly respect INITIAL_BET_USD. We don't reinvest yet to avoid deposit-bugs.
    let finalSize = Math.min(INITIAL_BET_USD, MAX_BET_USD, availableBalance);
    
    // Safety buffer (don't go to zero)
    if (finalSize > availableBalance * 0.95) {
        finalSize = availableBalance * 0.95;
    }

    console.log('[RiskManager] Mode: SAFE (Fixed) | Balance: $' + availableBalance.toFixed(2) + ' | Next Trade: $' + finalSize.toFixed(2));
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
