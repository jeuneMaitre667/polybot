import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { useWallet } from '../context/useWallet';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

function formatDate(ts) {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
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

export function TradeHistory() {
  const { address } = useWallet();
  const { trades, loading, error, refresh } = useTradeHistory(address, { limit: 200 });
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

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
      return [...acc, { date: format(new Date(ts), 'dd/MM HH:mm', { locale: fr }), cumul: Math.round(cum * 100) / 100, ts }];
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
    { label: 'Avg price', get: (t) => (t.price != null ? (Number(t.price) * 100).toFixed(1) + '%' : '') },
  ];

  return (
    <Card className="relative border border-border/60 bg-card/90 backdrop-blur-md shadow-xl shadow-black/10 rounded-2xl overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-500/40 via-cyan-500/18 to-emerald-500/40 opacity-100"
      />
      <CardHeader className="relative z-10 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl font-semibold tracking-tight">Historique des trades</CardTitle>
            <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
              Trades exécutés sur Polymarket pour le wallet connecté (Data API). Filtres, export CSV et courbe de flux (coût net cumulé).
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative z-10 space-y-4 pt-2">
        {!address ? (
          <p className="text-sm text-muted-foreground">Connecte ton wallet pour afficher l&apos;historique des trades.</p>
        ) : error ? (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Chargement des trades…</p>
        ) : trades.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun trade trouvé pour ce wallet.</p>
        ) : (
          <>
            <div className="rounded-lg border border-border/50 bg-muted/10 p-3 mb-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Trades aujourd&apos;hui</span>
                <span className="font-semibold">{tradesToday.length}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Flux du jour (estim.)</span>
                <span className={`font-semibold ${fluxToday >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {fluxToday >= 0 ? '+' : ''}{fluxToday.toFixed(2)} $
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Total trades (affiché)</span>
                <span className="font-semibold">{filtered.length}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Courbe</span>
                <span className="text-muted-foreground text-xs">Flux cumulé ci-dessous</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-end">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Recherche (marché, outcome)</span>
                <input
                  type="text"
                  placeholder="Filtrer…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Du</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Au</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </label>
              <button
                type="button"
                onClick={() => exportCSV(filtered, csvColumns)}
                disabled={filtered.length === 0}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Exporter CSV
              </button>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
              >
                Rafraîchir
              </button>
            </div>

            {pnlCurve.length > 0 && (
              <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">Flux cumulé (coût achats − ventes, USDC)</p>
                <div className="h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={pnlCurve} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                      <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" tickFormatter={(v) => `${v}`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                        labelFormatter={(_, payload) => payload[0]?.payload?.date}
                        formatter={(v) => [`${Number(v).toFixed(2)} USDC`, 'Cumul']}
                      />
                      <Line type="monotone" dataKey="cumul" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Marché</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Côté</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Outcome</th>
                    <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Taille</th>
                    <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stake (USDC)</th>
                    <th className="text-right py-3 px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Avg price</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t, i) => (
                    <tr
                      key={t.transactionHash ? `${t.transactionHash}-${i}` : `trade-${i}`}
                      className="border-b border-border/40 hover:bg-muted/20 transition-colors"
                    >
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{formatDate(t.timestamp)}</td>
                      <td className="py-3 px-3 max-w-[200px] truncate" title={t.title || t.slug}>
                        {t.title || t.slug || '—'}
                      </td>
                      <td className="py-3 px-3">
                        <span className={t.side === 'BUY' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                          {t.side === 'BUY' ? 'Achat' : 'Vente'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-muted-foreground">{t.outcome ?? '—'}</td>
                      <td className="py-3 px-3 text-right font-medium">{t.size != null ? Number(t.size).toFixed(2) : '—'}</td>
                      <td className="py-3 px-3 text-right">
                        {(() => {
                          const s = tradeStakeUsdc(t);
                          return s == null ? '—' : `${s.toFixed(2)} $`;
                        })()}
                      </td>
                      <td className="py-3 px-3 text-right">{formatPrice(t.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {filtered.length} trade(s) affiché(s){filtered.length !== trades.length ? ` (${trades.length} au total)` : ''}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
