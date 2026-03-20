import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';

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

  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const hasActiveLatency = latencyMode === '15m' ? hasTradeLatencyStats15m : hasTradeLatencyStats;
  const activeLatencyBreakdown = latencyMode === '15m' ? tradeLatencyBreakdownStats15m : tradeLatencyBreakdownStats;
  const activeCycleLatency = latencyMode === '15m' ? cycleLatencyStats15m : cycleLatencyStats;
  const hasActiveCycleLatency = latencyMode === '15m' ? hasCycleLatencyStats15m : hasCycleLatencyStats;
  const activeSignalDecisionLatency = latencyMode === '15m' ? signalDecisionLatencyStats15m : signalDecisionLatencyStats;
  const hasActiveSignalDecisionLatency = latencyMode === '15m' ? hasSignalDecisionLatencyStats15m : hasSignalDecisionLatencyStats;

  const cardBase = 'border border-border/60 bg-card/90 shadow-card rounded-xl min-h-[140px] flex flex-col';
  const rowClass = 'flex items-center justify-between gap-3 py-2 first:pt-0 border-b border-border/40 last:border-0';

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
    <div className="grid gap-6 sm:grid-cols-2">
      {/* Ligne 1 : Solde + PnL (fusion) */}
      <Card className={`${cardBase} relative overflow-hidden border-t-2 border-t-emerald-500/30 sm:col-span-2`}>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/15 via-cyan-500/0 to-violet-500/10"
        />
        <CardHeader className="relative z-10 pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            Solde, PnL &amp; Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="relative z-10 pt-0 flex-1">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-0">
              <div className={rowClass}>
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Solde (horaire)</span>
                <span className="text-xl font-semibold tabular-nums text-emerald-400">{balance != null ? formatUsd(balance) : '—'}</span>
              </div>
              {show15m && (
                <div className={rowClass}>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Solde (15 min)</span>
                  <span className="text-xl font-semibold tabular-nums text-emerald-400">{balance15m != null ? formatUsd(balance15m) : '—'}</span>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground/80">
                {data?.at && new Date(data.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                {show15m && data15m?.at && ` · 15m ${new Date(data15m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`}
              </p>
            </div>

            <div className="space-y-0">
              <div className={rowClass}>
                <span className="text-xs text-muted-foreground uppercase tracking-wider">PnL (horaire)</span>
                <span className={`text-xl font-semibold tabular-nums ${pnl != null && pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} %` : '—'}
                </span>
              </div>
              {show15m && (
                <div className={rowClass}>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">PnL (15 min)</span>
                  <span className={`text-xl font-semibold tabular-nums ${pnl15m != null && pnl15m >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pnl15m != null ? `${pnl15m >= 0 ? '+' : ''}${pnl15m.toFixed(1)} %` : '—'}
                  </span>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground/80">PnL calculé sur l’historique de solde (période graphique).</p>
            </div>
          </div>

          {/* Performance 24h fusionnée dans la carte du haut */}
          <div className="mt-4 pt-3 border-t border-border/40">
            <div className={rowClass}>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Horaire</span>
              <span className="text-sm font-medium text-slate-200">
                {orders24h != null ? `${orders24h} ordre${orders24h !== 1 ? 's' : ''}` : '—'}
                {winRate != null && (
                  <span
                    className={`ml-1.5 px-1.5 py-0.5 rounded-md text-[11px] ${
                      winRate >= 50 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                    }`}
                  >
                    Win {winRate.toFixed(1)} %
                  </span>
                )}
              </span>
            </div>
            {show15m && (
              <div className={rowClass}>
                <span className="text-xs text-muted-foreground uppercase tracking-wider">15 min</span>
                <span className="text-sm font-medium text-slate-200">
                  {orders24h15m != null ? `${orders24h15m} ordre${orders24h15m !== 1 ? 's' : ''}` : '—'}
                  {winRate15m != null && (
                    <span
                      className={`ml-1.5 px-1.5 py-0.5 rounded-md text-[11px] ${
                        winRate15m >= 50 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      Win {winRate15m.toFixed(1)} %
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
          {(data?.signalPriceSource || (show15m && data15m?.signalPriceSource)) && (
            <p className="mt-3 text-[11px] text-muted-foreground/90 border-t border-border/40 pt-3 leading-relaxed">
              <span className="font-medium text-muted-foreground">Prix signal (poll / fetchSignals)</span>
              {' · '}
              {data?.signalPriceSource && (
                <span title={`MARKET_MODE lu sur ce serveur : ${data.marketMode ?? '?'}`}>
                  Horaire : {data.signalPriceSource === 'clob' ? 'CLOB (best ask)' : 'Gamma'}
                </span>
              )}
              {show15m && data15m?.signalPriceSource && (
                <>
                  {data?.signalPriceSource ? ' · ' : null}
                  <span title={`MARKET_MODE lu sur ce serveur : ${data15m.marketMode ?? '?'}`}>
                    15m : {data15m.signalPriceSource === 'clob' ? 'CLOB (best ask)' : 'Gamma'}
                  </span>
                </>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className={`${cardBase} bg-card/70 relative overflow-hidden border-t-2 border-t-cyan-500/30 sm:col-span-2`}>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-cyan-500/30 via-cyan-500/12 to-emerald-500/30 opacity-100"
        />
        <CardHeader className="relative z-10 pb-2 space-y-2">
          <div className="flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
              Latences (trade + bot)
            </CardTitle>
            {show15m && (
              <div className="flex rounded-lg border border-slate-600 bg-slate-800/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setLatencyMode('1h')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    latencyMode === '1h' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Horaire
                </button>
                <button
                  type="button"
                  onClick={() => setLatencyMode('15m')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    latencyMode === '15m' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  15m
                </button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="relative z-10 pt-0 flex-1">
          <div className="grid gap-6 sm:grid-cols-3">
            {/* Trade */}
            <div className="space-y-1 rounded-xl border border-border/40 bg-slate-900/20 px-3 py-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Trade (24 h)</div>
              <div className="text-lg font-semibold tabular-nums text-slate-50">
                {hasActiveLatency && activeLatency?.all?.avgMs != null ? `~${Math.round(activeLatency.all.avgMs / 1000)} s` : '—'}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {hasActiveLatency && activeLatency?.all?.avgMs != null ? (
                  <>
                    Moy {Math.round(activeLatency.all.avgMs)} ms · p95 {activeLatency.all.p95Ms != null ? `${Math.round(activeLatency.all.p95Ms)} ms` : '—'}
                    <span className="block opacity-80">
                      {activeLatency.all.count} trade{activeLatency.all.count !== 1 ? 's' : ''}{' '}
                      {((activeLatency.ws?.count ?? 0) > 0 || (activeLatency.poll?.count ?? 0) > 0) && (
                        <>
                          · WS ~{activeLatency.ws?.avgMs != null ? `${Math.round(activeLatency.ws.avgMs)} ms` : '—'} · Poll ~{activeLatency.poll?.avgMs != null ? `${Math.round(activeLatency.poll.avgMs)} ms` : '—'}
                        </>
                      )}
                    </span>
                  </>
                ) : (
                  'Mesure seulement quand un ordre est placé.'
                )}

                <div className="mt-1 opacity-80">
                  Détails placeOrder:{' '}
                  <span className="tabular-nums text-slate-200">{activeLatencyBreakdown?.all?.placeOrder?.count ?? 0}</span> mesures sur 24 h.
                </div>

                <details className="mt-2 rounded-lg border border-border/40 bg-slate-900/30 px-2 py-1.5">
                  <summary className="cursor-pointer select-none text-[11px] text-slate-300">
                    Détails (avg · p95)
                  </summary>

                  {hasAnyTradeLatencyBreakdown ? (
                    <>
                      <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[11px]">
                        <div className="text-muted-foreground">Étape</div>
                        <div className="text-muted-foreground">Avg</div>
                        <div className="text-muted-foreground">p95</div>
                        <div className="text-muted-foreground">N</div>

                        <div className="text-muted-foreground">bestAsk</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.bestAsk?.avgMs)}</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.bestAsk?.p95Ms)}</div>
                        <div className="tabular-nums text-slate-200">{formatCount(activeLatencyBreakdown.all.bestAsk?.count)}</div>

                        <div className="text-muted-foreground">creds</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.creds?.avgMs)}</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.creds?.p95Ms)}</div>
                        <div className="tabular-nums text-slate-200">{formatCount(activeLatencyBreakdown.all.creds?.count)}</div>

                        <div className="text-muted-foreground">balance</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.balance?.avgMs)}</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.balance?.p95Ms)}</div>
                        <div className="tabular-nums text-slate-200">{formatCount(activeLatencyBreakdown.all.balance?.count)}</div>

                        <div className="text-muted-foreground">book</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.book?.avgMs)}</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.book?.p95Ms)}</div>
                        <div className="tabular-nums text-slate-200">{formatCount(activeLatencyBreakdown.all.book?.count)}</div>

                        <div className="text-muted-foreground">placeOrder</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.placeOrder?.avgMs)}</div>
                        <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.placeOrder?.p95Ms)}</div>
                        <div className="tabular-nums text-slate-200">{formatCount(activeLatencyBreakdown.all.placeOrder?.count)}</div>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground/80">
                        Source: {latencyMode === '15m' ? 'bot 15m' : 'bot horaire'} · agrégé sur 24 h (trades).
                      </div>
                    </>
                  ) : (
                    <div className="mt-2 text-[11px] text-slate-300/90">
                      Pas encore assez de données pour le breakdown (aucune mesure sur bestAsk/creds/balance/book) sur les 24h.
                    </div>
                  )}
                </details>
              </div>
            </div>

            {/* Cycle */}
            <div className="space-y-1 rounded-xl border border-border/40 bg-slate-900/20 px-3 py-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Cycle bot (24 h)</div>
              <div className="text-lg font-semibold tabular-nums text-slate-50">
                {hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? `~${Math.round(activeCycleLatency.avgMs)} ms` : '—'}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {hasActiveCycleLatency && activeCycleLatency?.avgMs != null ? (
                  <>
                    p95 {activeCycleLatency.p95Ms ?? '—'} ms · {activeCycleLatency.count} cycle{activeCycleLatency.count !== 1 ? 's' : ''}
                  </>
                ) : (
                  'Mesure même sans trade.'
                )}
              </div>
            </div>

            {/* Signal -> décision */}
            <div className="space-y-1 rounded-xl border border-border/40 bg-slate-900/20 px-3 py-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Signal → décision (24 h)</div>
              <div className="text-lg font-semibold tabular-nums text-slate-50">
                {hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? `~${Math.round(activeSignalDecisionLatency.all.avgMs)} ms` : '—'}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {hasActiveSignalDecisionLatency && activeSignalDecisionLatency?.all?.avgMs != null ? (
                  <>
                    p95 {activeSignalDecisionLatency.all.p95Ms ?? '—'} ms · {activeSignalDecisionLatency.all.count} mesure{activeSignalDecisionLatency.all.count !== 1 ? 's' : ''}
                    {activeDecisionTotal > 0 && (
                      <span className="block opacity-80">
                        no_signal {formatPct(activeDecisionReasons?.no_signal ?? 0, activeDecisionTotal)} · liquidity_ok {formatPct(activeDecisionReasons?.liquidity_ok ?? 0, activeDecisionTotal)} · liquidity_null {formatPct(activeDecisionReasons?.liquidity_null ?? 0, activeDecisionTotal)}
                      </span>
                    )}
                  </>
                ) : (
                  'Mesure même sans solde (inclut no_signal).'
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Carte latences fusionnée au-dessus */}
    </div>
  );
}
