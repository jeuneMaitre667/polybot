const fs = require('fs');

const filePath = 'c:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7\\index.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('--- Polymarket Reliability Precision Patch v7.12.15 ---');

// Bug 4: Constants
if (content.indexOf('INVENTORY_CAP') === -1) {
    console.log('[Fix 4] Adding Inventory Constants...');
    content = content.replace(
        'const STRIKE_DRIFT_THRESHOLD = Number(process.env.STRIKE_DRIFT_THRESHOLD) || 0.03; // 3%',
        'const STRIKE_DRIFT_THRESHOLD = Number(process.env.STRIKE_DRIFT_THRESHOLD) || 0.03;\n\n// v7.12.0: Inventory Skew Constants\nconst INVENTORY_CAP = 500; // parts max avant skew\nconst SKEW_REDUCTION_OFFSET = 0.005; // 0.5% de réduction'
    );
}

// Bug 3: Side in placeLimitOrderAtOptimalPrice
if (content.indexOf('const side = \'bid\';') === -1) {
    console.log('[Fix 3] Defining \'side\' in order placement...');
    content = content.replace(
        'async function placeLimitOrderAtOptimalPrice(signal, amountUsd, clobClient) {',
        'async function placeLimitOrderAtOptimalPrice(signal, amountUsd, clobClient) {\n  const side = \'bid\'; // v7.12.0 Fix'
    );
}

// Bug 6: WS Exposure Underlying
console.log('[Fix 6] Fixing WS Exposure Underlying...');
content = content.replace(
    "underlying: 'BTC',",
    "underlying: signalWithPrice?.asset || signal.asset || 'BTC', // v7.12.0 Fix"
);

// Bug 1: calculateFairProbability signature
console.log('[Fix 1] Updating calculateFairProbability parameter...');
content = content.replace(
    'function calculateFairProbability(currentPrice, strikePrice, timeToExpirySec, volOverwrite) {',
    'function calculateFairProbability(currentPrice, strikePrice, timeToExpirySec, volOverwrite, asset = \'BTC\') {'
);

// Bug 1: asset lookup in probability
if (content.indexOf('const state = getAssetState(asset);') === -1) {
   content = content.replace(
       '// v3.9.2 : Volatilité Hybride (Max entre 24h et 60min)\n  let vol = volOverwrite ?? BTC_ANNUALIZED_VOLATILITY;',
       '// v3.9.2 : Volatilité Hybride (Max entre 24h et 60min)\n  const state = getAssetState(asset);\n  let vol = volOverwrite ?? BTC_ANNUALIZED_VOLATILITY;'
   );
}

// Bug 8: VWAP repositioning
console.log('[Fix 8] Moving VWAP out of latency block...');
const vwapBlockIntro = "   // --- QUANT UPDATE v3.9.0 (VWAP & Fees) ---";
const vwapBlockStartIdx = content.indexOf(vwapBlockIntro);

if (vwapBlockStartIdx > -1) {
    const vwapBlockEndIdx = content.indexOf("priceDown: signal.takeSide === 'Down' ? vwapPrice : 1 - vwapPrice,\n    };", vwapBlockStartIdx) + 72;
    const vwapBlock = content.substring(vwapBlockStartIdx, vwapBlockEndIdx);
    
    // Deleting from old location
    content = content.substring(0, vwapBlockStartIdx) + content.substring(vwapBlockEndIdx);
    
    // Insertion after the closing brace of 'if (wsAgeMs)'
    // Note: The block after 'writeHealth({ staleWsData: false });' is where the vwapBlock was. 
    // We search for '    }' after the writeHealth.
    const searchAfterIdx = content.indexOf('writeHealth({ staleWsData: false });');
    const closingBraceIdx = content.indexOf('    }', searchAfterIdx);
    
    content = content.substring(0, closingBraceIdx + 5) + "\n\n " + vwapBlock + content.substring(closingBraceIdx + 5);
}

// Bug 2: Move getBalance
console.log('[Fix 2] Moving getBalance to top-level...');
const getBalanceDef = `    async function getBalance() {
      const viaClob = clobClient ? await getUsdcSpendableViaClob(clobClient) : null;
      if (viaClob != null) return viaClob;
      return getUsdcBalanceRpc();
    }`;

const getBalancePosIndex = content.indexOf(getBalanceDef);
if (getBalancePosIndex > -1) {
    content = content.replace(getBalanceDef, '    // getBalance moved to top-level (v7.12.0 Fix)');
    
    // Add to top-level (e.g., after getUsdcBalanceRpc)
    const targetTopIdx = content.indexOf('function getUsdcBalanceRpc() {');
    const nextFuncIdx = content.indexOf('}', targetTopIdx) + 1;
    content = content.substring(0, nextFuncIdx) + '\n\nasync function getBalance() {\n  const viaClob = clobClient ? await getUsdcSpendableViaClob(clobClient) : null;\n  if (viaClob != null) return viaClob;\n  return getUsdcBalanceRpc();\n}' + content.substring(nextFuncIdx);
}

// Bug 5: availableCapital in run()
console.log('[Fix 5] Adding availableCapital calculation to run loop...');
content = content.replace(
    'const balance = simulationTradeEnabled ? simulationTrade.getPaperBalanceUsd(BOT_DIR) : await getBalance();',
    'const balance = simulationTradeEnabled ? simulationTrade.getPaperBalanceUsd(BOT_DIR) : await getBalance();\n          const activePositions = readActivePositions();\n          const lockedCapital = activePositions.filter(p => !p.resolved).reduce((sum, p) => sum + (p.filledUsdc || p.amountUsd || 0), 0);\n          const availableCapital = Math.max(0, (balance || 0) - lockedCapital);'
);

fs.writeFileSync(filePath, content);
console.log('--- Patch Applied Successfully ---');
