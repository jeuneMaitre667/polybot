import { useState } from 'react';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import { use15mMiseMaxBookAvg } from '@/hooks/use15mMiseMaxBookAvg.js';
import { MiseMax15mOrderBookDepth } from '@/components/MiseMax15mOrderBookDepth.jsx';
import { TradeHistory } from '@/components/TradeHistory.jsx';

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)} $`;
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

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const orders24h15m = data15m?.ordersLast24h ?? null;
  const winRate = data?.winRate != null ? Number(data.winRate) * 100 : null;
  const winRate15m = data15m?.winRate != null ? Number(data15m.winRate) * 100 : null;

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
    slotsAttempted: miseMaxSlotsAttempted15m,
    currentSlotMiseMaxUsd: miseMaxCurrent15m,
    loading: miseMax15mLoading,
    error: miseMax15mError,
    lastAt: miseMax15mLastAt,
    refresh: refreshMiseMax15m,
    currentSlotBookAsksUp: miseMax15mBookAsksUp,
    currentSlotBookAsksDown: miseMax15mBookAsksDown,
    lastResolved15mSlot: miseMaxLastResolved15mSlot,
  } = use15mMiseMaxBookAvg({ enabled: show15m, slotCount: 36, staggerMs: 45 });

  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const hasActiveLatency = latencyMode === '15m' ? hasTradeLatencyStats15m : hasTradeLatencyStats;
  const activeLatencyBreakdown = latencyMode === '15m' ? tradeLatencyBreakdownStats15m : tradeLatencyBreakdownStats;
  const activeCycleLatency = latencyMode === '15m' ? cycleLatencyStats15m : cycleLatencyStats;
  const hasActiveCycleLatency = latencyMode === '15m' ? hasCycleLatencyStats15m : hasCycleLatencyStats;
  const activeSignalDecisionLatency = latencyMode === '15m' ? signalDecisionLatencyStats15m : signalDecisionLatencyStats;
  const hasActiveSignalDecisionLatency = latencyMode === '15m' ? hasSignalDecisionLatencyStats15m : hasSignalDecisionLatencyStats;

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
        </div>

        <div className="grid-main overview-latency-grid-main">
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
