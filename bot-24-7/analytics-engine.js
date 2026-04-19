import { safeReadJson, atomicWriteJson } from './src/core/persistence-layer.js';
import path from 'path';

/**
 * v17.3.0 Performance Analytics Engine
 * Tracks and computes high-level trading metrics.
 */

const TRADES_FILE = path.join(process.cwd(), 'trades-history.json');

/**
 * Records a completed trade result.
 */
export function recordTrade(tradeData) {
    const history = safeReadJson(TRADES_FILE, []);
    
    const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        asset: tradeData.asset || 'BTC',
        slug: tradeData.slug || 'N/A',
        isSimulated: tradeData.isSimulated || false,
        side: tradeData.side,
        entryPrice: tradeData.entryPrice,
        exitPrice: tradeData.exitPrice,
        quantity: tradeData.quantity,
        pnlUsd: tradeData.pnlUsd,
        pnlPct: parseFloat(((tradeData.exitPrice - tradeData.entryPrice) / tradeData.entryPrice * 100).toFixed(2)),
        isWin: tradeData.pnlUsd > 0
    };

    history.push(entry);
    
    // Keep last 2000 trades for analysis (increased from 1000)
    if (history.length > 2000) history.shift();
    
    atomicWriteJson(TRADES_FILE, history);
    console.log(`[Analytics] Recorded trade: ${entry.slug} | ${entry.side} at ${entry.exitPrice} (PnL: $${entry.pnlUsd.toFixed(2)})`);
}

/**
 * Computes summary statistics.
 */
export function computePerformanceStats() {
    const history = safeReadJson(TRADES_FILE, []);
    
    if (history.length === 0) {
        return {
            netProfit: 0,
            winRatePct: 0,
            totalVolume: 0,
            tradeCount: 0,
            profitFactor: 0,
            avgWin: 0,
            avgLoss: 0,
            updatedAt: new Date().toISOString()
        };
    }

    let grossProfit = 0;
    let grossLoss = 0;
    let totalVolume = 0;
    let wins = 0;

    history.forEach(t => {
        const val = t.pnlUsd;
        if (val > 0) {
            grossProfit += val;
            wins++;
        } else {
            grossLoss += Math.abs(val);
        }
        totalVolume += (t.entryPrice * t.quantity);
    });

    const tradeCount = history.length;
    const winRatePct = parseFloat(((wins / tradeCount) * 100).toFixed(1));
    const netProfit = grossProfit - grossLoss;
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : parseFloat((grossProfit / grossLoss).toFixed(2));

    return {
        netProfit,
        winRatePct,
        totalVolume: Math.round(totalVolume),
        tradeCount,
        profitFactor,
        avgWin: wins > 0 ? parseFloat((grossProfit / wins).toFixed(2)) : 0,
        avgLoss: (tradeCount - wins) > 0 ? parseFloat((grossLoss / (tradeCount - wins)).toFixed(2)) : 0,
        updatedAt: new Date().toISOString()
    };
}
