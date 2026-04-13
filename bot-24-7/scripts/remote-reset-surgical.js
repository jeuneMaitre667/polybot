import fs from 'fs';
import path from 'path';

const BOT_DIR = '/home/ubuntu/bot-24-7';

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

console.log(`[REMOTE_RESET] 🧹 Purge des données dans : ${BOT_DIR}`);

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
