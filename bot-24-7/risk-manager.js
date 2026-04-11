/**
 * v16.16.0: Risk & Capital Management
 * Logic: Compound reinvestment & Stop Loss
 */

const MAX_BET_USD = 100;
const INITIAL_BET_USD = 10; // Default if not specified

let sessionStartingBalance = null;

/**
 * Calculates the next trade size based on compound strategy
 * @param {number} currentBalance - The current USDC/pUSD balance
 * @returns {number} The size of the next trade in USD
 */
export function calculateTradeSize(currentBalance) {
    if (sessionStartingBalance === null) {
        sessionStartingBalance = currentBalance;
    }

    // Compound: reinvest profit
    const sessionProfit = Math.max(0, currentBalance - sessionStartingBalance);
    const calculatedSize = INITIAL_BET_USD + sessionProfit;

    // Cap at $100
    const finalSize = Math.min(calculatedSize, MAX_BET_USD);
    
    console.log(`[RiskManager] Balance: $${currentBalance.toFixed(2)} | Profit: $${sessionProfit.toFixed(2)} | Next Trade: $${finalSize.toFixed(2)}`);
    return finalSize;
}

/**
 * Evaluates if we should exit a position based on Stop Loss
 * @param {number} buyPrice - Price at which we bought 1 share (0-1)
 * @param {number} currentAsk - Current lowest price to sell on book
 * @returns {boolean} True if we should trigger Stop Loss (-10%)
 */
export function shouldTriggerStopLoss(buyPrice, currentAsk) {
    if (!buyPrice || !currentAsk) return false;
    
    const pnlPct = (currentAsk - buyPrice) / buyPrice;
    
    // -10% threshold
    if (pnlPct <= -0.10) {
        console.warn(`[RiskManager] ⚠️ STOP LOSS TRIGGERED: Buy price was ${buyPrice}, Current is ${currentAsk} (PnL: ${(pnlPct * 100).toFixed(2)}%)`);
        return true;
    }
    
    return false;
}

/**
 * Resets the session baseline (e.g. at bot restart)
 * @param {number} initialBalance 
 */
export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log(`[RiskManager] Session Initialized at $${initialBalance}`);
}
