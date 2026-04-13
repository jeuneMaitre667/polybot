const fs = require('fs');
const path = require('path');

const filePath = 'c:\\Users\\cedpa\\polymarket-dashboard\\bot-24-7\\index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Bug 6 Fix: Underlying BTC
console.log('Fixing Bug 6...');
content = content.replace("underlying: 'BTC',", "underlying: signalWithPrice?.asset || signal.asset || 'BTC', // v7.12.11 Fix");

// Bug 8 Fix: VWAP Positioning
console.log('Fixing Bug 8...');
const vwapMarker = "// --- QUANT UPDATE v3.9.0 (VWAP & Fees) ---";
const staleWsMarker = "writeHealth({ staleWsData: false });";
const closingBraceMarker = "    }\n\n    // --- QUANT UPDATE v3.9.0"; // Target: move after the brace

// On cherche le bloc VWAP qui est DANS le if (wsAgeMs > wsFreshnessMaxMs)
const vwapBlockStart = content.indexOf(vwapMarker);
const staleWsEnd = content.indexOf(staleWsMarker) + staleWsMarker.length;

if (vwapBlockStart > -1 && vwapBlockStart > staleWsEnd) {
    // Extraction du bloc (on prend jusqu'à la fin de la logique vwap)
    const vwapBlockEnd = content.indexOf("priceDown: signal.takeSide === 'Down' ? vwapPrice : 1 - vwapPrice,\n    };", vwapBlockStart) + 72;
    const vwapBlock = content.substring(vwapBlockStart, vwapBlockEnd);
    
    // Suppression de l'ancien emplacement
    content = content.substring(0, vwapBlockStart) + content.substring(vwapBlockEnd);
    
    // Insertion APRES la fermeture du if (wsAgeMs)
    // On cherche le '}' qui ferme le bloc à partir de staleWsEnd
    const closingBraceIndex = content.indexOf("    }", staleWsEnd);
    content = content.substring(0, closingBraceIndex + 5) + "\n\n    " + vwapBlock + content.substring(closingBraceIndex + 5);
}

fs.writeFileSync(filePath, content);
console.log('Reliability Script executed successfully.');
