import { fetchSignals } from '../../signal-engine.js';
import { getBinanceStrike } from '../../src/core/strike-manager.js';
import BinanceWS from '../../binance-ws.js';
import { CONFIG } from './config.js';

/**
 * Récupère l'état unifié du marché (Delta, Spot, Strike)
 */
export async function getUnifiedMarketState(asset = 'BTC', slotStrikeLock) {
    const now = Date.now();
    const slotStart = Math.floor(now / 300000) * 300000;
    const strikeTime = slotStart; 
    
    // 1. Fetch Binance Spot
    let bSpot = BinanceWS.isReady() ? BinanceWS.getPrice() : 0;
    let source = BinanceWS.isReady() ? 'WS' : 'POLL';

    // 2. Fetch or Backfill Strike
    let bStrike = slotStrikeLock.get(strikeTime);
    let strikeSource = bStrike ? 'LOCKED-MEM' : 'INIT';

    if (!bStrike) {
        bStrike = await getBinanceStrike(asset, strikeTime);
        if (bStrike) {
            strikeSource = 'BINANCE-OPEN-REST';
            slotStrikeLock.set(strikeTime, bStrike);
        } else {
            // Memory fallback logic...
            bStrike = global.lastBinanceOpen || 0;
            strikeSource = 'MEMORY-SYNC';
        }
    }

    // 3. Calculate Delta
    let bDeltaPct = 0;
    if (bStrike > 0 && bSpot > 0) {
        bDeltaPct = ((bSpot - bStrike) / bStrike) * 100;
    }

    return {
        asset,
        slotStart,
        bSpot,
        effectiveStrike: bStrike,
        bDeltaPct,
        source: `${strikeSource} (${source})`,
        timestamp: now
    };
}

/**
 * Valide si les conditions de tir (Delta, Fenêtre, Prix) sont réunies
 */
export function validateSniperConditions(marketState, secondsLeft) {
    if (secondsLeft < CONFIG.SNIPER_WINDOW_END || secondsLeft > CONFIG.SNIPER_WINDOW_START) {
        return { isValid: false, reason: `Timing window closed (T-${secondsLeft}s)` };
    }

    if (Math.abs(marketState.bDeltaPct) < CONFIG.SNIPER_DELTA_THRESHOLD_PCT) {
        return { isValid: false, reason: `Delta not met (${marketState.bDeltaPct.toFixed(3)}%)` };
    }

    const side = marketState.bDeltaPct > 0 ? 'YES' : 'NO';
    return { isValid: true, side };
}
