import { useState, useEffect, useLayoutEffect, useMemo } from 'react';
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
import { ORDER_BOOK_SIGNAL_MAX_P, ORDER_BOOK_SIGNAL_MIN_P } from '../lib/orderBookLiquidity.js';

const SIGNAL_BAND_PCT_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MIN_P * 100)}–${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)} %`;
const SIGNAL_MAX_CENTS_LABEL = `${Math.round(ORDER_BOOK_SIGNAL_MAX_P * 100)}¢`;
import { build15mBacktestDisplayRows, MAX_15M_GRID_SLOTS, SLOT_15M_SEC } from '../lib/bitcoin15mGridDisplay.js';
import {
  formatBitcoin15mSlotRangeEt,
  formatTradeTimestampEt,
  formatTimestampUtcTooltip,
} from '../lib/polymarketDisplayTime.js';
import { simulateReinvestMaxStake } from '../lib/bitcoin15mReinvestBacktest.js';

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
const STORAGE_BACKTEST_15M_DEBUG = 'polymarket-dashboard.backtest15mDebug';
const STORAGE_BACKTEST_15M_SIGNAL_MIN_C = 'polymarket-dashboard.backtest15mSignalMinC';
const STORAGE_BACKTEST_15M_SIGNAL_MAX_C = 'polymarket-dashboard.backtest15mSignalMaxC';
const STORAGE_BACKTEST_15M_SL_C = 'polymarket-dashboard.backtest15mSlC';
const STORAGE_BACKTEST_15M_MAX_STAKE_EUR = 'polymarket-dashboard.backtest15mMaxStakeEur';
const STORAGE_BACKTEST_15M_WINDOW_DAYS = 'polymarket-dashboard.backtest15mWindowDays';
const STORAGE_BACKTEST_15M_REINVEST = 'polymarket-dashboard.backtest15mReinvestMaxStake';

/**
 * Perte comptée à chaque SL dans le PnL agrégé : fraction du stake (aligné exécution bot / scripts `recalc`).
 * Le **seuil** de déclenchement (`backtestSlC`) et la détection sur l’historique ne changent pas — seul le montant
 * de perte au bilan utilise ce pourcentage (défaut 25 %). Surcharge : `VITE_BACKTEST_SL_FIXED_LOSS_FRAC`.
 */
const BACKTEST_SL_FIXED_LOSS_FRAC = (() => {
  const v = Number(import.meta.env.VITE_BACKTEST_SL_FIXED_LOSS_FRAC);
  if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  return 0.25;
})();

/** Fenêtres historique backtest 15m (jours calendaires × 24 h). */
const BACKTEST_WINDOW_DAYS_OPTIONS = [3, 7, 30];

function normalizeBacktestWindowDays(raw) {
  const n = Number(raw);
  return BACKTEST_WINDOW_DAYS_OPTIONS.includes(n) ? n : 3;
}
/** Grille SL dans les tableaux d’analyse 15m (60¢ → 45¢, pas 5¢). */
const SL_ANALYSIS_THRESHOLDS_C = [60, 58, 55, 50, 45];

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

/** Réinvestissement plafonné (défaut : oui — aligné stratégie « min(capital, mise max) »). */
function readBacktestReinvestFromStorage() {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(STORAGE_BACKTEST_15M_REINVEST);
    if (v == null || v === '') return true;
    return v === '1' || v === 'true';
  } catch {
    return true;
  }
}

/** Lien direct ex. `/?windowDays=30` pour ouvrir le backtest sur 3 / 7 / 30 jours sans cliquer. */
function readWindowDaysFromUrl() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('windowDays');
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return BACKTEST_WINDOW_DAYS_OPTIONS.includes(n) ? n : null;
  } catch {
    return null;
  }
}

/** Ex. `?signalMin=77&signalMax=78&sl=58` pour aligner l’UI sans cliquer (recharge les données si pas de cache figé). */
function readBacktestSignalParamsFromUrl() {
  if (typeof window === 'undefined') return null;
  try {
    const sp = new URLSearchParams(window.location.search);
    const min = sp.get('signalMin');
    const max = sp.get('signalMax');
    const sl = sp.get('sl') ?? sp.get('backtestSl');
    const out = {};
    if (min != null && min !== '') {
      const n = Number(min);
      if (Number.isFinite(n) && n >= 50 && n <= 99) out.signalMinC = Math.round(n);
    }
    if (max != null && max !== '') {
      const n = Number(max);
      if (Number.isFinite(n) && n >= 50 && n <= 99) out.signalMaxC = Math.round(n);
    }
    if (sl != null && sl !== '') {
      const n = Number(sl);
      if (Number.isFinite(n) && n >= 50 && n <= 95) out.backtestSlC = Math.round(n);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
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
  const static15mJsonUrl = (import.meta.env.VITE_BACKTEST_15M_STATIC_JSON || '').trim();
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

  const [backtestWindowDays, setBacktestWindowDays] = useState(() => {
    const fromUrl = readWindowDaysFromUrl();
    if (fromUrl != null) return fromUrl;
    return normalizeBacktestWindowDays(readNumberFromStorage(STORAGE_BACKTEST_15M_WINDOW_DAYS, 3));
  });
  const [includeFees, setIncludeFees] = useState(true);
  const [backtest15mDebug, setBacktest15mDebug] = useState(readBacktest15mDebugFromStorage);
  const [signalMinC, setSignalMinC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, 77));
  const [signalMaxC, setSignalMaxC] = useState(() => readNumberFromStorage(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, 78));
  const [backtestSlC, setBacktestSlC] = useState(() =>
    readNumberFromStorage(STORAGE_BACKTEST_15M_SL_C, Math.round(BACKTEST_STOP_LOSS_TRIGGER_PRICE_P * 100))
  );
  const [backtestMaxStakeEur, setBacktestMaxStakeEur] = useState(() =>
    readNumberFromStorage(STORAGE_BACKTEST_15M_MAX_STAKE_EUR, 500)
  );
  const [backtestReinvestMaxStake, setBacktestReinvestMaxStake] = useState(readBacktestReinvestFromStorage);
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

  /** Après le 1er paint : `?windowDays=` / `?signalMin=` etc. doivent primer sur le localStorage. */
  useLayoutEffect(() => {
    const fromUrl = readWindowDaysFromUrl();
    if (fromUrl != null) {
      setBacktestWindowDays(fromUrl);
    }
    const sig = readBacktestSignalParamsFromUrl();
    if (sig?.signalMinC != null) setSignalMinC(sig.signalMinC);
    if (sig?.signalMaxC != null) setSignalMaxC(sig.signalMaxC);
    if (sig?.backtestSlC != null) setBacktestSlC(sig.backtestSlC);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MIN_C, String(signalMinC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SIGNAL_MAX_C, String(signalMaxC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_SL_C, String(backtestSlC));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_MAX_STAKE_EUR, String(backtestMaxStakeEur));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_WINDOW_DAYS, String(backtestWindowDays));
      window.localStorage.setItem(STORAGE_BACKTEST_15M_REINVEST, backtestReinvestMaxStake ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [signalMinC, signalMaxC, backtestSlC, backtestMaxStakeEur, backtestWindowDays, backtestReinvestMaxStake]);

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

  const liveLastStopLoss = useMemo(() => {
    const lo = botStatusData15m?.lastOrder;
    if (!lo || lo.stopLossExit !== true) return null;
    const conditionId = typeof lo.conditionId === 'string' ? lo.conditionId.toLowerCase() : null;
    return {
      conditionId,
      at: lo.at ?? null,
      bestBidP: Number.isFinite(Number(lo.stopLossBestBidP)) ? Number(lo.stopLossBestBidP) : null,
      triggerPriceP:
        Number.isFinite(Number(lo.stopLossTriggerPriceP)) ? Number(lo.stopLossTriggerPriceP) : null,
    };
  }, [botStatusData15m]);

  const [initialBalance, setInitialBalance] = useState(20);
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
    /** Créneaux où la simu 15m a trouvé une entrée (fenêtre signal alignée bot / carnet, ex. 77–78 %). */
    const withSignal = resolved15m.filter((r) => r.botWouldTake != null);
    /** PnL uniquement sur marchés résolus (winner connu). */
    const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
    /** Ordre **chronologique** (fin de créneau croissante) : première mise = marché le plus **ancien**, dernière = le plus **récent**.
     *  Le tableau 15m affiche le **récent en haut** : la lecture haut→bas est l’inverse du temps ; le PnL suit le temps réel (bas→haut du tableau). */
    const sortedSimul = [...withSimul].sort(
      (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
    );

    const stakePerTradeEur =
      Number.isFinite(backtestMaxStakeEur) && backtestMaxStakeEur > 0
        ? Math.max(0.01, backtestMaxStakeEur)
        : 10;
    const liveStopLossConditionId =
      typeof liveLastStopLoss?.conditionId === 'string' ? liveLastStopLoss.conditionId.toLowerCase() : null;

    if (backtestReinvestMaxStake) {
      const sim = simulateReinvestMaxStake(sortedSimul, {
        initialBalance,
        maxStakeEur: stakePerTradeEur,
        backtestSlC,
        includeFees,
        liveStopLossConditionId,
        slFixedLossFractionOfStake: BACKTEST_SL_FIXED_LOSS_FRAC,
      });
      const n = sim.trades;
      return {
        netPnlMap: new Map(),
        capital: sim.capital,
        feesPaid: sim.feesPaid,
        maxDrawdown: sim.maxDrawdown,
        stakePerTradeEur,
        reinvestMaxStake: true,
        tradeCountForMetrics: n,
        withSimul,
        withSignal,
        wonNet: sim.wonNet,
        won: withSimul.filter((r) => r.botWon === true).length,
        stopLossExits: sim.slCount,
        resolutionLossesNoSl: sim.resolutionLossNoSl,
        expectancyPerTrade: n > 0 ? sim.pnl / n : null,
        avgWinPerTrade: null,
        avgLossPerTrade: null,
      };
    }

    /**
     * Mise **fixe** par créneau pour les agrégats (win rate net, gagnés net, capital final, frais).
     * L’ancien mode « réinvestir 100 % du capital » à chaque trade s’arrêtait à la **première** perte résolution
     * (capital ≈ 0), alors que le dénominateur comptait **tous** les créneaux — d’où un win rate net absurde.
     */
    const estimateCryptoTakerFeeRate = (p) => {
      if (!includeFees) return 0;
      if (p == null) return 0;
      const x = p * (1 - p);
      return 0.25 * Math.pow(x, 2);
    };
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
      const p = r.botEntryPrice != null ? Number(r.botEntryPrice) : null;
      const feeRate = estimateCryptoTakerFeeRate(p);
      const budgetForTrade = stakePerTradeEur;
      const stake = feeRate > 0 ? budgetForTrade / (1 + feeRate) : budgetForTrade;
      const feeUsd = stake * feeRate;
      feesPaid += feeUsd;
      let delta = 0;
      const rowConditionId = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
      const isStrictStopLoss =
        r.botStopLossExit === true ||
        (liveStopLossConditionId != null && rowConditionId != null && rowConditionId === liveStopLossConditionId);
      if (isStrictStopLoss) {
        delta = -stake * BACKTEST_SL_FIXED_LOSS_FRAC - feeUsd;
      } else if (p != null && r.botWon === true) {
        const odds = p > 0 ? 1 / p - 1 : 0;
        delta = stake * odds - feeUsd;
      } else if (r.botWon === false) {
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
      stakePerTradeEur,
      reinvestMaxStake: false,
      tradeCountForMetrics: sortedSimul.length,
      withSimul,
      withSignal,
      wonNet,
      won: withSimul.filter((r) => r.botWon === true).length,
      stopLossExits: withSimul.filter((r) => {
        const rowConditionId = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
        return (
          r.botStopLossExit === true ||
          (liveStopLossConditionId != null &&
            rowConditionId != null &&
            rowConditionId === liveStopLossConditionId)
        );
      }).length,
      resolutionLossesNoSl,
      expectancyPerTrade: withSimul.length > 0 ? sumDelta / withSimul.length : null,
      avgWinPerTrade: winsCount > 0 ? sumWinDelta / winsCount : null,
      avgLossPerTrade: lossesCount > 0 ? sumLossDelta / lossesCount : null,
    };
  }, [
    resolved15m,
    initialBalance,
    includeFees,
    backtestSlC,
    backtestMaxStakeEur,
    backtestReinvestMaxStake,
    liveLastStopLoss,
  ]);

  const slAnalysisSweep = useMemo(() => {
    // Analyse : pour des entrées dans la bande signal (~77–78¢ par défaut), on regarde le plus bas prix observé après entrée.
    // On répond à la question « quel % touche un SL à X¢ ? » via un proxy conservateur :
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

  const bt = activeBacktest;
  const metricN =
    typeof bt.tradeCountForMetrics === 'number' && bt.tradeCountForMetrics >= 0
      ? bt.tradeCountForMetrics
      : bt.withSimul.length;
  const winRateResolutionPct =
    bt.withSimul.length > 0 ? Math.round((bt.won / bt.withSimul.length) * 1000) / 10 : null;
  const winRateNetPct =
    metricN > 0 ? Math.round((bt.wonNet / metricN) * 1000) / 10 : null;
  const totalNetPnl = initialBalance > 0 ? bt.capital - initialBalance : null;
  const pnlPct =
    initialBalance > 0 && totalNetPnl != null
      ? ((totalNetPnl / initialBalance) * 100).toFixed(1)
      : null;
  const slHitRatePct =
    metricN > 0 ? Math.round((bt.stopLossExits / metricN) * 1000) / 10 : null;

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
            </div>

            <div className="strat-hero-right">
              <h3 className="strat-balance-perf-heading">Solde &amp; performance</h3>

              <div className="strat-metric-card">
                <p className="strat-metric-card__kicker">
                  Backtest · {resolvedDaysCount} derniers jours
                </p>
                <p className="strat-muted-tight" style={{ marginBottom: 8 }}>
                  Calcul dans l’ordre chronologique (ancien → récent) ; la grille 15m liste le plus récent en haut, donc la première
                  mise de la fenêtre correspond aux lignes du bas du tableau.
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
                      {metricN > 0 ? `${bt.wonNet} / ${metricN}` : '—'}
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
                  {bt.reinvestMaxStake ? (
                    <>
                      Agrégats : <strong>mise = min(capital, plafond)</strong> avec plafond{' '}
                      <strong>{bt.stakePerTradeEur != null ? `${bt.stakePerTradeEur} €` : '—'}</strong> (réinvestissement) ; frais
                      taker déduits du budget avant sizing. Gain / perte résolution comme la mise fixe ; chaque{' '}
                      <strong>SL simulé</strong> compte une perte de <strong>{Math.round(BACKTEST_SL_FIXED_LOSS_FRAC * 100)} %</strong> du
                      stake (+ frais), le seuil <strong>{backtestSlC}¢</strong> servant uniquement à savoir si le SL est déclenché
                      dans l’historique.
                    </>
                  ) : (
                    <>
                      Agrégats (win rate net, gagnés net, PnL) : <strong>mise fixe {bt.stakePerTradeEur != null ? `${bt.stakePerTradeEur} €` : '—'}</strong> par créneau{' '}
                      {backtestMaxStakeEur > 0 ? `(plafond « mise max »)` : `(défaut 10 € si mise max = 0)`} ; frais taker déduits du budget avant sizing.
                      Gain si résolution gagnante : <code>(1 / prix entrée − 1) × mise</code> (moins frais si activés). Perte si mauvais
                      côté à la résolution : <strong>−mise</strong> (binaire). Si <strong>SL simulé</strong> :{' '}
                      <strong>−{Math.round(BACKTEST_SL_FIXED_LOSS_FRAC * 100)} %</strong> du stake (+ frais) — même logique que le
                      bot en exécution (prix mid historique pour le déclenchement, pas pour le montant de perte au bilan).
                    </>
                  )}
                </p>
                <p className="strat-muted-tight">
                  Le <strong>win rate résolution</strong> (issue finale du marché) reste affiché dans le détail des lignes ; ici on
                  montre le <strong>win rate net</strong> (delta PnL positif).
                </p>
                {bt.reinvestMaxStake && metricN > 0 && metricN < bt.withSimul.length && (
                  <p className="strat-muted-tight" style={{ marginTop: 8 }}>
                    Simulation réinvest. arrêtée après <strong>{metricN}</strong> créneaux (capital insuffisant pour la mise suivante).
                  </p>
                )}
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
                  onClick={() => setBacktestReinvestMaxStake((v) => !v)}
                  className={`btn btn--xs ${backtestReinvestMaxStake ? 'btn--toggle-on' : 'btn--toggle-off'}`}
                  title="ON : mise = min(capital, plafond). OFF : même montant à chaque créneau."
                >
                  {backtestReinvestMaxStake ? 'Réinvest ON' : 'Réinvest OFF'}
                </button>
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
                  <p className="strat-metric-card__kicker">Analyse stop-loss (entrée ~77–78¢, proxy Data API/CLOB)</p>
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
                  {static15mJsonUrl ? (
                    <p className="strat-metric-card__sub strat-text-amber" style={{ marginTop: 6, lineHeight: 1.5 }}>
                      <strong>Cache JSON actif</strong> ({static15mJsonUrl}) : le tableau utilise les lignes précalculées du fichier.
                      Changer signal / SL ici ne refait pas la simu — retirez <code className="strat-code-inline">VITE_BACKTEST_15M_STATIC_JSON</code> du{' '}
                      <code className="strat-code-inline">.env</code> pour recharger en live, ou régénérez le cache :{' '}
                      <code className="strat-code-inline">
                        BACKTEST_SIGNAL_MIN_C=77 BACKTEST_SIGNAL_MAX_C=78 BACKTEST_SL_C=60 npm run cache:15m
                      </code>
                    </p>
                  ) : null}
                  <p className="strat-metric-card__sub" style={{ marginTop: 6 }}>
                    Modifie la bande d’entrée simulée (défaut 77–78¢, alignée bot) et le SL de simulation. Sans cache statique, cela
                    recharge les données et recalcule le tableau 15m.
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
                        setSignalMinC(77);
                        setSignalMaxC(78);
                      }}
                      className="btn btn--xs btn--outline"
                      title="Revenir à 90–91¢ (aligné bot)"
                    >
                      Reset 77–78¢
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
                      onClick={() => setBacktestMaxStakeEur(500)}
                      className="btn btn--xs btn--outline"
                      title="Plafond 500 € (aligné bot)"
                    >
                      Reset 500 €
                    </button>
                    <button type="button" onClick={refreshResolved15m} disabled={resolved15mLoading} className="btn btn--xs btn--outline">
                      Recalculer
                    </button>
                  </div>
                </div>
              }
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
                        <code className="strat-code-inline">STOP_LOSS_TRIGGER_PRICE_P</code> (ex. <strong>0.70</strong> = 70¢). Valeur
                        utilisée ici : <strong>{backtestSlC}¢</strong>, et{' '}
                        <code className="strat-code-inline">VITE_BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED</code> ={' '}
                        <code className="strat-code-inline">STOP_LOSS_DRAWDOWN_ENABLED</code>.
                      </li>
                      <li>
                        <strong>SL touché</strong> : le PnL compte <strong>−{Math.round(BACKTEST_SL_FIXED_LOSS_FRAC * 100)} %</strong> du
                        stake (+ frais), pas le rendement au prix mid de sortie — pour coller au bot réel. Comme une{' '}
                        <strong>perte</strong> dans le win rate net, même si la résolution aurait été favorable (ligne « Stop-loss
                        (résolution gagnante) »).
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
                    {resolved15mLoading &&
                      (backtestWindowDays === 30
                        ? ' Chargement 30 jours (plusieurs minutes, ne pas fermer l’onglet)…'
                        : ' Chargement en cours…')}
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
                      Solde ci-dessus) : réinvestissement intégral ; perte SL au bilan ={' '}
                      <strong>{Math.round(BACKTEST_SL_FIXED_LOSS_FRAC * 100)} %</strong> du stake (+ frais), seuil{' '}
                      <strong>{backtestSlC}¢</strong> pour la détection uniquement. Perte à la résolution (sans SL) = mise intégrale.{' '}
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
                  <p className="strat-data-window__body">
                    Chargement…
                    {backtestWindowDays === 30 && (
                      <span className="strat-muted-tight" style={{ display: 'block', marginTop: 6 }}>
                        Fenêtre 30 jours : listes Gamma paginées + prix CLOB / trades par créneau — compte plusieurs minutes.
                      </span>
                    )}
                  </p>
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
                            const rowConditionId =
                              typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
                            const isLiveLastStopLossRow =
                              rowConditionId != null &&
                              liveLastStopLoss?.conditionId != null &&
                              rowConditionId === liveLastStopLoss.conditionId;
                            const isBacktestPendingResolution =
                              isLiveLastStopLossRow && !(r.winner === 'Up' || r.winner === 'Down');
                            const slotEndSec = Number(r.slotEndSec);
                            const isRecentSlotPendingApi =
                              Number.isFinite(slotEndSec) &&
                              Date.now() / 1000 - slotEndSec >= 0 &&
                              Date.now() / 1000 - slotEndSec <= 90 * 60;
                            const unavailableLabel = isRecentSlotPendingApi
                              ? 'En attente de consolidation API (créneau récent)'
                              : 'Données indisponibles';
                            return (
                                <tr key={r.eventSlug ?? `15m-${r.slotEndSec ?? i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                                  <td className="strat-td strat-td--strong">
                                    {r.winner === 'Up' || r.winner === 'Down' ? <UpDownDot side={r.winner} /> : r.winner === null ? <span className="strat-muted">En attente</span> : r.winner ?? '—'}
                                  </td>
                                  <td className="strat-td strat-td--muted">
                                    {r.botWouldTake != null ? <UpDownDot side={r.botWouldTake} /> : unavailableLabel}
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
                                    {isLiveLastStopLossRow && (
                                      <div className="strat-muted-tight" style={{ marginTop: 4 }}>
                                        <span
                                          className="strat-sim-stopped"
                                          title={
                                            liveLastStopLoss?.triggerPriceP != null ||
                                            liveLastStopLoss?.bestBidP != null
                                              ? `Bot-status: bid ${
                                                  liveLastStopLoss?.bestBidP != null
                                                    ? `${(liveLastStopLoss.bestBidP * 100).toFixed(2)}¢`
                                                    : '—'
                                                } | seuil ${
                                                  liveLastStopLoss?.triggerPriceP != null
                                                    ? `${(liveLastStopLoss.triggerPriceP * 100).toFixed(2)}¢`
                                                    : '—'
                                                }`
                                              : 'SL live détecté via bot-status'
                                          }
                                        >
                                          SL live détecté (bot-status)
                                        </span>
                                      </div>
                                    )}
                                  </td>
                                  <td className="strat-td">
                                    {r.botStopLossExit === true || isLiveLastStopLossRow ? (
                                      <span
                                        className="strat-sim-stopped"
                                        title={
                                          r.botStopLossExit === true &&
                                          r.botStopLossObservedPriceP != null &&
                                          Number.isFinite(Number(r.botStopLossObservedPriceP))
                                            ? `Proxy observé ${(Number(r.botStopLossObservedPriceP) * 100).toFixed(2)}¢ · ${
                                                r.botResolutionWouldWin === true
                                                  ? 'à la résolution ce serait un gain'
                                                  : r.botResolutionWouldWin === false
                                                    ? 'à la résolution ce serait une perte totale'
                                                    : 'résolution inconnue'
                                              }`
                                            : isLiveLastStopLossRow
                                              ? 'SL live détecté via bot-status: compté comme perte côté discipline SL'
                                            : undefined
                                        }
                                      >
                                        {r.botStopLossExit === true && r.botResolutionWouldWin === true
                                          ? 'Stop-loss (résolution gagnante)'
                                          : isLiveLastStopLossRow
                                            ? 'Stop-loss (live détecté)'
                                            : 'Stop-loss'}
                                      </span>
                                    ) : (
                                      <>
                                        {isBacktestPendingResolution && (
                                          <span className="strat-muted">en attente de résolution backtest</span>
                                        )}
                                        {r.botWon === true && <span className="strat-sim-won">Gagné</span>}
                                        {r.botWon === false && <span className="strat-sim-lost">Perdu</span>}
                                        {r.botWon == null &&
                                          (r.winner === null ? (
                                            <span className="strat-muted">En attente</span>
                                          ) : (
                                            <span className="strat-muted">{unavailableLabel}</span>
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
                        <strong>{backtestResult15m.withSignal.length}</strong> entrée(s) dans la bande backtest{' '}
                        <strong>
                          {signalMinC}–{signalMaxC} %
                        </strong>{' '}
                        (CLOB + trades + complément 1−p, stop-loss hybride si activé). SL simulé :{' '}
                        <strong>proxy best bid</strong> (mid historique − offset, comme l’ordre de grandeur du bid vs mid côté bot ; pas d’historique bid tick par tick). Lien direct :{' '}
                        <code className="strat-code-inline">
                          ?windowDays=30&amp;signalMin=77&amp;signalMax=78&amp;sl=58
                        </code>
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
                        disabled={resolved15mLoading}
                        className={`btn btn--default btn--outline strat-window-btn ${backtestWindowDays === 3 ? 'strat-window-btn--active' : ''}`}
                        title="3 derniers jours (72 h)"
                      >
                        3 jours
                      </button>
                      <button
                        type="button"
                        onClick={() => setBacktestWindowDays(7)}
                        disabled={resolved15mLoading}
                        className={`btn btn--default btn--outline strat-window-btn ${backtestWindowDays === 7 ? 'strat-window-btn--active' : ''}`}
                        title="7 derniers jours (168 h)"
                      >
                        7 jours
                      </button>
                      <button
                        type="button"
                        onClick={() => setBacktestWindowDays(30)}
                        disabled={resolved15mLoading}
                        className={`btn btn--default btn--outline strat-window-btn ${backtestWindowDays === 30 ? 'strat-window-btn--active' : ''}`}
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
