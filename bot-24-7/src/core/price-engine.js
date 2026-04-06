/**
 * Price Engine (v8.0.0)
 * Unified Fair Value Calculation (Pyth Consensus)
 */

export const SANITY_MIN = { BTC: 40000, ETH: 1500, SOL: 40 };

/**
 * calculateConsensusPrice(asset, perpState)
 * v8.0.0 : Robust fetch of Pyth baseline
 */
export const calculateConsensusPrice = (asset, perpState) => {
    try {
        const state = perpState && typeof perpState.get === 'function' ? perpState.get(asset) : null;
        if (!state) return 0;

        const avg = state.pyth || 0;
        
        // Sanity Guard
        if (avg > 0 && avg < (SANITY_MIN[asset] || 0)) {
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
 * getUnifiedFairValue(asset, pythRes, perpState)
 * v8.0.0 : High-fidelity fallback logic
 */
export const getUnifiedFairValue = (asset, pythRes, perpState) => {
    let p = pythRes && pythRes.price ? pythRes.price : 0;
    let source = 'pyth_hermes';

    if (p <= 0) {
        p = calculateConsensusPrice(asset, perpState);
        source = 'consensus_pyth_fallback';
    }

    return { price: p, source };
};
