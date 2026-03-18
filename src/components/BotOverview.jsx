import { useState, useEffect } from 'react';
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
  const { data, loading } = useBotStatus(statusUrl);
  const { data: data15m, loading: loading15m } = useBotStatus(statusUrl15m);
  const [miseMaxMode, setMiseMaxMode] = useState('1h');
  const [latencyMode, setLatencyMode] = useState('1h');
  const [nowTs, setNowTs] = useState(null);
  useEffect(() => {
    const update = () => setNowTs(Date.now());
    const id = setInterval(update, 60000);
    const t = setTimeout(update, 0);
    return () => {
      clearInterval(id);
      clearTimeout(t);
    };
  }, []);

  if (!statusUrl) return null;

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const orders24h15m = data15m?.ordersLast24h ?? null;
  const winRate = data?.winRate != null ? Number(data.winRate) * 100 : null;
  const winRate15m = data15m?.winRate != null ? Number(data15m.winRate) * 100 : null;

  const pnl = computePnl(data?.balanceHistory, balance);
  const pnl15m = computePnl(data15m?.balanceHistory, balance15m);

  const isOnline = data?.status === 'online';
  const isOnline15m = data15m?.status === 'online';
  const liquidityStats = data?.liquidityStats ?? null;
  const hasLiquidityStats = liquidityStats?.count > 0;
  const liquidityStats15m = data15m?.liquidityStats ?? null;
  const hasLiquidityStats15m = liquidityStats15m?.count > 0;
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

  function formatLastLiquidityAt(lastAtIso, nowTsVal) {
    if (!lastAtIso) return null;
    if (nowTsVal == null)
      return new Date(lastAtIso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const then = new Date(lastAtIso).getTime();
    const diffMs = nowTsVal - then;
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMin / 60);
    if (diffMin < 1) return "à l'instant";
    if (diffMin < 60) return `il y a ${diffMin} min`;
    if (diffH < 24) return `il y a ${diffH} h`;
    return new Date(lastAtIso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const lastLiquidityLabel = hasLiquidityStats && liquidityStats?.lastAt ? formatLastLiquidityAt(liquidityStats.lastAt, nowTs) : null;
  const lastLiquidityLabel15m =
    hasLiquidityStats15m && liquidityStats15m?.lastAt ? formatLastLiquidityAt(liquidityStats15m.lastAt, nowTs) : null;

  const activeLiquidity = miseMaxMode === '15m' ? liquidityStats15m : liquidityStats;
  const hasActiveLiquidity = miseMaxMode === '15m' ? hasLiquidityStats15m : hasLiquidityStats;
  const lastActiveLabel = miseMaxMode === '15m' ? lastLiquidityLabel15m : lastLiquidityLabel;

  const activeLatency = latencyMode === '15m' ? tradeLatencyStats15m : tradeLatencyStats;
  const hasActiveLatency = latencyMode === '15m' ? hasTradeLatencyStats15m : hasTradeLatencyStats;
  const activeLatencyBreakdown = latencyMode === '15m' ? tradeLatencyBreakdownStats15m : tradeLatencyBreakdownStats;
  const activeCycleLatency = latencyMode === '15m' ? cycleLatencyStats15m : cycleLatencyStats;
  const hasActiveCycleLatency = latencyMode === '15m' ? hasCycleLatencyStats15m : hasCycleLatencyStats;
  const activeSignalDecisionLatency = latencyMode === '15m' ? signalDecisionLatencyStats15m : signalDecisionLatencyStats;
  const hasActiveSignalDecisionLatency = latencyMode === '15m' ? hasSignalDecisionLatencyStats15m : hasSignalDecisionLatencyStats;

  const cardBase = 'border border-border/60 bg-card/90 shadow-card rounded-xl min-h-[140px] flex flex-col';
  const rowClass = 'flex items-center justify-between gap-3 py-2 first:pt-0 border-b border-border/40 last:border-0';

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

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {/* Ligne 1 : Solde + PnL (fusion) */}
      <Card className={`${cardBase} border-t-2 border-t-emerald-500/30 sm:col-span-2`}>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            Solde &amp; PnL
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant={isOnline ? 'secondary' : 'destructive'} className="text-[10px] px-2 py-0.5">
              {loading ? '…' : '1h'}
            </Badge>
            {show15m && (
              <Badge variant={isOnline15m ? 'secondary' : 'destructive'} className="text-[10px] px-2 py-0.5">
                {loading15m ? '…' : '15m'}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0 flex-1">
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
        </CardContent>
      </Card>

      {/* Ligne 2 : Performance 24h | Mise max */}
      <Card className={`${cardBase} border-t-2 border-t-sky-500/30`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
            Performance 24 h
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 flex-1 flex flex-col justify-end">
          <div className="space-y-0">
            <div className={rowClass}>
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Horaire</span>
              <span className="text-sm font-medium text-slate-200">
                {orders24h != null ? `${orders24h} ordre${orders24h !== 1 ? 's' : ''}` : '—'}
                {winRate != null && (
                  <span className={winRate >= 50 ? 'text-emerald-400 ml-1.5' : 'text-rose-400 ml-1.5'}>
                    · Win {winRate.toFixed(1)} %
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
                    <span className={winRate15m >= 50 ? 'text-emerald-400 ml-1.5' : 'text-rose-400 ml-1.5'}>
                      · Win {winRate15m.toFixed(1)} %
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className={`${cardBase} border-t-2 border-t-violet-500/30`}>
        <CardHeader className="pb-2 space-y-2">
          <div className="flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
              Mise max au prix 97–97,5 % (moy. 3 j)
            </CardTitle>
            {show15m && (
            <div className="flex rounded-lg border border-slate-600 bg-slate-800/60 p-0.5">
              <button
                type="button"
                onClick={() => setMiseMaxMode('1h')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  miseMaxMode === '1h' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Horaire
              </button>
              <button
                type="button"
                onClick={() => setMiseMaxMode('15m')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  miseMaxMode === '15m' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                15m
              </button>
            </div>
          )}
          </div>
          {/* Indication claire : données liquidité récupérées ou non pour chaque bot */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-muted-foreground">
              Horaire :{' '}
              {hasLiquidityStats ? (
                <span className="text-emerald-500/90 font-medium">
                  {liquidityStats.count} relevé{liquidityStats.count !== 1 ? 's' : ''}
                </span>
              ) : (
                <span className="text-amber-500/90">aucun relevé</span>
              )}
            </span>
            {show15m && (
              <span className="text-muted-foreground">
                15m :{' '}
                {hasLiquidityStats15m ? (
                  <span className="text-emerald-500/90 font-medium">
                    {liquidityStats15m.count} relevé{liquidityStats15m.count !== 1 ? 's' : ''}
                  </span>
                ) : (
                  <span className="text-amber-500/90">aucun relevé</span>
                )}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0 flex-1 flex flex-col justify-end">
          <p className="text-2xl font-semibold tabular-nums text-slate-50">
            {hasActiveLiquidity ? `~${Math.round(activeLiquidity.avg)} $` : '—'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {hasActiveLiquidity ? (
              <>
                Profondeur au meilleur ask (97–97,5 %) : montant max à miser sans dégrader le prix moyen. Min {Math.round(activeLiquidity.min)} $ · Max {Math.round(activeLiquidity.max)} $
                <span className="block mt-0.5 opacity-80">
                  {activeLiquidity.count} relevé{activeLiquidity.count !== 1 ? 's' : ''}
                  {lastActiveLabel && ` · ${lastActiveLabel}`}
                </span>
              </>
            ) : (
              miseMaxMode === '15m'
                ? 'Profondeur au meilleur ask (97–97,5 %) pour les créneaux 15 min. Relevés envoyés par le bot.'
                : 'Profondeur au meilleur ask (97–97,5 %) pour les créneaux horaires. Relevés envoyés par le bot.'
            )}
          </p>
        </CardContent>
      </Card>

      <Card className={`${cardBase} border-t-2 border-t-cyan-500/30 sm:col-span-2`}>
        <CardHeader className="pb-2 space-y-2">
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
        <CardContent className="pt-0 flex-1">
          <div className="grid gap-6 sm:grid-cols-3">
            {/* Trade */}
            <div className="space-y-1">
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
                    {activeLatencyBreakdown?.all?.placeOrder?.count > 0 && (
                      <details className="mt-2 rounded-lg border border-border/40 bg-slate-900/30 px-2 py-1.5">
                        <summary className="cursor-pointer select-none text-[11px] text-slate-300">
                          Détails (avg · p95)
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                          <div className="text-muted-foreground">bestAsk</div>
                          <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.bestAsk?.avgMs)} · {formatMs(activeLatencyBreakdown.all.bestAsk?.p95Ms)}</div>
                          <div className="text-muted-foreground">creds</div>
                          <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.creds?.avgMs)} · {formatMs(activeLatencyBreakdown.all.creds?.p95Ms)}</div>
                          <div className="text-muted-foreground">balance</div>
                          <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.balance?.avgMs)} · {formatMs(activeLatencyBreakdown.all.balance?.p95Ms)}</div>
                          <div className="text-muted-foreground">book</div>
                          <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.book?.avgMs)} · {formatMs(activeLatencyBreakdown.all.book?.p95Ms)}</div>
                          <div className="text-muted-foreground">placeOrder</div>
                          <div className="tabular-nums text-slate-200">{formatMs(activeLatencyBreakdown.all.placeOrder?.avgMs)} · {formatMs(activeLatencyBreakdown.all.placeOrder?.p95Ms)}</div>
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground/80">
                          Source: {latencyMode === '15m' ? 'bot 15m' : 'bot horaire'} · agrégé sur 24 h (trades).
                        </div>
                      </details>
                    )}
                  </>
                ) : (
                  'Mesure seulement quand un ordre est placé.'
                )}
              </div>
            </div>

            {/* Cycle */}
            <div className="space-y-1">
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
            <div className="space-y-1">
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
