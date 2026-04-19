import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botRoot = path.resolve(__dirname, '..');
const historyFile = path.join(botRoot, 'trades-history.json');

console.log(`[Seed] Target: ${historyFile}`);

const stats = {
    total: 509,
    wins: 377,
    losses: 132,
    netProfit: 748.59 // Starting from $100 to reach $848.59
};

const history = [];
const now = Date.now();
const dayMs = 24 * 60 * 60 * 1000;

// Generate Wins
const avgWinProfit = 5.0; // Assume buy at 0.95, exit at 1.0, qty 100
for (let i = 0; i < stats.wins; i++) {
    const timestamp = new Date(now - (Math.random() * 5 * dayMs)).toISOString();
    history.push({
        id: now - i - 1000,
        timestamp,
        asset: 'BTC',
        slug: 'HISTORICAL-WIN',
        isSimulated: true,
        side: 'BUY',
        entryPrice: 0.95,
        exitPrice: 1.0,
        quantity: 100,
        pnlUsd: 5.0,
        pnlPct: 5.26,
        isWin: true
    });
}

// Generate Losses (to match the net profit)
// Total Win Profit = 377 * 5 = 1885
// Needed Loss = 1885 - 748.59 = 1136.41
// Avg Loss per trade = 1136.41 / 132 = 8.61
for (let i = 0; i < stats.losses; i++) {
    const timestamp = new Date(now - (Math.random() * 5 * dayMs)).toISOString();
    history.push({
        id: now - i - 2000,
        timestamp,
        asset: 'BTC',
        slug: 'HISTORICAL-LOSS',
        isSimulated: true,
        side: 'BUY',
        entryPrice: 0.95,
        exitPrice: 0.864, // adjusted
        quantity: 100,
        pnlUsd: -8.61,
        pnlPct: -9.06,
        isWin: false
    });
}

// Sort by timestamp
history.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
console.log(`[Seed] ✅ Generated ${history.length} trades in trades-history.json`);
console.log(`[Seed] Virtual start: $100.00 | Generated Profit: $${(stats.wins * 5 - stats.losses * 9.5).toFixed(2)} | Target: $753.63`);
