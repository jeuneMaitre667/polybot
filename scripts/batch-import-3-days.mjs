import axios from 'axios';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';
const SLOT_DURATION = 900; // 15 min

async function run() {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentSlotStart = Math.floor(nowSec / SLOT_DURATION) * SLOT_DURATION;
  
  // 3 jours = 3 * 24 * 4 slots = 288 slots
  const startSlot = currentSlotStart - (3 * 24 * 3600);
  
  console.log(`[Batch] Début de l'importation sur 3 jours (à partir de ${new Date(startSlot * 1000).toISOString()})`);
  
  const conditionIds = [];
  
  // On remonte slot par slot
  for (let slot = currentSlotStart; slot >= startSlot; slot -= SLOT_DURATION) {
    const slug = `${BITCOIN_UP_DOWN_15M_SLUG}-${slot}`;
    try {
      const resp = await axios.get(`https://gamma-api.polymarket.com/events/slug?slug=${slug}`);
      if (resp.data && resp.data.markets) {
        for (const m of resp.data.markets) {
          if (m.conditionId && !conditionIds.includes(m.conditionId)) {
            conditionIds.push(m.conditionId);
          }
        }
      }
    } catch (err) {
      // Certains slots n'existent peut-être pas ou l'event n'est pas encore créé
      // console.warn(`[Batch] Slot non trouvé: ${slug}`);
    }
  }
  
  console.log(`[Batch] Trouvé ${conditionIds.length} IDs de marchés uniques.`);
  
  // Exécution de l'import pour chaque ID
  for (const id of conditionIds) {
    console.log(`[Batch] Importation trades pour ${id}...`);
    try {
      execSync(`node bot-24-7/trade-importer.mjs ${id}`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`[Batch] Erreur lors de l'importation de ${id}:`, err.message);
    }
  }
  
  console.log('[Batch] Importation terminée.');
}

run();
