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

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v35.0.0: Binance Shadow & Hard Floor Strategy
    const HARD_STOP_LOSS = 0.25; // 25% Absolute Floor
    const BINANCE_SHADOW_THRESHOLD = 0.0003; // 0.03% Confirmation Threshold
    
    // v31.0 Swiss Guard: Fee-Aware Net PnL
    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = buyPrice * (1 + entryFee);
    const effectiveExit = currentBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;
    
    // 1. HARD FLOOR: Absolute exit regardless of Binance
    if (netPnlPct <= -HARD_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 HARD FLOOR TRIGGERED: Net PnL is ${(netPnlPct * 100).toFixed(2)}% (Limit: -${(HARD_STOP_LOSS * 100).toFixed(2)}%)`);
        return true;
    }

    // 2. BINANCE SHADOW: Confirmation logic for standard Stop Loss
    if (netPnlPct <= -SESSION_MAX_LOSS) {
        if (!entryAssetPrice || !currentAssetPrice) {
            return true; // Safety fallback
        }

        const assetDelta = (currentAssetPrice - entryAssetPrice) / entryAssetPrice;
        
        let isConfirmedByBinance = false;
        if (side === 'YES') {
            if (assetDelta <= -BINANCE_SHADOW_THRESHOLD) isConfirmedByBinance = true;
        } else {
            if (assetDelta >= BINANCE_SHADOW_THRESHOLD) isConfirmedByBinance = true;
        }

        if (isConfirmedByBinance) {
            console.warn(`[RiskManager] 🛡️ SHADOW CONFIRMED: Binance Delta ${ (assetDelta * 100).toFixed(4) }% confirms loss.`);
            return true;
        } else {
            if (Math.random() < 0.05) {
                console.log(`[RiskManager] 🛡️ SHADOW REJECTED: Binance Delta ${ (assetDelta * 100).toFixed(4) }% ignores noise.`);
            }
            return false;
        }
    }
    
    return false;
}


export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}
