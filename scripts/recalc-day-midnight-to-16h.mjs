/**
 * Backtest 15m : journée civile **America/New_York**, créneaux dont l’heure (trade ou fin de créneau)
 * est dans **[RECALC_HOUR_START, RECALC_HOUR_END_EXCLUSIVE)**.
 * Défaut **0–17** → heures **0…16** incluses (= « jusqu’à 16h59 » ; avant 17h).
 *
 * - **SL** : seuil inchangé (`BACKTEST_SL_C`) ; chaque SL compte une **perte fixe** du stake
 *   si `SL_FIXED_LOSS_FRAC` défini — **défaut 0,25** (25 %), comme le mode dashboard.
 * - Séries : **max victoires / défaites consécutives** (PnL net du trade : `delta > 0` = victoire).
 *
 * Usage :
 *   npm run recalc:day-16h
 *   $env:RECALC_TARGET_DAY_ET='2026-03-28'; npm run recalc:day-16h
 *
 * `HOURLY_BUCKET=slot_end` : heure de **fin de créneau** (endDate) au lieu de l’heure du trade.
 */
import { getBacktestMaxLossFractionOfStake } from '../src/lib/bitcoinBacktestLossFraction.js';
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from '../src/lib/bitcoin15mResolvedDataFetch.js';
import {
  getCalendarDayEt,
  computeRowDelta,
  instantForHourlyBreakdownEt,
  hourOfDayEt,
} from '../src/lib/bitcoin15mReinvestBacktest.js';

function estimateCryptoTakerFeeRate(p, includeFees) {
  if (!includeFees) return 0;
  if (p == null) return 0;
  const x = p * (1 - p);
  return 0.25 * Math.pow(x, 2);
}

let windowHours = Number(process.env.BACKTEST_WINDOW_HOURS);
if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 96;
if (windowHours > 168 && process.env.RECALC_TODAY_ALLOW_WIDE !== '1') {
  windowHours = 168;
}

const initialBalance = Number(process.env.INITIAL_BALANCE_EUR || 20);
const maxStakeEur = Number(process.env.MAX_STAKE_EUR || 500);
const minC = Number(process.env.BACKTEST_SIGNAL_MIN_C || 77);
const maxC = Number(process.env.BACKTEST_SIGNAL_MAX_C || 78);
const slC = Number(process.env.BACKTEST_SL_C || 60);
const includeFees = process.env.INCLUDE_FEES === '0' ? false : true;

/** Perte fixe sur chaque SL (défaut 25 %). Désactiver : SL_FIXED_LOSS_FRAC=0 */
const slFracRaw = process.env.SL_FIXED_LOSS_FRAC;
const slFrac =
  slFracRaw === undefined || String(slFracRaw).trim() === ''
    ? 0.25
    : Number(slFracRaw);
const useSlFrac = Number.isFinite(slFrac) && slFrac > 0 && slFrac <= 1;

const hourStart = Number(process.env.RECALC_HOUR_START ?? 0);
/** Exclusif : défaut **17** → inclut les trades 16h00–16h59 ET. */
const hourEndExclusive = Number(process.env.RECALC_HOUR_END_EXCLUSIVE ?? 17);

const hourlyBucketRaw = (process.env.HOURLY_BUCKET || 'trade').toLowerCase();
const hourlyBreakdownBy = hourlyBucketRaw === 'slotend' || hourlyBucketRaw === 'slot_end' ? 'slotEnd' : 'trade';

const todayEt =
  typeof process.env.RECALC_TARGET_DAY_ET === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(process.env.RECALC_TARGET_DAY_ET.trim())
    ? process.env.RECALC_TARGET_DAY_ET.trim()
    : getCalendarDayEt(new Date());

if (!todayEt) {
  console.error('Date ET impossible.');
  process.exit(1);
}

const simCfg = resolve15mSimConfig({
  simConfig: {
    ...(Number.isFinite(minC) && minC >= 50 && minC <= 99
      ? { detectMinP: minC / 100, entryMinP: minC / 100 }
      : {}),
    ...(Number.isFinite(maxC) && maxC >= 50 && maxC <= 99 ? { entryMaxP: maxC / 100 } : {}),
    ...(Number.isFinite(slC) && slC >= 50 && slC <= 95 ? { stopLossTriggerPriceP: slC / 100 } : {}),
  },
});

const lossFracFallback = getBacktestMaxLossFractionOfStake();
const cap = Number.isFinite(maxStakeEur) && maxStakeEur > 0 ? maxStakeEur : 10;

console.info(
  `[day-16h] Jour ET : ${todayEt} · heures [${hourStart}, ${hourEndExclusive}) ET · bucket ${hourlyBreakdownBy === 'trade' ? 'heure trade' : 'heure fin créneau'} · fetch ${windowHours} h · signal ${minC}–${maxC}¢ · SL ${slC}¢ · perte SL ${useSlFrac ? `${(slFrac * 100).toFixed(0)} % du stake` : 'modèle historique (pas fixe)'} · départ ${initialBalance} € · plafond ${maxStakeEur} €`,
);
console.info('[day-16h] Chargement…');

const { enrichedFinal } = await fetchBitcoin15mResolvedData(windowHours, simCfg, false);

const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const dayRows = withSimul.filter((r) => getCalendarDayEt(r.endDate) === todayEt);

function rowHourEt(r) {
  const inst = instantForHourlyBreakdownEt(r, hourlyBreakdownBy);
  const d = inst != null ? new Date(inst) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return hourOfDayEt(d);
}

/** Histogramme diagnostic (heure du trade), tous les créneaux du jour. */
const histTrade = {};
for (const r of dayRows) {
  const inst = instantForHourlyBreakdownEt(r, 'trade');
  const d = inst ? new Date(inst) : null;
  const h = d && !Number.isNaN(d.getTime()) ? hourOfDayEt(d) : '?';
  histTrade[h] = (histTrade[h] || 0) + 1;
}

const sortedDay = [...dayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
const sorted = sortedDay.filter((r) => {
  const h = rowHourEt(r);
  return h != null && h >= hourStart && h < hourEndExclusive;
});

if (sorted.length === 0) {
  console.info(`Aucun créneau dans [${hourStart}, ${hourEndExclusive}) pour ${todayEt} (fenêtre fetch ${windowHours} h).`);
  console.info(`Créneaux ce jour (toutes heures) : ${dayRows.length}. Répartition heure trade :`, histTrade);
  process.exit(0);
}

let capital = initialBalance > 0 ? initialBalance : 0;
let peak = capital;
let maxDrawdown = 0;
let feesPaid = 0;
let wonNet = 0;
let tradesProcessed = 0;
/** @type {Record<number, { trades: number, pnl: number, wonNet: number }>} */
const hourly = {};

let winStreak = 0;
let lossStreak = 0;
let maxWinStreak = 0;
let maxLossStreak = 0;

for (const r of sorted) {
  const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
  const feeRate = estimateCryptoTakerFeeRate(p, includeFees);
  const budgetForTrade = Math.min(Math.max(0, capital), cap);
  if (budgetForTrade < 0.01) break;

  const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
  const feeUsd = stake * feeRate;
  feesPaid += feeUsd;

  const delta = computeRowDelta(r, {
    stake,
    feeUsd,
    backtestSlC: slC,
    lossFracFallback,
    liveStopLossConditionId: null,
    slFixedLossFractionOfStake: useSlFrac ? slFrac : null,
  });

  capital = Math.max(0, capital + delta);
  if (delta > 0) {
    wonNet += 1;
    winStreak += 1;
    lossStreak = 0;
    if (winStreak > maxWinStreak) maxWinStreak = winStreak;
  } else if (delta < 0) {
    lossStreak += 1;
    winStreak = 0;
    if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
  } else {
    winStreak = 0;
    lossStreak = 0;
  }

  tradesProcessed += 1;

  if (capital > peak) peak = capital;
  const dd = peak > 0 ? (peak - capital) / peak : 0;
  if (dd > maxDrawdown) maxDrawdown = dd;

  const h = rowHourEt(r);
  if (h == null) continue;
  if (!hourly[h]) hourly[h] = { trades: 0, pnl: 0, wonNet: 0 };
  hourly[h].trades += 1;
  hourly[h].pnl += delta;
  if (delta > 0) hourly[h].wonNet += 1;
}

const pnl = capital - initialBalance;
const wrNetPct =
  tradesProcessed > 0 ? Math.round((wonNet / tradesProcessed) * 1000) / 10 : null;

console.log('');
console.log('═══ Résumé (backtest réinvest., fenêtre horaire) ═══');
console.log(
  `Créneaux ce jour (toutes heures) : ${dayRows.length} · dans la fenêtre [${hourStart}h, ${hourEndExclusive}h) : ${sorted.length} · traités : ${tradesProcessed}${tradesProcessed < sorted.length ? ` (arrêt capital)` : ''}`,
);
if (dayRows.length > sorted.length) {
  console.log(
    `ℹ️  ${dayRows.length - sorted.length} créneau(x) hors fenêtre (ex. après ${hourEndExclusive - 1}h59 ET). Tableau 30j : mélange de jours — les lignes « après-midi » peuvent être un autre jour civil.`,
  );
}
console.log(
  `PnL net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} € · Capital final ${capital.toFixed(2)} € · Frais cumulés ${feesPaid.toFixed(2)} €`,
);
console.log(`WR net global : ${wrNetPct != null ? `${wrNetPct} %` : '—'} (delta PnL > 0)`);
console.log(`Max drawdown : ${(maxDrawdown * 100).toFixed(2)} % · Capital max (pic) : ${peak.toFixed(2)} €`);
console.log(`Max victoires consécutives : ${maxWinStreak} · Max défaites consécutives : ${maxLossStreak}`);
console.log('');

console.log(`Heure ET (${hourlyBreakdownBy === 'trade' ? 'trade' : 'fin créneau'}) | Trades | PnL heure (€) | WR net heure`);
console.log('--------------------------------|--------|---------------|-------------');
for (let h = hourStart; h < hourEndExclusive; h++) {
  const x = hourly[h];
  const n = x?.trades ?? 0;
  const d = x?.pnl ?? 0;
  const w = x?.wonNet ?? 0;
  const wr = n > 0 ? Math.round((w / n) * 1000) / 10 : null;
  const hh = String(h).padStart(2, '0');
  const wrs = wr != null ? `${wr} %` : '—';
  console.log(
    `${hh}:00–${hh}:59                        | ${String(n).padStart(6)} | ${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(11)} | ${wrs.padStart(11)}`,
  );
}
console.log('');
console.log(
  `(Jour ${todayEt} ET · ${hourStart} ≤ h < ${hourEndExclusive} · signal ${minC}–${maxC}¢ · SL ${slC}¢${useSlFrac ? ` · perte SL fixe ${(slFrac * 100).toFixed(0)}%` : ''}.)`,
);
