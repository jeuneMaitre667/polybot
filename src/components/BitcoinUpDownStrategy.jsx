import { useState, useEffect, useRef, useMemo } from 'react';
import { useBitcoinUpDownSignals } from '../hooks/useBitcoinUpDownSignals';
import { useBitcoinUpDownResolved } from '../hooks/useBitcoinUpDownResolved';
import {
  useBitcoinUpDownResolved15m,
  BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
  BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT,
  BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
} from '../hooks/useBitcoinUpDownResolved15m';
import { useOrderBookLiquidity } from '../hooks/useOrderBookLiquidity';
import { useBotStatus, DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M } from '../hooks/useBotStatus';
import { useWallet } from '../context/useWallet';
import { placePolymarketOrder } from '../lib/polymarketOrder';
import { ORDER_BOOK_SIGNAL_MAX_P, ORDER_BOOK_SIGNAL_MIN_P } from '../lib/orderBookLiquidity.js';

const SIGNAL_BAND_PCT_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MIN_P * 100)}–${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)} %`;
const SIGNAL_MAX_CENTS_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)}¢`;
import { build15mBacktestDisplayRows, SLOT_15M_SEC } from '../lib/bitcoin15mGridDisplay.js';
import {
  formatBitcoin15mSlotRangeEt,
  formatTradeTimestampEt,
  formatTimestampUtcTooltip,
} from '../lib/polymarketDisplayTime.js';
import { getBacktestMaxLossFractionOfStake } from '../lib/bitcoinBacktestLossFraction.js';
import { readStratResultModeFromStorage, writeStratResultModeToStorage } from '../lib/dashboardUiPrefs.js';

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
/** Grille SL dans les tableaux d’analyse 15m (75¢ → 90¢, pas 5¢). */
const SL_ANALYSIS_THRESHOLDS_C = [75, 80, 85, 90];

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

export function BitcoinUpDownStrategy() {
  const { address, signer, isPolygon } = useWallet();
  const [resultMode, setResultMode] = useState(() => readStratResultModeFromStorage());
  const { signals, live15mMeta } = useBitcoinUpDownSignals(resultMode === '15m' ? '15m' : 'hourly');

  useEffect(() => {
    writeStratResultModeToStorage(resultMode);
  }, [resultMode]);

  /** Liquidité / carnet : même token que le signal « prix seul » si la grille ET masque le signal affiché. */
  const currentSignalTokenId =
    signals?.[0]?.tokenIdToBuy ??
    (live15mMeta?.hiddenByTiming ? live15mMeta.signalsIfTimingIgnored?.[0]?.tokenIdToBuy : null) ??
    null;
  const { liquidityUsd: liquidityAtTargetUsd, loading: liquidityLoading, error: liquidityError, refresh: refreshLiquidity } = useOrderBookLiquidity(currentSignalTokenId);
  const { data: botStatusData } = useBotStatus(DEFAULT_BOT_STATUS_URL);
  const { data: botStatusData15m } = useBotStatus(DEFAULT_BOT_STATUS_URL_15M);
  const liquidityStats = botStatusData?.liquidityStats ?? null;

  const [extraDays, setExtraDays] = useState(0); // 0 = 3 jours, 1..4 = 4 à 7 jours
  const [includeFees, setIncludeFees] = useState(true);
  const [backtest15mDebug, setBacktest15mDebug] = useState(readBacktest15mDebugFromStorage);
  const [signalMinC, setSignalMinC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, 95));
  const [signalMaxC, setSignalMaxC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, 96));
  const resolvedWindowHours = 72 + extraDays * 24;
  const resolvedDaysCount = 3 + extraDays;
  const { resolved: resolvedHours, loading: resolvedLoading, error: resolvedError, refresh: refreshResolved } = useBitcoinUpDownResolved(resolvedWindowHours);
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
    },
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, String(signalMinC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, String(signalMaxC));
    } catch {
      /* ignore */
    }
  }, [signalMinC, signalMaxC]);

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
  const [initialBalance, setInitialBalance] = useState(100);
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

  const backtestResult = useMemo(() => {
    const withSimul = resolvedHours.filter((r) => r.botWon !== null);
    const sortedSimul = [...withSimul].sort(
      (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
    );
    const estimateCryptoTakerFeeUsd = (stakeUsd, p) => {
      if (!includeFees) return 0;
      if (stakeUsd <= 0 || p == null) return 0;
      const x = p * (1 - p);
      const feeRate = 0.25;
      const exponent = 2;
      return stakeUsd * feeRate * Math.pow(x, exponent);
    };
    const lossFrac = getBacktestMaxLossFractionOfStake();
    let capital = initialBalance > 0 ? initialBalance : 0;
    let peak = capital;
    let maxDrawdown = 0;
    let feesPaid = 0;
    const netPnlMap = new Map();
    for (const r of sortedSimul) {
      if (capital <= 0) break;
      const stake = capital;
      const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
      const feeUsd = estimateCryptoTakerFeeUsd(stake, p);
      feesPaid += feeUsd;
      let delta = 0;
      if (p != null && r.botWon === true) {
        const odds = p > 0 ? 1 / p - 1 : 0;
        delta = stake * odds - feeUsd;
      } else if (r.botWon === false) {
        delta = -stake * lossFrac - feeUsd;
      }
      capital += delta;
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
      won: withSimul.filter((r) => r.botWon === true).length,
    };
  }, [resolvedHours, initialBalance, includeFees]);

  const backtestResult15m = useMemo(() => {
    /** Créneaux où la simu 15m a trouvé une entrée (fenêtre signal alignée bot / carnet, ex. 95–96 %). */
    const withSignal = resolved15m.filter((r) => r.botWouldTake != null);
    /** PnL uniquement sur marchés résolus (winner connu). */
    const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
    const sortedSimul = [...withSimul].sort(
      (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
    );
    const estimateCryptoTakerFeeUsd = (stakeUsd, p) => {
      if (!includeFees) return 0;
      if (stakeUsd <= 0 || p == null) return 0;
      const x = p * (1 - p);
      return stakeUsd * 0.25 * Math.pow(x, 2);
    };
    const lossFrac = getBacktestMaxLossFractionOfStake();
    let capital = initialBalance > 0 ? initialBalance : 0;
    let peak = capital;
    let maxDrawdown = 0;
    let feesPaid = 0;
    const netPnlMap = new Map();
    for (const r of sortedSimul) {
      if (capital <= 0) break;
      const stake = capital;
      const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
      const feeUsd = estimateCryptoTakerFeeUsd(stake, p);
      feesPaid += feeUsd;
      let delta = 0;
      if (r.botStopLossExit === true) {
        /** Perte plafonnée par la règle drawdown (comme le stop), pas une sortie worst 1¢ (−~100 %). */
        delta = -stake * lossFrac - feeUsd;
      } else if (p != null && r.botWon === true) {
        const odds = p > 0 ? 1 / p - 1 : 0;
        delta = stake * odds - feeUsd;
      } else if (r.botWon === false) {
        delta = -stake * lossFrac - feeUsd;
      }
      capital += delta;
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
      won: withSimul.filter((r) => r.botWon === true).length,
      stopLossExits: withSimul.filter((r) => r.botStopLossExit === true).length,
    };
  }, [resolved15m, initialBalance, includeFees]);

  const stopLossSweep97c = useMemo(() => {
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
      return { c, pctHit, hit, baseN, avgReturnIfHit, avgReturnWithSl };
    });

    return { baseN: base.length, minStats, sweep };
  }, [resolved15m, includeFees]);

  const activeBacktest = resultMode === 'hourly' ? backtestResult : backtestResult15m;

  const entryTiming = useMemo(() => {
    const rows = resultMode === 'hourly' ? resolvedHours : resolved15m;
    const sessionDurationSec = resultMode === 'hourly' ? 3600 : 15 * 60;
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
  }, [resultMode, resolvedHours, resolved15m]);

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
  const winRatePct =
    bt.withSimul.length > 0 ? Math.round((bt.won / bt.withSimul.length) * 1000) / 10 : null;
  const totalNetPnl = initialBalance > 0 ? bt.capital - initialBalance : null;
  const pnlPct =
    initialBalance > 0 && totalNetPnl != null
      ? ((totalNetPnl / initialBalance) * 100).toFixed(1)
      : null;

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
                  Répartition des décisions bot (24 h){' '}
                  {resultMode === '15m' ? '(15 min)' : '(horaire)'}
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
              <div className="strat-mode-toggle strat-mode-toggle--hero" role="group" aria-label="Période backtest">
                <button
                  type="button"
                  className={resultMode === 'hourly' ? 'strat-mode-toggle__btn strat-mode-toggle__btn--on' : 'strat-mode-toggle__btn'}
                  onClick={() => setResultMode('hourly')}
                >
                  Horaires
                </button>
                <button
                  type="button"
                  className={resultMode === '15m' ? 'strat-mode-toggle__btn strat-mode-toggle__btn--on' : 'strat-mode-toggle__btn'}
                  onClick={() => setResultMode('15m')}
                >
                  15 min
                </button>
              </div>

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
                  {resultMode === '15m' ? '15 min' : 'horaire'}
                  ). <strong>OFF</strong> = jamais d’ordre auto (tu peux trader à la main). Wallet Polygon requis pour
                  l’auto.
                </p>
                {resultMode === '15m' && live15mMeta?.hiddenByTiming && live15mMeta.signalsIfTimingIgnored?.[0] && (
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
                {resultMode === '15m' && live15mMeta?.slugMismatch && (
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
                {resultMode === '15m' &&
                  live15mMeta?.livePriceSource &&
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
                    <span className="strat-metric-card__lbl">Win rate</span>
                    <span className="strat-metric-card__val strat-metric-card__val--green">
                      {winRatePct != null ? `${winRatePct}%` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="strat-metric-card__lbl">Sessions</span>
                    <span className="strat-metric-card__val">
                      {bt.withSimul.length > 0 ? `${bt.won} / ${bt.withSimul.length}` : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="strat-metric-card__lbl">Capital final</span>
                    <span className="strat-metric-card__val strat-metric-card__val--green">
                      {initialBalance > 0 && bt.withSimul.length > 0 ? formatMoney(bt.capital) : '—'}
                    </span>
                  </div>
                </div>
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
                <button
                  type="button"
                  onClick={toggleShowLiquiditySuggestion}
                  className={`btn btn--xs ${showLiquiditySuggestion ? 'btn--toggle-on' : 'btn--toggle-off'}`}
                  title={`Afficher le panneau liquidité ${SIGNAL_BAND_PCT_LABEL} sous la stratégie`}
                >
                  Liquidité {showLiquiditySuggestion ? 'ON' : 'OFF'}
                </button>
              </div>

              {resultMode === '15m' && stopLossSweep97c.baseN > 0 && (
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">Analyse stop-loss (entrée ~95–96¢, proxy Data API/CLOB)</p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Base : <strong>{stopLossSweep97c.baseN}</strong> entrées simulées avec “min après entrée” observé.
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
                        {stopLossSweep97c.sweep.map((row, i) => (
                          <tr key={row.c} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                            <td className="strat-td">{row.c}¢</td>
                            <td className="strat-td strat-td--strong">{row.pct.toFixed(1)}%</td>
                            <td className="strat-td">
                              {row.hit} / {stopLossSweep97c.baseN}
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

              {resultMode === '15m' && (
                <div className="strat-metric-card" style={{ marginTop: 14 }}>
                  <p className="strat-metric-card__kicker">Fenêtre signal backtest (15 min)</p>
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Modifie la bande d’entrée simulée (ex. 95–96¢). Cela recharge les données et recalcul le tableau 15m.
                  </p>
                  <div className="strat-hero-controls" style={{ marginTop: 10 }}>
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
                    <button type="button" onClick={refreshResolved15m} disabled={resolved15mLoading} className="btn btn--xs btn--outline">
                      Recalculer
                    </button>
                  </div>
                </div>
              )}

              {resultMode === '15m' && stopLossTradeoff.baseN > 0 && (
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
                  <p className="strat-muted-tight" style={{ marginTop: 8 }}>
                    “Perte moy. si touché” = PnL moyen si la sortie se fait à SL (proxy, sans slippage). “PnL moy. avec SL” =
                    si touché → sortie SL, sinon → hold jusqu’à résolution (win/lose), avec frais si activés.
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
              Période : <strong>{resultMode === 'hourly' ? 'Horaires' : '15 min'}</strong>
            </span>
            <div className="strat-mode-toggle strat-mode-toggle--results" role="group" aria-label="Période tableau">
              <button
                type="button"
                className={resultMode === 'hourly' ? 'strat-mode-toggle__btn strat-mode-toggle__btn--on' : 'strat-mode-toggle__btn'}
                onClick={() => setResultMode('hourly')}
              >
                Horaires
              </button>
              <button
                type="button"
                className={resultMode === '15m' ? 'strat-mode-toggle__btn strat-mode-toggle__btn--on' : 'strat-mode-toggle__btn'}
                onClick={() => setResultMode('15m')}
              >
                15 min
              </button>
            </div>
          </div>
          <p className="strat-results-desc">
            Simulation alignée sur le bot ({SIGNAL_BAND_PCT_LABEL}, marché){' '}
            {resultMode === 'hourly'
              ? '— pas d’entrée dans les 5 dernières minutes du créneau.'
              : '— 15 min : pas d’entrée les 3 premières minutes ET de chaque quart (:00–:15–:30–:45) ni les 4 dernières (même grille que le bot).'}{' '}
            Données historiques CLOB.
          </p>

            {resultMode === 'hourly' && (
              <>
                {/* Fenêtre de données Horaires : toujours visible au-dessus du tableau */}
                <div className="strat-data-window">
                  <h4 className="strat-data-window__title">
                    Fenêtre de données (Horaires)
                  </h4>
                  <p className="strat-data-window__body">
                    Période : <strong className="strat-strong">{resolvedDaysCount} derniers jours</strong>
                    {' '}({Math.ceil(resolvedWindowHours)} créneaux horaires).
                    {resolvedLoading && ' Chargement en cours…'}
                    {!resolvedLoading && resolvedHours.length === 0 && !resolvedError && (
                      <span className="strat-block-msg strat-text-amber">Aucun créneau résolu récupéré pour cette période.</span>
                    )}
                    {resolvedError && (
                      <span className="strat-block-msg strat-text-red">{resolvedError}</span>
                    )}
                    {!resolvedLoading && resolvedHours.length > 0 && (
                      <span className="strat-block-msg strat-text-green">{resolvedHours.length} créneau{resolvedHours.length !== 1 ? 'x' : ''} chargé{resolvedHours.length !== 1 ? 's' : ''} (résolus).</span>
                    )}
                    <span className="strat-muted-tight">
                      Même règles que le bot : prix dans {SIGNAL_BAND_PCT_LABEL} et pas d&apos;entrée dans les 5 dernières minutes du créneau. Le WR reflète ce que le bot aurait fait avec l&apos;historique CLOB. En live le bot voit le prix à chaque cycle (1 s) et en WebSocket ; il peut rater une fenêtre très courte entre deux mises à jour.
                    </span>
                  </p>
                </div>
                {resolvedError && <p className="strat-data-window__body strat-text-red">{resolvedError}</p>}
                {resolvedLoading ? (
                  <p className="strat-data-window__body">Chargement…</p>
                ) : resolvedHours.length === 0 ? (
                  <p className="strat-data-window__body">Aucun créneau résolu sur les {resolvedDaysCount} derniers jours. Utilisez « Rafraîchir » ou « Un jour de plus » après la fenêtre ci‑dessus.</p>
                ) : (
                  <div className="strat-table-wrap">
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
                        </tr>
                      </thead>
                      <tbody>
                        {resolvedHours.map((r, i) => {
                          const signalLabel = signalBucketLabelFromPrice(r.botEntryPrice);
                          return (
                            <tr key={r.eventSlug ?? `h-${i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
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
                                {r.botWon === true && <span className="strat-sim-won">Gagné</span>}
                                {r.botWon === false && <span className="strat-sim-lost">Perdu</span>}
                                {r.botWon == null && (r.winner === null ? <span className="strat-muted">En attente</span> : <span className="strat-muted">Données indisponibles</span>)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {resolvedHours.length > 0 && (() => {
                  const { withSimul, won } = backtestResult;
                  if (withSimul.length > 0) {
                    return (
                      <p className="strat-results-foot">
                        Simulation : <strong className="strat-text-green">{won}</strong> gagnés /{' '}
                        <strong>{withSimul.length}</strong> créneaux avec signal {SIGNAL_BAND_PCT_LABEL} · Données historiques CLOB.
                      </p>
                    );
                  }
                  return (
                    <p className="strat-help-text-xs strat-mt-xs">
                      Bot / Simul. : historique des prix CLOB indisponible pour ces créneaux. Réessayer plus tard.
                    </p>
                  );
                })()}
                <div className="strat-actions-row">
                  <span className="strat-help-text">Affichage : {resolvedDaysCount} derniers jours</span>
                  <button type="button" onClick={refreshResolved} disabled={resolvedLoading} className="btn btn--default btn--outline">
                    Rafraîchir
                  </button>
                  <button type="button" onClick={() => setExtraDays((d) => Math.min(4, d + 1))} disabled={resolvedLoading || extraDays >= 4} className="btn btn--default btn--outline">
                    Un jour de plus
                  </button>
                  <button type="button" onClick={() => setExtraDays((d) => Math.max(0, d - 1))} disabled={resolvedLoading || extraDays <= 0} className="btn btn--default btn--outline">
                    Un jour de moins
                  </button>
                  <button
                    type="button"
                    onClick={() => setExtraDays(0)}
                    disabled={resolvedLoading || extraDays <= 0}
                    className="btn btn--default btn--outline"
                    title="Revenir directement aux 3 derniers jours (extraDays = 0)"
                  >
                    3 jours
                  </button>
                  <button
                    type="button"
                    onClick={() => setExtraDays(4)}
                    disabled={resolvedLoading || extraDays >= 4}
                    className="btn btn--default btn--outline"
                    title="Afficher les 7 derniers jours (168 h)"
                  >
                    7 jours
                  </button>
                </div>
              </>
            )}

            {resultMode === '15m' && (
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
                        <strong>Seuil SL simulé</strong> : <strong>{Math.round(BACKTEST_STOP_LOSS_TRIGGER_PRICE_P * 100)}¢</strong>{' '}
                        ou drawdown ≤ <strong>−{BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT} %</strong>, après{' '}
                        <strong>{BACKTEST_STOP_LOSS_MIN_HOLD_SEC}s</strong> de détention. Pour coller au serveur : même valeur
                        dans <code className="strat-code-inline">VITE_BACKTEST_STOP_LOSS_TRIGGER_PRICE_P</code> (dashboard) et{' '}
                        <code className="strat-code-inline">STOP_LOSS_TRIGGER_PRICE_P</code> (bot, ex. <strong>0.75</strong> = 75¢).
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
                    {' '}({Math.min(672, Math.ceil(resolvedWindowHours * 4))} créneaux 15 min).
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
                      Fenêtre signal <strong>{SIGNAL_BAND_PCT_LABEL}</strong> (complément <strong>1 − p</strong>). PNL agrégé :
                      perte max par créneau = fraction drawdown alignée sur la simu SL (pas −100 % arbitraire). Désactiver le
                      stop simulé :{' '}
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
                                        Stop-loss
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
                        Simulation : <strong className="strat-text-green">{backtestResult15m.won}</strong> gagnés /{' '}
                        <strong>{backtestResult15m.withSimul.length}</strong> créneaux résolus avec entrée ·{' '}
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
                      <button type="button" onClick={() => setExtraDays((d) => Math.min(4, d + 1))} disabled={resolved15mLoading || extraDays >= 4} className="btn btn--default btn--outline">
                        Un jour de plus
                      </button>
                      <button type="button" onClick={() => setExtraDays((d) => Math.max(0, d - 1))} disabled={resolved15mLoading || extraDays <= 0} className="btn btn--default btn--outline">
                        Un jour de moins
                      </button>
                      <button
                        type="button"
                        onClick={() => setExtraDays(0)}
                        disabled={resolved15mLoading || extraDays <= 0}
                        className="btn btn--default btn--outline"
                        title="Revenir directement aux 3 derniers jours (extraDays = 0)"
                      >
                        3 jours
                      </button>
                      <button
                        type="button"
                        onClick={() => setExtraDays(4)}
                        disabled={resolved15mLoading || extraDays >= 4}
                        className="btn btn--default btn--outline"
                        title="Afficher les 7 derniers jours (168 h)"
                      >
                        7 jours
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  );
}
