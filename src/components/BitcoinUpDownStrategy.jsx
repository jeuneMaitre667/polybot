import { useState, useEffect, useRef, useMemo } from 'react';
import { useBitcoinUpDownSignals } from '../hooks/useBitcoinUpDownSignals';
import {
  useBitcoinUpDownResolved15m,
  BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
  BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT,
  BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
  BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED,
} from '../hooks/useBitcoinUpDownResolved15m';
import { useOrderBookLiquidity } from '../hooks/useOrderBookLiquidity';
import { useBotStatus, DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M } from '../hooks/useBotStatus';
import { useWallet } from '../context/useWallet';
import { placePolymarketOrder } from '../lib/polymarketOrder';
import { ORDER_BOOK_SIGNAL_MAX_P, ORDER_BOOK_SIGNAL_MIN_P } from '../lib/orderBookLiquidity.js';

const SIGNAL_BAND_PCT_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MIN_P * 100)}–${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)} %`;
const SIGNAL_MAX_CENTS_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)}¢`;
import { build15mBacktestDisplayRows, MAX_15M_GRID_SLOTS, SLOT_15M_SEC } from '../lib/bitcoin15mGridDisplay.js';
import {
  formatBitcoin15mSlotRangeEt,
  formatTradeTimestampEt,
  formatTimestampUtcTooltip,
} from '../lib/polymarketDisplayTime.js';
import { getBacktestMaxLossFractionOfStake } from '../lib/bitcoinBacktestLossFraction.js';

function formatMoney(value) {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
const STORAGE_KEY_LIQUIDITY_SUGGESTION = 'polymarket-dashboard.showLiquiditySuggestion';
const STORAGE_KEY_AUTOTRADE = 'polymarket-dashboard.autoPlaceEnabled';
const STORAGE_BACKTEST_15M_DEBUG = 'polymarket-dashboard.backtest15mDebug';
const STORAGE_BACKTEST_15M_SIGNAL_MIN_C = 'polymarket-dashboard.backtest15mSignalMinC';
const STORAGE_BACKTEST_15M_SIGNAL_MAX_C = 'polymarket-dashboard.backtest15mSignalMaxC';
const STORAGE_BACKTEST_15M_SL_C = 'polymarket-dashboard.backtest15mSlC';
const STORAGE_BACKTEST_15M_MAX_STAKE_EUR = 'polymarket-dashboard.backtest15mMaxStakeEur';
const STORAGE_BACKTEST_15M_WINDOW_DAYS = 'polymarket-dashboard.backtest15mWindowDays';

/** Fenêtres historique backtest 15m (jours calendaires × 24 h). */
const BACKTEST_WINDOW_DAYS_OPTIONS = [3, 7, 30];

function normalizeBacktestWindowDays(raw) {
  const n = Number(raw);
  return BACKTEST_WINDOW_DAYS_OPTIONS.includes(n) ? n : 3;
}
/** Grille SL dans les tableaux d’analyse 15m (70¢ → 60¢, pas 5¢). */
const SL_ANALYSIS_THRESHOLDS_C = [70, 65, 60];
const OPT_SIGNAL_BANDS_C = [
  [94, 95],
  [95, 96],
  [96, 97],
  [97, 98],
];
const OPT_SL_C = [68, 70, 72, 75, 78];
const OPT_STAKE_EUR = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const SL_ANALYSIS_STAKE_USD = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

function readAutoPlaceFromStorage() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY_AUTOTRADE) === '1';
  } catch {
    return false;
  }
}

function readBacktest15mDebugFromStorage() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_BACKTEST_15M_DEBUG) === '1';
  } catch {
    return false;
  }
}

function readNumberFromStorage(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Slug Polymarket du créneau Bitcoin Up or Down - Hourly pour l'heure actuelle (ET). */
function getCurrentBitcoinUpDownEventSlug() {
  const tz = 'America/New_York';
  const d = new Date();
  const month = d.toLocaleString('en-US', { timeZone: tz, month: 'long' }).toLowerCase();
  const day = parseInt(d.toLocaleString('en-US', { timeZone: tz, day: 'numeric' }), 10);
  const year = parseInt(d.toLocaleString('en-US', { timeZone: tz, year: 'numeric' }), 10);
  let hour = parseInt(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  const ampm = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12 || 12;
  return `${BITCOIN_UP_DOWN_SLUG}-${month}-${day}-${year}-${hour}${ampm}-et`;
}

/** Slug Polymarket du créneau 15 min ouvert : `btc-updown-15m-{eventStartSec}` (début fenêtre, s UTC). */
function getCurrent15mEventSlug() {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotStart = Math.floor(nowSec / SLOT_15M_SEC) * SLOT_15M_SEC;
  return `btc-updown-15m-${slotStart}`;
}

/** Point vert (Up) ou rouge (Down) comme sur Polymarket. */
function UpDownDot({ side, title = true }) {
  if (side !== 'Up' && side !== 'Down') return null;
  const isUp = side === 'Up';
  return (
    <span
      className={`updown-dot ${isUp ? 'updown-dot--up' : 'updown-dot--down'}`}
      title={title ? (isUp ? 'Up' : 'Down') : undefined}
      aria-label={isUp ? 'Up' : 'Down'}
    />
  );
}

function signalBucketLabelFromPrice(priceP) {
  const p = Number(priceP);
  if (!Number.isFinite(p) || p <= 0) return null;
  const pct = p * 100;
  const bucketPct = Math.round(pct * 10) / 10;
  return `${bucketPct.toFixed(1)}%`;
}

function runFixedStakeGridSearch(rows, initialBalance, options = {}) {
  const useReinvest = options.useReinvest === true;
  const baseRows = (Array.isArray(rows) ? rows : [])
    .filter(
      (r) =>
        r.botWouldTake != null &&
        r.botEntryPrice != null &&
        r.botMinObservedAfterEntryP != null &&
        (r.winner === 'Up' || r.winner === 'Down') &&
        r.endDate
    )
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  const out = [];
  for (const [minC, maxC] of OPT_SIGNAL_BANDS_C) {
    for (const slC of OPT_SL_C) {
      for (const stakeBase of OPT_STAKE_EUR) {
          const startCapital = initialBalance > 0 ? initialBalance : 0;
          let capital = startCapital;
        let peak = capital;
        let maxDd = 0;
        let trades = 0;
        let winsNet = 0;
        let winsResolution = 0;
        let slHits = 0;
          for (const r of baseRows) {
          const entry = Number(r.botEntryPrice);
          const minAfter = Number(r.botMinObservedAfterEntryP);
          if (!(entry > 0 && entry < 1 && minAfter > 0 && minAfter < 1)) continue;
          const entryC = entry * 100;
          if (entryC < minC || entryC > maxC) continue;
          const slP = slC / 100;
          const slTouched = minAfter <= slP;
          const winResolution = r.winner === r.botWouldTake;
            const stakeAmount = useReinvest
              ? Math.max(0, Math.min(capital, stakeBase * (capital / Math.max(1, startCapital))))
              : Math.max(0, Math.min(stakeBase, capital));
            if (!(stakeAmount > 0)) break;
          let delta = 0;
          if (slTouched) {
              delta = stakeAmount * (slP / entry - 1);
            slHits += 1;
          } else if (winResolution) {
              delta = stakeAmount * (1 / entry - 1);
          } else {
              delta = -stakeAmount;
          }
          trades += 1;
          if (delta > 0) winsNet += 1;
          if (winResolution) winsResolution += 1;
          capital += delta;
          if (capital > peak) peak = capital;
          const dd = peak > 0 ? (peak - capital) / peak : 0;
          if (dd > maxDd) maxDd = dd;
        }
        if (trades === 0) continue;
        out.push({
          signalBand: `${minC}-${maxC}`,
          slC,
            stake: stakeBase,
            reinvest: useReinvest,
          trades,
          pnl: capital - initialBalance,
          finalCapital: capital,
          winRateNetPct: (winsNet / trades) * 100,
          winRateResolutionPct: (winsResolution / trades) * 100,
          slHitPct: (slHits / trades) * 100,
          maxDrawdownPct: maxDd * 100,
        });
      }
    }
  }
  return out.sort((a, b) => b.pnl - a.pnl);
}

export function BitcoinUpDownStrategy() {
  const { address, signer, isPolygon } = useWallet();
  const resultMode = '15m';
  const { signals, live15mMeta } = useBitcoinUpDownSignals('15m');

  /** Liquidité / carnet : même token que le signal « prix seul » si la grille ET masque le signal affiché. */
  const currentSignalTokenId =
    signals?.[0]?.tokenIdToBuy ??
    (live15mMeta?.hiddenByTiming ? live15mMeta.signalsIfTimingIgnored?.[0]?.tokenIdToBuy : null) ??
    null;
  const { liquidityUsd: liquidityAtTargetUsd, loading: liquidityLoading, error: liquidityError, refresh: refreshLiquidity } = useOrderBookLiquidity(currentSignalTokenId);
  const { data: botStatusData } = useBotStatus(DEFAULT_BOT_STATUS_URL);
  const { data: botStatusData15m } = useBotStatus(DEFAULT_BOT_STATUS_URL_15M);
  const liquidityStats = botStatusData?.liquidityStats ?? null;

  const [backtestWindowDays, setBacktestWindowDays] = useState(() =>
    normalizeBacktestWindowDays(readNumberFromStorage(STORAGE_BACKTEST_15M_WINDOW_DAYS, 3))
  );
  const [includeFees, setIncludeFees] = useState(true);
  const [backtest15mDebug, setBacktest15mDebug] = useState(readBacktest15mDebugFromStorage);
  const [signalMinC, setSignalMinC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, 95));
  const [signalMaxC, setSignalMaxC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, 96));
  const [backtestSlC, setBacktestSlC] = useState(() =>
    readNumberFromStorage(STORAGE_BACKTEST_15M_SL_C, Math.round(BACKTEST_STOP_LOSS_TRIGGER_PRICE_P * 100))
  );
  const backtestReinvest = true;
  const [backtestMaxStakeEur, setBacktestMaxStakeEur] = useState(() =>
    readNumberFromStorage(STORAGE_BACKTEST_15M_MAX_STAKE_EUR, 0)
  );
  const resolvedWindowHours = backtestWindowDays * 24;
  const resolvedDaysCount = backtestWindowDays;
  const {
    resolved: resolved15m,
    loading: resolved15mLoading,
    error: resolved15mError,
    refresh: refreshResolved15m,
    debugSummary: resolved15mDebugSummary,
  } = useBitcoinUpDownResolved15m(resolvedWindowHours, {
    debug: backtest15mDebug,
    simConfig: {
      detectMinP: Math.max(0.5, Math.min(0.999, Number(signalMinC) / 100)),
      entryMinP: Math.max(0.5, Math.min(0.999, Number(signalMinC) / 100)),
      entryMaxP: Math.max(0.5, Math.min(0.999, Number(signalMaxC) / 100)),
      stopLossTriggerPriceP: Math.max(0.01, Math.min(0.99, Number(backtestSlC) / 100)),
    },
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, String(signalMinC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, String(signalMaxC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SL_C, String(backtestSlC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_MAX_STAKE_EUR, String(backtestMaxStakeEur));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_WINDOW_DAYS, String(backtestWindowDays));
    } catch {
      /* ignore */
    }
  }, [signalMinC, signalMaxC, backtestSlC, backtestMaxStakeEur, backtestWindowDays]);

  /** Grille complète : un créneau 15 min par ligne (placeholders pour les trous). */
  const resolved15mDisplayRows = useMemo(
    () => build15mBacktestDisplayRows(resolved15m, resolvedWindowHours),
    [resolved15m, resolvedWindowHours]
  );

  const toggleBacktest15mDebug = () => {
    setBacktest15mDebug((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORAGE_BACKTEST_15M_DEBUG, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const decisionReasonCounts = useMemo(() => {
    const stats =
      resultMode === '15m' && DEFAULT_BOT_STATUS_URL_15M
        ? botStatusData15m?.signalDecisionLatencyStats
        : botStatusData?.signalDecisionLatencyStats;
    return stats?.reasonCounts ?? null;
  }, [resultMode, botStatusData, botStatusData15m]);

  const decisionBarPercents = useMemo(() => {
    const rc = decisionReasonCounts;
    if (!rc) return { no_signal: 0, liquidity_ok: 0, liquidity_null: 0, hasData: false };
    const total =
      (rc.no_signal ?? 0) + (rc.liquidity_ok ?? 0) + (rc.liquidity_null ?? 0) + (rc.other ?? 0);
    if (total <= 0) return { no_signal: 0, liquidity_ok: 0, liquidity_null: 0, hasData: false };
    const pct = (n) => Math.round(((n ?? 0) / total) * 1000) / 10;
    return {
      no_signal: pct(rc.no_signal),
      liquidity_ok: pct(rc.liquidity_ok),
      liquidity_null: pct(rc.liquidity_null),
      hasData: true,
    };
  }, [decisionReasonCounts]);

  const [orderSizeUsd] = useState(10);
  const [useMarketOrder] = useState(true);
  const [autoPlaceEnabled, setAutoPlaceEnabled] = useState(() => readAutoPlaceFromStorage());

  const toggleAutoPlaceEnabled = () => {
    setAutoPlaceEnabled((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORAGE_KEY_AUTOTRADE, next ? '1' : '0');
      } catch {
        /* localStorage indisponible */
      }
      return next;
    });
  };
  const [, setPlacedOrderKeys] = useState(() => new Set());
  const placedOrderKeysRef = useRef(new Set());
  const [, setPlacingFor] = useState(null);
  const [, setPlaceResult] = useState(null);
  const autoPlaceInProgress = useRef(false);
  const [initialBalance, setInitialBalance] = useState(20);
  const [gridUseReinvest, setGridUseReinvest] = useState(false);
  const [gridDays, setGridDays] = useState(3);
  const [showLiquiditySuggestion, setShowLiquiditySuggestion] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = localStorage.getItem(STORAGE_KEY_LIQUIDITY_SUGGESTION);
      if (stored === 'false') return false;
      if (stored === 'true') return true;
      return true;
    } catch {
      return true;
    }
  });

  const toggleShowLiquiditySuggestion = () => {
    setShowLiquiditySuggestion((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY_LIQUIDITY_SUGGESTION, String(next));
      } catch {
        // localStorage indisponible (navigation privée, etc.)
      }
      return next;
    });
  };

  const backtestResult15m = useMemo(() => {
    /** Créneaux où la simu 15m a trouvé une entrée (fenêtre signal alignée bot / carnet, ex. 95–96 %). */
    const withSignal = resolved15m.filter((r) => r.botWouldTake != null);
    /** PnL uniquement sur marchés résolus (winner connu). */
    const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
    const sortedSimul = [...withSimul].sort(
      (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
    );
    const estimateCryptoTakerFeeRate = (p) => {
      if (!includeFees) return 0;
      if (p == null) return 0;
      const x = p * (1 - p);
      return 0.25 * Math.pow(x, 2);
    };
    const lossFracFallback = getBacktestMaxLossFractionOfStake();
    let capital = initialBalance > 0 ? initialBalance : 0;
    let peak = capital;
    let maxDrawdown = 0;
    let feesPaid = 0;
    let wonNet = 0;
    let resolutionLossesNoSl = 0;
    let sumDelta = 0;
    let sumWinDelta = 0;
    let sumLossDelta = 0;
    let winsCount = 0;
    let lossesCount = 0;
    const netPnlMap = new Map();
    for (const r of sortedSimul) {
      if (capital <= 0) break;
      const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
      const feeRate = estimateCryptoTakerFeeRate(p);
      let desiredStake = backtestReinvest ? capital : Math.max(0, initialBalance);
      if (Number.isFinite(backtestMaxStakeEur) && backtestMaxStakeEur > 0) {
        desiredStake = Math.min(desiredStake, backtestMaxStakeEur);
      }
      const budgetForTrade = Math.max(0, Math.min(capital, desiredStake));
      if (!(budgetForTrade > 0)) break;
      const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
      const feeUsd = stake * feeRate;
      feesPaid += feeUsd;
      let delta = 0;
      if (r.botStopLossExit === true) {
        /**
         * PnL SL backtest:
         * - priorité au prix observé au déclenchement (proxy bid historique),
         * - sinon seuil SL configuré dans l'UI,
         * - puis repli worst/legacy.
         */
        const observed = r.botStopLossObservedPriceP != null ? Number(r.botStopLossObservedPriceP) : null;
        const triggerP = Math.max(0.01, Math.min(0.99, Number(backtestSlC) / 100));
        const wp = r.botStopLossExitPriceP != null ? Number(r.botStopLossExitPriceP) : null;
        // Proxy d'exécution SL robuste: ne jamais dégrader sous le seuil configuré à cause d'un point historique sparse.
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
        /** Perte à la résolution (mauvais côté) : mise binaire perdue en intégralité (hors frais modèle). */
        delta = -stake - feeUsd;
        resolutionLossesNoSl += 1;
      }
      capital = Math.max(0, capital + delta);
      if (delta > 0) wonNet += 1;
      sumDelta += delta;
      if (delta > 0) {
        winsCount += 1;
        sumWinDelta += delta;
      } else if (delta < 0) {
        lossesCount += 1;
        sumLossDelta += delta;
      }
      netPnlMap.set(`${r.eventSlug}-${r.endDate ?? ''}`, delta);
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    return {
      netPnlMap,
      capital,
      feesPaid,
      maxDrawdown,
      withSimul,
      withSignal,
      wonNet,
      won: withSimul.filter((r) => r.botWon === true).length,
      stopLossExits: withSimul.filter((r) => r.botStopLossExit === true).length,
      resolutionLossesNoSl,
      expectancyPerTrade: withSimul.length > 0 ? sumDelta / withSimul.length : null,
      avgWinPerTrade: winsCount > 0 ? sumWinDelta / winsCount : null,
      avgLossPerTrade: lossesCount > 0 ? sumLossDelta / lossesCount : null,
    };
  }, [resolved15m, initialBalance, includeFees, backtestSlC, backtestMaxStakeEur]);

  const slAnalysisSweep = useMemo(() => {
    // Analyse : pour des entrées ~95–96¢, on regarde le plus bas prix observé après entrée.
    // On répond à la question “si j’entre à 95¢, quel % touche un SL à X¢ ?” via un proxy conservateur:
    // si minObservedAfterEntryP <= X, alors SL X¢ touché.
    const rows = Array.isArray(resolved15m) ? resolved15m : [];
    const withEntry = rows.filter((r) => r.botWouldTake != null && r.botEntryPrice != null && r.botMinObservedAfterEntryP != null);
    if (withEntry.length === 0) return { baseN: 0, sweep: [] };

    // Seuils en cents (tu peux ajuster ensuite)
    const thresholdsC = SL_ANALYSIS_THRESHOLDS_C;
    const sweep = thresholdsC.map((c) => {
      const thr = c / 100;
      const hit = withEntry.filter((r) => Number(r.botMinObservedAfterEntryP) <= thr).length;
      const pct = Math.round((hit / withEntry.length) * 1000) / 10;
      return { c, hit, pct };
    });
    return { baseN: withEntry.length, sweep };
  }, [resolved15m]);

  const stopLossTradeoff = useMemo(() => {
    const rows = Array.isArray(resolved15m) ? resolved15m : [];
    const base = rows.filter(
      (r) =>
        r.botWouldTake != null &&
        r.botEntryPrice != null &&
        r.botMinObservedAfterEntryP != null &&
        (r.winner === 'Up' || r.winner === 'Down')
    );
    if (base.length === 0) return { baseN: 0, minStats: null, sweep: [] };

    const minVals = base
      .map((r) => Number(r.botMinObservedAfterEntryP))
      .filter((x) => Number.isFinite(x) && x > 0 && x < 1)
      .sort((a, b) => a - b);
    const q = (pct) => {
      if (minVals.length === 0) return null;
      const idx = Math.min(minVals.length - 1, Math.max(0, Math.round((pct / 100) * (minVals.length - 1))));
      return minVals[idx];
    };
    const minStats = {
      minP: minVals.length ? minVals[0] : null,
      medianP: q(50),
      p95P: q(95),
    };

    const lossFrac = getBacktestMaxLossFractionOfStake();
    const estimateFee = (stakeUsd, p) => {
      if (!includeFees) return 0;
      if (!(stakeUsd > 0) || p == null) return 0;
      const x = p * (1 - p);
      return stakeUsd * 0.25 * Math.pow(x, 2);
    };
    const thresholdsC = SL_ANALYSIS_THRESHOLDS_C;
    const sweep = thresholdsC.map((c) => {
      const slP = c / 100;
      let hit = 0;
      let sumReturnIfHit = 0;
      let nHit = 0;
      let sumReturnWithSl = 0;

      for (const r of base) {
        const entryP = Number(r.botEntryPrice);
        const minAfter = Number(r.botMinObservedAfterEntryP);
        if (!(entryP > 0 && entryP < 1) || !(minAfter > 0 && minAfter < 1)) continue;

        const stake = 1; // returns normalisées par 1 USDC
        const feeUsd = estimateFee(stake, entryP);
        const hitThis = minAfter <= slP;
        if (hitThis) {
          hit += 1;
          nHit += 1;
          // Return si on sort pile à SL (proxy, sans slippage): stake*(sl/entry - 1) - fee
          const ret = stake * (slP / entryP - 1) - feeUsd;
          sumReturnIfHit += ret;
          sumReturnWithSl += ret;
        } else {
          // Sinon on hold jusqu’à résolution: gain = (1/entry - 1) si win, sinon -lossFrac
          const win = r.winner === r.botWouldTake;
          const ret = win ? stake * (1 / entryP - 1) - feeUsd : -stake * lossFrac - feeUsd;
          sumReturnWithSl += ret;
        }
      }

      const baseN = base.length;
      const pctHit = baseN > 0 ? Math.round((hit / baseN) * 1000) / 10 : 0;
      const avgReturnIfHit = nHit > 0 ? sumReturnIfHit / nHit : null;
      const avgReturnWithSl = baseN > 0 ? sumReturnWithSl / baseN : null;
      const projectionByStake = SL_ANALYSIS_STAKE_USD.map((stakeUsd) => ({
        stakeUsd,
        avgLossIfHitUsd: avgReturnIfHit != null ? avgReturnIfHit * stakeUsd : null,
        avgPnlWithSlUsd: avgReturnWithSl != null ? avgReturnWithSl * stakeUsd : null,
      }));
      return { c, pctHit, hit, baseN, avgReturnIfHit, avgReturnWithSl, projectionByStake };
    });

    return { baseN: base.length, minStats, sweep };
  }, [resolved15m, includeFees]);

  const setupGridTop10 = useMemo(() => {
    const days = Math.max(3, Math.min(30, Number(gridDays) || 3));
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = (Array.isArray(resolved15m) ? resolved15m : []).filter((r) => {
      const t = r?.endDate ? new Date(r.endDate).getTime() : NaN;
      return Number.isFinite(t) && t >= cutoffMs;
    });
    return runFixedStakeGridSearch(rows, initialBalance, { useReinvest: gridUseReinvest }).slice(0, 10);
  }, [resolved15m, initialBalance, gridUseReinvest, gridDays]);

  const activeBacktest = backtestResult15m;

  const entryTiming = useMemo(() => {
    const rows = resolved15m;
    const sessionDurationSec = 15 * 60;
    const last24h = rows.filter(
      (r) => r.endDate && new Date(r.endDate).getTime() >= Date.now() - 24 * 60 * 60 * 1000
    );
    const total24 = last24h.length;
    const withTrade24 = last24h.filter((r) => r.botEntryTimestamp != null).length;
    const pctFilled24 = total24 > 0 ? ((withTrade24 / total24) * 100).toFixed(1) : '0';
    const withEntry = rows.filter((r) => r.botEntryTimestamp != null && r.endDate);
    const minutesList = withEntry.map((r) => {
      const sessionEndSec = new Date(r.endDate).getTime() / 1000;
      const sessionStartSec = sessionEndSec - sessionDurationSec;
      return (r.botEntryTimestamp - sessionStartSec) / 60;
    });
    const avgMinutes = minutesList.length > 0 ? minutesList.reduce((a, b) => a + b, 0) / minutesList.length : 0;
    return { avgMinutes, pctFilled24, withTrade24, total24, withEntryCount: withEntry.length };
  }, [resolved15m]);

  const getSignalKey = (signal) => signal.market?.conditionId ?? signal.eventSlug ?? '';

  /** Règle : pas de trade si l’événement se termine dans moins d’une minute (ex. fin 18h → plus de trade à partir de 17h59). */
  const ONE_MINUTE_MS = 60 * 1000;
  const isInLastMinute = (signal) => {
    const raw = signal?.endDate;
    if (raw == null || raw === '') return false;
    let endMs;
    if (typeof raw === 'number') {
      endMs = raw > 1e12 ? raw : raw * 1000;
    } else {
      endMs = new Date(raw).getTime();
    }
    if (Number.isNaN(endMs)) return false;
    return Date.now() >= endMs - ONE_MINUTE_MS;
  };

  const placeOrderForSignal = async (signal, options = {}) => {
    if (!signer || !signal.tokenIdToBuy) return { error: 'Pas de signer ou token.' };
    if (isInLastMinute(signal)) {
      return { error: "Trop tard : l'événement se termine dans moins d'une minute." };
    }
    let sizeUsd = Number(orderSizeUsd) || 10;
    if (options.capUsd != null && options.capUsd > 0 && sizeUsd > options.capUsd) {
      sizeUsd = options.capUsd;
    }
    const raw = signal.takeSide === 'Down' ? signal.priceDown : signal.priceUp;
    /** Plafond signal (ex. 96¢) comme le backtest / carnet, même si le best ask live dépasse. */
    const n = Number(raw);
    const price = Number.isFinite(n)
      ? Math.min(Math.max(n, ORDER_BOOK_SIGNAL_MIN_P), ORDER_BOOK_SIGNAL_MAX_P)
      : ORDER_BOOK_SIGNAL_MAX_P;
    return placePolymarketOrder(signer, {
      tokenIdToBuy: signal.tokenIdToBuy,
      price,
      sizeUsd,
      useMarketOrder,
    });
  };

  const getCapUsdForSignal = (signal) => {
    if (!showLiquiditySuggestion || liquidityAtTargetUsd == null || liquidityAtTargetUsd <= 0) return null;
    const primary = signals?.[0] ?? (live15mMeta?.hiddenByTiming ? live15mMeta.signalsIfTimingIgnored?.[0] : null);
    if (primary && getSignalKey(signal) === getSignalKey(primary)) return liquidityAtTargetUsd;
    return null;
  };

  const _handlePlaceOrder = async (signal) => {
    const key = getSignalKey(signal);
    setPlacingFor(key);
    setPlaceResult(null);
    if (isInLastMinute(signal)) {
      setPlaceResult({ key, error: "Trop tard : l'événement se termine dans moins d'une minute." });
      setPlacingFor(null);
      return;
    }
    const result = await placeOrderForSignal(signal, { capUsd: getCapUsdForSignal(signal) });
    setPlaceResult({ key, ...result });
    setPlacingFor(null);
  };

  // Le bot place l'ordre à ta place dès qu'un signal dans la bande (ex. 95–96 %) apparaît
  useEffect(() => {
    if (!autoPlaceEnabled || !signer || !address || !isPolygon || signals.length === 0 || autoPlaceInProgress.current) return;
    const toPlace = signals.filter(
      (s) => s.tokenIdToBuy && !placedOrderKeysRef.current.has(getSignalKey(s)) && !isInLastMinute(s)
    );
    if (toPlace.length === 0) return;
    autoPlaceInProgress.current = true;
    (async () => {
      for (const signal of toPlace) {
        if (isInLastMinute(signal)) continue;
        const key = getSignalKey(signal);
        placedOrderKeysRef.current.add(key);
        setPlacedOrderKeys((prev) => new Set([...prev, key]));
        setPlacingFor(key);
        const result = await placeOrderForSignal(signal, { capUsd: getCapUsdForSignal(signal) });
        setPlaceResult({ key, ...result });
        setPlacingFor(null);
        await new Promise((r) => setTimeout(r, 350));
      }
      autoPlaceInProgress.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isInLastMinute/placeOrderForSignal stables
  }, [autoPlaceEnabled, signer, address, isPolygon, signals, orderSizeUsd, useMarketOrder]);

  const bt = activeBacktest;
  const winRateResolutionPct =
    bt.withSimul.length > 0 ? Math.round((bt.won / bt.withSimul.length) * 1000) / 10 : null;
  const winRateNetPct =
    bt.withSimul.length > 0 ? Math.round((bt.wonNet / bt.withSimul.length) * 1000) / 10 : null;
  const totalNetPnl = initialBalance > 0 ? bt.capital - initialBalance : null;
  const pnlPct =
    initialBalance > 0 && totalNetPnl != null
      ? ((totalNetPnl / initialBalance) * 100).toFixed(1)
      : null;
  const slHitRatePct =
    bt.withSimul.length > 0 ? Math.round((bt.stopLossExits / bt.withSimul.length) * 1000) / 10 : null;

  return (
    <div className="strat-page">
      <div className="card strat-card-wrap">
        <div className="strat-hero-inner">
          <div className="strat-hero-grid">
            <div className="strat-hero-left">
              <h2 className="strat-hero-title">Bitcoin Up or Down</h2>
              <p className="strat-hero-sub">Signal {SIGNAL_BAND_PCT_LABEL} · Horaires &amp; 15 min · FOK</p>
              <div className="strat-hero-links">
                <a
                  href={`https://polymarket.com/event/${getCurrentBitcoinUpDownEventSlug()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="strat-hero-link"
                >
                  Créneau horaire actuel <span className="strat-hero-link-arr">→</span>
                </a>
                <a
                  href={`https://polymarket.com/event/${getCurrent15mEventSlug()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="strat-hero-link"
                >
                  Créneau 15 min actuel <span className="strat-hero-link-arr">→</span>
                </a>
              </div>
              <ul className="strat-rule-list">
                <li>
                  <span className="strat-rule-chevron" aria-hidden>
                    &gt;
                  </span>
                  Un seul pari par créneau (bougie 1h BTC/USDT Binance)
                </li>
                <li>
                  <span className="strat-rule-chevron" aria-hidden>
                    &gt;
                  </span>
                  Up ou Down selon la tendance, support/résistance ou cotes
                </li>
                <li>
                  <span className="strat-rule-chevron" aria-hidden>
                    &gt;
                  </span>
                  Mise 80–100 % du solde, réinvestissement total à chaque créneau
                </li>
                <li>
                  <span className="strat-rule-chevron" aria-hidden>
                    &gt;
                  </span>
                  Résolution → capital + gains réinvestis sur le créneau suivant
                </li>
                <li>
                  <span className="strat-rule-chevron" aria-hidden>
                    &gt;
                  </span>
                  Signaux {SIGNAL_BAND_PCT_LABEL} : marge théorique plus faible qu’à 96¢ (ex. achat 95¢ → gain 5¢ si résolu 1 $)
                </li>
              </ul>
              <div className="strat-reason-bars">
                <p className="strat-reason-bars__hint">
                  Répartition des décisions bot (24 h) (15 min)
                  {!decisionBarPercents.hasData && ' — connecte le statut bot pour afficher les barres.'}
                </p>
                {[
                  { key: 'no_signal', label: 'no_signal' },
                  { key: 'liquidity_ok', label: 'liq_ok' },
                  { key: 'liquidity_null', label: 'liq_null' },
                ].map(({ key, label }) => (
                  <div key={key} className="strat-reason-row">
                    <span className="strat-reason-row__label">{label}</span>
                    <div className="strat-reason-row__track">
                      <div
                        className="strat-reason-row__fill"
                        style={{ width: `${Math.min(100, decisionBarPercents[key] ?? 0)}%` }}
                      />
                    </div>
                    <span className="strat-reason-row__pct">
                      {decisionBarPercents.hasData ? `${(decisionBarPercents[key] ?? 0).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="strat-hero-right">
              <div className="strat-autoplace-panel">
                <div className="strat-autoplace-panel__row">
                  <span className="strat-autoplace-panel__label" id="autoplace-label">
                    Ordres automatiques
                  </span>
                  <button
                    type="button"
                    onClick={toggleAutoPlaceEnabled}
                    className={`btn btn--xs ${autoPlaceEnabled ? 'btn--toggle-on' : 'btn--toggle-off'}`}
                    aria-pressed={autoPlaceEnabled}
                    aria-labelledby="autoplace-label"
                    title={
                      autoPlaceEnabled
                        ? 'Les ordres sont placés automatiquement au signal (tant que le wallet est connecté).'
                        : 'Aucun ordre automatique : cliquez pour activer.'
                    }
                  >
                    {autoPlaceEnabled ? 'ON — trade auto' : 'OFF — manuel'}
                  </button>
                </div>
                <p className="strat-autoplace-panel__hint">
                  <strong>ON</strong> = un ordre part tout seul dès qu’un signal {SIGNAL_BAND_PCT_LABEL} apparaît (
                  15 min). <strong>OFF</strong> = jamais d’ordre auto (tu peux trader à la main). Wallet Polygon requis pour
                  l’auto.
                </p>
                {live15mMeta?.hiddenByTiming && live15mMeta.signalsIfTimingIgnored?.[0] && (
                  <p
                    className="strat-autoplace-panel__hint"
                    style={{
                      borderLeft: '3px solid var(--amber, #f5a623)',
                      paddingLeft: 10,
                      marginTop: 10,
                      color: 'var(--text-1)',
                    }}
                  >
                    <strong>Prix dans {SIGNAL_BAND_PCT_LABEL}</strong> (côté{' '}
                    {live15mMeta.signalsIfTimingIgnored[0].takeSide}) mais{' '}
                    <strong>fenêtre d’entrée interdite</strong> (grille ET : 3 premières / 4 dernières min du quart
                    d’heure). Le dashboard et le bot <strong>ne montrent pas</strong> de signal dans ce cas — comme un
                    trade refusé par timing. Asks live : Up{' '}
                    {live15mMeta.liveAskUp != null ? `${(live15mMeta.liveAskUp * 100).toFixed(1)}¢` : '—'}, Down{' '}
                    {live15mMeta.liveAskDown != null ? `${(live15mMeta.liveAskDown * 100).toFixed(1)}¢` : '—'}.
                  </p>
                )}
                {live15mMeta?.slugMismatch && (
                  <p
                    className="strat-autoplace-panel__hint strat-text-amber"
                    style={{ marginTop: 10, lineHeight: 1.5 }}
                  >
                    <strong>Créneau 15m :</strong> l’event Gamma utilisé ne correspond pas au slug attendu du créneau
                    UTC courant. Les prix peuvent être ceux <strong>d’un autre quart d’heure</strong>. Attendu :{' '}
                    <code className="strat-code-inline">{live15mMeta.expectedEventSlug ?? '—'}</code> — reçu :{' '}
                    <code className="strat-code-inline">{live15mMeta.resolvedEventSlug ?? '—'}</code>. Actualise la page
                    après déploiement ; le hook force désormais GET <code className="strat-code-inline">/events/slug/…</code>{' '}
                    sur le bon slug.
                  </p>
                )}
                {live15mMeta?.livePriceSource &&
                  live15mMeta.livePriceSource !== 'clob' && (
                    <p
                      className="strat-autoplace-panel__hint strat-text-amber"
                      style={{ marginTop: 10, lineHeight: 1.5 }}
                    >
                      <strong>Source prix : Gamma (indicatif)</strong> — le carnet CLOB n’a pas renvoyé les deux best
                      asks (réseau, CORS, proxy dev, etc.). Les pourcentages peuvent rester proches de 50/50 alors que
                      Polymarket affiche les <strong>vrais prix d’achat</strong> (ex. 10¢ / 91¢). Compare avec l’URL
                      officielle du même slug (
                      <code className="strat-code-inline">{live15mMeta.expectedEventSlug ?? getCurrent15mEventSlug()}</code>
                      ).
                    </p>
                  )}
              </div>

              <h3 className="strat-balance-perf-heading">Solde &amp; performance</h3>

              <div className="strat-metric-card">
                <p className="strat-metric-card__kicker">
                  Backtest · {resolvedDaysCount} derniers jours
                </p>
                <div className="strat-metric-card__row3">
                  <div>
                    <span className="strat-metric-card__lbl">Win rate net</span>
                    <span className="strat-metric-card__val strat-metric-card__val--green">
                      {winRateNetPct != null ? `${winRateNetPct}%` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="strat-metric-card__lbl">Sessions</span>
                    <span className="strat-metric-card__val">
                      {bt.withSimul.length > 0 ? `${bt.wonNet} / ${bt.withSimul.length}` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="strat-metric-card__lbl">Capital final</span>
                    <span className="strat-metric-card__val strat-metric-card__val--green">
                      {initialBalance > 0 && bt.withSimul.length > 0 ? formatMoney(bt.capital) : '—'}
                    </span>
                  </div>
                </div>
                <p className="strat-muted-tight" style={{ marginTop: 10 }}>
                  Calcul : à chaque créneau simulé, la mise suit le mode <strong>compound jusqu’au cap</strong> (réinvestissement
                  ON permanent, plafond <strong>{backtestMaxStakeEur > 0 ? `${backtestMaxStakeEur}€` : 'désactivé'}</strong>) ; frais
                  taker déduits du budget avant sizing.
                  Gain si résolution gagnante : <code>(1 / prix entrée − 1) × mise</code> (moins frais si activés). Perte si mauvais
                  côté à la résolution : <strong>−mise</strong> (binaire). Si <strong>SL simulé</strong> : rendement{' '}
                  <code>(prix observé au déclenchement / prix entrée − 1) × mise</code> (fallback sur seuil SL configuré).
                </p>
                <p className="strat-muted-tight">
                  Le <strong>win rate résolution</strong> (issue finale du marché) reste affiché dans le détail des lignes ; ici on
                  montre le <strong>win rate net</strong> (delta PnL positif).
                </p>
              </div>

              <div className="strat-metric-card">
                <p className="strat-metric-card__kicker">PnL net total (départ {formatMoney(initialBalance)})</p>
                <p className="strat-metric-card__pnl">
                  {totalNetPnl != null && bt.withSimul.length > 0 ? (
                    <>
                      <span className={totalNetPnl >= 0 ? 'strat-text-green' : 'strat-text-red'}>
                        {totalNetPnl >= 0 ? '+' : ''}
                        {formatMoney(totalNetPnl)}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </p>
                {pnlPct != null && bt.withSimul.length > 0 && (
                  <p className="strat-metric-card__sub">
                    <span className={Number(pnlPct) >= 0 ? 'strat-text-green' : 'strat-text-red'}>
                      {Number(pnlPct) >= 0 ? '+' : ''}
                      {pnlPct}%
                    </span>
                    {includeFees && bt.feesPaid > 0 && (
                      <span>
                        {' '}
                        · frais estimés {formatMoney(bt.feesPaid)}
                      </span>
                    )}
                  </p>
                )}
                {bt.withSimul.length > 0 && (
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    WR net <strong>{winRateNetPct != null ? `${winRateNetPct}%` : '—'}</strong> · WR résolution{' '}
                    <strong>{winRateResolutionPct != null ? `${winRateResolutionPct}%` : '—'}</strong> · taux SL{' '}
                    <strong>{slHitRatePct != null ? `${slHitRatePct}%` : '—'}</strong> · expectancy/trade{' '}
                    <strong>{bt.expectancyPerTrade != null ? formatMoney(bt.expectancyPerTrade) : '—'}</strong> · pertes
                    résolution sans SL <strong>{bt.resolutionLossesNoSl}</strong>
                  </p>
                )}
              </div>

              <div className="strat-metric-card">
                <p className="strat-metric-card__kicker">Entrée moyenne après début créneau</p>
                <p className="strat-metric-card__time">
                  {entryTiming.withEntryCount > 0 ? `${entryTiming.avgMinutes.toFixed(1)} min` : '—'}
                </p>
                <p className="strat-metric-card__sub">
                  {entryTiming.total24 > 0
                    ? `${entryTiming.pctFilled24}% des créneaux avec position (24h)`
                    : '—'}
                </p>
              </div>

              <div className="strat-hero-controls">
                <button
                  type="button"
                  onClick={() => setIncludeFees((v) => !v)}
                  className={`btn btn--xs ${includeFees ? 'btn--toggle-on' : 'btn--toggle-off'}`}
                  title="Frais taker (modèle simplifié)"
                >
                  {includeFees ? 'Frais ON' : 'Frais OFF'}
                </button>
                <button
                  type="button"
                  onClick={toggleShowLiquiditySuggestion}
                  className={`btn btn--xs ${showLiquiditySuggestion ? 'btn--toggle-on' : 'btn--toggle-off'}`}
                  title={`Afficher le panneau liquidité ${SIGNAL_BAND_PCT_LABEL} sous la stratégie`}
                >
                  Liquidité {showLiquiditySuggestion ? 'ON' : 'OFF'}
                </button>
              </div>

              {resultMode === '15m' && slAnalysisSweep.baseN > 0 && (
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">Analyse stop-loss (entrée ~95–96¢, proxy Data API/CLOB)</p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Base : <strong>{slAnalysisSweep.baseN}</strong> entrées simulées avec “min après entrée” observé.
                    Le % ci-dessous = part des créneaux où le prix a touché au moins une fois le seuil.
                  </p>
                  <div className="strat-table-wrap" style={{ marginTop: 10 }}>
                    <table className="strat-table">
                      <thead>
                        <tr>
                          <th className="strat-th">SL (¢)</th>
                          <th className="strat-th">% touché</th>
                          <th className="strat-th">Touché</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slAnalysisSweep.sweep.map((row, i) => (
                          <tr key={row.c} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                            <td className="strat-td">{row.c}¢</td>
                            <td className="strat-td strat-td--strong">{row.pct.toFixed(1)}%</td>
                            <td className="strat-td">
                              {row.hit} / {slAnalysisSweep.baseN}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="strat-muted-tight" style={{ marginTop: 8 }}>
                    Interprétation rapide : plus le SL est haut, plus il est touché souvent (sorties fréquentes) ; plus il est bas, moins il est touché mais tu laisses plus de drawdown. Ce calcul est un proxy (trades Data API + prices-history), pas un best bid live WS.
                  </p>
                </div>
              )}

              {
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">Fenêtre signal backtest (15 min)</p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Modifie la bande d’entrée simulée (ex. 95–96¢) et le SL de simulation. Cela recharge les données et
                    recalcule le tableau 15m.
                  </p>
                  <div className="strat-hero-controls" style={{ marginTop: 10 }}>
                    <label className="strat-label-inline">
                      <span>Solde départ (€)</span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={initialBalance}
                        onChange={(e) => setInitialBalance(Number(e.target.value) || 0)}
                        className="input-strat-compact"
                      />
                    </label>
                    <label className="strat-label-inline">
                      <span>Signal min (¢)</span>
                      <input
                        type="number"
                        min="50"
                        max="99"
                        step="1"
                        value={signalMinC}
                        onChange={(e) => setSignalMinC(Number(e.target.value) || 0)}
                        className="input-strat-compact"
                      />
                    </label>
                    <label className="strat-label-inline">
                      <span>SL backtest (¢)</span>
                      <input
                        type="number"
                        min="50"
                        max="95"
                        step="1"
                        value={backtestSlC}
                        onChange={(e) => setBacktestSlC(Number(e.target.value) || 0)}
                        className="input-strat-compact"
                      />
                    </label>
                    <label className="strat-label-inline">
                      <span>Signal max (¢)</span>
                      <input
                        type="number"
                        min="50"
                        max="99"
                        step="1"
                        value={signalMaxC}
                        onChange={(e) => setSignalMaxC(Number(e.target.value) || 0)}
                        className="input-strat-compact"
                      />
                    </label>
                    <label className="strat-label-inline">
                      <span>Mise max (€)</span>
                      <input
                        type="number"
                        min="0"
                        step="5"
                        value={backtestMaxStakeEur}
                        onChange={(e) => setBacktestMaxStakeEur(Number(e.target.value) || 0)}
                        className="input-strat-compact"
                        title="0 = pas de plafond de mise"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setSignalMinC(95);
                        setSignalMaxC(96);
                      }}
                      className="btn btn--xs btn--outline"
                      title="Revenir à 95–96¢"
                    >
                      Reset 95–96¢
                    </button>
                    <button
                      type="button"
                      onClick={() => setBacktestSlC(Math.round(BACKTEST_STOP_LOSS_TRIGGER_PRICE_P * 100))}
                      className="btn btn--xs btn--outline"
                      title="Revenir au SL par défaut .env"
                    >
                      Reset SL défaut
                    </button>
                    <button
                      type="button"
                      onClick={() => setBacktestMaxStakeEur(0)}
                      className="btn btn--xs btn--outline"
                      title="Retirer le plafond de mise"
                    >
                      Reset mise max
                    </button>
                    <button type="button" onClick={refreshResolved15m} disabled={resolved15mLoading} className="btn btn--xs btn--outline">
                      Recalculer
                    </button>
                  </div>
                </div>
              }

              {stopLossTradeoff.baseN > 0 && (
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">Trade-off stop-loss (proxy) — stats &amp; PnL estimé</p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Base : <strong>{stopLossTradeoff.baseN}</strong> entrées résolues. Stats sur le plus bas prix observé après entrée.
                  </p>
                  {stopLossTradeoff.minStats && (
                    <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                      min :{' '}
                      <strong>
                        {stopLossTradeoff.minStats.minP != null ? `${(stopLossTradeoff.minStats.minP * 100).toFixed(2)}¢` : '—'}
                      </strong>{' '}
                      · médiane :{' '}
                      <strong>
                        {stopLossTradeoff.minStats.medianP != null ? `${(stopLossTradeoff.minStats.medianP * 100).toFixed(2)}¢` : '—'}
                      </strong>{' '}
                      · p95 :{' '}
                      <strong>
                        {stopLossTradeoff.minStats.p95P != null ? `${(stopLossTradeoff.minStats.p95P * 100).toFixed(2)}¢` : '—'}
                      </strong>
                    </p>
                  )}
                  <div className="strat-table-wrap" style={{ marginTop: 10 }}>
                    <table className="strat-table">
                      <thead>
                        <tr>
                          <th className="strat-th">SL (¢)</th>
                          <th className="strat-th">% touché</th>
                          <th className="strat-th">Perte moy. si touché (par 1$)</th>
                          <th className="strat-th">PnL moy. si on applique SL (par 1$)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stopLossTradeoff.sweep.map((row, i) => (
                          <tr key={row.c} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                            <td className="strat-td">{row.c}¢</td>
                            <td className="strat-td strat-td--strong">{row.pctHit.toFixed(1)}%</td>
                            <td className="strat-td">
                              {row.avgReturnIfHit != null ? row.avgReturnIfHit.toFixed(3) : '—'}
                            </td>
                            <td className="strat-td">
                              {row.avgReturnWithSl != null ? row.avgReturnWithSl.toFixed(3) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="strat-table-wrap" style={{ marginTop: 10 }}>
                    <table className="strat-table">
                      <thead>
                        <tr>
                          <th className="strat-th">SL (¢)</th>
                          {SL_ANALYSIS_STAKE_USD.map((s) => (
                            <th key={`stake-${s}`} className="strat-th">
                              ${s}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stopLossTradeoff.sweep.map((row, i) => (
                          <tr key={`proj-${row.c}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                            <td className="strat-td">{row.c}¢</td>
                            {row.projectionByStake.map((p) => (
                              <td key={`sl-${row.c}-s-${p.stakeUsd}`} className="strat-td">
                                {p.avgPnlWithSlUsd != null ? p.avgPnlWithSlUsd.toFixed(2) : '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="strat-muted-tight" style={{ marginTop: 8 }}>
                    “Perte moy. si touché” = PnL moyen si la sortie se fait à SL (proxy, sans slippage). “PnL moy. avec SL” =
                    si touché → sortie SL, sinon → hold jusqu’à résolution (win/lose), avec frais si activés. Le tableau
                    en dessous projette ce PnL moyen pour des mises de $5 à $50 (pas de $5).
                  </p>
                </div>
              )}

              {setupGridTop10.length > 0 && (
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">
                    Top 10 setups ({gridDays}j, mise fixe {gridUseReinvest ? 'avec réinvestissement' : 'sans réinvestissement'})
                  </p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Grid-search sur les lignes 15m résolues (signal, SL, mise fixe). Classement par PnL net.
                  </p>
                  <div className="strat-hero-controls" style={{ marginTop: 10 }}>
                    <label className="strat-label-inline">
                      <span>Fenêtre (jours)</span>
                      <select
                        value={gridDays}
                        onChange={(e) => setGridDays(Number(e.target.value) || 3)}
                        className="input-strat-compact"
                      >
                        <option value={3}>3</option>
                        <option value={4}>4</option>
                        <option value={5}>5</option>
                        <option value={6}>6</option>
                        <option value={7}>7</option>
                      </select>
                    </label>
                    <label className="strat-15m-debug-toggle" style={{ marginTop: 0 }}>
                      <input
                        type="checkbox"
                        checked={gridUseReinvest}
                        onChange={(e) => setGridUseReinvest(e.target.checked)}
                      />
                      <span>Inclure réinvestissement progressif</span>
                    </label>
                  </div>
                  <div className="strat-table-wrap" style={{ marginTop: 10 }}>
                    <table className="strat-table">
                      <thead>
                        <tr>
                          <th className="strat-th">#</th>
                          <th className="strat-th">Signal</th>
                          <th className="strat-th">SL</th>
                          <th className="strat-th">Mise</th>
                          <th className="strat-th">Trades</th>
                          <th className="strat-th">PnL</th>
                          <th className="strat-th">Capital final</th>
                          <th className="strat-th">WR net</th>
                          <th className="strat-th">WR résolution</th>
                          <th className="strat-th">% SL touché</th>
                          <th className="strat-th">Max DD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {setupGridTop10.map((s, i) => (
                          <tr key={`${s.signalBand}-${s.slC}-${s.stake}-${i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                            <td className="strat-td">{i + 1}</td>
                            <td className="strat-td">{s.signalBand}¢</td>
                            <td className="strat-td">{s.slC}¢</td>
                            <td className="strat-td">{s.stake}€</td>
                            <td className="strat-td">{s.trades}</td>
                            <td className="strat-td">{formatMoney(s.pnl)}</td>
                            <td className="strat-td">{formatMoney(s.finalCapital)}</td>
                            <td className="strat-td">{s.winRateNetPct.toFixed(1)}%</td>
                            <td className="strat-td">{s.winRateResolutionPct.toFixed(1)}%</td>
                            <td className="strat-td">{s.slHitPct.toFixed(1)}%</td>
                            <td className="strat-td">{s.maxDrawdownPct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="strat-muted-tight" style={{ marginTop: 8 }}>
                    Règle d’évaluation : si le SL est touché après l’entrée, la ligne est comptée en sortie SL
                    (même si la résolution finale est gagnante). Réinvestissement ON = taille de mise qui évolue
                    proportionnellement au capital courant.
                  </p>
                </div>
              )}
            </div>
          </div>

          {showLiquiditySuggestion && (currentSignalTokenId || liquidityAtTargetUsd != null) && (
            <div className="strat-data-window strat-data-window--nested">
              <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ width: 2, height: 16, borderRadius: 999, background: 'rgba(0,255,136,0.6)' }} aria-hidden />
                Taille max suggérée (FOK ≤ {SIGNAL_MAX_CENTS_LABEL})
              </h3>
              <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.5 }}>
                Liquidité disponible à {SIGNAL_BAND_PCT_LABEL} sur le créneau actuel. La mise est <strong>plafonnée automatiquement</strong> à ce montant (dashboard et bot) pour ne pas dépasser {SIGNAL_MAX_CENTS_LABEL}.
              </p>
              {liquidityLoading ? (
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Chargement du carnet…</span>
              ) : liquidityError ? (
                <span style={{ fontSize: 13, color: 'var(--amber)' }}>{liquidityError}</span>
              ) : liquidityAtTargetUsd != null && liquidityAtTargetUsd > 0 ? (
                <div className="strat-stack-sm">
                  <div className="strat-flex-gap">
                    <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--green)' }}>
                      ~{liquidityAtTargetUsd.toFixed(0)} $
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--text-2)' }}>(taille max conseillée pour ce créneau)</span>
                    <button
                      type="button"
                      onClick={refreshLiquidity}
                      style={{
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                        background: 'rgba(255,255,255,0.03)',
                        color: 'var(--text-2)',
                        padding: '6px 10px',
                        fontSize: 12,
                        fontWeight: 700,
                        fontFamily: 'JetBrains Mono, monospace',
                      }}
                    >
                      Rafraîchir
                    </button>
                  </div>
                  {liquidityStats?.count > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                      Moyenne sur les 3 derniers jours (relevés bot) : <strong className="strat-strong">~{Math.round(liquidityStats.avg)} $</strong>
                      {liquidityStats.min != null && liquidityStats.max != null && (
                        <span> (min {Math.round(liquidityStats.min)} $, max {Math.round(liquidityStats.max)} $)</span>
                      )}
                      {liquidityStats.median != null && liquidityStats.p95 != null && (
                        <span>
                          {' '}
                          · médiane ~{Math.round(liquidityStats.median)} $ · p95 ~{Math.round(liquidityStats.p95)} $
                        </span>
                      )}
                      {liquidityStats.lastUsd != null && (
                        <span> · dernier relevé ~{Math.round(liquidityStats.lastUsd)} $</span>
                      )}
                      <span> — {liquidityStats.count} relevé{liquidityStats.count !== 1 ? 's' : ''}</span>
                    </p>
                  )}
                </div>
              ) : currentSignalTokenId ? (
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Aucune liquidité à {SIGNAL_BAND_PCT_LABEL} pour l’instant.</span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="section-title">
        <h2>Résultats passés</h2>
        <div className="line" />
      </div>

      <div className="card strat-card-wrap">
        <div className="strat-results-inner">
          <div className="strat-results-toolbar">
            <span className="strat-results-mode-label">
              Période : <strong>15 min</strong>
            </span>
          </div>
          <p className="strat-results-desc">
            Simulation alignée sur le bot ({SIGNAL_BAND_PCT_LABEL}, marché) — 15 min : pas d’entrée les 3 premières
            minutes ET de chaque quart (:00–:15–:30–:45) ni les 4 dernières (même grille que le bot).{' '}
            Données historiques CLOB.
          </p>
              <>
                {/* Fenêtre de données 15m : toujours visible pour indiquer la période et le statut */}
                <div className="strat-data-window">
                  <h4 className="strat-data-window__title">
                    Fenêtre de données (15 min)
                  </h4>
                  <div className="strat-backtest-caveat" role="note">
                    <strong>Simu vs bot (à lire)</strong>
                    <ul className="strat-backtest-caveat__list">
                      <li>
                        <strong>Prix SL</strong> : le tableau utilise le prix <strong>historique (mid)</strong> (
                        <code>prices-history</code>) ; le bot utilise le <strong>best bid</strong> CLOB — une ligne peut
                        afficher « pas de SL » alors qu’en live le bid était plus bas (ou l’inverse).
                      </li>
                      <li>
                        <strong>Seuil SL simulé</strong> : <strong>{backtestSlC}¢</strong>
                        {BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED ? (
                          <>
                            {' '}
                            ou drawdown ≤ <strong>−{BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT} %</strong>, après{' '}
                            <strong>{BACKTEST_STOP_LOSS_MIN_HOLD_SEC}s</strong> de détention minimum.
                          </>
                        ) : (
                          <>
                            {' '}
                            — <strong>drawdown désactivé</strong> dans la simu (comme{' '}
                            <code className="strat-code-inline">STOP_LOSS_DRAWDOWN_ENABLED=false</code> côté bot). Déclenchement
                            uniquement sur le prix, après <strong>{BACKTEST_STOP_LOSS_MIN_HOLD_SEC}s</strong> de détention minimum.
                          </>
                        )}{' '}
                        Alignement serveur :{' '}
                        <code className="strat-code-inline">VITE_BACKTEST_STOP_LOSS_TRIGGER_PRICE_P</code> ={' '}
                        <code className="strat-code-inline">STOP_LOSS_TRIGGER_PRICE_P</code> (ex. <strong>0.75</strong> = 75¢). Valeur
                        utilisée ici : <strong>{backtestSlC}¢</strong>, et{' '}
                        <code className="strat-code-inline">VITE_BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED</code> ={' '}
                        <code className="strat-code-inline">STOP_LOSS_DRAWDOWN_ENABLED</code>.
                      </li>
                      <li>
                        <strong>SL touché</strong> : compté comme une <strong>perte</strong> dans le PnL agrégé et le{' '}
                        <strong>win rate</strong>, même si le marché se résout ensuite en ta faveur (ligne « Stop-loss (résolution
                        gagnante) » — tu sors avant la résolution, la discipline SL prime).
                      </li>
                      <li>
                        <strong>Grille Eastern (ET)</strong> : pas d’entrée simulée (et le live respecte la même grille) pendant
                        les <strong>3 premières</strong> et les <strong>4 dernières</strong> minutes de chaque quart d’heure
                        local <strong>America/New_York</strong> (:00, :15, :30, :45). Le stop-loss, lui, n’est pas bloqué par
                        cette grille.
                      </li>
                    </ul>
                  </div>
                  <p className="strat-data-window__body">
                    Période : <strong className="strat-strong">{resolvedDaysCount} derniers jours</strong>
                    {' '}({Math.min(MAX_15M_GRID_SLOTS, Math.ceil(resolvedWindowHours * 4))} créneaux 15 min).
                    {resolved15mLoading && ' Chargement en cours…'}
                    {!resolved15mLoading && resolved15m.length === 0 && !resolved15mError && (
                      <span className="strat-block-msg strat-text-amber">Aucun créneau résolu récupéré pour cette période.</span>
                    )}
                    {resolved15mError && (
                      <span className="strat-block-msg strat-text-red">{resolved15mError}</span>
                    )}
                    {!resolved15mLoading && !resolved15mError && (
                      <span className="strat-block-msg strat-text-green">
                        {resolved15m.length > 0
                          ? `${resolved15m.length} marché${resolved15m.length !== 1 ? 's' : ''} résolu${resolved15m.length !== 1 ? 's' : ''}`
                          : 'Aucun marché résolu'}
                        {' · '}
                        {resolved15mDisplayRows.length} ligne{resolved15mDisplayRows.length !== 1 ? 's' : ''} affichée
                        {resolved15mDisplayRows.length !== 1 ? 's' : ''} (grille 15 min)
                      </span>
                    )}
                    <span className="strat-muted-tight">
                      Simu 15m : <code>prices-history</code> CLOB ≈ <strong>mid</strong> ; exécutions via <strong>Data API</strong>{' '}
                      (<code>asset</code> / <code>asset_id</code>). Filtre créneau ≈ <strong>fin − 30 min → fin + 45 min</strong>.
                      Fenêtre signal <strong>{SIGNAL_BAND_PCT_LABEL}</strong> (complément <strong>1 − p</strong>). PNL agrégé (carte
                      Solde ci-dessus) : réinvestissement intégral ; SL simulé avec prix de sortie{' '}
                      <code className="strat-code-inline">VITE_BACKTEST_STOP_LOSS_WORST_PRICE_P</code> ; perte à la résolution =
                      mise intégrale.{' '}
                      <strong>Win rate</strong> : une ligne avec SL simulé compte comme <strong>perdue</strong>, même si la
                      résolution aurait été gagnante. Désactiver le stop simulé :{' '}
                      <code className="trade-history-code-inline">VITE_BACKTEST_STOP_LOSS_ENABLED=false</code>. Signaux live :
                      même grille ET ; bot : <strong>carnet / WS</strong>. — Détails SL / bid vs mid / grille :{' '}
                      <strong>encadré ci-dessus</strong>.
                    </span>
                  </p>
                  <label className="strat-15m-debug-toggle">
                    <input type="checkbox" checked={backtest15mDebug} onChange={toggleBacktest15mDebug} />
                    <span>
                      <strong>Mode debug</strong> simulation 15m (détails par créneau + console : CLOB, trades, filtre créneau, raison si pas de signal). Recharge les données au changement.
                    </span>
                  </label>
                  {backtest15mDebug && resolved15mDebugSummary && !resolved15mLoading && (
                    <pre className="strat-15m-debug-summary" title="Résumé dernier chargement">
                      {JSON.stringify(resolved15mDebugSummary, null, 2)}
                    </pre>
                  )}
                </div>
                {resolved15mError && <p className="strat-data-window__body strat-text-red">{resolved15mError}</p>}
                {resolved15mLoading ? (
                  <p className="strat-data-window__body">Chargement…</p>
                ) : resolved15mError ? null : (
                  <>
                    {resolved15m.length === 0 && (
                      <p className="strat-data-window__body strat-muted">
                        Grille 15 min : chaque ligne correspond à un quart d’heure UTC ; les écarts indiquent l’absence de
                        marché résolu ou de données dans la fenêtre chargée.
                      </p>
                    )}
                    <div className="strat-table-wrap strat-table-wrap--scroll">
                      <table className="strat-table">
                        <thead>
                          <tr>
                            <th className="strat-th">Résultat</th>
                            <th className="strat-th">Bot aurait pris</th>
                            <th className="strat-th">Prix d&apos;entrée</th>
                            <th className="strat-th">Signal</th>
                            <th
                              className="strat-th"
                              title="Eastern Time (ET), comme sur polymarket.com — infobulle sur la cellule = UTC"
                            >
                              Heure trade (ET)
                            </th>
                            <th className="strat-th">Type</th>
                            <th className="strat-th">Simul.</th>
                            {backtest15mDebug && <th className="strat-th strat-th--debug">Debug</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {resolved15mDisplayRows.map((r, i) => {
                            if (r.__placeholder15m) {
                              return (
                                <tr
                                  key={`15m-placeholder-${r.slotEndSec}`}
                                  className={`strat-tbody-row strat-tbody-row--15m-gap ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}
                                >
                                  <td className="strat-td strat-td--muted" colSpan={backtest15mDebug ? 8 : 7}>
                                    <span
                                      className="strat-muted"
                                      title={
                                        r.slotEndSec != null
                                          ? `Fin créneau UTC : ${formatTimestampUtcTooltip(r.slotEndSec)}`
                                          : undefined
                                      }
                                    >
                                      Écart · créneau : {formatBitcoin15mSlotRangeEt(r.slotEndSec)}
                                    </span>
                                    <span className="strat-muted"> — pas de marché résolu dans les données chargées</span>
                                  </td>
                                </tr>
                              );
                            }
                            const signalLabel = signalBucketLabelFromPrice(r.botEntryPrice);
                            const dbg = r.simDebug;
                            const dbgCode = dbg?.why?.code ?? '—';
                            return (
                                <tr key={r.eventSlug ?? `15m-${r.slotEndSec ?? i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                                  <td className="strat-td strat-td--strong">
                                    {r.winner === 'Up' || r.winner === 'Down' ? <UpDownDot side={r.winner} /> : r.winner === null ? <span className="strat-muted">En attente</span> : r.winner ?? '—'}
                                  </td>
                                  <td className="strat-td strat-td--muted">
                                    {r.botWouldTake != null ? <UpDownDot side={r.botWouldTake} /> : 'Données indisponibles'}
                                  </td>
                                  <td className="strat-td">
                                    {r.botEntryPrice != null ? `${(r.botEntryPrice * 100).toFixed(1)} %` : '—'}
                                  </td>
                                  <td className="strat-td strat-td--signal">
                                    {signalLabel ?? '—'}
                                  </td>
                                  <td
                                    className="strat-td"
                                    title={
                                      r.botEntryTimestamp != null
                                        ? `UTC : ${formatTimestampUtcTooltip(r.botEntryTimestamp)}`
                                        : undefined
                                    }
                                  >
                                    {formatTradeTimestampEt(r.botEntryTimestamp)}
                                  </td>
                                  <td className="strat-td">
                                    {r.botOrderType ?? '—'}
                                  </td>
                                  <td className="strat-td">
                                    {r.botStopLossExit === true ? (
                                      <span
                                        className="strat-sim-stopped"
                                        title={
                                          r.botStopLossObservedPriceP != null && Number.isFinite(Number(r.botStopLossObservedPriceP))
                                            ? `Proxy observé ${(Number(r.botStopLossObservedPriceP) * 100).toFixed(2)}¢ · ${
                                                r.botResolutionWouldWin === true
                                                  ? 'à la résolution ce serait un gain'
                                                  : r.botResolutionWouldWin === false
                                                    ? 'à la résolution ce serait une perte totale'
                                                    : 'résolution inconnue'
                                              }`
                                            : undefined
                                        }
                                      >
                                        {r.botResolutionWouldWin === true
                                          ? 'Stop-loss (résolution gagnante)'
                                          : 'Stop-loss'}
                                      </span>
                                    ) : (
                                      <>
                                        {r.botWon === true && <span className="strat-sim-won">Gagné</span>}
                                        {r.botWon === false && <span className="strat-sim-lost">Perdu</span>}
                                        {r.botWon == null &&
                                          (r.winner === null ? (
                                            <span className="strat-muted">En attente</span>
                                          ) : (
                                            <span className="strat-muted">Données indisponibles</span>
                                          ))}
                                      </>
                                    )}
                                  </td>
                                  {backtest15mDebug && (
                                    <td className="strat-td strat-td--debug">
                                      <details className="strat-15m-debug-details">
                                        <summary className="strat-15m-debug-summary-btn" title={dbg?.why?.detail}>
                                          {dbgCode}
                                        </summary>
                                        {dbg && (
                                          <pre className="strat-15m-debug-json">{JSON.stringify(dbg, null, 2)}</pre>
                                        )}
                                      </details>
                                    </td>
                                  )}
                                </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {backtestResult15m.withSignal.length > 0 && (
                      <p className="strat-results-foot">
                        Simulation : <strong className="strat-text-green">{backtestResult15m.wonNet}</strong> gagnés net /{' '}
                        <strong>{backtestResult15m.withSimul.length}</strong> créneaux résolus avec entrée (un SL simulé = une
                        perte au bilan, même si résolution gagnante) ·{' '}
                        <strong>{backtestResult15m.won}</strong> gagnés à la résolution ·{' '}
                        {backtestResult15m.stopLossExits > 0 && (
                          <>
                            <strong>{backtestResult15m.stopLossExits}</strong> stop-loss simulé(s) ·{' '}
                          </>
                        )}
                        <strong>{backtestResult15m.withSignal.length}</strong> entrée(s) dans {SIGNAL_BAND_PCT_LABEL} (CLOB +
                        trades + complément 1−p, stop-loss hybride aligné bot si activé).
                      </p>
                    )}
                    <div className="strat-actions-row">
                      <span className="strat-help-text">Affichage : {resolvedDaysCount} derniers jours</span>
                      <button type="button" onClick={refreshResolved15m} disabled={resolved15mLoading} className="btn btn--default btn--outline">
                        Rafraîchir
                      </button>
                      <button
                        type="button"
                        onClick={() => setBacktestWindowDays(3)}
                        disabled={resolved15mLoading || backtestWindowDays === 3}
                        className="btn btn--default btn--outline"
                        title="3 derniers jours (72 h)"
                      >
                        3 jours
                      </button>
                      <button
                        type="button"
                        onClick={() => setBacktestWindowDays(7)}
                        disabled={resolved15mLoading || backtestWindowDays === 7}
                        className="btn btn--default btn--outline"
                        title="7 derniers jours (168 h)"
                      >
                        7 jours
                      </button>
                      <button
                        type="button"
                        onClick={() => setBacktestWindowDays(30)}
                        disabled={resolved15mLoading || backtestWindowDays === 30}
                        className="btn btn--default btn--outline"
                        title="30 derniers jours — chargement long, préférer cet onglet sur dev:backtest"
                      >
                        30 jours
                      </button>
                    </div>
                  </>
                )}
              </>
        </div>
      </div>
    </div>
  );
}
