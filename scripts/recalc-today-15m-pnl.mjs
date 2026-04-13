/**
 * PnL « type dashboard » uniquement pour la journée civile America/New_York d’aujourd’hui,
 * sur les lignes backtest 15m (fetchBitcoin15mResolvedData), avec réinvestissement plafonné.
 *
 * Usage :
 *   npx vite-node --config vite.config.js scripts/recalc-today-15m-pnl.mjs
 *
 * Optionnel (aligné UI) :
 *   BACKTEST_SIGNAL_MIN_C=77 BACKTEST_SIGNAL_MAX_C=78 BACKTEST_SL_C=60 \
 *   INITIAL_BALANCE_EUR=20 MAX_STAKE_EUR=500 BACKTEST_WINDOW_HOURS=96 \
 *   npx vite-node --config vite.config.js scripts/recalc-today-15m-pnl.mjs
 */
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from '../src/lib/bitcoin15mResolvedDataFetch.js';
import { getCalendarDayEt, simulateReinvestMaxStake } from '../src/lib/bitcoin15mReinvestBacktest.js';

let windowHours = Number(process.env.BACKTEST_WINDOW_HOURS);
if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 96;
if (windowHours > 168 && process.env.RECALC_TODAY_ALLOW_WIDE !== '1') {
  console.warn(
    `[today-15m-pnl] BACKTEST_WINDOW_HOURS trop large (${windowHours}) — plafonné à 168 h pour ce script. Exportez RECALC_TODAY_ALLOW_WIDE=1 pour forcer.`,
  );
  windowHours = 168;
}
const initialBalance = Number(process.env.INITIAL_BALANCE_EUR || 20);
const maxStakeEur = Number(process.env.MAX_STAKE_EUR || 500);
const minC = Number(process.env.BACKTEST_SIGNAL_MIN_C || 77);
const maxC = Number(process.env.BACKTEST_SIGNAL_MAX_C || 78);
const slC = Number(process.env.BACKTEST_SL_C || 60);

const simCfg = resolve15mSimConfig({
  simConfig: {
    ...(Number.isFinite(minC) && minC >= 50 && minC <= 99
      ? { detectMinP: minC / 100, entryMinP: minC / 100 }
      : {}),
    ...(Number.isFinite(maxC) && maxC >= 50 && maxC <= 99 ? { entryMaxP: maxC / 100 } : {}),
    ...(Number.isFinite(slC) && slC >= 50 && slC <= 95 ? { stopLossTriggerPriceP: slC / 100 } : {}),
  },
});

const todayEt = getCalendarDayEt(new Date());
if (!todayEt) {
  console.error('Impossible de déterminer la date ET du jour.');
  process.exit(1);
}

console.info(`[today-15m-pnl] Fenêtre fetch: ${windowHours} h · jour civil ET cible: ${todayEt}`);
console.info(`[today-15m-pnl] simCfg: signal ${minC}–${maxC}¢ · SL ${slC}¢ · départ ${initialBalance} € · plafond ${maxStakeEur} €`);
console.info('[today-15m-pnl] Téléchargement des marchés résolus (peut prendre 1–3 min)…');

const { enrichedFinal } = await fetchBitcoin15mResolvedData(windowHours, simCfg, false);

const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const todayRows = withSimul.filter((r) => getCalendarDayEt(r.endDate) === todayEt);
const sorted = [...todayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

const slCount = sorted.filter((r) => r.botStopLossExit === true).length;
const resWins = sorted.filter((r) => !r.botStopLossExit && r.botWon === true).length;

console.info(`[today-15m-pnl] Créneaux avec entrée simulée aujourd’hui (ET) : ${sorted.length} (SL ${slCount} · résolution gagnée ${resWins})`);

if (sorted.length === 0) {
  console.info('Aucun créneau résolu avec entrée pour ce jour dans la fenêtre — élargir BACKTEST_WINDOW_HOURS ou attendre des résolutions.');
  process.exit(0);
}

function run(label, extra) {
  const r = simulateReinvestMaxStake(sorted, {
    initialBalance,
    maxStakeEur,
    backtestSlC: slC,
    includeFees: true,
    liveStopLossConditionId: null,
    ...extra,
  });
  const pnl = r.capital - initialBalance;
  const pct = initialBalance > 0 ? (pnl / initialBalance) * 100 : 0;
  console.log('');
  console.log(`— ${label} —`);
  console.log(`  Trades simulés : ${r.trades} · PnL net : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} € · Capital final : ${r.capital.toFixed(2)} € (${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %) · Frais estimés : ${r.feesPaid.toFixed(2)} €`);
}

run('Modèle dashboard (SL = prix historiques / fallback drawdown comme le code actuel)', {});
run('SL simplifié live : perte fixe 25 % du stake à chaque SL', { slFixedLossFractionOfStake: 0.25 });
run('SL simplifié live : perte fixe 22 % du stake à chaque SL', { slFixedLossFractionOfStake: 0.22 });
