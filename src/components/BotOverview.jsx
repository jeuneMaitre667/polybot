import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M, useBotStatus } from '@/hooks/useBotStatus.js';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';

/** Regroupe les relevés par tranche de temps (max par tranche) pour lisser le graphique. */
function bucketMiseMaxSeries(series, bucketMs) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const buckets = new Map();
  for (const p of series) {
    const t = new Date(p.at).getTime();
    if (Number.isNaN(t)) continue;
    const k = Math.floor(t / bucketMs);
    if (!buckets.has(k)) {
      buckets.set(k, { t: k * bucketMs, Up: [], Down: [], other: [] });
    }
    const b = buckets.get(k);
    const v = Number(p.liquidityUsd);
    if (!Number.isFinite(v)) continue;
    if (p.takeSide === 'Up') b.Up.push(v);
    else if (p.takeSide === 'Down') b.Down.push(v);
    else b.other.push(v);
  }
  const maxArr = (arr) => (arr.length ? Math.max(...arr) : null);
  return Array.from(buckets.keys())
    .sort((a, b) => a - b)
    .map((key) => {
      const b = buckets.get(key);
      return {
        t: b.t,
        label: new Date(b.t).toLocaleString('fr-FR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        Up: maxArr(b.Up),
        Down: maxArr(b.Down),
        other: maxArr(b.other),
      };
    });
}

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
  const [miseMaxMode, setMiseMaxMode] = useState('1h');
  /** Fenêtre d’agrégation des stats / graphique mise max */
  const [miseMaxPeriod, setMiseMaxPeriod] = useState('72h');
  /** Filtre Up / Down / tout (données issues du bot avec takeSide) */
  const [miseMaxSide, setMiseMaxSide] = useState('all');
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

  const balance = data?.balanceUsd != null ? Number(data.balanceUsd) : null;
  const balance15m = data15m?.balanceUsd != null ? Number(data15m.balanceUsd) : null;
  const orders24h = data?.ordersLast24h ?? null;
  const orders24h15m = data15m?.ordersLast24h ?? null;
  const winRate = data?.winRate != null ? Number(data.winRate) * 100 : null;
  const winRate15m = data15m?.winRate != null ? Number(data15m.winRate) * 100 : null;

  const pnl = computePnl(data?.balanceHistory, balance);
  const pnl15m = computePnl(data15m?.balanceHistory, balance15m);

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
  const activeStatus = miseMaxMode === '15m' ? data15m : data;
  const activeLiquidityReport = activeStatus?.liquidityReport;
  const periodKey = miseMaxPeriod === '24h' ? '24h' : '72h';
  const fallbackLiq72 = miseMaxMode === '15m' ? liquidityStats15m : liquidityStats;
  const fallbackLiq24 = miseMaxMode === '15m' ? data15m?.liquidityStats24h : data?.liquidityStats24h;

  const activeLiquidity = useMemo(() => {
    const w = activeLiquidityReport?.windows?.[periodKey];
    if (w) {
      if (miseMaxSide === 'Up') return w.Up;
      if (miseMaxSide === 'Down') return w.Down;
      return w.all;
    }
    if (periodKey === '72h') return fallbackLiq72;
    if (fallbackLiq24 && miseMaxSide === 'all') return fallbackLiq24;
    return {
      avg: null,
      min: null,
      max: null,
      median: null,
      p95: null,
      lastUsd: null,
      count: 0,
      lastAt: null,
    };
  }, [activeLiquidityReport, periodKey, miseMaxSide, fallbackLiq72, fallbackLiq24]);

  const hasActiveLiquidity = (activeLiquidity?.count ?? 0) > 0;
  const lastActiveLabel =
    activeLiquidity?.lastAt && nowTs != null ? formatLastLiquidityAt(activeLiquidity.lastAt, nowTs) : null;

  const miseMaxChartData = useMemo(() => {
    const raw = activeLiquidityReport?.series?.[periodKey];
    if (!raw?.length) return [];
    const bucketMs = periodKey === '24h' ? 2 * 60 * 1000 : 5 * 60 * 1000;
    return bucketMiseMaxSeries(raw, bucketMs);
  }, [activeLiquidityReport, periodKey]);

  const miseMaxBySignalData = useMemo(() => {
    const rows = activeLiquidityReport?.bySignal?.[periodKey];
    if (!Array.isArray(rows) || rows.length === 0) return [];
    return rows.map((r) => ({
      label: r.signalLabel,
      All: r?.all?.avg ?? null,
      Up: r?.Up?.avg ?? null,
      Down: r?.Down?.avg ?? null,
      nAll: r?.all?.count ?? 0,
      nUp: r?.Up?.count ?? 0,
      nDown: r?.Down?.count ?? 0,
    }));
  }, [activeLiquidityReport, periodKey]);

  const winForSideCounts = activeLiquidityReport?.windows?.[periodKey];

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
        </CardContent>
      </Card>

      <Card className={`${cardBase} relative overflow-hidden border-t-2 border-t-violet-500/30 sm:col-span-2 min-h-0`}>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-500/15 via-cyan-500/0 to-emerald-500/10"
        />
        <CardHeader className="relative z-10 pb-2 space-y-2">
          <div className="flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-[0.16em]">
              Mise max 97–97,5 % · {miseMaxPeriod === '24h' ? '24 h' : '3 j'}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5 justify-end">
              <div className="flex rounded-lg border border-slate-600 bg-slate-800/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setMiseMaxPeriod('24h')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    miseMaxPeriod === '24h' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  24 h
                </button>
                <button
                  type="button"
                  onClick={() => setMiseMaxPeriod('72h')}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    miseMaxPeriod === '72h' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  3 j
                </button>
              </div>
              <div className="flex rounded-lg border border-slate-600 bg-slate-800/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setMiseMaxSide('all')}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    miseMaxSide === 'all' ? 'bg-slate-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Tout
                </button>
                <button
                  type="button"
                  onClick={() => setMiseMaxSide('Up')}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    miseMaxSide === 'Up' ? 'bg-violet-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Up
                </button>
                <button
                  type="button"
                  onClick={() => setMiseMaxSide('Down')}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    miseMaxSide === 'Down' ? 'bg-amber-800/80 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Down
                </button>
              </div>
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
            {winForSideCounts && (
              <span className="text-muted-foreground opacity-90">
                (fenêtre {miseMaxPeriod === '24h' ? '24 h' : '3 j'} — N: tout {winForSideCounts.all?.count ?? 0}
                {', '}
                Up {winForSideCounts.Up?.count ?? 0}, Down {winForSideCounts.Down?.count ?? 0})
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="relative z-10 pt-0 flex-1 flex flex-col gap-3 min-h-0">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-50">
                {hasActiveLiquidity ? `~${Math.round(activeLiquidity.avg)} $` : '—'}
              </p>
              {hasActiveLiquidity && activeLiquidity.lastUsd != null && (
                <p className="mt-1 text-sm tabular-nums text-violet-200/95">
                  Dernier relevé : ~{Math.round(activeLiquidity.lastUsd)} $
                </p>
              )}
            </div>
            {!activeLiquidityReport && (
              <p className="text-[11px] text-amber-500/90 max-w-md">
                API status-server à jour requise pour le graphique et le filtre Up/Down (redéploie le bot sur Lightsail).
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {hasActiveLiquidity ? (
              <>
                Profondeur cumulée jusqu'à 97,5 % : montant max à miser (FOK ≤ 97,5c). Min {Math.round(activeLiquidity.min)} $ · Max {Math.round(activeLiquidity.max)} $
                {(activeLiquidity.median != null || activeLiquidity.p95 != null) && (
                  <span className="block mt-1">
                    {activeLiquidity.median != null && (
                      <span>Médiane ~{Math.round(activeLiquidity.median)} $</span>
                    )}
                    {activeLiquidity.median != null && activeLiquidity.p95 != null && <span> · </span>}
                    {activeLiquidity.p95 != null && (
                      <span>p95 ~{Math.round(activeLiquidity.p95)} $</span>
                    )}
                  </span>
                )}
                <span className="block mt-0.5 opacity-80">
                  {activeLiquidity.count} relevé{activeLiquidity.count !== 1 ? 's' : ''}
                  {lastActiveLabel && ` · ${lastActiveLabel}`}
                </span>
              </>
            ) : (
              <>
                {miseMaxMode === '15m'
                  ? 'Profondeur cumulée jusqu\'à 97,5 % pour les créneaux 15 min. Relevés envoyés par le bot.'
                  : 'Profondeur cumulée jusqu\'à 97,5 % pour les créneaux horaires. Relevés envoyés par le bot.'}
                {miseMaxSide !== 'all' && !activeLiquidityReport && (
                  <span className="block mt-1 text-amber-500/80">Sélection Up/Down disponible après mise à jour du status-server.</span>
                )}
              </>
            )}
          </p>

          {miseMaxBySignalData.length > 0 ? (
            <div className="w-full h-[220px] mt-1">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={miseMaxBySignalData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={48} tickFormatter={(v) => `${Math.round(v)}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e8f0' }}
                    formatter={(value, key, ctx) => {
                      const k = String(key);
                      if (value == null) return ['—', k];
                      if (k === 'All') return [`~${Math.round(Number(value))} $ (N=${ctx?.payload?.nAll ?? 0})`, 'Tout'];
                      if (k === 'Up') return [`~${Math.round(Number(value))} $ (N=${ctx?.payload?.nUp ?? 0})`, 'Up'];
                      if (k === 'Down') return [`~${Math.round(Number(value))} $ (N=${ctx?.payload?.nDown ?? 0})`, 'Down'];
                      return [`~${Math.round(Number(value))} $`, k];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {miseMaxSide === 'all' && (
                    <Line type="monotone" dataKey="All" name="Tout" stroke="#22d3ee" dot={{ r: 2 }} strokeWidth={2} connectNulls />
                  )}
                  {(miseMaxSide === 'all' || miseMaxSide === 'Up') && (
                    <Line type="monotone" dataKey="Up" name="Up" stroke="#a78bfa" dot={{ r: 2 }} strokeWidth={2} connectNulls />
                  )}
                  {(miseMaxSide === 'all' || miseMaxSide === 'Down') && (
                    <Line type="monotone" dataKey="Down" name="Down" stroke="#fbbf24" dot={{ r: 2 }} strokeWidth={2} connectNulls />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-muted-foreground/80 mt-1">
                Moyenne de mise max par niveau de signal (97.0% → 97.5%), utile pour calibrer la stratégie par prix.
              </p>
            </div>
          ) : activeLiquidityReport ? (
            <p className="text-[11px] text-muted-foreground">Pas encore assez de points avec signalPrice pour la vue "Par signal".</p>
          ) : miseMaxChartData.length > 0 ? (
            <div className="w-full h-[220px] mt-1">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={miseMaxChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} interval="preserveStartEnd" />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    width={48}
                    tickFormatter={(v) => `${Math.round(v)}`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e8f0' }}
                    formatter={(value) => (value != null ? [`~${Math.round(value)} $`, ''] : ['—', ''])}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {(miseMaxSide === 'all' || miseMaxSide === 'Up') && (
                    <Line type="monotone" dataKey="Up" name="Up" stroke="#a78bfa" dot={false} strokeWidth={2} connectNulls />
                  )}
                  {(miseMaxSide === 'all' || miseMaxSide === 'Down') && (
                    <Line type="monotone" dataKey="Down" name="Down" stroke="#fbbf24" dot={false} strokeWidth={2} connectNulls />
                  )}
                  {miseMaxSide === 'all' && (
                    <Line
                      type="monotone"
                      dataKey="other"
                      name="Sans côté (ancien)"
                      stroke="#64748b"
                      strokeDasharray="4 4"
                      dot={false}
                      strokeWidth={1.5}
                      connectNulls
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-muted-foreground/80 mt-1">
                Courbe : max par tranche ({miseMaxPeriod === '24h' ? '2 min' : '5 min'}) pour lisibilité — jusqu’à {periodKey === '24h' ? '24 h' : '3 j'}.
              </p>
            </div>
          ) : activeLiquidityReport ? (
            <p className="text-[11px] text-muted-foreground">Pas encore assez de points pour tracer l’historique sur cette fenêtre.</p>
          ) : null}
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
