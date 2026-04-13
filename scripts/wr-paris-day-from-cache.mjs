/**
 * WR pour une journée civile Paris à partir de `public/data/btc-15m-cache.json` (sans API).
 *
 *   $env:PARIS_DAY='2026-03-27'; npx vite-node --config vite.config.js scripts/wr-paris-day-from-cache.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCalendarDayInTimezone, simulateReinvestMaxStake } from '../src/lib/bitcoin15mReinvestBacktest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cachePath = join(__dirname, '..', 'public', 'data', 'btc-15m-cache.json');

const DAY = (process.env.PARIS_DAY || '2026-03-27').trim();
const TZ = 'Europe/Paris';
const initialBalance = 20;
const maxStakeEur = 500;
const slC = 60;
const slFrac = 0.25;

const raw = readFileSync(cachePath, 'utf8');
const { rows } = JSON.parse(raw);
if (!Array.isArray(rows)) {
  console.error('Cache invalide.');
  process.exit(1);
}

const withSignal = rows.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const dayRows = withSimul.filter((r) => getCalendarDayInTimezone(r.endDate, TZ) === DAY);
const sorted = [...dayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

if (sorted.length === 0) {
  console.log(`Aucun créneau pour ${DAY} dans le cache.`);
  process.exit(0);
}

const sim = simulateReinvestMaxStake(sorted, {
  initialBalance,
  maxStakeEur,
  backtestSlC: slC,
  includeFees: true,
  liveStopLossConditionId: null,
  slFixedLossFractionOfStake: slFrac,
});

const resWins = sorted.filter((r) => r.botWon === true).length;
const netPct = sim.trades > 0 ? Math.round((sim.wonNet / sim.trades) * 1000) / 10 : null;
const resPct = sorted.length > 0 ? Math.round((resWins / sorted.length) * 1000) / 10 : null;

console.log(`Cache : ${cachePath}`);
console.log(`Jour ${DAY} (${TZ}, fin de créneau) · ${sorted.length} créneaux avec entrée simulée\n`);
console.log(`WR net (Δ PnL > 0, SL −${slFrac * 100}% stake + frais) : ${sim.wonNet} / ${sim.trades} → ${netPct} %`);
console.log(`WR résolution (botWon === true, comme l’UI) : ${resWins} / ${sorted.length} → ${resPct} %`);
console.log(`SL simulés : ${sim.slCount} · capital final ${sim.capital.toFixed(2)} €`);
