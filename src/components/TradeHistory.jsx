import { useMemo, useState, useId } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useWallet } from '../context/useWallet';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

function formatDate(ts) {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatWalletShort(addr) {
  if (!addr || typeof addr !== 'string' || addr.length < 12) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatPrice(p) {
  if (p == null || Number.isNaN(p)) return '—';
  return `${(Number(p) * 100).toFixed(1)} %`;
}

function tradeStakeUsdc(t) {
  const size = Number(t.size) || 0;
  const price = Number(t.price) || 0;
  const stake = Math.abs(size * price);
  if (!Number.isFinite(stake) || stake <= 0) return null;
  return stake;
}

function tradeValue(t) {
  const size = Number(t.size) || 0;
  const price = Number(t.price) || 0;
  const v = size * price;
  return t.side === 'BUY' ? -v : v;
}

function exportCSV(trades, columns) {
  const header = columns.map((c) => c.label).join(',');
  const escape = (v) => (v == null ? '' : String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : v);
  const rows = trades.map((t) => columns.map((c) => escape(c.get(t))).join(','));
  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trades-polymarket-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function TradeHistory({ hideCardTitle = false }) {
  const { address } = useWallet();
  const { trades, loading, error, refresh } = useTradeHistory(address, { limit: 200 });
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const chartGradId = `trade-cumul-${useId().replace(/:/g, '')}`;

  const filtered = useMemo(() => {
    let list = Array.isArray(trades) ? [...trades] : [];
    const q = (search || '').toLowerCase().trim();
    if (q) {
      list = list.filter(
        (t) =>
          (t.title && t.title.toLowerCase().includes(q)) ||
          (t.slug && t.slug.toLowerCase().includes(q)) ||
          (t.outcome && t.outcome.toLowerCase().includes(q))
      );
    }
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      list = list.filter((t) => {
        const ts = t.timestamp != null ? (t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000) : 0;
        return new Date(ts) >= from;
      });
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      list = list.filter((t) => {
        const ts = t.timestamp != null ? (t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000) : 0;
        return new Date(ts) <= to;
      });
    }
    return list.sort((a, b) => {
      const ta = a.timestamp != null ? (a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000) : 0;
      const tb = b.timestamp != null ? (b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000) : 0;
      return tb - ta;
    });
  }, [trades, search, dateFrom, dateTo]);

  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return { start: start.getTime(), end: end.getTime() };
  }, []);

  const tradesToday = useMemo(() => {
    return (filtered || []).filter((t) => {
      const ts = t.timestamp != null ? (t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000) : 0;
      return ts >= today.start && ts <= today.end;
    });
  }, [filtered, today]);

  const fluxToday = useMemo(() => {
    return tradesToday.reduce((acc, t) => acc + tradeValue(t), 0);
  }, [tradesToday]);

  const pnlCurve = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      const ta = a.timestamp != null ? (a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000) : 0;
      const tb = b.timestamp != null ? (b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000) : 0;
      return ta - tb;
    });
    return sorted.reduce((acc, t) => {
      const prevCum = acc.length ? acc[acc.length - 1].cumul : 0;
      const cum = prevCum + tradeValue(t);
      const ts = t.timestamp != null ? (t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000) : 0;
      return [
        ...acc,
        {
          cumul: Math.round(cum * 100) / 100,
          ts,
          date: format(new Date(ts), 'dd/MM/yy HH:mm', { locale: fr }),
          axisDate: format(new Date(ts), 'dd/MM', { locale: fr }),
        },
      ];
    }, []);
  }, [filtered]);

  const csvColumns = [
    { label: 'Date', get: (t) => formatDate(t.timestamp) },
    { label: 'Marché', get: (t) => t.title || t.slug || '' },
    { label: 'Côté', get: (t) => (t.side === 'BUY' ? 'Achat' : 'Vente') },
    { label: 'Outcome', get: (t) => t.outcome ?? '' },
    { label: 'Taille', get: (t) => (t.size != null ? Number(t.size).toFixed(2) : '') },
    {
      label: 'Stake (USDC)',
      get: (t) => {
        const s = tradeStakeUsdc(t);
        return s == null ? '' : s.toFixed(2);
      },
    },
    { label: 'Avg price', get: (t) => (t.price != null ? `${(Number(t.price) * 100).toFixed(1)}%` : '') },
  ];

  return (
    <div className="card trade-history-card trade-history-card--overview">
      <div className="trade-history-top">
        <div className={`trade-history-top-text${hideCardTitle ? ' trade-history-top-text--no-title' : ''}`}>
          {!hideCardTitle && <h2 className="trade-history-title">Historique des trades</h2>}
          <p className="trade-history-desc">
            Trades exécutés sur Polymarket pour le wallet connecté (Data API). Filtres, export CSV et courbe de flux
            (coût net cumulé).
          </p>
        </div>
        <div className="trade-history-actions">
          <button
            type="button"
            onClick={() => exportCSV(filtered, csvColumns)}
            disabled={!address || filtered.length === 0}
            className="btn btn--default btn--outline trade-history-action-btn"
          >
            Exporter CSV
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading || !address}
            className="btn btn--default btn--outline trade-history-action-btn"
          >
            Rafraîchir
          </button>
        </div>
      </div>

      <div className="trade-history-content">
        {!address ? (
          <p className="trade-history-connect-msg">Connecte ton wallet pour afficher l&apos;historique des trades.</p>
        ) : error ? (
          <p className="strat-data-window__body strat-text-red">{error}</p>
        ) : loading ? (
          <p className="trade-history-connect-msg">Chargement des trades…</p>
        ) : trades.length === 0 ? (
          <p className="trade-history-connect-msg">Aucun trade trouvé pour ce wallet.</p>
        ) : (
          <>
            <div className="trade-stats-grid trade-stats-grid--overview">
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Trades aujourd&apos;hui</span>
                <span className="trade-stat-value">{tradesToday.length}</span>
              </div>
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Flux du jour (estim.)</span>
                <span className={`trade-stat-value ${fluxToday >= 0 ? 'trade-stat-value--green' : 'trade-stat-value--red'}`}>
                  {fluxToday >= 0 ? '+' : ''}
                  {fluxToday.toFixed(2)} $
                </span>
              </div>
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Total trades</span>
                <span className="trade-stat-value">{trades.length}</span>
              </div>
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Wallet</span>
                <span className="trade-stat-value trade-stat-value--mono">{formatWalletShort(address)}</span>
              </div>
            </div>

            <div className="trade-filters-row trade-filters-row--overview">
              <label className="trade-filter-label">
                <span>Recherche</span>
                <input
                  type="text"
                  placeholder="Filtrer par marché…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input-trade input-trade--search"
                />
              </label>
              <label className="trade-filter-label">
                <span>Du</span>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input-trade" />
              </label>
              <label className="trade-filter-label">
                <span>Au</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input-trade" />
              </label>
            </div>

            {pnlCurve.length > 0 && (
              <div className="trade-chart-panel trade-chart-panel--overview">
                <p className="trade-chart-panel-title">Flux cumulé (coût achats − ventes, USDC)</p>
                <div className="trade-chart-h trade-chart-h--overview">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={pnlCurve} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id={chartGradId} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--green)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--green)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis
                        dataKey="axisDate"
                        tick={{ fontSize: 10, fill: 'var(--text-3)' }}
                        axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={28}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'var(--text-3)' }}
                        axisLine={{ stroke: 'transparent' }}
                        tickLine={false}
                        tickFormatter={(v) => `${v}`}
                        width={44}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'var(--bg-card)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                          color: 'var(--text-1)',
                        }}
                        labelFormatter={(_, payload) => payload[0]?.payload?.date}
                        formatter={(v) => [`${Number(v).toFixed(2)} USDC`, 'Cumul']}
                      />
                      <Area
                        type="monotone"
                        dataKey="cumul"
                        stroke="var(--green)"
                        strokeWidth={2}
                        fill={`url(#${chartGradId})`}
                        dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="strat-table-wrap trade-history-table-wrap">
              <table className="strat-table">
                <thead>
                  <tr>
                    <th className="strat-th">Date</th>
                    <th className="strat-th">Marché</th>
                    <th className="strat-th">Côté</th>
                    <th className="strat-th">Outcome</th>
                    <th className="strat-th strat-th--right">Taille</th>
                    <th className="strat-th strat-th--right">Stake (USDC)</th>
                    <th className="strat-th strat-th--right">Avg price</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t, i) => (
                    <tr
                      key={t.transactionHash ? `${t.transactionHash}-${i}` : `trade-${i}`}
                      className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}
                    >
                      <td className="strat-td strat-muted strat-td--nowrap">{formatDate(t.timestamp)}</td>
                      <td className="strat-td strat-td--truncate-market" title={t.title || t.slug}>
                        {t.title || t.slug || '—'}
                      </td>
                      <td className="strat-td">
                        <span className={t.side === 'BUY' ? 'trade-side-buy' : 'trade-side-sell'}>
                          {t.side === 'BUY' ? 'Achat' : 'Vente'}
                        </span>
                      </td>
                      <td className="strat-td strat-muted">{t.outcome ?? '—'}</td>
                      <td className="strat-td strat-td--right strat-td--semi">{t.size != null ? Number(t.size).toFixed(2) : '—'}</td>
                      <td className="strat-td strat-td--right">
                        {(() => {
                          const s = tradeStakeUsdc(t);
                          return s == null ? '—' : `${s.toFixed(2)} $`;
                        })()}
                      </td>
                      <td className="strat-td strat-td--right">{formatPrice(t.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="trade-footer-note trade-footer-note--overview">
              <span>
                {filtered.length} trade(s) affiché(s)
                {filtered.length !== trades.length ? ` (${trades.length} au total chargés)` : ''}
              </span>
              <span className="trade-footer-sep"> — </span>
              <span>wallet {formatWalletShort(address)}</span>
              <span className="trade-footer-sep"> — </span>
              <span className="trade-footer-api">Data API Polymarket</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
