/**
 * WR + créneaux gagnants/perdants (PnL net) depuis public/data/btc-15m-cache.json
 * npx vite-node --config vite.config.js scripts/metrics-backtest-from-cache.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateReinvestMaxStake } from '../src/lib/bitcoin15mReinvestBacktest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cachePath = join(__dirname, '..', 'public', 'data', 'btc-15m-cache.json');

const j = JSON.parse(readFileSync(cachePath, 'utf8'));
const rows = j.rows;
const slC = Number(j.simConfig?.slC ?? 60);
const slFrac = Number(j.pnlModel?.slFixedLossFractionForPnl ?? 0.25);

if (!Array.isArray(rows)) {
  console.error('Cache invalide.');
  process.exit(1);
}

const withSignal = rows.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const sorted = [...withSimul].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

const initialBalance = 20;
const maxStakeEur = 500;

const sim = simulateReinvestMaxStake(sorted, {
  initialBalance,
  maxStakeEur,
  backtestSlC: slC,
  includeFees: true,
  liveStopLossConditionId: null,
  slFixedLossFractionOfStake: slFrac,
});

const n = sim.trades;
const netWins = sim.wonNet;
const netLosses = n - netWins;

const wrPct = n > 0 ? Math.round((netWins / n) * 1000) / 10 : null;

const resWin = sorted.filter((r) => r.botWon === true).length;
const resLose = sorted.filter((r) => r.botWon === false).length;
const slCount = sorted.filter((r) => r.botStopLossExit === true).length;

console.log(`Fichier : ${cachePath}`);
console.log(`Fenêtre cache : ${j.windowHours ?? '?'} h · généré : ${j.generatedAt ?? '—'}`);
console.log(`simConfig :`, j.simConfig);
console.log(`pnlModel  :`, j.pnlModel ?? { note: 'absent du cache → 0,25 utilisé' });
console.log('');
console.log('--- PnL net (réinvest, SL = −fraction stake + frais) ---');
console.log(`Créneaux avec entrée simulée : ${n}`);
console.log(`Gagnants (Δ PnL > 0)         : ${netWins}`);
console.log(`Perdants (Δ PnL ≤ 0)         : ${netLosses}`);
console.log(`WR net                       : ${wrPct}%`);
console.log(`Capital final                : ${sim.capital.toFixed(2)} € (départ ${initialBalance} €)`);
console.log('');
console.log('--- Détail issue marché (lignes brutes) ---');
console.log(`Résolution gagnée (botWon)   : ${resWin}`);
console.log(`Résolution perdue (botWon)   : ${resLose}`);
console.log(`SL simulé (sortie avant rés.) : ${slCount}`);
console.log(`(resWin + resLose + slCount peut différer de n si lignes ambiguës — vérifier données)`);
