import { useState, useEffect, useRef, useMemo } from 'react';
import { useBitcoinUpDownSignals } from '../hooks/useBitcoinUpDownSignals';
import { useBitcoinUpDownResolved } from '../hooks/useBitcoinUpDownResolved';
import { useBitcoinUpDownResolved15m } from '../hooks/useBitcoinUpDownResolved15m';
import { useOrderBookLiquidity } from '../hooks/useOrderBookLiquidity';
import { useBotStatus, DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M } from '../hooks/useBotStatus';
import { useWallet } from '../context/useWallet';
import { placePolymarketOrder } from '../lib/polymarketOrder';
import { ORDER_BOOK_SIGNAL_MAX_P, ORDER_BOOK_SIGNAL_MIN_P } from '../lib/orderBookLiquidity.js';
import { build15mBacktestDisplayRows, SLOT_15M_SEC } from '../lib/bitcoin15mGridDisplay.js';
import {
  formatBitcoin15mSlotRangeEt,
  formatTradeTimestampEt,
  formatTimestampUtcTooltip,
} from '../lib/polymarketDisplayTime.js';

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

/** Slug Polymarket du créneau 15 min actuel (btc-updown-15m-{timestamp} fin de créneau en s UTC). */
function getCurrent15mEventSlug() {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotEnd = Math.ceil(nowSec / SLOT_15M_SEC) * SLOT_15M_SEC;
  return `btc-updown-15m-${slotEnd}`;
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
  const [resultMode, setResultMode] = useState('hourly'); // 'hourly' | '15m' — avant les signaux (mode fetch)
  const { signals } = useBitcoinUpDownSignals(resultMode === '15m' ? '15m' : 'hourly');
  const currentSignalTokenId = signals?.[0]?.tokenIdToBuy ?? null;
  const { liquidityUsd: liquidityAtTargetUsd, loading: liquidityLoading, error: liquidityError, refresh: refreshLiquidity } = useOrderBookLiquidity(currentSignalTokenId);
  const { data: botStatusData } = useBotStatus(DEFAULT_BOT_STATUS_URL);
  const { data: botStatusData15m } = useBotStatus(DEFAULT_BOT_STATUS_URL_15M);
  const liquidityStats = botStatusData?.liquidityStats ?? null;

  const [extraDays, setExtraDays] = useState(0); // 0 = 3 jours, 1..4 = 4 à 7 jours
  const [includeFees, setIncludeFees] = useState(true);
  const [backtest15mDebug, setBacktest15mDebug] = useState(readBacktest15mDebugFromStorage);
  const resolvedWindowHours = 72 + extraDays * 24;
  const resolvedDaysCount = 3 + extraDays;
  const { resolved: resolvedHours, loading: resolvedLoading, error: resolvedError, refresh: refreshResolved } = useBitcoinUpDownResolved(resolvedWindowHours);
  const {
    resolved: resolved15m,
    loading: resolved15mLoading,
    error: resolved15mError,
    refresh: refreshResolved15m,
    debugSummary: resolved15mDebugSummary,
  } = useBitcoinUpDownResolved15m(resolvedWindowHours, { debug: backtest15mDebug });

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
        delta = -stake - feeUsd;
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
    /** Créneaux où la simu 15m a trouvé une entrée (≥ 97 %, plafond ~99,5 % sur timeseries CLOB ; bot réel ~97,5 %). */
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
        delta = -stake - feeUsd;
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
    };
  }, [resolved15m, initialBalance, includeFees]);

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
    /** Plafond 97,5¢ comme le backtest / carnet « signal », même si le best ask affiche 98–99¢. */
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
    if (signals?.[0] && getSignalKey(signal) === getSignalKey(signals[0])) return liquidityAtTargetUsd;
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

  // Le bot place l'ordre à ta place dès qu'un signal 97–97,5 % apparaît
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
              <p className="strat-hero-sub">Signal 97–97,5 % · Horaires &amp; 15 min · FOK</p>
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
                  Signaux 97–97,5 % visent ≥ 4 % de gain par trade (achat à 95¢, gain 5¢)
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
                  <strong>ON</strong> = un ordre part tout seul dès qu’un signal 97–97,5 % apparaît (
                  {resultMode === '15m' ? '15 min' : 'horaire'}
                  ). <strong>OFF</strong> = jamais d’ordre auto (tu peux trader à la main). Wallet Polygon requis pour
                  l’auto.
                </p>
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
                  title="Afficher le panneau liquidité 97–97,5 % sous la stratégie"
                >
                  Liquidité {showLiquiditySuggestion ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          </div>

          {showLiquiditySuggestion && (currentSignalTokenId || liquidityAtTargetUsd != null) && (
            <div className="strat-data-window strat-data-window--nested">
              <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ width: 2, height: 16, borderRadius: 999, background: 'rgba(0,255,136,0.6)' }} aria-hidden />
                Taille max suggérée (FOK ≤ 97,5c)
              </h3>
              <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, lineHeight: 1.5 }}>
                Liquidité disponible à 97–97,5 % sur le créneau actuel. La mise est <strong>plafonnée automatiquement</strong> à ce montant (dashboard et bot) pour ne pas dépasser 97,5c.
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
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Aucune liquidité à 97–97,5 % pour l’instant.</span>
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
            Simulation alignée sur le bot (97–97,5 %, marché){' '}
            {resultMode === 'hourly'
              ? '— pas d’entrée dans les 5 dernières minutes du créneau.'
              : '— 15 min : pas d’entrée les 3 premières minutes UTC de chaque quart d’heure ni les 4 dernières avant la fin (aligné exécution prudente).'}{' '}
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
                      Même règles que le bot : prix dans 97–97,5 % et pas d&apos;entrée dans les 5 dernières minutes du créneau. Le WR reflète ce que le bot aurait fait avec l&apos;historique CLOB. En live le bot voit le prix à chaque cycle (1 s) et en WebSocket ; il peut rater une fenêtre très courte entre deux mises à jour.
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
                        <strong>{withSimul.length}</strong> créneaux avec signal 97–97,5 % · Données historiques CLOB.
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
                      Simu 15m : <code>prices-history</code> CLOB ≈ <strong>mid</strong> (~50 %) ; exécutions via <strong>Data API</strong> (<code>asset</code> / <code>asset_id</code>, <code>outcome</code>). Filtre créneau ≈ <strong>fin − 30 min → fin + 10 min</strong> (15m + marge 15m + padding 10m). Entrées interdites par <strong>quart d’heure Eastern (ET)</strong> : pas les <strong>3 premières</strong> ni les <strong>4 dernières</strong> minutes de chaque bloc :00–:15–:30–:45 (comme l’heure affichée du trade). Conviction ≥ 97 % jusqu’à 1,00, complément <strong>1 − p</strong>. Signaux live 15m : même grille ET. Bot live : <strong>carnet / WS</strong> (cooldown ouverture + fin de créneau alignés).
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
                                    {r.botWon === true && <span className="strat-sim-won">Gagné</span>}
                                    {r.botWon === false && <span className="strat-sim-lost">Perdu</span>}
                                    {r.botWon == null && (r.winner === null ? <span className="strat-muted">En attente</span> : <span className="strat-muted">Données indisponibles</span>)}
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
                        <strong>{backtestResult15m.withSignal.length}</strong> entrée(s) ≥ 97 % (simu CLOB + trades + complément 1−p).
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
