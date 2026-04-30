/**
 * v50.4.8 Risk Manager (ULTRA-SAFE)
 * Base stake is fixed at $2.50 (Safety Mode).
 * SL 14% + 500ms Timer.
 * Delta Shield: SL blocked if Delta >= 0.04% (Balanced confirmation).
 * Exit Mode: GTC + $0.01 slippage margin on Best Bid.
 */

const FIXED_STOP_LOSS = 0.14; // 14%
const CONFIRMATION_DELTA_PCT = 0.04; // v50.4.3: Balanced threshold for SL protection

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
    console.log('[RiskManager] 🛡️🛰️⚓ Switch to REAL TRADING Mode. Fixed $2.50 Stake Active.');
    console.log('[RiskManager] 🛡️⚓ Delta Shield v50.4.8 (Delta 0.04%) + RAW-EXIT Active.');
}


export function calculateTradeSize(balance) {
    const baseStake = 2.5;
    const finalStake = Math.min(baseStake, parseFloat(balance || 0));
    return finalStake;
}





