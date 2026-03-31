import { useState, useEffect, useMemo } from 'react';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { use15mMiseMaxBookAvg } from '@/hooks/use15mMiseMaxBookAvg.js';
import { MiseMax15mOrderBookDepth } from '@/components/MiseMax15mOrderBookDepth.jsx';
import { TradeHistory } from '@/components/TradeHistory.jsx';
import { formatBitcoin15mSlotRangeEt, formatLiveClockEt, formatSlotEndEt } from '@/lib/polymarketDisplayTime.js';
import {
  is15mSlotEntryTimeForbiddenWithWindows,
  normalizeForbidWindowMinutes,
} from '@/lib/bitcoin15mSlotEntryTiming.js';
import {
  ORDER_BOOK_MARKET_WORST_P,
  ORDER_BOOK_SIGNAL_MAX_P,
  ORDER_BOOK_SIGNAL_MIN_P,
} from '@/lib/orderBookLiquidity.js';
import { readLatencyModeFromStorage, writeLatencyModeToStorage } from '@/lib/dashboardUiPrefs.js';
import { useWallet } from '@/context/useWallet.js';
import { resolveTradeHistoryAddress } from '@/lib/tradeHistoryAddress.js';
import { sumManualTopupUsd } from '@/lib/tradeHistoryManualTopups.js';
import { useBridgeDeposits } from '@/hooks/useBridgeDeposits.js';
import { useManualTopupEntries } from '@/hooks/useManualTopupEntries.js';

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)} $`;
}

function formatWalletShort(addr) {
  if (!addr || typeof addr !== 'string' || addr.length < 12) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

function encodeUsdcBalanceOf(address) {
  const a = String(address || '').replace(/^0x/, '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(a)) return null;
  return `0x70a08231${a.padStart(64, '0')}`;
}

function hexUsdcToFloat(hexValue) {
  const h = String(hexValue || '').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(h)) return null;
  try {
    const bn = BigInt(h);
    const n = Number(bn) / 1_000_000;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function formatAskCents(p) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  const c = Number(p) * 100;
  const s = c < 10 ? c.toFixed(2) : c.toFixed(1);
  return `${s}¢`;
}

function formatCountdownRemaining(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec <= 0) return '0 s';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 1) return `${m} min ${s}s`;
  return `${s} s`;
}

function formatSignedUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)} $`;
}

function formatTimeHmsMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatSecondsAgo(iso, nowMs) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const baseNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sec = Math.max(0, Math.floor((baseNowMs - t) / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return `${m} min`;
}

function pickLiveBestAskP(liveP, bandP) {
  if (Number.isFinite(Number(liveP))) return Number(liveP);
  if (Number.isFinite(Number(bandP))) return Number(bandP);
  return null;
}

function isPriceInSignalBand(p) {
  if (p == null || !Number.isFinite(Number(p))) return false;
  const n = Number(p);
  return n >= ORDER_BOOK_SIGNAL_MIN_P && n <= ORDER_BOOK_SIGNAL_MAX_P;
}

/**
 * Variation relative du solde **bot** (même source que `balanceHistory` / `balance.json`).
 * Ne pas passer le solde wallet on-chain ici : les relevés historiques sont des snapshots CLOB/bot, pas l’USDC chaîne.
 * @returns {{ pct: number, window: 'rolling24h' | 'sinceFirst' } | null}
 */
function computePnl(balanceHistory, currentBalance, nowMs = Date.now()) {
  const history = Array.isArray(balanceHistory) ? balanceHistory : [];
  if (!history.length) return null;
  const sorted = [...history]
    .filter((p) => p && p.at != null && Number.isFinite(Number(p.balance)))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (!sorted.length) return null;

  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = nowMs - windowMs;
  const lastBalance =
    currentBalance != null ? Number(currentBalance) : Number(sorted[sorted.length - 1].balance);
  if (!Number.isFinite(lastBalance)) return null;

  const beforeOrAtCutoff = sorted.filter((p) => new Date(p.at).getTime() <= cutoff);
  /** `rolling24h` : dernier relevé au plus à il y a 24h. `sinceFirst` : historique entièrement plus récent → pas d’ancre 24h. */
  let baseline;
  let window;
  if (beforeOrAtCutoff.length) {
    baseline = Number(beforeOrAtCutoff[beforeOrAtCutoff.length - 1].balance);
    window = 'rolling24h';
  } else {
    baseline = Number(sorted[0].balance);
    window = 'sinceFirst';
  }

  const MIN_BASELINE_USD = 1;
  if (!Number.isFinite(baseline) || baseline < MIN_BASELINE_USD) {
    const firstUsable = sorted.find((p) => Number(p.balance) >= MIN_BASELINE_USD);
    baseline = firstUsable ? Number(firstUsable.balance) : null;
  }
  if (!(Number.isFinite(baseline) && baseline > 0)) return null;

  const pct = ((lastBalance - baseline) / baseline) * 100;
  return { pct, window };
}

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL;
  const statusUrl15m = DEFAULT_BOT_STATUS_URL_15M;
  const { address: walletAddress } = useWallet();
  const { data } = useBotStatus(statusUrl);
  const { data: data15m } = useBotStatus(statusUrl15m);
  /** Persisté (localStorage) ; 15m seulement si URL bot 15m configurée. */
  const [latencyMode, setLatencyMode] = useState(() =>
    readLatencyModeFromStorage(Boolean(DEFAULT_BOT_STATUS_URL_15M), Boolean(DEFAULT_BOT_STATUS_URL)),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    writeLatencyModeToStorage(latencyMode);
  }, [latencyMode]);

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const orders24h15m = data15m?.ordersLast24h ?? null;
  const pnl = computePnl(data?.balanceHistory, balance, nowMs);
  const funder15m = data15m?.lastOrder?.clobFunderAddress ?? null;
  const signer15m = data15m?.lastOrder?.clobSignerAddress ?? null;
  const [walletUsdc15m, setWalletUsdc15m] = useState(null);
  const [walletUsdcAt, setWalletUsdcAt] = useState(null);
  const [upInBandSince, setUpInBandSince] = useState(null);
  const [downInBandSince, setDownInBandSince] = useState(null);
  const preferredWalletAddress = useMemo(() => {
    const envAddr = String(import.meta.env.VITE_TRADE_HISTORY_ADDRESS || '').trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(envAddr)) return envAddr;
    if (typeof funder15m === 'string' && /^0x[a-fA-F0-9]{40}$/.test(funder15m)) return funder15m;
    return null;
  }, [funder15m]);

  useEffect(() => {
    let cancelled = false;
    async function fetchWalletUsdc() {
      if (!preferredWalletAddress) {
        if (!cancelled) {
          setWalletUsdc15m(null);
          setWalletUsdcAt(null);
        }
        return;
      }
      const data = encodeUsdcBalanceOf(preferredWalletAddress);
      if (!data) return;
      const rpcUrls = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'];
      for (const url of rpcUrls) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_call',
              params: [{ to: USDC_E_POLYGON, data }, 'latest'],
            }),
          });
          if (!res.ok) continue;
          const json = await res.json();
          const v = hexUsdcToFloat(json?.result);
          if (v == null) continue;
          if (!cancelled) {
            setWalletUsdc15m(v);
            setWalletUsdcAt(new Date().toISOString());
          }
          return;
        } catch {
          // try next RPC
        }
      }
      if (!cancelled) {
        setWalletUsdc15m(null);
      }
    }

    fetchWalletUsdc();
    const id = setInterval(fetchWalletUsdc, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [preferredWalletAddress]);

  /** Même source que la carte « Solde 15 Min » (wallet USDC.e si dispo, sinon balance status). */
  const displayedBalance15m = walletUsdc15m != null ? walletUsdc15m : balance15m;

  const tradeLatencyStats = data?.tradeLatencyStats ?? null;
  const tradeLatencyStats15m = data15m?.tradeLatencyStats ?? null;
  const hasTradeLatencyStats = (tradeLatencyStats?.all?.count ?? 0) > 0;
  const hasTradeLatencyStats15m = (tradeLatencyStats15m?.all?.count ?? 0) > 0;
  const tradeLatencyBreakdownStats = data?.tradeLatencyBreakdownStats ?? null;
  const tradeLatencyBreakdownStats15m = data15m?.tradeLatencyBreakdownStats ?? null;
  const cycleLatencyStats = data?.cycleLatencyStats ?? null;
  const cycleLatencyStats15m = data15m?.cycleLatencyStats ?? null;
  const hasCycleLatencyStats = (cycleLatencyStats?.count ?? 0) > 0;
  const hasCycleLatencyStats15m = (cycleLatencyStats15m?.count ?? 0) > 0;
  const signalDecisionLatencyStats = data?.signalDecisionLatencyStats ?? null;
  const signalDecisionLatencyStats15m = data15m?.signalDecisionLatencyStats ?? null;
  const hasSignalDecisionLatencyStats = (signalDecisionLatencyStats?.all?.count ?? 0) > 0;
  const hasSignalDecisionLatencyStats15m = (signalDecisionLatencyStats15m?.all?.count ?? 0) > 0;
  const show15m = !!statusUrl15m;
  const showStatus1h = !!statusUrl;
  /** Sans URL bot 1h, toutes les latences / watch lisent le 15m. */
  const latencySourceMode = !statusUrl && statusUrl15m ? '15m' : latencyMode;

  /** Funder Polymarket (profil) depuis last-order bot — pour aligner l’historique Data API sur le même compte que le bot. */
  const tradeHistoryBotFunders = useMemo(
    () =>
      [data15m?.lastOrder?.clobFunderAddress, data?.lastOrder?.clobFunderAddress].filter(
        (x) => typeof x === 'string' && x.startsWith('0x'),
      ),
    [data15m?.lastOrder?.clobFunderAddress, data?.lastOrder?.clobFunderAddress],
  );

  const historyAddressTradePnl = useMemo(
    () =>
      resolveTradeHistoryAddress({
        connectedAddress: walletAddress,
        botFunderCandidates: tradeHistoryBotFunders,
      }).address,
    [walletAddress, tradeHistoryBotFunders],
  );
  const manualEntriesForPnl = useManualTopupEntries(historyAddressTradePnl);
  const { totalApproxUsdc: bridgeTotalForPnl } = useBridgeDeposits(historyAddressTradePnl);
  const manualAdjustmentPnl = useMemo(() => sumManualTopupUsd(manualEntriesForPnl), [manualEntriesForPnl]);
  const capitalIn15m = manualAdjustmentPnl + (Number(bridgeTotalForPnl) || 0);
  const netPnl15mVsDeposits = useMemo(() => {
    if (!show15m || !historyAddressTradePnl) return null;
    const b = Number(displayedBalance15m);
    if (!Number.isFinite(b)) return null;
    return b - (Number(bridgeTotalForPnl) || 0) - manualAdjustmentPnl;
  }, [show15m, historyAddressTradePnl, displayedBalance15m, bridgeTotalForPnl, manualAdjustmentPnl]);
  const pnl15mRoiPct =
    netPnl15mVsDeposits != null && capitalIn15m > 0
      ? (netPnl15mVsDeposits / capitalIn15m) * 100
      : null;

  const {
    avgUsd: miseMaxAvg15m,
    minUsd: miseMaxMin15m,
    maxUsd: miseMaxMax15m,
    medianUsd: miseMaxMedian15m,
    sampleSize: miseMaxSample15m,
    currentSlotMiseMaxUsd: miseMaxCurrent15m,
    loading: miseMax15mLoading,
    error: miseMax15mError,
    lastAt: miseMax15mLastAt,
    refresh: refreshMiseMax15m,
    currentSlotBookAsksUp: miseMax15mBookAsksUp,
    currentSlotBookAsksDown: miseMax15mBookAsksDown,
    lastResolved15mSlot: miseMaxLastResolved15mSlot,
    currentSlotEndSec: miseMaxSlotEndSec,
    slotMarketOpen: miseMaxSlotOpen,
    liquidityBandUpUsd: miseMaxLiqBandUp,
    liquidityBandDownUsd: miseMaxLiqBandDown,
    bestAskUpP: miseMaxBestAskUp,
    bestAskDownP: miseMaxBestAskDown,
    bestAskLiveUpP: miseMaxBestAskLiveUp,
    bestAskLiveDownP: miseMaxBestAskLiveDown,
    bestBidLiveUpP: miseMaxBestBidLiveUp,
    bestBidLiveDownP: miseMaxBestBidLiveDown,
    levelsBandUp: miseMaxLevelsBandUp,
    levelsBandDown: miseMaxLevelsBandDown,
    liquidityToWorstUpUsd: miseMaxLiqWorstUp,
    liquidityToWorstDownUsd: miseMaxLiqWorstDown,
  } = use15mMiseMaxBookAvg({ enabled: show15m, slotCount: 36, staggerMs: 45 });

  const [miseMaxNowSec, setMiseMaxNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!show15m) return undefined;
    const id = setInterval(() => setMiseMaxNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [show15m]);

  const miseMaxSecLeft =
    miseMaxSlotEndSec != null && Number.isFinite(miseMaxSlotEndSec)
      ? miseMaxSlotEndSec - miseMaxNowSec
      : null;
  /** Aligné sur le bot : API bot-status puis Vite puis défaut 0/0 (même logique que `normalizeForbidWindowMinutes`). */
  const live15mForbidWindowSec = useMemo(() => {
    const apiF = data15m?.entryForbiddenFirstMin;
    const apiL = data15m?.entryForbiddenLastMin;
    const envF = import.meta.env.VITE_ENTRY_FORBIDDEN_FIRST_MIN;
    const envL = import.meta.env.VITE_ENTRY_FORBIDDEN_LAST_MIN;
    const f =
      apiF != null && Number.isFinite(Number(apiF))
        ? Number(apiF)
        : envF !== undefined && String(envF).trim() !== '' && Number.isFinite(Number(envF))
          ? Number(envF)
          : NaN;
    const l =
      apiL != null && Number.isFinite(Number(apiL))
        ? Number(apiL)
        : envL !== undefined && String(envL).trim() !== '' && Number.isFinite(Number(envL))
          ? Number(envL)
          : NaN;
    return normalizeForbidWindowMinutes(f, l);
  }, [data15m?.entryForbiddenFirstMin, data15m?.entryForbiddenLastMin]);
  const miseMaxEntryForbiddenEt = useMemo(() => {
    if (!Number.isFinite(nowMs)) return false;
    return is15mSlotEntryTimeForbiddenWithWindows(
      Math.floor(nowMs / 1000),
      live15mForbidWindowSec.forbidFirstSec,
      live15mForbidWindowSec.forbidLastSec,
    );
  }, [nowMs, live15mForbidWindowSec]);
  const miseMaxForbidFirstMinUi = Math.round(live15mForbidWindowSec.forbidFirstSec / 60);
  const miseMaxForbidLastMinUi = Math.round(live15mForbidWindowSec.forbidLastSec / 60);
  const miseMaxBookAge = formatSecondsAgo(miseMax15mLastAt, nowMs);
  const botLiqSignalUsd =
    data15m?.liquidityStats24h?.lastUsd ?? data15m?.liquidityStats?.lastUsd ?? null;
  const botLiqSignalAt = data15m?.liquidityStats24h?.lastAt ?? data15m?.liquidityStats?.lastAt ?? null;
  const signalMinPct = (ORDER_BOOK_SIGNAL_MIN_P * 100).toFixed(0);
  const signalMaxPct = (ORDER_BOOK_SIGNAL_MAX_P * 100).toFixed(1).replace(/\.0$/, '');
  const worstPct = (ORDER_BOOK_MARKET_WORST_P * 100).toFixed(0);
  const miseMaxComparedOutcome =
    miseMaxLiqBandUp == null || miseMaxLiqBandDown == null
      ? null
      : miseMaxLiqBandUp >= miseMaxLiqBandDown
        ? 'Up'
        : 'Down';
  const miseMaxSnapshotAt = formatTimeHmsMs(miseMax15mLastAt);
  const bestAskDeltaUp =
    Number.isFinite(Number(miseMaxBestAskUp)) && Number.isFinite(Number(miseMaxBestAskLiveUp))
      ? Math.abs(Number(miseMaxBestAskUp) - Number(miseMaxBestAskLiveUp))
      : null;
  const bestAskDeltaDown =
    Number.isFinite(Number(miseMaxBestAskDown)) && Number.isFinite(Number(miseMaxBestAskLiveDown))
      ? Math.abs(Number(miseMaxBestAskDown) - Number(miseMaxBestAskLiveDown))
      : null;
  // 0.15c de tolérance visuelle (0.0015 en probabilité).
  const BEST_ASK_DELTA_OK_P = 0.0015;
  const bestAskUpAligned = bestAskDeltaUp != null ? bestAskDeltaUp <= BEST_ASK_DELTA_OK_P : null;
  const bestAskDownAligned = bestAskDeltaDown != null ? bestAskDeltaDown <= BEST_ASK_DELTA_OK_P : null;

  const activeLatency = latencySourceMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  /** Dernier ordre mesuré : WS ou poll (souvent poll si placement via boucle principale, pas le handler WS). */
  const lastTradeLatency = useMemo(() => {
    if (!activeLatency) return null;
    const ws = activeLatency.ws;
    const poll = activeLatency.poll;
    const wsMs = Number(ws?.lastLatencyMs);
    const pollMs = Number(poll?.lastLatencyMs);
    const wsT = ws?.lastLatencyAt ? new Date(ws.lastLatencyAt).getTime() : NaN;
    const pollT = poll?.lastLatencyAt ? new Date(poll.lastLatencyAt).getTime() : NaN;
    const wsOk = Number.isFinite(wsMs) && wsMs > 0 && Number.isFinite(wsT);
    const pollOk = Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(pollT);
    if (!wsOk && !pollOk) return null;
    if (wsOk && !pollOk) return { ms: wsMs, source: 'ws', at: ws.lastLatencyAt };
    if (!wsOk && pollOk) return { ms: pollMs, source: 'poll', at: poll.lastLatencyAt };
    return wsT >= pollT
      ? { ms: wsMs, source: 'ws', at: ws.lastLatencyAt }
      : { ms: pollMs, source: 'poll', at: poll.lastLatencyAt };
  }, [activeLatency]);
  const hasActiveLatency = latencySourceMode === '15m' ? hasTradeLatencyStats15m : hasTradeLatencyStats;
  const activeLatencyBreakdown = latencySourceMode === '15m' ? tradeLatencyBreakdownStats15m : tradeLatencyBreakdownStats;
  const activeCycleLatency = latencySourceMode === '15m' ? cycleLatencyStats15m : cycleLatencyStats;
  const hasActiveCycleLatency = latencySourceMode === '15m' ? hasCycleLatencyStats15m : hasCycleLatencyStats;
  const activeSignalDecisionLatency = latencySourceMode === '15m' ? signalDecisionLatencyStats15m : signalDecisionLatencyStats;
  const hasActiveSignalDecisionLatency = latencySourceMode === '15m' ? hasSignalDecisionLatencyStats15m : hasSignalDecisionLatencyStats;
  const activeStatus = latencySourceMode === '15m' ? data15m : data;
  const activeAlerts = Array.isArray(activeStatus?.alerts) ? activeStatus.alerts : [];
  const hasPolymarketDelayRisk = activeAlerts.some((a) => ['polymarket_degraded', 'stale_ws_data', 'execution_delayed'].includes(String(a?.kind)));
  const activeNoOrderEvents = Array.isArray(activeStatus?.signalInRangeNoOrderRecent)
    ? activeStatus.signalInRangeNoOrderRecent
    : [];
  const signalLiveUpP = pickLiveBestAskP(miseMaxBestAskLiveUp, miseMaxBestAskUp);
  const signalLiveDownP = pickLiveBestAskP(miseMaxBestAskLiveDown, miseMaxBestAskDown);
  const signalLiveUpInBand = isPriceInSignalBand(signalLiveUpP);
  const signalLiveDownInBand = isPriceInSignalBand(signalLiveDownP);

  const DWELL_SEC = Number(import.meta.env.VITE_BACKTEST_SIGNAL_MIN_DWELL_SEC || 5);

  useEffect(() => {
    if (signalLiveUpInBand) {
      if (!upInBandSince) {
        const timer = setTimeout(() => setUpInBandSince(Date.now()), 0);
        return () => clearTimeout(timer);
      }
    } else if (upInBandSince) {
      const timer = setTimeout(() => setUpInBandSince(null), 0);
      return () => clearTimeout(timer);
    }
  }, [signalLiveUpInBand, upInBandSince]);

  useEffect(() => {
    if (signalLiveDownInBand) {
      if (!downInBandSince) {
        const timer = setTimeout(() => setDownInBandSince(Date.now()), 0);
        return () => clearTimeout(timer);
      }
    } else if (downInBandSince) {
      const timer = setTimeout(() => setDownInBandSince(null), 0);
      return () => clearTimeout(timer);
    }
  }, [signalLiveDownInBand, downInBandSince]);

  const upDwellElapsed = upInBandSince ? (nowMs - upInBandSince) / 1000 : 0;
  const downDwellElapsed = downInBandSince ? (nowMs - downInBandSince) / 1000 : 0;
  const upConfirmed = signalLiveUpInBand && upDwellElapsed >= DWELL_SEC;
  const downConfirmed = signalLiveDownInBand && downDwellElapsed >= DWELL_SEC;
  const activeLastSkip = activeStatus?.health?.lastSkipReason ?? null;
  const activeLastSkipSource = activeStatus?.health?.lastSkipSource ?? null;
  const activeLastSkipAt = activeStatus?.health?.lastSkipAt ?? null;
  const activeLastSkipAge = formatSecondsAgo(activeLastSkipAt, nowMs);
  const activeLastSkipDetails = activeStatus?.health?.lastSkipDetails ?? null;
  const activeLastSkipTimingBlock =
    activeLastSkip === 'timing_forbidden' && activeLastSkipDetails?.timingBlock
      ? String(activeLastSkipDetails.timingBlock)
      : null;
  const activeLastSkipTimingSuffix =
    activeLastSkipTimingBlock === 'first_6min'
      ? ' · début quart ET'
      : activeLastSkipTimingBlock === 'last_4min'
        ? ' · fin quart ET'
        : activeLastSkipTimingBlock
          ? ` · ${activeLastSkipTimingBlock}`
          : '';

  const lastTimingForbiddenSkip = activeStatus?.health?.lastTimingForbiddenSkip ?? null;
  const lastTfAt = lastTimingForbiddenSkip?.at ?? null;
  const lastTfAge = formatSecondsAgo(lastTfAt, nowMs);
  const lastTfSource = lastTimingForbiddenSkip?.source ?? null;
  const lastTfDetails = lastTimingForbiddenSkip?.details ?? null;
  const lastTfBlock =
    lastTfDetails?.timingBlock != null ? String(lastTfDetails.timingBlock) : null;
  const lastTfTimingSuffix =
    lastTfBlock === 'first_6min'
      ? ' · début quart ET'
      : lastTfBlock === 'last_4min'
        ? ' · fin quart ET'
        : lastTfBlock
          ? ` · ${lastTfBlock}`
          : '';
  /** Évite doublon si le « dernier skip » global est déjà le même événement timing. */
  const showDedicatedTimingSkipRow =
    lastTimingForbiddenSkip != null &&
    !(activeLastSkip === 'timing_forbidden' && activeLastSkipAt === lastTfAt);

  const skipReasonLabels = {
    /** Pas la « fenêtre » 97–98¢ : règle début/fin de quart d’heure en heure ET (comme le bot). */
    timing_forbidden: 'Entrée interdite (timing ET)',
    degraded_mode: 'Mode incident',
    ws_stale: 'WS stale / mismatch REST',
    cooldown_active: 'Cooldown exécution actif',
    amount_below_min: 'Montant sous minimum',
    amount_zero_after_clamp: 'Montant nul après clamp solde',
    ws_price_out_of_window: 'Prix hors fenêtre signal',
    already_placed_for_slot: 'Déjà placé sur ce créneau',
  };
  const activeLastSkipLabel = activeLastSkip ? (skipReasonLabels[activeLastSkip] ?? activeLastSkip) : null;
  const noOrderReasonLabels = {
    order_placed: 'Signal: Ordre marché placé',
    timing_forbidden: 'Entrée interdite (timing ET)',
    cooldown_active: 'Cooldown',
    degraded_mode_pause: 'Mode incident',
    ws_stale_rest_invalid: 'WS stale (REST invalide)',
    ws_stale_rest_mismatch: 'WS stale (mismatch REST)',
    amount_below_min: 'Montant sous minimum',
    amount_zero_after_clamp: 'Montant nul après clamp solde',
    place_order_failed: "Echec placement d'ordre",
    already_placed_for_slot: 'Déjà placé sur ce créneau',
    clob_creds: 'Erreur creds CLOB',
    ws_price_out_of_window: 'Prix hors fenêtre',
    auto_place_disabled: 'Autotrade désactivé',
    kill_switch: 'Kill switch',
    wallet_not_configured: 'Wallet non configuré',
    stop_loss_price: 'SL touché (best bid < seuil)',
    stop_loss_drawdown: 'SL touché (drawdown max)',
  };

  const activePosition15m = useMemo(() => {
    const last = data15m?.lastOrder;
    if (!last || typeof last !== 'object') return null;
    if (last.stopLossExit === true) return null;
    const endMs = Number(last.marketEndMs);
    if (!Number.isFinite(endMs) || endMs <= nowMs) return null;
    const side = last.takeSide === 'Up' || last.takeSide === 'Down' ? last.takeSide : null;
    if (!side) return null;

    const entryP = Number(last.averageFillPriceP);
    const entryPriceP = Number.isFinite(entryP) && entryP > 0 ? entryP : null;
    const currentAskRaw = side === 'Up' ? miseMaxBestAskLiveUp ?? miseMaxBestAskUp : miseMaxBestAskLiveDown ?? miseMaxBestAskDown;
    const currentAskP = Number.isFinite(Number(currentAskRaw)) ? Number(currentAskRaw) : null;
    const qtyRaw = Number(last.filledOutcomeTokens);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : null;
    const stakeRaw = Number(last.filledUsdc ?? last.amountUsd);
    const stakeUsd = Number.isFinite(stakeRaw) && stakeRaw > 0 ? stakeRaw : null;
    const entryValue = qty != null && entryPriceP != null ? qty * entryPriceP : stakeUsd;
    const markValue = qty != null && currentAskP != null ? qty * currentAskP : null;
    const unrealizedUsd =
      markValue != null && entryValue != null && Number.isFinite(markValue) && Number.isFinite(entryValue)
        ? markValue - entryValue
        : null;
    const unrealizedPct =
      unrealizedUsd != null && entryValue != null && entryValue > 0
        ? (unrealizedUsd / entryValue) * 100
        : null;
    const remainingSec = Math.max(0, Math.floor((endMs - nowMs) / 1000));

    return {
      side,
      remainingSec,
      entryPriceP,
      currentAskP,
      stakeUsd,
      unrealizedUsd,
      unrealizedPct,
    };
  }, [
    data15m?.lastOrder,
    nowMs,
    miseMaxBestAskLiveUp,
    miseMaxBestAskUp,
    miseMaxBestAskLiveDown,
    miseMaxBestAskDown,
  ]);

  /** Seuil SL exposé par le bot (API) — même comparaison que le bot : best bid < seuil. */
  const botSlTriggerP = useMemo(() => {
    const p = data15m?.stopLossTriggerPriceP;
    if (p == null || !Number.isFinite(Number(p))) return null;
    return Number(p);
  }, [data15m?.stopLossTriggerPriceP]);

  /** Carnet navigateur : bids Up/Down vs seuil — visible même sans position (pas de ligne `stop_loss_touched_watch` dans bot.log). */
  const slZoneCarnetLive = useMemo(() => {
    if (!show15m || botSlTriggerP == null) return null;
    const bu = miseMaxBestBidLiveUp;
    const bd = miseMaxBestBidLiveDown;
    if (bu == null && bd == null) return null;
    const upTouch = bu != null && bu < botSlTriggerP;
    const downTouch = bd != null && bd < botSlTriggerP;
    return { bu, bd, upTouch, downTouch };
  }, [show15m, botSlTriggerP, miseMaxBestBidLiveUp, miseMaxBestBidLiveDown]);

  const bestAskCount = activeLatencyBreakdown?.all?.bestAsk?.count ?? 0;
  const credsCount = activeLatencyBreakdown?.all?.creds?.count ?? 0;
  const balanceCount = activeLatencyBreakdown?.all?.balance?.count ?? 0;
  const bookCount = activeLatencyBreakdown?.all?.book?.count ?? 0;
  const placeOrderCount = activeLatencyBreakdown?.all?.placeOrder?.count ?? 0;
  const hasAnyTradeLatencyBreakdown = [bestAskCount, credsCount, balanceCount, bookCount, placeOrderCount].some((c) => c > 0);

  const activeDecisionReasons = activeSignalDecisionLatency?.reasonCounts ?? null;
  const activeDecisionTotal =
    (activeDecisionReasons?.no_signal ?? 0)
    + (activeDecisionReasons?.liquidity_ok ?? 0)
    + (activeDecisionReasons?.liquidity_null ?? 0)
    + (activeDecisionReasons?.other ?? 0);

  function formatPct(n, total) {
    if (!total || total <= 0) return '—';
    return `${Math.round((n / total) * 100)}%`;
  }

  function formatMs(v) {
    if (v == null) return '—';
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)} ms` : '—';
  }

  function formatCount(v) {
    if (v == null) return '—';
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)}` : '—';
  }

  if (!statusUrl && !statusUrl15m) {
    return (
      <div className="bot-overview-grid">
        <div className="grid-main">
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-label">Statut bot non configuré</div>
            <p className="card-sub" style={{ marginTop: 10, lineHeight: 1.65, maxWidth: 52 * 16 }}>
              Les cartes Solde / PNL / latences viennent du serveur de statut. Définissez au minimum{' '}
              <code style={{ fontSize: 12 }}>VITE_BOT_STATUS_URL_15M=http://VOTRE_IP:3001</code> pour le bot 15m. Pour
              remettre un bot horaire plus tard : <code style={{ fontSize: 12 }}>VITE_BOT_STATUS_URL=...</code> en plus.
              Puis redémarrez <code style={{ fontSize: 12 }}>npm run dev</code>. Voir{' '}
              <code style={{ fontSize: 12 }}>.env.example</code>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bot-overview-grid">
      <div className="grid-main">
        <div className="card">
          <div className="card-label">Solde Horaire</div>
          <div className="card-value green">{showStatus1h && balance != null ? formatUsd(balance) : '—'}</div>
          <div className="card-sub">
            {showStatus1h && data?.at
              ? `${new Date(data.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · 1h`
              : showStatus1h
                ? '— · 1h'
                : 'Pas de bot 1h — ajoutez VITE_BOT_STATUS_URL pour rebrancher'}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Solde 15 Min</div>
          <div className="card-value green">{show15m && displayedBalance15m != null ? formatUsd(displayedBalance15m) : '—'}</div>
          <div className="card-sub">
            {show15m && data15m?.at ? new Date(data15m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'} · 15m
          </div>
          <div className="card-sub">
            Source: {walletUsdc15m != null ? 'wallet on-chain (USDC.e)' : 'status-server (`balance.json`)'} · Wallet: {preferredWalletAddress ? formatWalletShort(preferredWalletAddress) : '—'}
            {walletUsdcAt ? ` · sync ${new Date(walletUsdcAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </div>
          <div className="card-sub">
            Funder bot: {funder15m ? formatWalletShort(funder15m) : '—'}
            {signer15m ? ` · Signer: ${formatWalletShort(signer15m)}` : ''}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Trades enregistrés (24h)</div>
          <div className="overview-two-lines">
            <div>Horaire <span>{orders24h ?? '—'}</span></div>
            <div>15 Min <span>{show15m ? (orders24h15m ?? '—') : '—'}</span></div>
          </div>
          <div className="card-sub" style={{ marginTop: 6 }}>
            Lignes <code>orders.log</code> sur 24 h, hors tentatives stop-loss rejetées (sans exécution). À rapprocher de
            l’historique Polymarket ci-dessous — ce n’est pas le nombre d’ordres encore ouverts sur le carnet.
          </div>
        </div>
      </div>

      <div className="grid-main">
        <div className="card">
          <div className="card-label">
            {pnl?.window === 'sinceFirst' ? 'PNL Horaire (depuis 1er relevé)' : 'PNL Horaire (24h)'}
          </div>
          <div className={`card-value ${showStatus1h && pnl != null ? (pnl.pct >= 0 ? 'green' : 'red') : ''}`}>
            {showStatus1h && pnl != null ? `${pnl.pct >= 0 ? '+' : ''}${pnl.pct.toFixed(1)} %` : '—'}
          </div>
          <div className="card-sub">
            {showStatus1h ? (orders24h ? `${orders24h} ordre(s)` : 'Aucun trade exécuté') : 'Bot horaire non connecté'}
          </div>
        </div>
        <div className="card">
          <div className="card-label">PNL net 15m (vs dépôts)</div>
          <div
            className={`card-value ${netPnl15mVsDeposits != null ? (netPnl15mVsDeposits >= 0 ? 'green' : 'red') : ''}`}
          >
            {show15m && netPnl15mVsDeposits != null ? formatSignedUsd(netPnl15mVsDeposits) : '—'}
          </div>
          {show15m && historyAddressTradePnl && capitalIn15m > 0 && pnl15mRoiPct != null && (
            <div className="card-sub">
              {pnl15mRoiPct >= 0 ? '+' : ''}
              {pnl15mRoiPct.toFixed(1)} % vs capital (manuel + bridge)
            </div>
          )}
          <div className="card-sub">
            {show15m && orders24h15m ? `${orders24h15m} ordre(s)` : 'Aucun trade exécuté'}
            {show15m && historyAddressTradePnl ? (
              <>
                {' '}
                · Même formule que l’historique des trades : solde affiché − dépôts bridge − entrées manuelles.
              </>
            ) : null}
          </div>
          {show15m && !historyAddressTradePnl && (
            <div className="card-sub">Configurez le bot ou l’adresse trades pour lier les dépôts manuels (localStorage).</div>
          )}
        </div>
        <div className="card">
          <div className="card-label">Position 15m en cours</div>
          {activePosition15m ? (
            <>
              <div className={`card-value ${activePosition15m.unrealizedUsd != null ? (activePosition15m.unrealizedUsd >= 0 ? 'green' : 'red') : ''}`}>
                {activePosition15m.unrealizedPct != null ? `${activePosition15m.unrealizedPct >= 0 ? '+' : ''}${activePosition15m.unrealizedPct.toFixed(1)} %` : '—'}
              </div>
              <div className="overview-two-lines">
                <div>
                  Side <span>{activePosition15m.side}</span> · PNL <span>{formatSignedUsd(activePosition15m.unrealizedUsd)}</span>
                </div>
                <div>
                  Entrée <span>{formatAskCents(activePosition15m.entryPriceP)}</span> · Actuel <span>{formatAskCents(activePosition15m.currentAskP)}</span>
                </div>
              </div>
              <div className="card-sub">
                Mise {formatUsd(activePosition15m.stakeUsd)} · fin créneau dans {formatCountdownRemaining(activePosition15m.remainingSec)}
              </div>
            </>
          ) : (
            <>
              <div className="card-value">—</div>
              <div className="card-sub">Aucune position 15m ouverte en ce moment.</div>
            </>
          )}
        </div>
      </div>

      {/* Latences : même grille / mêmes cartes que Solde & Performance */}
      <div className="col-span-full overview-latency-section">
        <div className="overview-latency-heading">
          <div className="section-title overview-latency-section-title">
            <h2>Latences</h2>
            <div className="line" />
          </div>
          {show15m && statusUrl && (
            <div className="overview-toggle" role="group" aria-label="Source latences">
              <button
                type="button"
                onClick={() => setLatencyMode('1h')}
                className={`overview-toggle-btn overview-toggle-btn--hour ${latencyMode === '1h' ? 'overview-toggle-btn--active' : ''}`}
              >
                Horaire
              </button>
              <button
                type="button"
                onClick={() => setLatencyMode('15m')}
                className={`overview-toggle-btn overview-toggle-btn--15m ${latencyMode === '15m' ? 'overview-toggle-btn--active' : ''}`}
              >
                15m
              </button>
            </div>
          )}
          {hasPolymarketDelayRisk && (
            <span className="overview-alert-badge overview-alert-badge--warn">Risque retard Polymarket</span>
          )}
        </div>
        {show15m && (
          <div className="overview-slot-state">
            <div className="mise-max-meta-row mise-max-meta-row--pills">
              <span className="mise-max-meta-label">État</span>
              <span className="mise-max-meta-pills">
                <span
                  className={`mise-max-pill ${miseMaxSlotOpen ? 'mise-max-pill--ok' : 'mise-max-pill--muted'}`}
                >
                  {miseMaxSlotOpen ? 'Créneau ouvert (UTC)' : 'Créneau fermé'}
                </span>
                <span
                  className={`mise-max-pill ${miseMaxEntryForbiddenEt ? 'mise-max-pill--warn' : 'mise-max-pill--ok'}`}
                >
                  {miseMaxEntryForbiddenEt ? 'Entrée interdite (grille ET)' : 'Entrée autorisée (grille ET)'}
                </span>
              </span>
            </div>
          </div>
        )}
        <div className="overview-skip-reason">
          <span className="overview-skip-reason__label">Dernier skip</span>
          <span className="overview-skip-reason__value">
            {activeLastSkipLabel ?? '—'}
            {activeLastSkipTimingSuffix}
            {activeLastSkipSource ? ` · ${String(activeLastSkipSource).toUpperCase()}` : ''}
            {activeLastSkipAge ? ` · il y a ${activeLastSkipAge}` : ''}
          </span>
        </div>
        {showDedicatedTimingSkipRow && (
          <div className="overview-skip-reason overview-skip-reason--timing-secondary">
            <span className="overview-skip-reason__label">Dernier blocage timing (ET)</span>
            <span className="overview-skip-reason__value" title="Conservé même si un autre skip a remplacé « Dernier skip »">
              {skipReasonLabels.timing_forbidden}
              {lastTfTimingSuffix}
              {lastTfSource ? ` · ${String(lastTfSource).toUpperCase()}` : ''}
              {lastTfAge ? ` · il y a ${lastTfAge}` : ''}
            </span>
          </div>
        )}
        <div className="overview-watch-card">
          <div className="overview-watch-card__columns">
            <div className="overview-watch-column">
              <div className="overview-watch-card__title">Signaux Live</div>
              <p className="overview-watch-card__hint">
                <strong>≠ Signaux live</strong> : lignes <code className="overview-watch-code">bot.log</code> côté{' '}
                <strong>serveur</strong> (anti-spam ~5 s). Ordre <strong>chronologique</strong> : le plus récent en haut —
                tu peux enchaîner visuellement (ex. « montant sous minimum » puis, plus tard, « SL touché » si le bot l’a
                loggé). Le <strong>SL le plus récent</strong> reste inclus dans la fenêtre même si beaucoup de no-order
                arrivent entre-temps. La colonne de droite lit le carnet CLOB <strong>depuis ton navigateur</strong>.
              </p>
              {activeNoOrderEvents.length > 0 ? (
                <div className="overview-watch-list">
                  {activeNoOrderEvents.slice(0, 3).map((e, idx) => {
                    const age = formatSecondsAgo(e?.ts, nowMs);
                    const reasonKey = e?.reason != null ? String(e.reason) : '';
                    const reason =
                      reasonKey && noOrderReasonLabels[reasonKey] != null
                        ? noOrderReasonLabels[reasonKey]
                        : reasonKey || 'unknown';
                    const source = e?.source ? String(e.source).toUpperCase() : '—';
                    const side = e?.takeSide ?? '—';
                    const isSlWatch =
                      reasonKey === 'stop_loss_price' ||
                      reasonKey === 'stop_loss_drawdown' ||
                      e?.kind === 'stop_loss_watch';
                    const bestAsk = e?.bestAskP != null ? `${(Number(e.bestAskP) * 100).toFixed(2)}¢` : '—';
                    const bestBid =
                      e?.bestBidP != null && Number.isFinite(Number(e.bestBidP))
                        ? `${(Number(e.bestBidP) * 100).toFixed(2)}¢`
                        : null;
                    const slThr =
                      e?.stopLossTriggerPriceP != null && Number.isFinite(Number(e.stopLossTriggerPriceP))
                        ? `${(Number(e.stopLossTriggerPriceP) * 100).toFixed(0)}¢`
                        : null;
                    const askN = e?.bestAskP != null ? Number(e.bestAskP) : null;
                    const askInSignalBand =
                      askN != null &&
                      Number.isFinite(askN) &&
                      askN >= ORDER_BOOK_SIGNAL_MIN_P &&
                      askN <= ORDER_BOOK_SIGNAL_MAX_P;
                    const timingBandHint =
                      e?.reason === 'timing_forbidden' && askInSignalBand
                        ? ' · bande prix OK, bloqué par timing ET'
                        : '';
                    const timingBlock = e?.timingBlock ? String(e.timingBlock) : null;
                    const timingDetail =
                      e?.reason === 'timing_forbidden' && timingBlock
                        ? ` (${
                            timingBlock === 'first_6min' ||
                            timingBlock === 'first_window'
                              ? 'début'
                              : timingBlock === 'last_4min' || timingBlock === 'last_window'
                                ? 'fin'
                                : timingBlock
                          } quart ET)`
                        : '';
                    return (
                      <div
                        key={`${e?.ts || 'na'}-${idx}-${e?.kind || 'no'}-${e?.fromHealthSnapshot ? 'snap' : ''}${e?.fromHealthEnriched ? 'enr' : ''}`}
                        className="overview-watch-row"
                      >
                        <span className="overview-watch-row__main">
                          {reason}
                          {timingDetail}
                        </span>
                        <span className="overview-watch-row__meta">
                          {source} · {side} ·{' '}
                          {isSlWatch && bestBid != null
                            ? `bid ${bestBid}${slThr != null ? ` · seuil SL ${slThr}` : ''}`
                            : bestAsk}
                          {age ? ` · il y a ${age}` : ''}
                          {timingBandHint}
                          {e?.fromHealthSnapshot ? ' · aligné health.json' : ''}
                          {e?.fromHealthEnriched ? ' · timing complété depuis health' : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="overview-watch-empty">Aucun événement watch récent (no-order / SL).</div>
              )}
              {show15m && slZoneCarnetLive != null && botSlTriggerP != null && (
                <div
                  className="overview-watch-sl-carnet card-sub"
                  style={{ marginTop: 10, lineHeight: 1.55 }}
                  title="Prix de vente (best bid) sur le carnet CLOB — ton navigateur, pas le serveur du bot."
                >
                  <span className="overview-watch-row__main">Zone SL (carnet live · navigateur)</span>
                  <span className="overview-watch-row__meta" style={{ display: 'block', marginTop: 4 }}>
                    Seuil bot {formatAskCents(botSlTriggerP)} · Up bid {formatAskCents(slZoneCarnetLive.bu)} · Down bid{' '}
                    {formatAskCents(slZoneCarnetLive.bd)}
                    {slZoneCarnetLive.upTouch || slZoneCarnetLive.downTouch
                      ? ' · au moins un bid < seuil (prix marché)'
                      : ' · aucun bid sous le seuil'}
                  </span>
                  <span className="card-sub" style={{ display: 'block', marginTop: 6, fontSize: 12, opacity: 0.92 }}>
                    La ligne « SL touché » du panneau (bot.log) n’existe que si le bot a une{' '}
                    <strong>position ouverte</strong>. Sans entrée (ex. montant sous min), tu peux quand même suivre ici si le
                    <strong> bid</strong> du marché passerait le test SL.
                    {activePosition15m ? ' Avec position, la ligne bot et ce carnet se rapprochent.' : ''}
                  </span>
                </div>
              )}
            </div>
            <div className="overview-watch-column overview-watch-column--signal">
              <div className="overview-watch-card__title">Signaux live (CLOB · BTC 15m)</div>
              {!show15m ? (
                <div className="overview-watch-empty">
                  Configure <code className="overview-watch-code">VITE_BOT_STATUS_URL_15M</code> pour afficher le carnet du
                  créneau courant.
                </div>
              ) : miseMax15mError ? (
                <div className="overview-watch-empty">{miseMax15mError}</div>
              ) : miseMax15mLoading && signalLiveUpP == null && signalLiveDownP == null ? (
                <div className="overview-watch-empty">Chargement carnet…</div>
              ) : (
                <>
                  <div
                    className="overview-watch-signal-slot"
                    title="Créneau Polymarket (ET). Heure live = horloge du navigateur en Eastern Time."
                  >
                    <span className="overview-watch-signal-slot__range">
                      {formatBitcoin15mSlotRangeEt(miseMaxSlotEndSec)}
                    </span>
                    <span
                      className="overview-watch-signal-slot__live"
                      title={`UTC (capture) : ${new Date(nowMs).toISOString()}`}
                    >
                      Heure live (ET) : {formatLiveClockEt(nowMs)}
                    </span>
                  </div>
                  {!miseMaxSlotOpen && (
                    <div className="overview-watch-signal-warn">Créneau fermé ou carnet indisponible — valeurs peuvent être vides.</div>
                  )}
                  <div className="overview-watch-signal-row">
                    <span className="overview-watch-signal-side">Up</span>
                    <span className="overview-watch-signal-ask">
                      {formatAskCents(signalLiveUpP)}
                      {signalLiveUpP != null && (
                        <span className={upConfirmed ? 'overview-watch-signal-ok' : signalLiveUpInBand ? 'overview-watch-signal-off' : 'overview-watch-signal-off'}>
                          {upConfirmed 
                            ? ` · OK (Confirmé ${DWELL_SEC}s)` 
                            : signalLiveUpInBand 
                              ? ` · En attente (${Math.floor(upDwellElapsed)}/${DWELL_SEC}s)` 
                              : ' · hors bande signal'}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="overview-watch-signal-row">
                    <span className="overview-watch-signal-side">Down</span>
                    <span className="overview-watch-signal-ask">
                      {formatAskCents(signalLiveDownP)}
                      {signalLiveDownP != null && (
                        <span className={downConfirmed ? 'overview-watch-signal-ok' : signalLiveDownInBand ? 'overview-watch-signal-off' : 'overview-watch-signal-off'}>
                          {downConfirmed 
                            ? ` · OK (Confirmé ${DWELL_SEC}s)` 
                            : signalLiveDownInBand 
                              ? ` · En attente (${Math.floor(downDwellElapsed)}/${DWELL_SEC}s)` 
                              : ' · hors bande signal'}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="overview-watch-signal-meta">
                    Bande prix signal (≠ timing entrée) : {signalMinPct}–{signalMaxPct}¢ · MAJ {miseMaxBookAge ?? '—'}
                    {data15m?.signalPriceSource ? ` · source prix bot 15m: ${data15m.signalPriceSource}` : ''}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid-main overview-latency-grid-main">
        {/* Dernier trade (latence) — WS ou poll selon le dernier enregistrement côté bot */}
        <div className="card latency-kpi-card">
          <div className="card-label">Dernier trade (latence)</div>
          <div className={`card-value ${lastTradeLatency != null ? 'green' : ''}`}>
            {lastTradeLatency != null ? formatMs(lastTradeLatency.ms) : '—'}
          </div>
          <div className="card-sub latency-kpi-card__body">
            {lastTradeLatency != null ? (
              <div className="latency-kpi-card__sub">
                Source : <strong>{lastTradeLatency.source === 'ws' ? 'WebSocket' : 'poll'}</strong>
                {lastTradeLatency.at ? ` · ${formatSecondsAgo(lastTradeLatency.at, nowMs) ?? '—'}` : ''}
              </div>
            ) : hasActiveLatency ? (
              <div className="latency-kpi-card__sub">Pas de latence enregistrée sur les dernières 24 h.</div>
            ) : (
              <div className="latency-kpi-card__sub">Données latence indisponibles.</div>
            )}
            {hasActiveLatency && (activeLatency?.ws?.count ?? 0) + (activeLatency?.poll?.count ?? 0) > 0 && (
              <div className="latency-kpi-card__sub">
                24 h : {activeLatency.ws?.count ?? 0} WS · {activeLatency.poll?.count ?? 0} poll
              </div>
            )}
          </div>
          <span
            className={`latency-card-pill ${
              lastTradeLatency != null ? 'latency-card-pill--ok' : 'latency-card-pill--idle'
            }`}
          >
            {lastTradeLatency != null ? (lastTradeLatency.source === 'ws' ? 'WS' : 'Poll') : 'En attente'}
          </span>
        </div>

          {/* Trade */}
          <div className="card latency-kpi-card">
            <div className="card-label">Trade (24 h)</div>
            <div
              className={`card-value ${hasActiveLatency && activeLatency?.all?.avgMs != null ? 'green' : ''}`}
            >
              {hasActiveLatency && activeLatency?.all?.avgMs != null
                ? `~${Math.round(activeLatency.all.avgMs / 1000)} s`
                : '—'}
            </div>
            <div className="card-sub latency-kpi-card__body">
              {hasActiveLatency && activeLatency?.all?.avgMs != null ? (
                <>
                  <div>
                    Moy {Math.round(activeLatency.all.avgMs)} ms · p95{' '}
                    {activeLatency.all.p95Ms != null ? `${Math.round(activeLatency.all.p95Ms)} ms` : '—'}
                  </div>
                  <div className="latency-kpi-card__sub">
                    {activeLatency.all.count} trade{activeLatency.all.count !== 1 ? 's' : ''}
                    {((activeLatency.ws?.count ?? 0) > 0 || (activeLatency.poll?.count ?? 0) > 0) && (
                      <>
                        {' '}
                        · WS ~{activeLatency.ws?.avgMs != null ? `${Math.round(activeLatency.ws.avgMs)} ms` : '—'} · Poll ~
                        {activeLatency.poll?.avgMs != null ? `${Math.round(activeLatency.poll.avgMs)} ms` : '—'}
                      </>
                    )}
                  </div>
                  <div className="latency-kpi-card__sub">
                    Détails placeOrder :{' '}
                    <span className="overview-num-strong">{activeLatencyBreakdown?.all?.placeOrder?.count ?? 0}</span>{' '}
                    mesures sur 24 h.
                  </div>
                </>
              ) : (
                <>
                  <div>Mesure seulement quand un ordre est placé.</div>
                  <div className="latency-kpi-card__sub">
                    placeOrder : <span className="overview-num-strong">{placeOrderCount}</span> mesures
                  </div>
                </>
              )}
            </div>

            <details className="overview-details latency-kpi-details">
              <summary className="overview-details-summary">Détails (avg · p95)</summary>
              {hasAnyTradeLatencyBreakdown ? (
                <>
                  <div className="overview-details-grid">
                    <div className="overview-details-muted">Étape</div>
                    <div className="overview-details-muted">Avg</div>
                    <div className="overview-details-muted">p95</div>
                    <div className="overview-details-muted">N</div>
                    <div className="overview-details-muted">bestAsk</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.bestAsk?.avgMs)}</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.bestAsk?.p95Ms)}</div>
                    <div className="overview-num-strong">{formatCount(activeLatencyBreakdown?.all?.bestAsk?.count)}</div>
                    <div className="overview-details-muted">creds</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.creds?.avgMs)}</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.creds?.p95Ms)}</div>
                    <div className="overview-num-strong">{formatCount(activeLatencyBreakdown?.all?.creds?.count)}</div>
                    <div className="overview-details-muted">balance</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.balance?.avgMs)}</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.balance?.p95Ms)}</div>
                    <div className="overview-num-strong">{formatCount(activeLatencyBreakdown?.all?.balance?.count)}</div>
                    <div className="overview-details-muted">book</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.book?.avgMs)}</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.book?.p95Ms)}</div>
                    <div className="overview-num-strong">{formatCount(activeLatencyBreakdown?.all?.book?.count)}</div>
                    <div className="overview-details-muted">placeOrder</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.placeOrder?.avgMs)}</div>
                    <div className="overview-num-strong">{formatMs(activeLatencyBreakdown?.all?.placeOrder?.p95Ms)}</div>
                    <div className="overview-num-strong">{formatCount(activeLatencyBreakdown?.all?.placeOrder?.count)}</div>
                  </div>
                  <div className="overview-last-update">
                    Source: {latencySourceMode === '15m' ? 'bot 15m' : 'bot horaire'} · agrégé sur 24 h (trades).
                  </div>
                </>
              ) : (
                <div className="overview-latency-note">
                  Pas encore assez de données pour le breakdown (aucune mesure sur bestAsk/creds/balance/book) sur les
                  24h.
                </div>
              )}
            </details>

            <span
              className={`latency-card-pill ${hasActiveLatency && activeLatency?.all?.avgMs != null ? 'latency-card-pill--ok' : 'latency-card-pill--idle'}`}
            >
              {hasActiveLatency && activeLatency?.all?.avgMs != null ? 'Optimal' : 'En attente'}
            </span>
          </div>

          {/* Cycle */}
          <div className="card latency-kpi-card">
            <div className="card-label">Cycle bot (24 h)</div>
            <div
              className={`card-value ${hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? 'green' : ''}`}
            >
              {hasActiveCycleLatency && activeCycleLatency?.avgMs != null
                ? `~${Math.round(activeCycleLatency.avgMs)} ms`
                : '—'}
            </div>
            <div className="card-sub">
              {hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? (
                <>
                  p95 {activeCycleLatency.p95Ms ?? '—'} ms · {activeCycleLatency.count} cycle
                  {activeCycleLatency.count !== 1 ? 's' : ''}
                </>
              ) : (
                'Mesure même sans trade.'
              )}
            </div>
            <span
              className={`latency-card-pill ${hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? 'latency-card-pill--ok' : 'latency-card-pill--idle'}`}
            >
              {hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? 'Optimal' : 'En attente'}
            </span>
          </div>

          {/* Signal → décision */}
          <div className="card latency-kpi-card">
            <div className="card-label">Signal → décision (24 h)</div>
            <div
              className={`card-value ${hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? 'green' : ''}`}
            >
              {hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null
                ? `~${Math.round(activeSignalDecisionLatency.all.avgMs)} ms`
                : '—'}
            </div>
            <div className="card-sub latency-kpi-card__body">
              {hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? (
                <>
                  <div>
                    p95 {activeSignalDecisionLatency.all.p95Ms ?? '—'} ms · {activeSignalDecisionLatency.all.count}{' '}
                    mesure{activeSignalDecisionLatency.all.count !== 1 ? 's' : ''}
                  </div>
                  {activeDecisionTotal > 0 && (
                    <div className="latency-kpi-card__sub">
                      no_signal {formatPct(activeDecisionReasons?.no_signal ?? 0, activeDecisionTotal)} · liquidity_ok{' '}
                      {formatPct(activeDecisionReasons?.liquidity_ok ?? 0, activeDecisionTotal)} · liquidity_null{' '}
                      {formatPct(activeDecisionReasons?.liquidity_null ?? 0, activeDecisionTotal)}
                    </div>
                  )}
                </>
              ) : (
                'Mesure même sans solde (inclut no_signal).'
              )}
            </div>
            <span
              className={`latency-card-pill ${hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? 'latency-card-pill--ok' : 'latency-card-pill--idle'}`}
            >
              {hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? 'Optimal' : 'En attente'}
            </span>
          </div>
        </div>
      </div>

      <div className="col-span-full trade-history-section">
        <div className="overview-latency-heading">
          <div className="section-title overview-latency-section-title">
            <h2>Historique des trades</h2>
            <div className="line" />
          </div>
        </div>
        <TradeHistory
          hideCardTitle
          botFunderCandidates={tradeHistoryBotFunders}
          balanceHistory={data15m?.balanceHistory ?? null}
          currentBalanceUsd={displayedBalance15m}
          useRealBalancePnl={false}
          balanceReconcilesWithDisplayedBalance={walletUsdc15m == null}
        />
      </div>

      {show15m && (
        <div className="col-span-full mise-max-section">
          <div className="mise-max-section-head">
            <div className="section-title mise-max-section-title">
              <h2>Mise max carnet · Bitcoin 15m</h2>
              <div className="line" />
            </div>
            <button
              type="button"
              onClick={() => refreshMiseMax15m()}
              disabled={miseMax15mLoading}
              className="btn btn--default btn--outline btn--sm"
            >
              Rafraîchir
            </button>
          </div>

          <div className="card mise-max-card">
            {miseMax15mLoading && (
              <p className="overview-state mise-max-card-state">Analyse des carnets 15m… (~quelques secondes)</p>
            )}
            {!miseMax15mLoading && miseMax15mError && (
              <p className="overview-state overview-state--amber mise-max-card-state">{miseMax15mError}</p>
            )}
            {!miseMax15mLoading && !miseMax15mError && miseMaxSample15m > 0 && (
              <>
                <div className="mise-max-kpi-row">
                  <div className="mise-max-kpi-cell">
                    <div className="mise-max-kpi-label">Moyenne</div>
                    <div className="mise-max-kpi-value mise-max-kpi-value--green">{formatUsd(miseMaxAvg15m)}</div>
                  </div>
                  <div className="mise-max-kpi-cell">
                    <div className="mise-max-kpi-label">Créneau actuel</div>
                    <div className="mise-max-kpi-value mise-max-kpi-value--white">{formatUsd(miseMaxCurrent15m)}</div>
                  </div>
                  <div className="mise-max-kpi-cell">
                    <div className="mise-max-kpi-label">Min — Max</div>
                    <div className="mise-max-kpi-mid">
                      {formatUsd(miseMaxMin15m)} — {formatUsd(miseMaxMax15m)}
                    </div>
                    <div className="mise-max-kpi-median">
                      Médiane {miseMaxMedian15m != null ? formatUsd(miseMaxMedian15m) : '—'}
                    </div>
                  </div>
                  <div className="mise-max-kpi-cell mise-max-kpi-cell--last">
                    <div className="mise-max-kpi-label">Échantillon</div>
                    <div className="mise-max-kpi-value mise-max-kpi-value--amber">
                      {miseMaxSample15m} créneau{miseMaxSample15m !== 1 ? 'x' : ''}
                    </div>
                    <div className="mise-max-kpi-source">Gamma + CLOB</div>
                  </div>
                </div>

                <div className="mise-max-meta">
                  <div className="mise-max-meta-row mise-max-meta-row--asks">
                    <span className="mise-max-meta-label">Best ask (CLOB)</span>
                    <span className="mise-max-meta-value">
                      Up {formatAskCents(miseMaxBestAskUp)} · Down {formatAskCents(miseMaxBestAskDown)}
                      <span
                        className={`mise-max-mini-label ${
                          bestAskUpAligned == null
                            ? 'mise-max-mini-label--muted'
                            : bestAskUpAligned
                              ? 'mise-max-mini-label--ok'
                              : 'mise-max-mini-label--warn'
                        }`}
                      >
                        {bestAskUpAligned == null ? 'book vs live: n/a' : `Up ${bestAskUpAligned ? 'aligné' : 'écart'}`}
                      </span>
                      <span
                        className={`mise-max-mini-label ${
                          bestAskDownAligned == null
                            ? 'mise-max-mini-label--muted'
                            : bestAskDownAligned
                              ? 'mise-max-mini-label--ok'
                              : 'mise-max-mini-label--warn'
                        }`}
                      >
                        {bestAskDownAligned == null ? 'book vs live: n/a' : `Down ${bestAskDownAligned ? 'aligné' : 'écart'}`}
                      </span>
                    </span>
                  </div>
                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Best ask live (carnet CLOB, repli /price)</span>
                    <span className="mise-max-meta-value">
                      Up {formatAskCents(miseMaxBestAskLiveUp)} · Down {formatAskCents(miseMaxBestAskLiveDown)}
                    </span>
                  </div>
                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Outcome comparé (mise max)</span>
                    <span className="mise-max-meta-value">
                      {miseMaxComparedOutcome ?? '—'}{miseMaxComparedOutcome ? ` (${signalMinPct}–${signalMaxPct}%)` : ''}
                    </span>
                  </div>
                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Liquidité {signalMinPct}–{signalMaxPct} %</span>
                    <span className="mise-max-meta-value">
                      Up {formatUsd(miseMaxLiqBandUp)} · Down {formatUsd(miseMaxLiqBandDown)}
                    </span>
                  </div>
                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Profondeur → {worstPct} ¢ (FAK / worst)</span>
                    <span className="mise-max-meta-value">
                      Up {formatUsd(miseMaxLiqWorstUp)} · Down {formatUsd(miseMaxLiqWorstDown)}
                    </span>
                  </div>
                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Niveaux asks ({signalMinPct}–{signalMaxPct} %)</span>
                    <span className="mise-max-meta-value">
                      Up {miseMaxLevelsBandUp ?? '—'} · Down {miseMaxLevelsBandDown ?? '—'}
                    </span>
                  </div>

                  <div className="mise-max-meta-row mise-max-meta-row--clock">
                    <span className="mise-max-meta-label">Créneau (ET)</span>
                    <span className="mise-max-meta-value mise-max-meta-value--wrap">
                      {miseMaxSlotEndSec != null ? (
                        <>
                          Fin {formatSlotEndEt(miseMaxSlotEndSec)} · {formatBitcoin15mSlotRangeEt(miseMaxSlotEndSec)}
                          <br />
                          <span className="mise-max-meta-sub">
                            Reste {formatCountdownRemaining(miseMaxSecLeft)} · fenêtres interdites (ET) :{' '}
                            {miseMaxForbidFirstMinUi} premières min et {miseMaxForbidLastMinUi} dernières min de chaque bloc
                            :00 / :15 / :30 / :45 (aligné API bot ou VITE_ENTRY_FORBIDDEN_*)
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>

                  {!miseMaxSlotOpen && (
                    <p className="mise-max-meta-notice mise-max-meta-notice--resolved">
                      Marché résolu — carnet CLOB souvent indisponible (normal, pas un bug).
                    </p>
                  )}
                  {miseMaxSlotOpen &&
                    (!miseMax15mBookAsksUp?.length && !miseMax15mBookAsksDown?.length ? (
                      <p className="mise-max-meta-notice">
                        Créneau ouvert mais carnet vide côté CLOB (liquidity ou latence).
                      </p>
                    ) : null)}

                  <div className="mise-max-meta-row">
                    <span className="mise-max-meta-label">Fraîcheur</span>
                    <span className="mise-max-meta-value">
                      {miseMaxBookAge != null
                        ? `Snapshot ${miseMaxSnapshotAt ?? '—'} · il y a ${miseMaxBookAge}`
                        : 'En attente de première lecture…'}
                    </span>
                  </div>

                  <p className="mise-max-meta-ref">
                    Réf. bot (CLOB) : bande signal {signalMinPct}–{signalMaxPct} % · prix max exécution marché typique{' '}
                    {worstPct} % — la « mise max » affichée est la liquidité dans la bande, pas le plafond FAK.
                  </p>

                  {botLiqSignalUsd != null && Number(botLiqSignalUsd) > 0 && (
                    <div className="mise-max-meta-row mise-max-meta-row--bot">
                      <span className="mise-max-meta-label">Corrélation bot</span>
                      <span className="mise-max-meta-value mise-max-meta-value--wrap">
                        Dernière liquidité enregistrée au signal (status) :{' '}
                        <strong>{formatUsd(botLiqSignalUsd)}</strong>
                        {botLiqSignalAt ? (
                          <>
                            {' '}
                            ·{' '}
                            {new Date(botLiqSignalAt).toLocaleString('fr-FR', {
                              dateStyle: 'short',
                              timeStyle: 'medium',
                            })}
                          </>
                        ) : null}
                        <br />
                        <span className="mise-max-meta-sub">
                          Live carnet (max Up/Down, bande {signalMinPct}–{signalMaxPct} %) :{' '}
                          <strong>
                            {formatUsd(
                              miseMaxLiqBandUp != null && miseMaxLiqBandDown != null
                                ? Math.max(miseMaxLiqBandUp, miseMaxLiqBandDown)
                                : miseMaxCurrent15m
                            )}
                          </strong>{' '}
                          — utile pour debugger écarts / no-fill.
                        </span>
                      </span>
                    </div>
                  )}
                </div>

                <MiseMax15mOrderBookDepth
                  asksUp={miseMax15mBookAsksUp}
                  asksDown={miseMax15mBookAsksDown}
                  lastAt={miseMax15mLastAt}
                  lastResolved15mSlot={miseMaxLastResolved15mSlot}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
