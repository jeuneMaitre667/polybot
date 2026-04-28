/**
 * v46.2.5 Delta-Shield (Final V1 Patch)
 * Base stake is fixed at 100$ to ensure consistency.
 * SL 15% + 1.5s Timer.
 * NEW: SL blocked if Delta > 0.6% (Underlying confirmation).
 */

const FIXED_STOP_LOSS = 0.15; // 15%
const CONFIRMATION_DELTA_PCT = 0.6; // 0.6% underlying gain blocks SL

export function shouldTriggerStopLoss(buyPrice, currentBid, currentAsk, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const assetPrice = parseFloat(currentAssetPrice);
    const strike = parseFloat(strikePrice);

    // 1. Calculate PnL on the Ticket
    const entryFee = 0.018;
    const exitFee = 0.018;
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    const isTicketViolated = netPnlPct <= -FIXED_STOP_LOSS;

    if (!isTicketViolated) return false;

    // 2. Delta Shield Confirmation (Option 1/46.2.5)
    // If BTC is winning by more than 0.6%, we block the SL.
    if (strike > 0 && assetPrice > 0) {
        let deltaPct = 0;
        if (side === 'YES') {
            deltaPct = ((assetPrice - strike) / strike) * 100;
        } else {
            deltaPct = ((strike - assetPrice) / strike) * 100;
        }

        if (deltaPct >= CONFIRMATION_DELTA_PCT) {
            if (Math.random() < 0.1) {
                console.log(`[Shield] 🛡️⚓ Delta Shield Active: winning by ${deltaPct.toFixed(3)}%. Blocking SL wick.`);
            }
            return false; // Block SL
        }
    }

    return true;
}

export function initSession(initialBalance) {
    console.log('[RiskManager] 🛡️⚓ Anti-Glitch Shield v46.2.5 (Delta 0.6%) Active.');
}

export function calculateTradeSize(balance) {
    const FIXED_BASE_STAKE = 100.0;
    return FIXED_BASE_STAKE;
}





