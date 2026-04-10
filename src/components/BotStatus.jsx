import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useBotStatus, DEFAULT_BOT_STATUS_URL, DEFAULT_BOT_STATUS_URL_15M } from '@/hooks/useBotStatus.js';




/** Badge compact pour le header : pastille + statut + uptime + config (marché · 3s) + résultats + Rafraîchir. Optionnel : statusUrl + label (ex. "15m"). */
export function BotStatusBadge({ statusUrl: statusUrlProp, label, refreshIntervalMs = 2000 }) {
  const statusUrl = statusUrlProp ?? DEFAULT_BOT_STATUS_URL;
  const { data, loading, error, refresh } = useBotStatus(statusUrl, refreshIntervalMs);
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
  const uptimeMs = data?.uptime
    ? now - data.uptime
    : data?.timestamp
      ? now - Number(data.timestamp)
      : null;
  const orderLabel = data?.useMarketOrder !== false ? 'marché' : 'limite';
  const pollSec = data?.pollIntervalSec ?? 3;
  const isWsOnline = data?.wsConnected === true;
  const wsAlert = Array.isArray(data?.alerts) && data.alerts.some((a) => a?.kind === 'ws_disconnected');
  const wsLabel = data?.useWebSocket === false ? null : (isWsOnline ? 'WS OK' : 'WS KO');
  const signalPriceSource = data?.signalPriceSource;
  const signalPollHint =
    signalPriceSource === 'clob'
      ? 'Prix signal (poll) : best ask CLOB — aligné carnet'
      : signalPriceSource === 'gamma'
        ? 'Prix signal (poll) : outcomePrices Gamma'
        : null;

  return (
    <div
      className="bot-pill"
      title={[signalPollHint, `Ordre au marché ou limite, poll ${pollSec}s`].filter(Boolean).join(' · ')}
    >
      <span 
        className="status-dot"
        style={{ 
          width: '8px', 
          height: '8px', 
          borderRadius: '50%', 
          backgroundColor: isOnline ? '#10b981' : (loading ? '#3b82f6' : '#ef4444'),
          boxShadow: isOnline ? '0 0 10px #10b981' : 'none',
          animation: isOnline ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none'
        }}
      />
      <span className="name" style={{ fontWeight: 900, fontSize: '11px', letterSpacing: '0.1em' }}>{label || 'BOT'}</span>
      <span style={{ 
        fontSize: '10px', 
        fontWeight: 900, 
        textTransform: 'uppercase', 
        letterSpacing: '0.2em', 
        marginLeft: '10px',
        color: isOnline ? '#10b981' : 'rgba(255,255,255,0.2)'
      }}>
        {isOnline ? 'SNIPER LIVE' : (loading ? 'SYNCING...' : 'DISCONNECTED')}
      </span>
      <span className="tag-sep">·</span>
      <span className="tag tag-sig">
        sig. {signalPriceSource === 'clob' ? 'CLOB' : signalPriceSource === 'gamma' ? 'Gamma' : orderLabel}
      </span>
      {wsLabel && <span className={`tag ${wsAlert ? 'tag-ws-ko' : 'tag-ws'}`}>{wsLabel}</span>}
      <button type="button" onClick={refresh} disabled={loading} className="bot-pill-refresh" aria-label="Rafraîchir">
        ↻
      </button>
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
  const [periodIndex, setPeriodIndex] = useState(2);
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
  const lastBalance = data?.balanceUsd != null
    ? Number(data.balanceUsd)
    : chartData.length > 0 ? chartData[chartData.length - 1].balance : null;
  const pnl = firstBalance != null && lastBalance != null && firstBalance > 0
    ? lastBalance - firstBalance : null;

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
    <div className="card" style={{ position: 'relative', overflow: 'hidden' }}>
      <div
        aria-hidden
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(135deg, rgba(139,92,246,0.08) 0%, rgba(0,255,136,0.04) 100%)',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <div>
            <div className="card-label">Solde bot (évolution)</div>
            {pnl != null && (
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                PnL sur la période :{' '}
                <strong style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} $
                </strong>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>Période :</span>
            {PERIODS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setPeriodIndex(i)}
                className="btn btn--xs"
                style={periodIndex === i
                  ? { background: 'var(--green)', borderColor: 'var(--green)', color: 'var(--bg-base)' }
                  : {}}
              >
                {p.label}
              </button>
            ))}
            {fullChartData.length > 0 && (
              <button type="button" onClick={exportCsv} className="btn btn--xs btn--outline">
                CSV
              </button>
            )}
          </div>
        </div>

        {chartData.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-2)' }}>Aucune donnée sur cette période.</p>
        ) : (
          <div style={{ height: 220, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: 'var(--text-2)' }}
                  tickFormatter={(v, i) => chartData[i]?.time ?? v}
                  axisLine={{ stroke: 'transparent' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#7b849a' }}
                  tickFormatter={(v) => `${v.toFixed(0)} $`}
                  axisLine={{ stroke: 'transparent' }}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--text-1)',
                  }}
                  content={({ payload }) =>
                    payload?.[0]
                      ? <span style={{ fontSize: 12, color: 'var(--text-1)' }}>{payload[0].value?.toFixed(2)} $</span>
                      : null
                  }
                />
                <Line type="monotone" dataKey="balance" stroke="var(--green)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
