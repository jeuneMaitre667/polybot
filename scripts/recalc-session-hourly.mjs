/**
 * Backtest 15m : fenêtre **continue** en heure America/New_York (trade ou fin de créneau),
 * PnL réinvesti plafonné, SL avec **perte fixe** du stake (défaut 25 % comme le bot / dashboard).
 *
 * Usage (PowerShell) :
 *   $env:INITIAL_BALANCE_EUR='10'; $env:SL_FIXED_LOSS_FRAC='0.25'; $env:BACKTEST_WINDOW_HOURS='720'; $env:RECALC_TODAY_ALLOW_WIDE='1'; npm run recalc:session-hourly
 *
 * Fenêtre par défaut : 2026-03-27 19:00 → 2026-03-28 14:00 **ET** (EDT -04:00). Override ISO :
 *   $env:RECALC_SESSION_START_ISO='2026-03-27T19:00:00-04:00'; $env:RECALC_SESSION_END_ISO='2026-03-28T14:00:00-04:00'
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
if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 720;
if (windowHours > 168 && process.env.RECALC_TODAY_ALLOW_WIDE !== '1') {
  console.warn(
    `[session-hourly] BACKTEST_WINDOW_HOURS=${windowHours} > 168 — plafonné à 168. Exportez RECALC_TODAY_ALLOW_WIDE=1 pour élargir (ex. 720).`,
  );
  windowHours = 168;
}

const initialBalance = Number(process.env.INITIAL_BALANCE_EUR || 10);
const maxStakeEur = Number(process.env.MAX_STAKE_EUR || 500);
const minC = Number(process.env.BACKTEST_SIGNAL_MIN_C || 77);
const maxC = Number(process.env.BACKTEST_SIGNAL_MAX_C || 78);
const slC = Number(process.env.BACKTEST_SL_C || 60);
const includeFees = process.env.INCLUDE_FEES === '0' ? false : true;

const slFracRaw = process.env.SL_FIXED_LOSS_FRAC;
const slFrac =
  slFracRaw === undefined || String(slFracRaw).trim() === ''
    ? 0.25
    : Number(slFracRaw);
const useSlFrac = Number.isFinite(slFrac) && slFrac > 0 && slFrac <= 1;

const hourlyBucketRaw = (process.env.HOURLY_BUCKET || 'trade').toLowerCase();
const hourlyBreakdownBy = hourlyBucketRaw === 'slotend' || hourlyBucketRaw === 'slot_end' ? 'slotEnd' : 'trade';

const startIso =
  typeof process.env.RECALC_SESSION_START_ISO === 'string' && process.env.RECALC_SESSION_START_ISO.trim() !== ''
    ? process.env.RECALC_SESSION_START_ISO.trim()
    : '2026-03-27T19:00:00-04:00';
const endIso =
  typeof process.env.RECALC_SESSION_END_ISO === 'string' && process.env.RECALC_SESSION_END_ISO.trim() !== ''
    ? process.env.RECALC_SESSION_END_ISO.trim()
    : '2026-03-28T14:00:00-04:00';

const sessionStartMs = Date.parse(startIso);
const sessionEndMs = Date.parse(endIso);
if (!Number.isFinite(sessionStartMs) || !Number.isFinite(sessionEndMs) || sessionEndMs <= sessionStartMs) {
  console.error('RECALC_SESSION_START_ISO / RECALC_SESSION_END_ISO invalides ou fin ≤ début.');
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

function instantMs(r) {
  const inst = instantForHourlyBreakdownEt(r, hourlyBreakdownBy);
  if (inst == null) return null;
  const d = inst instanceof Date ? inst : new Date(inst);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function hourKeyEt(r) {
  const inst = instantForHourlyBreakdownEt(r, hourlyBreakdownBy);
  if (inst == null) return null;
  const d = inst instanceof Date ? inst : new Date(inst);
  if (Number.isNaN(d.getTime())) return null;
  const day = getCalendarDayEt(d);
  const h = hourOfDayEt(d);
  if (day == null || h == null) return null;
  return `${day}_${String(h).padStart(2, '0')}`;
}

console.info(
  `[session-hourly] Fenêtre ET [${startIso} → ${endIso}) · bucket ${hourlyBreakdownBy === 'trade' ? 'heure trade' : 'heure fin créneau'} · fetch ${windowHours} h · signal ${minC}–${maxC}¢ · SL ${slC}¢ · perte SL ${useSlFrac ? `${(slFrac * 100).toFixed(0)} %` : 'historique'} · départ ${initialBalance} € · plafond ${maxStakeEur} € · dwell ${simCfg.signalMinDwellSec ?? 0} s`,
);
console.info('[session-hourly] Chargement API…');

const { enrichedFinal } = await fetchBitcoin15mResolvedData(windowHours, simCfg, false);

const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');

const inSession = withSimul.filter((r) => {
  const ms = instantMs(r);
  return ms != null && ms >= sessionStartMs && ms < sessionEndMs;
});

const sorted = [...inSession].sort((a, b) => {
  const ma = instantMs(a);
  const mb = instantMs(b);
  return (ma ?? 0) - (mb ?? 0);
});

if (sorted.length === 0) {
  console.info(
    `Aucun créneau avec entrée simulée dans la fenêtre (marchés résolus + signal). Élargir BACKTEST_WINDOW_HOURS ou vérifier les dates ISO (données disponibles seulement si la fenêtre fetch recouvre ces marchés).`,
  );
  console.info(`Marchés avec signal (toute fenêtre fetch) : ${withSignal.length} · résolus : ${withSimul.length}`);
  process.exit(0);
}

let capital = initialBalance > 0 ? initialBalance : 0;
let peak = capital;
let maxDrawdown = 0;
let feesPaid = 0;
let wonNet = 0;
let wonResolution = 0;
let slCount = 0;
let resolutionLossNoSl = 0;
let tradesProcessed = 0;
let winStreak = 0;
let lossStreak = 0;
let maxWinStreak = 0;
let maxLossStreak = 0;

/** @type {Record<string, { trades: number, pnl: number, wonNet: number, sl: number, resWin: number }>} */
const hourly = {};

for (const r of sorted) {
  const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
  const feeRate = estimateCryptoTakerFeeRate(p, includeFees);
  const budgetForTrade = Math.min(Math.max(0, capital), cap);
  if (budgetForTrade < 0.01) break;

  const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
  const feeUsd = stake * feeRate;
  feesPaid += feeUsd;

  const isStrictStopLoss = r.botStopLossExit === true;

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

  if (r.botWon === true) wonResolution += 1;
  if (isStrictStopLoss) slCount += 1;
  if (!isStrictStopLoss && r.botWon === false) resolutionLossNoSl += 1;

  tradesProcessed += 1;

  if (capital > peak) peak = capital;
  const dd = peak > 0 ? (peak - capital) / peak : 0;
  if (dd > maxDrawdown) maxDrawdown = dd;

  const hk = hourKeyEt(r);
  if (hk == null) continue;
  if (!hourly[hk]) hourly[hk] = { trades: 0, pnl: 0, wonNet: 0, sl: 0, resWin: 0 };
  hourly[hk].trades += 1;
  hourly[hk].pnl += delta;
  if (delta > 0) hourly[hk].wonNet += 1;
  if (isStrictStopLoss) hourly[hk].sl += 1;
  if (r.botWon === true) hourly[hk].resWin += 1;
}

const pnl = capital - initialBalance;
const wrNetPct =
  tradesProcessed > 0 ? Math.round((wonNet / tradesProcessed) * 1000) / 10 : null;
const wrResPct =
  tradesProcessed > 0 ? Math.round((wonResolution / tradesProcessed) * 1000) / 10 : null;

console.log('');
console.log('═══ Résumé session (réinvest. plafonné, créneaux dans la fenêtre) ═══');
console.log(
  `Créneaux dans la fenêtre [${startIso} → ${endIso}) : ${sorted.length} · traités : ${tradesProcessed}${tradesProcessed < sorted.length ? ` (arrêt capital)` : ''}`,
);
console.log(
  `PnL net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} € · Capital final ${capital.toFixed(2)} € · Frais cumulés ${feesPaid.toFixed(2)} €`,
);
console.log(`WR net (delta > 0) : ${wrNetPct != null ? `${wrNetPct} %` : '—'} · WR résolution : ${wrResPct != null ? `${wrResPct} %` : '—'}`);
console.log(`SL simulés : ${slCount} · Pertes résolution (sans SL) : ${resolutionLossNoSl}`);
console.log(`Max drawdown : ${(maxDrawdown * 100).toFixed(2)} % · Pic capital : ${peak.toFixed(2)} €`);
console.log(`Max victoires consécutives : ${maxWinStreak} · Max défaites consécutives : ${maxLossStreak}`);
console.log('');

const hourKeys = Object.keys(hourly).sort((a, b) => a.localeCompare(b));
console.log('Heure ET (bucket)          | Trades | PnL €   | WR net | SL | WR rés.');
console.log('----------------------------|--------|---------|--------|----|--------');
for (const hk of hourKeys) {
  const x = hourly[hk];
  const n = x.trades;
  const d = x.pnl;
  const w = x.wonNet;
  const sl = x.sl;
  const rw = x.resWin;
  const wr = n > 0 ? Math.round((w / n) * 1000) / 10 : null;
  const wrr = n > 0 ? Math.round((rw / n) * 1000) / 10 : null;
  const label = hk.replace('_', ' ');
  console.log(
    `${label.padEnd(28)}| ${String(n).padStart(6)} | ${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(7)} | ${wr != null ? `${String(wr).padStart(5)} %` : '    —'} | ${String(sl).padStart(2)} | ${wrr != null ? `${String(wrr).padStart(5)} %` : '    —'}`,
  );
}
console.log('');
console.log(
  `(Signal ${minC}–${maxC}¢ · SL ${slC}¢ · perte SL fixe ${useSlFrac ? `${(slFrac * 100).toFixed(0)} % du stake` : '—'} · même fetch que le dashboard.)`,
);
