
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import * as fs from 'fs';

async function fetchHistory() {
    console.log("--- 🕵️‍♂️ AUDIT DES TRANSACTIONS POLYMARKET ---");

    const env = fs.readFileSync('C:/Users/cedpa/polymarket-dashboard/bot-24-7/.env', 'utf8');
    const getVal = (key) => {
        const match = env.match(new RegExp(`^${key}=["']?([^"'\r\n]+)["']?`, 'm'));
        return match ? match[1] : null;
    };

    const pk = getVal('PRIVATE_KEY');
    const makerAddress = getVal('CLOB_FUNDER_ADDRESS');

    if (!pk) {
        console.error("❌ Erreur : Impossible de trouver la PRIVATE_KEY.");
        return;
    }

    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(pk, provider);
    
    // Auth
    let client = new ClobClient('https://clob.polymarket.com', 137, signer);
    console.log("🔑 Authentification L2 en cours...");
    const creds = await client.deriveApiKey();
    client = new ClobClient('https://clob.polymarket.com', 137, signer, creds);

    try {
        // Fetch last 20 trades
        const trades = await client.getTrades();
        if (!trades || trades.length === 0) {
            console.log("Aucun trade trouvé pour ce compte.");
            return;
        }

        console.log(`\n✅ ${trades.length} transactions identifiées.`);
        console.log("\n--- DEBUG RAW TRADE ---");
        console.log(JSON.stringify(trades[0], null, 2));
        console.log("------------------------\n");
        
        const tableData = trades.slice(0, 20).map(t => {
            let dateStr = "N/A";
            try {
                const ts = t.match_time || t.timestamp;
                const date = new Date(parseInt(ts) * 1000);
                dateStr = date.toLocaleString('fr-FR');
            } catch(e) {}

            return {
                "Date/Heure": dateStr,
                "Type": t.side,
                "Prix": `$${parseFloat(t.price).toFixed(3)}`,
                "Quantité": t.size,
                "Total USD": `$${(parseFloat(t.price) * parseFloat(t.size)).toFixed(2)}`,
                "Issue": t.outcome || "N/A"
            };
        });

        console.table(tableData);
        console.log("\n(Affichage des 20 dernières transactions)");

    } catch (err) {
        console.error("❌ Échec de la récupération :", err.message);
    }
}

fetchHistory();
