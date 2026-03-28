/**
 * Détail des créneaux dont le trade est 00:00–00:59 à Paris le 27/03/2026,
 * dans l’ordre de traitement du backtest (fin de créneau croissante).
 *
 *   npx vite-node --config vite.config.js scripts/detail-paris-hour0-four-slots.mjs
 */
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from '../src/lib/bitcoin15mResolvedDataFetch.js';
import { getCalendarDayInTimezone, hourOfDayInTimezone } from '../src/lib/bitcoin15mReinvestBacktest.js';
import { getBacktestMaxLossFractionOfStake } from '../src/lib/bitcoinBacktestLossFraction.js';

function estimateCryptoTakerFeeRate(p, includeFees) {
  if (!includeFees) return 0;
  if (p == null) return 0;
  const x = p * (1 - p);
  return 0.25 * Math.pow(x, 2);
}

function computeRowDelta(r, {
  stake,
  feeUsd,
  backtestSlC,
  lossFracFallback,
  liveStopLossConditionId,
  slFixedLossFractionOfStake = null,
}) {
  let delta = 0;
  const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
  const rowConditionId = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
  const isStrictStopLoss =
    r.botStopLossExit === true ||
    (liveStopLossConditionId != null &&
      rowConditionId != null &&
      rowConditionId === liveStopLossConditionId);
  if (isStrictStopLoss) {
    if (
      slFixedLossFractionOfStake != null &&
      Number.isFinite(Number(slFixedLossFractionOfStake)) &&
      Number(slFixedLossFractionOfStake) > 0 &&
      Number(slFixedLossFractionOfStake) <= 1
    ) {
      return -stake * Number(slFixedLossFractionOfStake) - feeUsd;
    }
    const observed = r.botStopLossObservedPriceP != null ? Number(r.botStopLossObservedPriceP) : null;
    const triggerP = Math.max(0.01, Math.min(0.99, Number(backtestSlC) / 100));
    const wp = r.botStopLossExitPriceP != null ? Number(r.botStopLossExitPriceP) : null;
    const slExecP =
      Number.isFinite(observed) && observed > 0 ? Math.max(triggerP, observed) : triggerP;
    if (Number.isFinite(p) && p > 0 && Number.isFinite(slExecP) && slExecP >= 0) {
      delta = stake * (slExecP / p - 1) - feeUsd;
    } else if (Number.isFinite(p) && p > 0 && Number.isFinite(wp) && wp >= 0) {
      delta = stake * (wp / p - 1) - feeUsd;
    } else {
      delta = -stake * lossFracFallback - feeUsd;
    }
  } else if (p != null && r.botWon === true) {
    const odds = p > 0 ? 1 / p - 1 : 0;
    delta = stake * odds - feeUsd;
  } else if (r.botWon === false) {
    delta = -stake - feeUsd;
  }
  return delta;
}

const TZ = 'Europe/Paris';
const DAY = '2026-03-27';
const windowHours = 168;
const initialBalance = 20;
const maxStakeEur = 500;
const slC = 60;
const slFrac = 0.25;

const simCfg = resolve15mSimConfig({
  simConfig: {
    detectMinP: 0.77,
    entryMinP: 0.77,
    entryMaxP: 0.78,
    stopLossTriggerPriceP: slC / 100,
  },
});

const fmtParis = (sec) => {
  const t = Number(sec);
  const ms = t < 1e12 ? t * 1000 : t;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(ms));
};

function tradeInTargetHour(r) {
  if (r.botEntryTimestamp == null) return false;
  const t = Number(r.botEntryTimestamp);
  const ms = t < 1e12 ? t * 1000 : t;
  if (getCalendarDayInTimezone(ms, TZ) !== DAY) return false;
  return hourOfDayInTimezone(ms, TZ) === 0;
}

const { enrichedFinal } = await fetchBitcoin15mResolvedData(windowHours, simCfg, false);
const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
const dayRows = withSimul.filter((r) => getCalendarDayInTimezone(r.endDate, TZ) === DAY);
const sorted = [...dayRows].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

const lossFracFallback = getBacktestMaxLossFractionOfStake();
const cap = maxStakeEur;
const liveStopLossConditionId = null;

let capital = initialBalance > 0 ? initialBalance : 0;
let seq = 0;
const picked = [];
let sumDelta = 0;

for (let idx = 0; idx < sorted.length; idx++) {
  const r = sorted[idx];
  const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
  const feeRate = estimateCryptoTakerFeeRate(p, true);
  const budgetForTrade = Math.min(Math.max(0, capital), cap);
  if (budgetForTrade < 0.01) break;

  const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
  const feeUsd = stake * feeRate;

  const rowConditionId = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
  const isStrictStopLoss =
    r.botStopLossExit === true ||
    (liveStopLossConditionId != null &&
      rowConditionId != null &&
      rowConditionId === liveStopLossConditionId);

  const delta = computeRowDelta(r, {
    stake,
    feeUsd,
    backtestSlC: slC,
    lossFracFallback,
    liveStopLossConditionId,
    slFixedLossFractionOfStake: slFrac,
  });

  const capitalBefore = capital;
  capital = Math.max(0, capital + delta);

  if (tradeInTargetHour(r)) {
    seq += 1;
    sumDelta += delta;
    let labelOutcome = '—';
    if (isStrictStopLoss) labelOutcome = `SL (−${(slFrac * 100).toFixed(0)} % stake + frais)`;
    else if (r.botWon === true) labelOutcome = 'Gain résolution';
    else if (r.botWon === false) labelOutcome = 'Perte résolution';

    picked.push({
      seq,
      indexJour: idx + 1,
      capitalBefore,
      budgetForTrade,
      stake,
      feeUsd,
      feeRate,
      delta,
      capitalAfter: capital,
      slug: r.eventSlug ?? '—',
      endUtc: r.endDate,
      tradeParis: fmtParis(r.botEntryTimestamp),
      p,
      botWon: r.botWon,
      isStrictStopLoss,
      labelOutcome,
      side: r.botWouldTake,
      winner: r.winner,
    });
  }
}

console.log(`Journée ${DAY} (${TZ}, fin de créneau) — ${sorted.length} créneaux traités dans l’ordre.\n`);
console.log(`Créneaux avec trade 00:00–00:59 ${TZ} le ${DAY} : ${picked.length}\n`);
console.log('═'.repeat(72));

for (const row of picked) {
  console.log(`\n### ${row.seq}/4 — créneau n°${row.indexJour} du jour (ordre fin de créneau)\n`);
  console.log(`  slug          ${row.slug}`);
  console.log(`  fin (UTC)     ${row.endUtc}`);
  console.log(`  trade (Paris) ${row.tradeParis}`);
  console.log(`  entrée / issue  ${row.side} · p=${row.p} · résol. ${row.winner} · ${row.labelOutcome}`);
  console.log('');
  console.log(`  capital avant   ${row.capitalBefore.toFixed(2)} €`);
  console.log(`  budget (mise)   ${row.budgetForTrade.toFixed(4)} €  (= min(capital, ${maxStakeEur} €))`);
  console.log(`  feeRate(p)      ${row.feeRate.toFixed(6)}`);
  console.log(`  stake           ${row.stake.toFixed(4)} €`);
  console.log(`  frais €         ${row.feeUsd.toFixed(4)} €`);
  console.log(`  Δ PnL           ${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)} €`);
  console.log(`  capital après   ${row.capitalAfter.toFixed(2)} €`);
}

console.log(`\n${'═'.repeat(72)}`);
console.log(`Somme des Δ sur ces ${picked.length} lignes : ${sumDelta >= 0 ? '+' : ''}${sumDelta.toFixed(2)} € (attendu tableau ~ −2,60 € si 4 lignes)`);
if (picked.length !== 4) {
  console.warn(`\n[Attention] ${picked.length} ligne(s) au lieu de 4 — données ou fenêtre différente du run précédent.`);
}
