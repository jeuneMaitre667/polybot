/**
 * Backtest 15m : journée civile **America/New_York**, créneaux dont l’heure (trade ou fin créneau)
 * est dans **[RECALC_HOUR_START, RECALC_HOUR_END_EXCLUSIVE)** — défaut **0–16** (= 00h00–15h59 ET).
 *
 * Affiche : tableau **heure par heure** (trades, PnL de l’heure, WR net heure), puis totaux :
 * PnL, **WR net global**, **max drawdown**, **capital max** (pic / « max V »).
 *
 * Usage :
 *   npx vite-node --config vite.config.js scripts/recalc-day-midnight-to-16h.mjs
 *   $env:RECALC_TARGET_DAY_ET='2026-03-28'; npm run recalc:day-16h
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
const slFrac = Number(process.env.SL_FIXED_LOSS_FRAC ?? '');
const useSlFrac = Number.isFinite(slFrac) && slFrac > 0 && slFrac <= 1;
const includeFees = process.env.INCLUDE_FEES === '0' ? false : true;

const hourStart = Number(process.env.RECALC_HOUR_START ?? 0);
const hourEndExclusive = Number(process.env.RECALC_HOUR_END_EXCLUSIVE ?? 16);

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
  `[day-16h] Jour ET : ${todayEt} · heures [${hourStart}, ${hourEndExclusive}) · bucket ${hourlyBreakdownBy === 'trade' ? 'trade' : 'fin créneau'} · fetch ${windowHours} h · signal ${minC}–${maxC}¢ · SL ${slC}¢${useSlFrac ? ` · perte fixe SL ${(slFrac * 100).toFixed(0)}%` : ''} · départ ${initialBalance} € · plafond ${maxStakeEur} € · frais ${includeFees ? 'oui' : 'non'}`,
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

const sortedDay = [...dayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
const sorted = sortedDay.filter((r) => {
  const h = rowHourEt(r);
  return h != null && h >= hourStart && h < hourEndExclusive;
});

if (sorted.length === 0) {
  console.info(`Aucun créneau dans [${hourStart}, ${hourEndExclusive}) pour ${todayEt} (fenêtre fetch ${windowHours} h).`);
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
  if (delta > 0) wonNet += 1;
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
console.log('═══ Résumé (backtest réinvest., créneaux filtrés [minuit → 16h) ═══');
console.log(
  `Créneaux traités : ${tradesProcessed}${tradesProcessed < sorted.length ? ` (arrêt capital < ${sorted.length} prévus)` : ''} · PnL net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} € · Capital final ${capital.toFixed(2)} € · Frais cumulés ${feesPaid.toFixed(2)} €`,
);
console.log(`WR net global : ${wrNetPct != null ? `${wrNetPct} %` : '—'} (trades avec delta PnL > 0)`);
console.log(`Max drawdown (séquence) : ${(maxDrawdown * 100).toFixed(2)} %`);
console.log(`Capital max (pic, max V) : ${peak.toFixed(2)} €`);
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
  `(Jour civil ${todayEt} ET · heures ${hourStart} ≤ h < ${hourEndExclusive} · aligné dashboard : signal ${minC}–${maxC}¢, SL ${slC}¢.)`,
);
