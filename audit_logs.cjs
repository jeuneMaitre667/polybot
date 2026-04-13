const fs = require('fs');

function audit() {
    const ordersPath = 'tmp_orders.log';
    const healthPath = 'tmp_health.json';
    const analyticsPath = 'tmp_analytics.log';

    console.log("--- v6.3.7 Audit Report ---");

    // 1. Performance Outcomes (analytics.log)
    if (fs.existsSync(analyticsPath)) {
        const lines = fs.readFileSync(analyticsPath, 'utf8').split('\n').filter(l => l.trim());
        const outcomes = lines.map(o => JSON.parse(o));
        
        let totalPnl = 0;
        let wins = 0;
        let losses = 0;
        let tps = 0;

        outcomes.forEach(o => {
            if (o.pnl != null) {
                totalPnl += o.pnl;
                if (o.pnl > 0) wins++; else if (o.pnl < 0) losses++;
                if (o.winner === 'Yes' || o.winner === 'Up') tps++; // TP check
            }
        });

        console.log(`\n💰 Performance (Paper/Sim):`);
        console.log(`- Net PnL (Session): $${totalPnl.toFixed(2)}`);
        console.log(`- Win Rate: ${((wins / (wins + losses)) * 100).toFixed(1)}% (${wins}W / ${losses}L)`);
    }

    // 2. Activity & Volume (orders.log)
    if (fs.existsSync(ordersPath)) {
        const lines = fs.readFileSync(ordersPath, 'utf8').split('\n').filter(l => l.trim());
        const orders = lines.map(l => JSON.parse(l));

        const buyOrders = orders.filter(o => o.takeSide || o.side === 'Buy');
        const assetDist = { BTC: 0, ETH: 0, SOL: 0 };
        let totalVal = 0;
        let totalEdge = 0;
        let edgeCount = 0;
        let solGapsGt10 = 0;

        buyOrders.forEach(o => {
            const asset = o.underlying || o.asset || '?';
            if (assetDist[asset] !== undefined) assetDist[asset]++;
            
            const amt = o.amountUsd || 0;
            totalVal += amt;
            
            if (o.edge != null) {
                totalEdge += o.edge;
                edgeCount++;
                if (asset === 'SOL' && o.edge > 0.10) solGapsGt10++;
            }
        });

        console.log(`\n📊 Activity:`);
        console.log(`- Total BUY Decisions: ${buyOrders.length}`);
        console.log(`- Asset Split: BTC: ${assetDist.BTC}, ETH: ${assetDist.ETH}, SOL: ${assetDist.SOL}`);
        console.log(`- Total Trading Volume: $${totalVal.toFixed(2)}`);
        console.log(`- Average Edge (Gap): ${edgeCount > 0 ? (totalEdge / edgeCount * 100).toFixed(2) : 0}%`);
        if (solGapsGt10 > 0) console.log(`- 🎯 SOL ALERT: Found ${solGapsGt10} gaps > 10% !`);
    }

    // 3. Health & State (health.json)
    if (fs.existsSync(healthPath)) {
        const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
        console.log(`\n⚙️ Current State:`);
        console.log(`- Available Capital: $${health.availableCapital || health.balanceUsd || '?'}`);
        console.log(`- Performance Updated At: ${health.performance?.updatedAt || '?'}`);
    }

    console.log("\n--- End of Audit ---");
}

audit();
