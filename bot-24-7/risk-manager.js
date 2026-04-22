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

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v37.0.0: Strike-Aware Binance Shadow Strategy
    const HARD_STOP_LOSS = 0.20; // 20% Absolute Floor
    const BINANCE_SHADOW_THRESHOLD = 0.0003; // 0.03% Confirmation Threshold
    const STRIKE_SAFETY_BUFFER = 0.0005; // 0.05% Zone of "Indisputable Win"
    
    // v31.0 Swiss Guard: Fee-Aware Net PnL
    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = buyPrice * (1 + entryFee);
    const effectiveExit = currentBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;
    
    // 1. HARD FLOOR: Absolute exit regardless of Binance
    if (netPnlPct <= -HARD_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 HARD FLOOR TRIGGERED: Net PnL is ${(netPnlPct * 100).toFixed(2)}%`);
        return true;
    }

    // 2. BINANCE SHADOW: Confirmation logic for standard Stop Loss
    if (netPnlPct <= -SESSION_MAX_LOSS) {
        if (!entryAssetPrice || !currentAssetPrice) {
            return true; // Safety fallback
        }

        const assetDeltaSinceEntry = (currentAssetPrice - entryAssetPrice) / entryAssetPrice;
        
        // v37.0: Calculate distance to Strike to detect "Safe Wins"
        let isConfirmedByBinance = false;
        
        if (side === 'YES') {
            // Confirm loss ONLY if Binance dropped since entry AND we are dangerously close to Strike
            const isDroppingSinceEntry = assetDeltaSinceEntry <= -BINANCE_SHADOW_THRESHOLD;
            
            // If we have a strike, check if we are still well above it
            let isSafeAboveStrike = false;
            if (strikePrice && strikePrice > 0) {
                const distToStrike = (currentAssetPrice - strikePrice) / strikePrice;
                if (distToStrike > STRIKE_SAFETY_BUFFER) isSafeAboveStrike = true;
            }

            if (isDroppingSinceEntry && !isSafeAboveStrike) isConfirmedByBinance = true;
            
            if (isDroppingSinceEntry && isSafeAboveStrike) {
                console.log(`[RiskManager] 🛡️ SHADOW REJECTED: Binance dropped but we are still safely ABOVE Strike (+${((currentAssetPrice-strikePrice)/strikePrice*100).toFixed(3)}%). Ignoring noise.`);
            }
        } else {
            // Confirm loss ONLY if Binance rose since entry AND we are dangerously close to Strike
            const isRisingSinceEntry = assetDeltaSinceEntry >= BINANCE_SHADOW_THRESHOLD;
            
            let isSafeBelowStrike = false;
            if (strikePrice && strikePrice > 0) {
                const distToStrike = (currentAssetPrice - strikePrice) / strikePrice;
                if (distToStrike < -STRIKE_SAFETY_BUFFER) isSafeBelowStrike = true;
            }

            if (isRisingSinceEntry && !isSafeBelowStrike) isConfirmedByBinance = true;

            if (isRisingSinceEntry && isSafeBelowStrike) {
                console.log(`[RiskManager] 🛡️ SHADOW REJECTED: Binance rose but we are still safely BELOW Strike (${((currentAssetPrice-strikePrice)/strikePrice*100).toFixed(3)}%). Ignoring noise.`);
            }
        }

        if (isConfirmedByBinance) {
            console.warn(`[RiskManager] 🛡️ SHADOW CONFIRMED: Binance Delta ${ (assetDeltaSinceEntry * 100).toFixed(4) }% confirms real danger.`);
            return true;
        } else {
            return false;
        }
    }
    
    return false;
}


export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}
