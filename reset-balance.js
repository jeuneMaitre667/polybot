const fs = require('fs');
const path = 'bot-24-7/simulation-paper.json';

try {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const oldBalance = data.balanceUsd;
  data.balanceUsd = 500;
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[RESET] Ancien solde: ${oldBalance} -> Nouveau solde: ${data.balanceUsd} USDC`);
} catch (e) {
  console.error('[ERREUR] Impossible de réinitialiser le solde:', e.message);
  process.exit(1);
}
