/**
 * OFI Alpha Audit Utility (v6.2.0)
 * 
 * Analyse decisions.log pour corréler l'OFI Score au moment du trade avec 
 * le mouvement du prix dans les 30-60 secondes suivantes.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECISION_LOG = path.join(__dirname, 'decisions.log');

async function runAudit() {
  if (!fs.existsSync(DECISION_LOG)) {
    console.error("Fichier decisions.log introuvable.");
    return;
  }

  const lines = fs.readFileSync(DECISION_LOG, 'utf8').split('\n').filter(Boolean);
  const data = lines.map(l => {
    try { return JSON.parse(l); } catch(e) { return null; }
  }).filter(d => d && d.asset && d.ask);

  console.log(`--- OFI Alpha Audit (Samples: ${data.length}) ---`);

  const horizons = [30, 60, 120]; // secondes
  const results = { BTC: {}, ETH: {}, SOL: {} };

  const assets = ['BTC', 'ETH', 'SOL'];
  
  for (const asset of assets) {
    const assetData = data.filter(d => d.asset === asset);
    if (assetData.length < 10) continue;

    console.log(`\n[${asset}] Analyse de ${assetData.length} signaux...`);

    for (const h of horizons) {
      let correct = 0;
      let total = 0;
      let sumDelta = 0;

      for (let i = 0; i < assetData.length; i++) {
        const now = assetData[i];
        const tNow = new Date(now.at).getTime();
        
        // Trouver le prix futur à T + h
        const future = assetData.find(d => {
          const t = new Date(d.at).getTime();
          return t >= tNow + (h * 1000) && t <= tNow + (h * 1000) + 15000; // Fenêtre de 15s
        });

        if (future && now.ofi !== 0) {
          const delta = (future.ask - now.ask);
          const expectedDir = now.ofi > 0 ? 1 : -1;
          const actualDir = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
          
          if (actualDir === expectedDir) correct++;
          sumDelta += Math.abs(delta);
          total++;
        }
      }

      if (total > 0) {
        const accuracy = (correct / total) * 100;
        console.log(`  Horizon ${h}s: Accuracy=${accuracy.toFixed(1)}% (n=${total})`);
      }
    }
  }
}

runAudit();
