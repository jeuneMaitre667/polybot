/**
 * v38.1.0 Iron Sight Risk Manager
 * Strike-Aware Safety with Total Immunity on Win Zones.
 */

let sessionStartingBalance = 0;
const SESSION_MAX_LOSS = 0.10; // 10% Standard Stop Loss

export function shouldTriggerStopLoss(buyPrice, currentBid, side, entryAssetPrice, currentAssetPrice, strikePrice) {
    if (!buyPrice || !currentBid) return false;
    
    // v39.3: Absolute Numeric Enforcement
    const bPrice = parseFloat(buyPrice);
    const cBid = parseFloat(currentBid);
    const sPrice = parseFloat(strikePrice || 0);
    const aPriceEntry = parseFloat(entryAssetPrice || 0);
    const aPriceCurrent = parseFloat(currentAssetPrice || 0);

    const HARD_STOP_LOSS = 0.15; // 15% Absolute Floor
    const SESSION_MAX_LOSS = 0.10; // 10% Standard Alert
    const BINANCE_SHADOW_THRESHOLD = 0.0003; // 0.03%
    const STRIKE_SAFETY_BUFFER = 0.0005; // 0.05%

    const entryFee = 0.018;
    const exitFee = 0.018;
    
    const effectiveEntry = bPrice * (1 + entryFee);
    const effectiveExit = cBid * (1 - exitFee);
    const netPnlPct = (effectiveExit - effectiveEntry) / effectiveEntry;

    // --- 🛡️ STRIKE IMMUNITY CHECK (FIRST LINE OF DEFENSE) ---
    // If Binance says we are winning, we ignore Polymarket noise entirely
    if (sPrice > 0 && aPriceCurrent > 0) {
        const isUp = (side === 'UP' || side === 'YES' || side === 'BUY');
        const distToStrike = (aPriceCurrent - sPrice) / sPrice;

        if (isUp && distToStrike > STRIKE_SAFETY_BUFFER) {
            // IMMUNE: We are above strike on an UP trade
            return false; 
        }
        if (!isUp && distToStrike < -STRIKE_SAFETY_BUFFER) {
            // IMMUNE: We are below strike on a DOWN trade
            return false;
        }
    }

    // --- 🚨 EMERGENCY EXIT (HARD FLOOR) ---
    if (netPnlPct <= -HARD_STOP_LOSS) {
        console.warn(`[RiskManager] 🚨 HARD FLOOR TRIGGERED: Net PnL is ${(netPnlPct * 100).toFixed(2)}% (Binance Delta: ${(((aPriceCurrent-aPriceEntry)/aPriceEntry)*100).toFixed(4)}%)`);
        return true;
    }

    // --- 🛰️ BINANCE SHADOW (STANDARD SL) ---
    if (netPnlPct <= -SESSION_MAX_LOSS) {
        if (aPriceEntry <= 0 || aPriceCurrent <= 0) return true; // Safety fallback

        const assetDelta = (aPriceCurrent - aPriceEntry) / aPriceEntry;
        const isUp = (side === 'UP' || side === 'YES' || side === 'BUY');

        if (isUp && assetDelta <= -BINANCE_SHADOW_THRESHOLD) return true;
        if (!isUp && assetDelta >= BINANCE_SHADOW_THRESHOLD) return true;
    }
    
    return false;
}

export function initSession(initialBalance) {
    sessionStartingBalance = initialBalance;
    console.log('[RiskManager] Session Initialized at $' + initialBalance);
}

/**
 * Calcule la taille de la mise en fonction du capital.
 * v39.2: Hard cap à 100$ pour sécurité maximale.
 */
export function calculateTradeSize(balance) {
    const DEFAULT_STAKE = 100.0;
    const PERCENT_STAKE = 0.10; // 10% du capital
    
    let suggestedStake = balance * PERCENT_STAKE;
    
    // On prend le min entre 10% du capital et 100$
    return Math.min(DEFAULT_STAKE, suggestedStake);
}
