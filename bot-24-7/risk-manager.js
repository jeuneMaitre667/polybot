/**
 * v16.16.0: Risk & Capital Management
 * Logic: Compound reinvestment & Stop Loss
 */

const INITIAL_BET_USD = parseFloat(process.env.ORDER_SIZE_USD || "10");
const MAX_BET_USD = parseFloat(process.env.MAX_STAKE_USD || "100");
const SESSION_MAX_LOSS = parseFloat(process.env.MAX_LOSS || "0.10");

let sessionStartingBalance = null;

/**
 * Calculates the next trade size based on compound strategy
 * @param {number} availableBalance - The current USDC/virtual balance
 * @returns {number} The size of the next trade in USD
 */
export function calculateTradeSize(availableBalance) {
    if (sessionStartingBalance === null || sessionStartingBalance === 0) {
        sessionStartingBalance = availableBalance;
    }

    // Compound: reinvest profit
    // current_stake = base_stake + accumulated_profit
    const sessionProfit = Math.max(0, availableBalance - sessionStartingBalance);
    const calculatedSize = INITIAL_BET_USD + sessionProfit;

    // Cap at $100 and available balance
    const finalSize = Math.min(calculatedSize, MAX_BET_USD, availableBalance);
    
    console.log(`[RiskManager] Balance: $${availableBalance.toFixed(2)} | Profit: $${sessionProfit.toFixed(2)} | Next Trade: $${finalSize.toFixed(2)}`);
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
    
    // Stop Loss threshold (from .env)
    if (pnlPct <= -SESSION_MAX_LOSS) {
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
