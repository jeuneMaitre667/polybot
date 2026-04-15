import fs from 'fs';
import path from 'path';

const LOG_DIR = '/home/ubuntu/.pm2/logs/';
const OUT_LOG_PATTERN = /poly-engine-out\.log/;

function parseLogs() {
    const files = fs.readdirSync(LOG_DIR).filter(f => OUT_LOG_PATTERN.test(f));
    let totalWins = 0;
    let totalLosses = 0;
    let totalSLs = 0;
    let trades = [];

    for (const file of files) {
        const content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
        const lines = content.split('\n');

        for (const line of lines) {
            // Parse Wins/Losses from FastResolution
            if (line.includes('Resolution Found')) {
                const isWin = line.includes('Result:WIN');
                const isLoss = line.includes('Result:LOSS');
                if (isWin) totalWins++;
                if (isLoss) totalLosses++;
                
                trades.push({
                    type: isWin ? 'WIN' : 'LOSS',
                    line: line.trim()
                });
            }

            // Parse Stop Losses
            if (line.includes('SIMULATION EXIT') || line.includes('SORTIE SIMULEE')) {
                totalSLs++;
                trades.push({
                    type: 'SL',
                    line: line.trim()
                });
            }
        }
    }

    return {
        totalWins,
        totalLosses,
        totalSLs,
        totalTrades: totalWins + totalLosses + totalSLs,
        winRate: (totalWins / (totalWins + totalLosses + totalSLs) * 100).toFixed(2),
        recentTrades: trades.slice(-10)
    };
}

const stats = parseLogs();
console.log(JSON.stringify(stats, null, 2));
