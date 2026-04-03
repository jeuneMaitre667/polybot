import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Le dossier racine bot-24-7 est un cran au-dessus de scripts/ */
const BOT_DIR = path.resolve(__dirname, '..');

const FILES_TO_RESET = {
  'balance.json': JSON.stringify({ balance: 100 }),
  'active-positions.json': JSON.stringify([]),
  'balance-history.json': JSON.stringify([]),
  'stop-loss-metrics.json': JSON.stringify([]),
  'last-order.json': null, // Suppression
  'orders.log': '',        // Tronquer
  'bot.log': '',           // Tronquer
  'decisions.log': '',     // Tronquer
};

console.log(`[RESET] 🧹 Purge des données dans : ${BOT_DIR}`);

for (const [filename, content] of Object.entries(FILES_TO_RESET)) {
  const filePath = path.join(BOT_DIR, filename);
  try {
    if (content === null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`  - ${filename} : Supprimé ✅`);
      }
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`  - ${filename} : Réinitialisé ✅`);
    }
  } catch (err) {
    console.error(`  - ${filename} : Échec (${err.message}) ❌`);
  }
}

console.log(`\n[RESET] 🚀 Terminé. La balance est revenue à 100 USDC.`);
console.log(`[RESET] 💡 Pense à redémarrer le bot (pm2 restart polymarket-bot) pour charger les nouvelles données.`);
