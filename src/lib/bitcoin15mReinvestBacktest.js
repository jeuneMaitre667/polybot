/**
 * Backtest 15m : mise = min(capital, mise max) à chaque trade (réinvestissement plafonné).
 * Après un SL le capital baisse : la mise suivante reflète ce capital — « reset » du rampement vers la mise max.
 */

import { getBacktestMaxLossFractionOfStake } from './bitcoinBacktestLossFraction.js';

export function getCalendarDayEt(isoOrDate) {
  const d = isoOrDate != null ? new Date(isoOrDate) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Jour civil `YYYY-MM-DD` dans un fuseau IANA (ex. `Europe/Paris`). */
export function getCalendarDayInTimezone(isoOrDate, timeZone) {
  const d = isoOrDate != null ? new Date(isoOrDate) : null;
  if (!d || Number.isNaN(d.getTime()) || typeof timeZone !== 'string' || !timeZone.trim()) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone.trim(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Heure locale 0–23 (America/New_York), basée sur `endDate` du créneau (fin du quart d’heure). */
export function hourOfDayEt(isoOrDate) {
  const d = isoOrDate != null ? new Date(isoOrDate) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value;
  return h != null ? parseInt(h, 10) : null;
}

/** Heure locale 0–23 dans un fuseau IANA (ex. `Europe/Paris`). */
export function hourOfDayInTimezone(isoOrDate, timeZone) {
  const d = isoOrDate != null ? new Date(isoOrDate) : null;
  if (!d || Number.isNaN(d.getTime()) || typeof timeZone !== 'string' || !timeZone.trim()) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone.trim(),
    hour: 'numeric',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value;
  return h != null ? parseInt(h, 10) : null;
}

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

/**
 * @param {object} r — ligne créneau enrichie
 * @param {'slotEnd' | 'trade'} bucket — `slotEnd` : heure de fin de créneau (`endDate`) ; `trade` : heure du signal / ordre (`botEntryTimestamp`, sec ou ms).
 */
function instantForHourlyBreakdownEt(r, bucket) {
  if (bucket === 'trade' && r.botEntryTimestamp != null) {
    const t = Number(r.botEntryTimestamp);
    if (Number.isFinite(t)) {
      return new Date(t < 1e12 ? t * 1000 : t);
    }
  }
  return r.endDate;
}

/**
 * @param {object[]} sortedRows — créneaux résolus, triés par temps croissant (même logique que le backtest fixe).
 * @param {object} opts
 * @param {number | null} [opts.slFixedLossFractionOfStake] — Si défini (ex. 0,25), chaque SL applique au PnL une perte
 *   `−stake × valeur − frais` ; le **déclenchement** SL sur la ligne (historique, seuil `backtestSlC`) est inchangé.
 * @param {boolean} [opts.hourlyBreakdownEt] — Si vrai, agrège le delta PnL par heure locale (0–23).
 * @param {'slotEnd' | 'trade'} [opts.hourlyBreakdownBy] — Avec `hourlyBreakdownEt` : regrouper par fin de créneau (`endDate`, défaut) ou par heure du trade (`botEntryTimestamp`), comme la colonne « HEURE TRADE » du dashboard.
 * @param {string | null} [opts.hourlyBreakdownTimezone] — Fuseau IANA pour les tranches horaires (ex. `Europe/Paris`). Si absent, utilise America/New_York (ET).
 * @returns {object} stats globales + si `opts.todayEt` : stats jour (même jour civil ET que `todayEt`).
 */
export function simulateReinvestMaxStake(sortedRows, opts) {
  const {
    initialBalance = 20,
    maxStakeEur = 500,
    backtestSlC = 58,
    includeFees = true,
    liveStopLossConditionId = null,
    todayEt = null,
    slFixedLossFractionOfStake = null,
    hourlyBreakdownEt = false,
    hourlyBreakdownBy = 'slotEnd',
    hourlyBreakdownTimezone = null,
  } = opts;

  const hourlyBucket =
    hourlyBreakdownBy === 'trade' ? 'trade' : 'slotEnd';

  const hourlyTz =
    typeof hourlyBreakdownTimezone === 'string' && hourlyBreakdownTimezone.trim() !== ''
      ? hourlyBreakdownTimezone.trim()
      : null;

  const cap = Number.isFinite(maxStakeEur) && maxStakeEur > 0 ? maxStakeEur : 10;
  const lossFracFallback = getBacktestMaxLossFractionOfStake();

  let capital = initialBalance > 0 ? initialBalance : 0;
  let peak = capital;
  let maxDrawdown = 0;
  let feesPaid = 0;
  let wonNet = 0;
  let wonResolution = 0;
  let slCount = 0;
  let resolutionLossNoSl = 0;

  let dayPnl = 0;
  let dayTrades = 0;
  let dayWonNet = 0;
  let dayWonResolution = 0;
  let daySl = 0;
  let dayResolutionLoss = 0;
  let capitalBeforeFirstTradeOfDay = null;
  let capitalEndOfDay = null;
  let enteredTargetDay = false;
  let tradesProcessed = 0;
  /** @type {Record<number, number> | null} */
  const hourlyDeltaEt = hourlyBreakdownEt ? {} : null;
  /** @type {Record<number, number> | null} */
  const hourlyTradesEt = hourlyBreakdownEt ? {} : null;

  for (const r of sortedRows) {
    const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
    const feeRate = estimateCryptoTakerFeeRate(p, includeFees);
    const budgetForTrade = Math.min(Math.max(0, capital), cap);
    if (budgetForTrade < 0.01) break;

    const rowDayEt = getCalendarDayEt(r.endDate);
    if (todayEt && rowDayEt === todayEt && !enteredTargetDay) {
      capitalBeforeFirstTradeOfDay = capital;
      enteredTargetDay = true;
    }

    const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
    const feeUsd = stake * feeRate;
    feesPaid += feeUsd;

    const rowConditionId = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
    const isStrictStopLoss =
      r.botStopLossExit === true ||
      (liveStopLossConditionId != null &&
        rowConditionId != null &&
        rowConditionId === liveStopLossConditionId);

    const delta = computeRowDelta(r, {
      stake,
      feeUsd,
      backtestSlC,
      lossFracFallback,
      liveStopLossConditionId,
      slFixedLossFractionOfStake,
    });

    if (isStrictStopLoss) slCount += 1;
    if (!isStrictStopLoss && r.botWon === false) resolutionLossNoSl += 1;
    if (r.botWon === true) wonResolution += 1;

    capital = Math.max(0, capital + delta);
    if (delta > 0) wonNet += 1;

    if (hourlyDeltaEt && hourlyTradesEt) {
      const inst = instantForHourlyBreakdownEt(r, hourlyBucket);
      const h = hourlyTz ? hourOfDayInTimezone(inst, hourlyTz) : hourOfDayEt(inst);
      if (h != null) {
        hourlyDeltaEt[h] = (hourlyDeltaEt[h] ?? 0) + delta;
        hourlyTradesEt[h] = (hourlyTradesEt[h] ?? 0) + 1;
      }
    }

    if (todayEt && rowDayEt === todayEt) {
      dayPnl += delta;
      dayTrades += 1;
      if (delta > 0) dayWonNet += 1;
      if (r.botWon === true) dayWonResolution += 1;
      if (isStrictStopLoss) daySl += 1;
      if (!isStrictStopLoss && r.botWon === false) dayResolutionLoss += 1;
      capitalEndOfDay = capital;
    }

    if (capital > peak) peak = capital;
    const dd = peak > 0 ? (peak - capital) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    tradesProcessed += 1;
  }

  const n = tradesProcessed;
  const dayWinRateNetPct =
    dayTrades > 0 ? Math.round((dayWonNet / dayTrades) * 1000) / 10 : null;
  const dayWinRateResPct =
    dayTrades > 0 ? Math.round((dayWonResolution / dayTrades) * 1000) / 10 : null;

  return {
    capital,
    initialBalance,
    pnl: capital - initialBalance,
    trades: n,
    wonNet,
    wonResolution,
    slCount,
    resolutionLossNoSl,
    winRateNetPct: n > 0 ? Math.round((wonNet / n) * 1000) / 10 : null,
    winRateResolutionPct: n > 0 ? Math.round((wonResolution / n) * 1000) / 10 : null,
    maxDrawdown,
    feesPaid,
    hourlyDeltaEt: hourlyBreakdownEt ? hourlyDeltaEt : null,
    hourlyTradesEt: hourlyBreakdownEt ? hourlyTradesEt : null,
    day:
      todayEt && enteredTargetDay
        ? {
            todayEt,
            pnl: dayPnl,
            trades: dayTrades,
            wonNet: dayWonNet,
            wonResolution: dayWonResolution,
            slCount: daySl,
            resolutionLossNoSl: dayResolutionLoss,
            winRateNetPct: dayWinRateNetPct,
            winRateResolutionPct: dayWinRateResPct,
            capitalBeforeFirstTrade: capitalBeforeFirstTradeOfDay,
            capitalEndOfDay,
          }
        : todayEt
          ? {
              todayEt,
              pnl: 0,
              trades: 0,
              wonNet: 0,
              wonResolution: 0,
              slCount: 0,
              resolutionLossNoSl: 0,
              winRateNetPct: null,
              winRateResolutionPct: null,
              capitalBeforeFirstTrade: null,
            }
          : null,
  };
}
