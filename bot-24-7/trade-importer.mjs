import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(ROOT_DATA_DIR)) fs.mkdirSync(ROOT_DATA_DIR, { recursive: true });

const DATA_API_URL = 'https://data-api.polymarket.com/trades';

/**
 * Récupère l'intégralité des trades d'un marché via la Data API (pagination).
 * @param {string} marketId - L'ID du marché (conditionId).
 */
export async function fetchAllTradesForMarket(marketId) {
  console.log(`[Importer] Récupération des trades pour le marché : ${marketId}`);
  let allTrades = [];
  let limit = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const response = await axios.get(DATA_API_URL, {
        params: {
          market: marketId,
          limit: limit,
          offset: offset
        }
      });

      const data = response.data?.data || response.data || [];
      if (!Array.isArray(data) || data.length === 0) {
        hasMore = false;
        break;
      }

      allTrades = allTrades.concat(data);
      console.log(`[Importer] Récupéré ${allTrades.length} trades...`);

      if (data.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
      
      // Petite pause pour ne pas saturer l'API publique
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) {
      console.error(`[Importer] Erreur à l'offset ${offset} :`, err.message);
      hasMore = false;
    }
  }

  return allTrades;
}

/**
 * Trie et sauvegarde les trades dans des fichiers JSONL par jour.
 */
async function saveTrades(marketId, trades) {
  const tradesByDay = {};
  
  for (const t of trades) {
    let ts = new Date(t.timestamp).getTime();
    if (isNaN(ts)) continue;
    
    // Si le timestamp semble être en secondes (inférieur à 10^12), on convertit en ms
    if (ts < 10000000000) ts *= 1000;
    
    const day = new Date(ts).toISOString().split('T')[0];
    if (!tradesByDay[day]) tradesByDay[day] = [];
    
    tradesByDay[day].push({
      ts,
      type: 'trade',
      asset: t.asset_id || marketId,
      price: t.price,
      size: t.size,
      side: t.side,
      source: 'data-api'
    });
  }

  for (const [day, records] of Object.entries(tradesByDay)) {
    const filePath = path.join(ROOT_DATA_DIR, `trades-${day}.jsonl`);
    records.sort((a, b) => a.ts - b.ts);
    const data = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(filePath, data, 'utf8');
    console.log(`[Importer] Sauvegardé ${records.length} trades dans trades-${day}.jsonl`);
  }
}

// Si lancé directement avec un argument marketId
if (process.argv[2]) {
  const mid = process.argv[2];
  fetchAllTradesForMarket(mid).then(trades => saveTrades(mid, trades));
} else {
  console.log('Usage: node bot-24-7/trade-importer.mjs <marketId>');
}
