import { useState, useEffect } from 'react';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { use15mMiseMaxBookAvg } from '@/hooks/use15mMiseMaxBookAvg.js';
import { MiseMax15mOrderBookDepth } from '@/components/MiseMax15mOrderBookDepth.jsx';
import { TradeHistory } from '@/components/TradeHistory.jsx';
import { formatBitcoin15mSlotRangeEt, formatSlotEndEt } from '@/lib/polymarketDisplayTime.js';
import { isLive15mEntryForbiddenNow } from '@/lib/bitcoin15mSlotEntryTiming.js';
import {
  ORDER_BOOK_MARKET_WORST_P,
  ORDER_BOOK_SIGNAL_MAX_P,
  ORDER_BOOK_SIGNAL_MIN_P,
} from '@/lib/orderBookLiquidity.js';

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)} $`;
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

function computePnl(balanceHistory, currentBalance) {
  const history = balanceHistory ?? [];
  const firstBalance = history.length > 0 ? Number(history[0].balance) : null;
  const lastBalance =
    currentBalance != null ? currentBalance : history.length > 0 ? Number(history[history.length - 1].balance) : null;
  if (firstBalance == null || lastBalance == null || firstBalance <= 0) return null;
  return ((lastBalance - firstBalance) / firstBalance) * 100;
}

export function BotOverview() {
  const statusUrl = DEFAULT_BOT_STATUS_URL;
  const statusUrl15m = DEFAULT_BOT_STATUS_URL_15M;
  const { data } = useBotStatus(statusUrl);
  const { data: data15m } = useBotStatus(statusUrl15m);
  const [latencyMode, setLatencyMode] = useState('1h');
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const orders24h15m = data15m?.ordersLast24h ?? null;
  const pnl = computePnl(data?.balanceHistory, balance);
  const pnl15m = computePnl(data15m?.balanceHistory, balance15m);

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
  const miseMaxEntryForbiddenEt = isLive15mEntryForbiddenNow(nowMs);
  const miseMaxBookAge = formatSecondsAgo(miseMax15mLastAt, nowMs);
  const botLiqSignalUsd =
    data15m?.liquidityStats24h?.lastUsd ?? data15m?.liquidityStats?.lastUsd ?? null;
  const botLiqSignalAt = data15m?.liquidityStats24h?.lastAt ?? data15m?.liquidityStats?.lastAt ?? null;
  const signalMinPct = (ORDER_BOOK_SIGNAL_MIN_P * 100).toFixed(0);
  const signalMaxPct = (ORDER_BOOK_SIGNAL_MAX_P * 100).toFixed(1).replace(/\.0$/, '');
  const worstPct = (ORDER_BOOK_MARKET_WORST_P * 100).toFixed(0);

  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const hasActiveLatency = latencyMode === '15m' ? hasTradeLatencyStats15m : hasTradeLatencyStats;
  const activeLatencyBreakdown = latencyMode === '15m' ? tradeLatencyBreakdownStats15m : tradeLatencyBreakdownStats;
  const activeCycleLatency = latencyMode === '15m' ? cycleLatencyStats15m : cycleLatencyStats;
  const hasActiveCycleLatency = latencyMode === '15m' ? hasCycleLatencyStats15m : hasCycleLatencyStats;
  const activeSignalDecisionLatency = latencyMode === '15m' ? signalDecisionLatencyStats15m : signalDecisionLatencyStats;
  const hasActiveSignalDecisionLatency = latencyMode === '15m' ? hasSignalDecisionLatencyStats15m : hasSignalDecisionLatencyStats;
  const activeStatus = latencyMode === '15m' ? data15m : data;
  const activeAlerts = Array.isArray(activeStatus?.alerts) ? activeStatus.alerts : [];
  const hasPolymarketDelayRisk = activeAlerts.some((a) => ['polymarket_degraded', 'stale_ws_data', 'execution_delayed'].includes(String(a?.kind)));
  const activeNoOrderEvents = Array.isArray(activeStatus?.signalInRangeNoOrderRecent)
    ? activeStatus.signalInRangeNoOrderRecent
    : [];
  const activeLastSkip = activeStatus?.health?.lastSkipReason ?? null;
  const activeLastSkipSource = activeStatus?.health?.lastSkipSource ?? null;
  const activeLastSkipAt = activeStatus?.health?.lastSkipAt ?? null;
  const activeLastSkipAge = formatSecondsAgo(activeLastSkipAt, nowMs);
  const skipReasonLabels = {
    timing_forbidden: 'Fenêtre interdite',
    degraded_mode: 'Mode incident',
    ws_stale: 'WS stale / mismatch REST',
    cooldown_active: 'Cooldown exécution actif',
    amount_below_min: 'Montant sous minimum',
    ws_price_out_of_window: 'Prix hors fenêtre signal',
    already_placed_for_slot: 'Déjà placé sur ce créneau',
  };
  const activeLastSkipLabel = activeLastSkip ? (skipReasonLabels[activeLastSkip] ?? activeLastSkip) : null;
  const noOrderReasonLabels = {
    timing_forbidden: 'Fenêtre interdite',
    cooldown_active: 'Cooldown',
    degraded_mode_pause: 'Mode incident',
    ws_stale_rest_invalid: 'WS stale (REST invalide)',
    ws_stale_rest_mismatch: 'WS stale (mismatch REST)',
    amount_below_min: 'Montant sous minimum',
    place_order_failed: "Echec placement d'ordre",
    already_placed_for_slot: 'Déjà placé sur ce créneau',
    clob_creds: 'Erreur creds CLOB',
    ws_price_out_of_window: 'Prix hors fenêtre',
    auto_place_disabled: 'Autotrade désactivé',
    kill_switch: 'Kill switch',
    wallet_not_configured: 'Wallet non configuré',
  };

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

  if (!statusUrl) return null;

  return (
    <div className="bot-overview-grid">
      <div className="grid-main">
        <div className="card">
          <div className="card-label">Solde Horaire</div>
          <div className="card-value green">{balance != null ? formatUsd(balance) : '—'}</div>
          <div className="card-sub">
            {data?.at ? new Date(data.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'} · 1h
          </div>
        </div>
        <div className="card">
          <div className="card-label">Solde 15 Min</div>
          <div className="card-value green">{show15m && balance15m != null ? formatUsd(balance15m) : '—'}</div>
          <div className="card-sub">
            {show15m && data15m?.at ? new Date(data15m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'} · 15m
          </div>
        </div>
        <div className="card">
          <div className="card-label">Ordres actifs</div>
          <div className="overview-two-lines">
            <div>Horaire <span>{orders24h ?? '—'}</span></div>
            <div>15 Min <span>{show15m ? (orders24h15m ?? '—') : '—'}</span></div>
          </div>
        </div>
      </div>

      <div className="grid-main">
        <div className="card">
          <div className="card-label">PNL Horaire (24h)</div>
          <div className={`card-value ${pnl != null ? (pnl >= 0 ? 'green' : 'red') : ''}`}>
            {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} %` : '—'}
          </div>
          <div className="card-sub">{orders24h ? `${orders24h} ordre(s)` : 'Aucun trade exécuté'}</div>
        </div>
        <div className="card">
          <div className="card-label">PNL 15 Min (24h)</div>
          <div className={`card-value ${pnl15m != null ? (pnl15m >= 0 ? 'green' : 'red') : ''}`}>
            {show15m && pnl15m != null ? `${pnl15m >= 0 ? '+' : ''}${pnl15m.toFixed(1)} %` : '—'}
          </div>
          <div className="card-sub">{show15m && orders24h15m ? `${orders24h15m} ordre(s)` : 'Aucun trade exécuté'}</div>
        </div>
        <div className="card">
          <div className="card-label">Prix signal</div>
          <div className="overview-two-lines">
            <div>
              Horaire :{' '}
              <span
                className={
                  data?.signalPriceSource === 'clob'
                    ? 'overview-signal-source--clob'
                    : data?.signalPriceSource === 'gamma'
                      ? 'overview-signal-source--gamma'
                      : 'overview-signal-source--muted'
                }
              >
                {data?.signalPriceSource === 'clob'
                  ? 'CLOB best ask'
                  : data?.signalPriceSource === 'gamma'
                    ? 'Gamma'
                    : '—'}
              </span>
            </div>
            <div>
              15m :{' '}
              <span
                className={
                  data15m?.signalPriceSource === 'clob'
                    ? 'overview-signal-source--clob'
                    : data15m?.signalPriceSource === 'gamma'
                      ? 'overview-signal-source--gamma'
                      : 'overview-signal-source--muted'
                }
              >
                {data15m?.signalPriceSource === 'clob'
                  ? 'CLOB best ask'
                  : data15m?.signalPriceSource === 'gamma'
                    ? 'Gamma'
                    : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Latences : même grille / mêmes cartes que Solde & Performance */}
      <div className="col-span-full overview-latency-section">
        <div className="overview-latency-heading">
          <div className="section-title overview-latency-section-title">
            <h2>Latences</h2>
            <div className="line" />
          </div>
          {show15m && (
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
        <div className="overview-skip-reason">
          <span className="overview-skip-reason__label">Dernier skip</span>
          <span className="overview-skip-reason__value">
            {activeLastSkipLabel ?? '—'}
            {activeLastSkipSource ? ` · ${String(activeLastSkipSource).toUpperCase()}` : ''}
            {activeLastSkipAge ? ` · il y a ${activeLastSkipAge}` : ''}
          </span>
        </div>
        <div className="overview-watch-card">
          <div className="overview-watch-card__title">Watch no-order (live)</div>
          {activeNoOrderEvents.length > 0 ? (
            <div className="overview-watch-list">
              {activeNoOrderEvents.slice(0, 8).map((e, idx) => {
                const age = formatSecondsAgo(e?.ts, nowMs);
                const reason = noOrderReasonLabels[e?.reason] ?? e?.reason ?? 'unknown';
                const source = e?.source ? String(e.source).toUpperCase() : '—';
                const side = e?.takeSide ?? '—';
                const bestAsk = e?.bestAskP != null ? `${(Number(e.bestAskP) * 100).toFixed(2)}¢` : '—';
                return (
                  <div key={`${e?.ts || 'na'}-${idx}`} className="overview-watch-row">
                    <span className="overview-watch-row__main">{reason}</span>
                    <span className="overview-watch-row__meta">
                      {source} · {side} · {bestAsk}
                      {age ? ` · il y a ${age}` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="overview-watch-empty">Aucun événement no-order récent.</div>
          )}
        </div>

        <div className="grid-main overview-latency-grid-main">
        {/* Dernier trade WS */}
        <div className="card latency-kpi-card">
          <div className="card-label">Dernier trade WS</div>
          <div
            className={`card-value ${
              hasActiveLatency && activeLatency?.ws?.lastLatencyMs != null ? 'green' : ''
            }`}
          >
            {hasActiveLatency && activeLatency?.ws?.lastLatencyMs != null ? formatMs(activeLatency.ws.lastLatencyMs) : '—'}
          </div>
          <div className="card-sub latency-kpi-card__body">
            {hasActiveLatency && (activeLatency?.ws?.count ?? 0) > 0 ? (
              <div className="latency-kpi-card__sub">
                {(activeLatency.ws.count ?? 0)} trade{activeLatency.ws.count !== 1 ? 's' : ''} WS sur 24 h.
              </div>
            ) : (
              <div className="latency-kpi-card__sub">Mesure seulement quand un ordre WS est placé.</div>
            )}
          </div>
          <span
            className={`latency-card-pill ${
              hasActiveLatency && activeLatency?.ws?.lastLatencyMs != null ? 'latency-card-pill--ok' : 'latency-card-pill--idle'
            }`}
          >
            {hasActiveLatency && activeLatency?.ws?.lastLatencyMs != null ? 'WS' : 'En attente'}
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
                    Source: {latencyMode === '15m' ? 'bot 15m' : 'bot horaire'} · agrégé sur 24 h (trades).
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
        <TradeHistory hideCardTitle />
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
                            Reste {formatCountdownRemaining(miseMaxSecLeft)} · fenêtres interdites (ET) : 3 premières min
                            et 4 dernières min de chaque bloc :00 / :15 / :30 / :45
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>

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
                        ? `Carnet à jour il y a ${miseMaxBookAge}`
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
