/**
 * PnL agrégé par heure locale (trade ou fin de créneau), SL réinvest + perte fixe.
 *
 * Mode ET (défaut) :
 *   - Jour : `RECALC_TARGET_DAY_ET=YYYY-MM-DD` ou aujourd’hui en America/New_York.
 *   - Heures : ET (sauf si `RECALC_CALENDAR_TZ` défini, voir ci-dessous).
 *
 * Mode jour civil personnalisé (ex. Paris) :
 *   - `RECALC_CALENDAR_TZ=Europe/Paris` + `RECALC_TARGET_DAY=2026-03-27`
 *   - Filtre : créneaux dont la **fin** (`endDate`) tombe ce jour-là dans ce fuseau.
 *   - Table : tranches 0–23 h **dans ce fuseau** (heure du trade si `HOURLY_BUCKET=trade`).
 *
 *   npx vite-node --config vite.config.js scripts/recalc-today-pnl-by-hour.mjs
 *   $env:RECALC_CALENDAR_TZ='Europe/Paris'; $env:RECALC_TARGET_DAY='2026-03-27'; npm run recalc:today-by-hour
 */
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from '../src/lib/bitcoin15mResolvedDataFetch.js';
import {
  getCalendarDayEt,
  getCalendarDayInTimezone,
  simulateReinvestMaxStake,
} from '../src/lib/bitcoin15mReinvestBacktest.js';

let windowHours = Number(process.env.BACKTEST_WINDOW_HOURS);
if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 96;
if (windowHours > 168 && process.env.RECALC_TODAY_ALLOW_WIDE !== '1') {
  console.warn(
    `[by-hour] BACKTEST_WINDOW_HOURS trop large (${windowHours}) — plafonné à 168 h. RECALC_TODAY_ALLOW_WIDE=1 pour forcer.`,
  );
  windowHours = 168;
}

const initialBalance = Number(process.env.INITIAL_BALANCE_EUR || 20);
const maxStakeEur = Number(process.env.MAX_STAKE_EUR || 500);
const minC = Number(process.env.BACKTEST_SIGNAL_MIN_C || 77);
const maxC = Number(process.env.BACKTEST_SIGNAL_MAX_C || 78);
const slC = Number(process.env.BACKTEST_SL_C || 60);
const slFrac = Number(process.env.SL_FIXED_LOSS_FRAC || 0.25);

const hourlyBucketRaw = (process.env.HOURLY_BUCKET || 'trade').toLowerCase();
const hourlyBreakdownBy = hourlyBucketRaw === 'slotend' || hourlyBucketRaw === 'slot_end' ? 'slotEnd' : 'trade';

const calendarTz =
  typeof process.env.RECALC_CALENDAR_TZ === 'string' && process.env.RECALC_CALENDAR_TZ.trim() !== ''
    ? process.env.RECALC_CALENDAR_TZ.trim()
    : null;

/** @type {string | null} */
let todayEt = null;
/** @type {string | null} */
let targetCalendarDay = null;
/** @type {string | null} */
let hourlyBreakdownTimezone = null;

if (calendarTz) {
  hourlyBreakdownTimezone = calendarTz;
  if (
    typeof process.env.RECALC_TARGET_DAY === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(process.env.RECALC_TARGET_DAY.trim())
  ) {
    targetCalendarDay = process.env.RECALC_TARGET_DAY.trim();
  } else {
    targetCalendarDay = getCalendarDayInTimezone(new Date(), calendarTz);
  }
  if (!targetCalendarDay) {
    console.error('Date calendaire impossible dans ce fuseau.');
    process.exit(1);
  }
} else {
  todayEt =
    typeof process.env.RECALC_TARGET_DAY_ET === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(process.env.RECALC_TARGET_DAY_ET.trim())
      ? process.env.RECALC_TARGET_DAY_ET.trim()
      : getCalendarDayEt(new Date());
  if (!todayEt) {
    console.error('Date ET impossible.');
    process.exit(1);
  }
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

const dayLog = calendarTz
  ? `${targetCalendarDay} · ${calendarTz}${process.env.RECALC_TARGET_DAY ? ' (RECALC_TARGET_DAY)' : ''}`
  : `${todayEt}${process.env.RECALC_TARGET_DAY_ET ? ' (RECALC_TARGET_DAY_ET)' : ''} · America/New_York`;

console.info(
  `[by-hour] Jour (fin créneau) : ${dayLog} · bucket ${hourlyBreakdownBy === 'trade' ? 'heure trade' : 'fin créneau'} · heures affichées : ${hourlyBreakdownTimezone ?? 'ET'} · fetch ${windowHours} h · signal ${minC}–${maxC}¢ · SL ${slC}¢ · SL perte fixe ${(slFrac * 100).toFixed(0)} % · départ ${initialBalance} € · plafond ${maxStakeEur} €`,
);
console.info('[by-hour] Chargement des données…');

const { enrichedFinal } = await fetchBitcoin15mResolvedData(windowHours, simCfg, false);

const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const todayRows = calendarTz
  ? withSimul.filter((r) => getCalendarDayInTimezone(r.endDate, calendarTz) === targetCalendarDay)
  : withSimul.filter((r) => getCalendarDayEt(r.endDate) === todayEt);
const sorted = [...todayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

if (sorted.length === 0) {
  console.info('Aucun créneau pour ce jour dans la fenêtre.');
  process.exit(0);
}

const r = simulateReinvestMaxStake(sorted, {
  initialBalance,
  maxStakeEur,
  backtestSlC: slC,
  includeFees: true,
  liveStopLossConditionId: null,
  slFixedLossFractionOfStake: slFrac,
  hourlyBreakdownEt: true,
  hourlyBreakdownBy,
  hourlyBreakdownTimezone,
  todayEt: calendarTz ? null : todayEt,
});

const pnl = r.capital - initialBalance;

const tzShort = calendarTz === 'Europe/Paris' ? 'Paris' : calendarTz ?? 'ET';

console.log('');
console.log(`Total journée : ${sorted.length} créneaux · PnL net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} € · capital final ${r.capital.toFixed(2)} € · frais cumulés ${r.feesPaid.toFixed(2)} €`);
console.log('');
const hourLabel = calendarTz
  ? hourlyBreakdownBy === 'trade'
    ? `Heure ${tzShort} (trade / signal)`
    : `Heure ${tzShort} (fin créneau)`
  : hourlyBreakdownBy === 'trade'
    ? 'Heure ET (trade / signal)'
    : 'Heure ET (fin créneau)';
console.log(`${hourLabel} | Créneaux | Delta PnL cumulé (€)`);
console.log('------------------------|----------|----------------------');

for (let h = 0; h < 24; h++) {
  const n = r.hourlyTradesEt?.[h] ?? 0;
  const d = r.hourlyDeltaEt?.[h] ?? 0;
  const hh = String(h).padStart(2, '0');
  console.log(`${hh}:00–${hh}:59              | ${String(n).padStart(8)} | ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
}

console.log('');
if (calendarTz) {
  console.log(
    `(Filtre journée : date de fin de créneau en ${calendarTz}. Tranches : ${hourlyBreakdownBy === 'trade' ? 'heure du trade' : 'heure de fin de créneau'} dans le même fuseau.)`,
  );
} else {
  console.log(
    hourlyBreakdownBy === 'trade'
      ? '(Les lignes à 0 = aucun trade dans cette heure ET. Le filtre « journée » reste basé sur la date de fin de créneau ET.)'
      : '(Les lignes à 0 = aucune fin de créneau dans cette heure ET.)',
  );
}
