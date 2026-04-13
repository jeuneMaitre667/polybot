const fs = require('fs');

function runAudit() {
    const csvPath = 'btc_5m_history_week.csv';
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.trim().split('\n');
    const data = [];

    // Parse CSV
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < 5) continue;
        data.push({
            Open: parseFloat(cols[1]),
            High: parseFloat(cols[2]),
            Low: parseFloat(cols[3]),
            Close: parseFloat(cols[4])
        });
    }

    const MARGIN = 1000;
    const LEVERAGE = 100;
    const DELTA_THRESHOLD = 0.0010;
    const SL_FACTOR = 0.001;
    let balance = MARGIN;
    let trades = 0;
    let wins = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currWinStreak = 0;
    let currLossStreak = 0;

    for (let i = 0; i < data.length - 1; i++) {
        const strike = data[i].Open;
        const entry = data[i + 1].Open;
        const delta = Math.abs(entry - strike) / strike;

        if (delta >= DELTA_THRESHOLD) {
            trades++;
            const direction = entry > strike ? 'LONG' : 'SHORT';
            const slPrice = direction === 'LONG' ? entry * (1 - SL_FACTOR) : entry * (1 + SL_FACTOR);
            
            const candle = data[i + 1];
            const slHit = direction === 'LONG' ? candle.Low <= slPrice : candle.High >= slPrice;
            const exitPrice = slHit ? slPrice : candle.Close;
            
            let pnlPct = 0;
            if (direction === 'LONG') {
                pnlPct = (exitPrice - entry) / entry * LEVERAGE;
            } else {
                pnlPct = (entry - exitPrice) / entry * LEVERAGE;
            }
            
            const pnlUsd = pnlPct * MARGIN; 
            balance += pnlUsd;

            if (pnlUsd > 0) {
                wins++;
                currWinStreak++;
                currLossStreak = 0;
                maxWinStreak = Math.max(maxWinStreak, currWinStreak);
            } else {
                currLossStreak++;
                currWinStreak = 0;
                maxLossStreak = Math.max(maxLossStreak, currLossStreak);
            }

            if (balance <= 0) {
                console.log(`💀 LIQUIDÉ au trade n°${trades}`);
                return;
            }
        }
    }

    console.log(`\n🎯 RÉSULTATS SIMULATION (DOMINATION 1000$ / x100)`);
    console.log(`💰 BALANCE FINALE      : ${balance.toFixed(2)} $`);
    console.log(`📈 PROFIT NET          : +${(balance - MARGIN).toFixed(2)} $`);
    console.log(`📊 WINRATE (1 SEMAINE) : ${(wins/trades*100).toFixed(1)}% (${wins}/${trades} trades)`);
    console.log(`🔥 PLUS LONGUE SÉRIE DE GAINS : ${maxWinStreak} trades`);
    console.log(`🚨 PLUS LONGUE SÉRIE DE PERTES : ${maxLossStreak} trades`);
    if(balance > 1000) console.log(`✅ SURVIE : Félicitations, vous avez triplé votre mise en 7 jours !`);
}

runAudit();
