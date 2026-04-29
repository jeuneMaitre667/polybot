/**
 * v46.2.5 Delta-Shield (Final V1 Patch)
 * Base stake is fixed at 100$ to ensure consistency.
 * SL 15% + 1.5s Timer.
 * NEW: SL blocked if Delta > 0.3% (Underlying confirmation).
 */

const FIXED_STOP_LOSS = 0.15; // 15%
const CONFIRMATION_DELTA_PCT = 0.3; // 0.3% underlying gain blocks SL

let dynamicFeeRate = 0.036; // Default fallback (v2: ~3.6% feeRate => 1.8% at p=0.5)

export function setDynamicFees(rate) {
    if (rate && rate > 0) dynamicFeeRate = rate;
}

export function shouldTriggerStopLoss(buyPrice, currentBid, currentAsk, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const assetPrice = parseFloat(currentAssetPrice);
    const strike = parseFloat(strikePrice);

    // 1. Calculate PnL on the Ticket
    // v49.1.0: Using Dynamic Protocol Fees
    const entryFee = dynamicFeeRate;
    const exitFee = dynamicFeeRate;
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
    console.log('[RiskManager] 🛡️🛰️⚓ Switch to REAL TRADING Mode. Fixed $3.00 Stake Active.');
    console.log('[RiskManager] 🛡️⚓ Anti-Glitch Shield v47.0.0 (Delta 0.3%) Active.');
}

export function calculateTradeSize(balance) {
    // v47.1.0: Real Trading Transition. Fixed $3.00 stake.
    // If balance < $3, we use the remaining amount (compound).
    const baseStake = 3.0;
    const finalStake = Math.min(baseStake, parseFloat(balance || 0));
    return finalStake;
}





