/**
 * Limit Order Utils (v7.0.0)
 * Helpers for calculating optimal "Maker" prices and managing the order life cycle.
 */

export const TICK_SIZE = 0.001; // Minimum increment on Polymarket Yes/No tokens

/**
 * Calculates the optimal price for a "Maker" order.
 * Goal: Be at the top of the book (Best Bid + 0.001) without crossing into the "Taker" zone.
 * 
 * @param {string} side - "Buy" or "Sell" (usually "Buy" for our entry)
 * @param {number} bestBid - Current highest bid on the book
 * @param {number} bestAsk - Current lowest ask on the book
 */
export function calculateMakerPrice(side, bestBid, bestAsk) {
    if (side === 'Buy' || side === 'Yes' || side === 'Up') {
        // We want to buy. To be a Maker, we must be at or below bestBid.
        // To be FAST, we want to be EXACTLY at bestBid + 0.001 (if that doesn't cross bestAsk)
        let target = (bestBid || 0) + TICK_SIZE;
        
        // Safety: Never pay more than the Best Ask (which would make us a Taker)
        target = Math.min(target, (bestAsk || 1) - TICK_SIZE);
        
        // Final sanity check: round to TICK_SIZE
        return Math.round(target * 1000) / 1000;
    } else {
        // Selling (not used for entry, but for exit/SL)
        let target = (bestAsk || 1) - TICK_SIZE;
        target = Math.max(target, (bestBid || 0) + TICK_SIZE);
        return Math.round(target * 1000) / 1000;
    }
}

/**
 * Validates if an order is still "Safe" relative to the current market.
 * Used for the 15s cleanup loop.
 */
export function isOrderStale(orderPrice, currentBestBid, currentBestAsk, threshold = 0.01) {
    // If the market has moved away from our limit price by more than 1 cent, it's stale.
    const gap = Math.abs(orderPrice - ((currentBestBid + currentBestAsk) / 2));
    return gap > threshold;
}
