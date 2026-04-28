/**
 * v46.2.3 Anti-Glitch Shield (Master Recovery)
 * Base stake is fixed at 100$ to ensure consistency.
 * SL tightened to 15% as per USER request.
 */

const FIXED_STOP_LOSS = 0.15; // 15%
const MAX_ALLOWED_SPREAD = 0.12; // 12% spread max to allow SL exit

export function shouldTriggerStopLoss(buyPrice, currentBid, currentAsk, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid || !currentAsk) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const cAsk = parseFloat(currentAsk);

    // 1. Calculate PnL on the Ticket
    const entryFee = 0.018;
    const exitFee = 0.018;
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // 2. Ticket Price Violation?
    const isViolated = netPnlPct <= -FIXED_STOP_LOSS;

    // 3. Spread Filter (Option 3)
    // If the spread is too wide, we don't trigger SL as the price is likely a glitch/fake.
    const spreadPct = (cAsk - cBid) / cAsk;
    const isLiquidityOk = spreadPct <= MAX_ALLOWED_SPREAD;

    if (isViolated && !isLiquidityOk) {
        if (Math.random() < 0.05) {
            console.log(`[Shield] 🛡️⚓ Spread too wide (${(spreadPct * 100).toFixed(1)}%). Blocking SL to avoid glitch exit.`);
        }
        return false; // Liquidity guard
    }

    return isViolated;
}

export function initSession(initialBalance) {
    console.log('[RiskManager] 🛡️⚓ Anti-Glitch Shield v46.2.3 (SL 15%) Active. Session: $' + initialBalance);
}

export function calculateTradeSize(balance) {
    // v46.1.2: Fixed base stake at 100$ as per USER request.
    const FIXED_BASE_STAKE = 100.0;
    return FIXED_BASE_STAKE;
}



