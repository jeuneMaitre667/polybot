/**
 * v38.1.0 Iron Sight Risk Manager
 * Strike-Aware Safety with Total Immunity on Win Zones.
 */

let sessionStartingBalance = 0;
const SESSION_MAX_LOSS = 0.10; // 10% Standard Stop Loss

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v37.0.0: Strike-Aware Binance Shadow Strategy
    const HARD_STOP_LOSS = 0.15; // 15% Absolute Floor
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
        let isConfirmedByBinance = false;
        
        // v38.1: Directional Logic (UP/DOWN)
        if (side === 'UP' || side === 'YES' || side === 'BUY') {
            const isDroppingSinceEntry = assetDeltaSinceEntry <= -BINANCE_SHADOW_THRESHOLD;
            
            // STRIKE IMMUNITY: If we are safely above strike, we NEVER exit.
            let isSafeAboveStrike = false;
            if (strikePrice && strikePrice > 0) {
                const distToStrike = (currentAssetPrice - strikePrice) / strikePrice;
                if (distToStrike > STRIKE_SAFETY_BUFFER) isSafeAboveStrike = true;
            }

            if (isSafeAboveStrike) {
                if (Math.random() < 0.1) {
                    console.log(`[RiskManager] 🛡️ IMMUNITY: Polymarket noise ignored. Binance is safely ABOVE Strike (+${((currentAssetPrice-strikePrice)/strikePrice*100).toFixed(3)}%).`);
                }
                return false; 
            }

            if (isDroppingSinceEntry) isConfirmedByBinance = true;

        } else {
            // DOWN / NO Logic
            const isRisingSinceEntry = assetDeltaSinceEntry >= BINANCE_SHADOW_THRESHOLD;
            
            let isSafeBelowStrike = false;
            if (strikePrice && strikePrice > 0) {
                const distToStrike = (currentAssetPrice - strikePrice) / strikePrice;
                if (distToStrike < -STRIKE_SAFETY_BUFFER) isSafeBelowStrike = true;
            }

            if (isSafeBelowStrike) {
                if (Math.random() < 0.1) {
                    console.log(`[RiskManager] 🛡️ IMMUNITY: Polymarket noise ignored. Binance is safely BELOW Strike (${((currentAssetPrice-strikePrice)/strikePrice*100).toFixed(3)}%).`);
                }
                return false;
            }

            if (isRisingSinceEntry) isConfirmedByBinance = true;
        }

        if (isConfirmedByBinance) {
            console.warn(`[RiskManager] 🛡️ SHADOW CONFIRMED: Binance Delta ${ (assetDeltaSinceEntry * 100).toFixed(4) }% confirms real danger.`);
            return true;
        }
    }
    
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}
