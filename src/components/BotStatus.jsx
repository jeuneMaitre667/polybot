import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useBotStatus, DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M } from '@/hooks/useBotStatus.js';

function uptimeStrFrom(uptimeMs) {
  if (uptimeMs == null) return null;
  const s = Math.floor(uptimeMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

/** Badge compact pour le header : pastille + statut + uptime + config (marché · 3s) + résultats + Rafraîchir. Optionnel : statusUrl + label (ex. "15m"). */
export function BotStatusBadge({ statusUrl: statusUrlProp, label }) {
  const statusUrl = statusUrlProp ?? DEFAULT_BOT_STATUS_URL;
  const { data, loading, error, refresh } = useBotStatus(statusUrl);
  const [now, setNow] = useState(() => Date.now());
  const wasOnlineRef = useRef(false);
  const hadWsAlertRef = useRef(false);

  useEffect(() => {
    if (data?.status !== 'online') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [data?.status]);

  useEffect(() => {
    const isOnline = data?.status === 'online';
    if (wasOnlineRef.current && !isOnline && !loading && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Bot Polymarket hors ligne', { body: error || 'Le bot ne répond plus. Vérifier le serveur.' });
    }
    wasOnlineRef.current = !!isOnline;
  }, [data?.status, loading, error]);

  useEffect(() => {
    const wsAlert = Array.isArray(data?.alerts) && data.alerts.some((a) => a?.kind === 'ws_disconnected');
    if (hadWsAlertRef.current === false && wsAlert && !loading && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Bot Polymarket — WebSocket déconnecté', { body: 'Le WS CLOB est hors ligne depuis un moment (polling continue).' });
    }
    hadWsAlertRef.current = !!wsAlert;
  }, [data?.alerts, loading]);

  if (!statusUrl) return null;

  const isOnline = data?.status === 'online';
  const uptimeMs = data?.uptime ? now - data.uptime : null;
  const uptimeStr = uptimeStrFrom(uptimeMs);
  const orderLabel = data?.useMarketOrder !== false ? 'marché' : 'limite';
  const pollSec = data?.pollIntervalSec ?? 3;
  const wsAlert = Array.isArray(data?.alerts) && data.alerts.some((a) => a?.kind === 'ws_disconnected');
  const wsLabel = data?.useWebSocket === false ? null : (wsAlert ? 'WS KO' : 'WS OK');
  const signalPriceSource = data?.signalPriceSource;
  const signalPollHint =
    signalPriceSource === 'clob'
      ? 'Prix signal (poll) : best ask CLOB — aligné carnet'
      : signalPriceSource === 'gamma'
        ? 'Prix signal (poll) : outcomePrices Gamma'
        : null;

  return (
    <div className="w-full min-w-0 rounded-xl border border-slate-700/50 bg-slate-900/60 px-4 py-3 shadow-inner">
      {label && <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-offset-2 ring-offset-slate-900 ${
              loading ? 'animate-pulse bg-slate-500 ring-slate-600' : isOnline ? 'bg-emerald-500 ring-emerald-500/30' : 'bg-red-500 ring-red-500/30'
            }`}
            title={isOnline ? 'En ligne' : 'Hors ligne'}
          />
          <span className="text-sm font-medium text-slate-200">
            {loading ? '…' : isOnline ? 'En ligne' : error || 'Hors ligne'}
          </span>
          {uptimeStr && isOnline && (
            <span className="text-xs text-slate-500">({uptimeStr})</span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isOnline && !loading && (
            <span
              className="text-[11px] text-slate-500 font-medium tabular-nums"
              title={[signalPollHint, 'Ordre au marché ou limite, intervalle poll'].filter(Boolean).join(' · ')}
            >
              {orderLabel} · {pollSec}s
              {signalPriceSource === 'clob' && (
                <span className="text-cyan-400/90"> · sig. CLOB</span>
              )}
              {signalPriceSource === 'gamma' && (
                <span className="text-slate-400"> · sig. Gamma</span>
              )}
            </span>
          )}
          {isOnline && !loading && wsLabel && (
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
                wsAlert ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
              title={wsAlert ? 'WebSocket CLOB déconnecté depuis trop longtemps (polling continue).' : 'WebSocket CLOB connecté.'}
            >
              {wsLabel}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded-lg border border-slate-600 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-50 transition-colors"
          >
            Rafraîchir
          </button>
        </div>
      </div>
    </div>
  );
}

const PERIODS = [
  { label: '24 h', ms: 24 * 60 * 60 * 1000 },
  { label: '3 j', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '7 j', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Carte : courbe du solde dans le temps (balanceHistory) + PnL + période + export CSV. */
export function BotBalanceChart() {
  const statusUrl = DEFAULT_BOT_STATUS_URL;
  const { data, loading } = useBotStatus(statusUrl);
  const [periodIndex, setPeriodIndex] = useState(2); // 7j par défaut
  const [now, setChartNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setChartNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!statusUrl) return null;

  const history = data?.balanceHistory ?? [];
  const fullChartData = history.map((p) => ({
    at: p.at,
    atMs: p.at ? new Date(p.at).getTime() : 0,
    time: p.at ? new Date(p.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '',
    date: p.at ? new Date(p.at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '',
    balance: p.balance != null ? Number(p.balance) : 0,
  }));

  const periodMs = PERIODS[periodIndex]?.ms ?? PERIODS[2].ms;
  const cutoff = now - periodMs;
  const chartData = fullChartData.filter((d) => d.atMs >= cutoff);

  const firstBalance = chartData.length > 0 ? chartData[0].balance : null;
  const lastBalance = data?.balanceUsd != null ? Number(data.balanceUsd) : (chartData.length > 0 ? chartData[chartData.length - 1].balance : null);
  const pnl = firstBalance != null && lastBalance != null && firstBalance > 0 ? lastBalance - firstBalance : null;

  const exportCsv = () => {
    if (fullChartData.length === 0) return;
    const headers = 'date;heure;solde_usd\n';
    const rows = fullChartData.map((d) => `${d.date};${d.time};${d.balance.toFixed(2)}`).join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `solde-bot-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && fullChartData.length === 0) return null;

  return (
    <Card className="relative border border-border/60 bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-500/10 via-cyan-500/0 to-emerald-500/10"
      />
      <CardHeader className="relative z-10 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Solde bot (évolution)</CardTitle>
            <p className="text-sm text-muted-foreground">
              Derniers points enregistrés par le bot. {pnl != null && <span>PnL sur la période : <strong className={pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} $</strong></span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Période :</span>
            {PERIODS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setPeriodIndex(i)}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${periodIndex === i ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
              >
                {p.label}
              </button>
            ))}
            {fullChartData.length > 0 && (
              <button
                type="button"
                onClick={exportCsv}
                className="rounded px-2 py-1 text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
              >
                Export CSV
              </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative z-10">
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune donnée sur cette période.</p>
        ) : (
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v, i) => chartData[i]?.time ?? v} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(0)} $`} />
                <Tooltip content={({ payload }) => (payload?.[0] ? <span className="text-sm">{payload[0].value?.toFixed(2)} $</span> : null)} />
                <Line type="monotone" dataKey="balance" stroke="rgb(52 211 153)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
