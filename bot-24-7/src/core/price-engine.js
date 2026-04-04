/**
 * Price Engine (v8.0.0)
 * Unified Fair Value Calculation (Chainlink + Perp Consensus)
 */

export const SANITY_MIN = { BTC: 40000, ETH: 1500, SOL: 40 };

/**
 * calculateConsensusPrice(asset, perpState)
 * v8.0.0 : Robust average of Binance, OKX, and Hyperliquid
 */
export const calculateConsensusPrice = (asset, perpState) => {
    try {
        const state = perpState && typeof perpState.get === 'function' ? perpState.get(asset) : null;
        if (!state) return 0;

        const sources = [];
        if (state.binance > 0) sources.push(state.binance);
        if (state.okx > 0) sources.push(state.okx);
        if (state.hyper > 0) sources.push(state.hyper);

        if (sources.length === 0) return 0;
        
        const avg = sources.reduce((a, b) => a + b, 0) / sources.length;
        
        // Sanity Guard
        if (avg < (SANITY_MIN[asset] || 0)) {
            console.warn(`[PriceEngine] Consensus ${asset} price ${avg.toFixed(2)} below sanity threshold (${SANITY_MIN[asset]}). REJECTED.`);
            return 0;
        }
        
        return avg;
    } catch (e) {
        console.error(`[PriceEngine] ${asset} Error:`, e.message);
        return 0;
    }
};

/**
 * getUnifiedFairValue(asset, chainlinkRes, perpState)
 * v8.0.0 : High-fidelity fallback logic
 */
export const getUnifiedFairValue = (asset, chainlinkRes, perpState) => {
    let p = chainlinkRes && chainlinkRes.price ? chainlinkRes.price : 0;
    let source = 'chainlink_polygon';

    if (p <= 0) {
        p = calculateConsensusPrice(asset, perpState);
        source = 'consensus_perp_fallback';
    }

    return { price: p, source };
};
