import { useMemo, useState, useId, useEffect } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useWallet } from '../context/useWallet';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { useBridgeDeposits } from '../hooks/useBridgeDeposits';
import { resolveTradeHistoryAddress, tradeHistorySourceLabel } from '../lib/tradeHistoryAddress.js';
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

function makeEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultManualEntries() {
  return [
    { id: makeEntryId(), date: format(new Date(Date.now() - 24 * 60 * 60 * 1000), 'yyyy-MM-dd'), amount: 4.71, label: 'Depot manuel' },
    { id: makeEntryId(), date: format(new Date(), 'yyyy-MM-dd'), amount: 10.37, label: 'Depot manuel' },
  ];
}

function loadManualEntries(historyAddress) {
  if (!historyAddress) return [];
  try {
    const key = `trade-history-topups:${historyAddress.toLowerCase()}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    // Fallback de migration: reprendre la dernière liste existante
    // si l'adresse source a changé (wallet -> bot funder, etc.).
    let best = null;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('trade-history-topups:')) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      try {
        const arr = JSON.parse(v);
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (!best || arr.length > best.length) best = arr;
      } catch {
        // ignore parse issues
      }
    }
    if (best) return best;
    return defaultManualEntries();
  } catch {
    return defaultManualEntries();
  }
}

/** Notional USDC du fill (Data API : `size` × `price`, price 0–1). */
function tradeNotionalUsdc(t) {
  const size = Number(t.size) || 0;
  const price = Number(t.price) || 0;
  const n = Math.abs(size * price);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function tradeStakeUsdc(t) {
  const n = tradeNotionalUsdc(t);
  return n > 0 ? n : null;
}

/** Cashflow signé : achat = sortie d’USDC (−), vente = entrée (+). Côté normalisé en majuscules. */
function tradeCashflowSigned(t) {
  const n = tradeNotionalUsdc(t);
  if (n <= 0) return 0;
  const side = String(t?.side ?? '').toUpperCase();
  if (side === 'BUY') return -n;
  if (side === 'SELL') return n;
  return 0;
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

/**
 * @param {{
 *   hideCardTitle?: boolean,
 *   botFunderCandidates?: (string|null|undefined)[],
 *   balanceHistory?: { at?: string, balance?: number|string }[] | null,
 *   currentBalanceUsd?: number|null,
 *   useRealBalancePnl?: boolean,
 *   balanceReconcilesWithDisplayedBalance?: boolean
 * }} props
 * botFunderCandidates : ex. clobFunderAddress depuis last-order (15m puis horaire) — aligné sur le compte Polymarket du bot.
 */
export function TradeHistory({
  hideCardTitle = false,
  botFunderCandidates = [],
  balanceHistory = null,
  currentBalanceUsd = null,
  useRealBalancePnl = true,
  /** false si le solde affiché ailleurs est l’USDC on-chain alors que la courbe vient des relevés bot. */
  balanceReconcilesWithDisplayedBalance = true,
}) {
  const { address } = useWallet();
  const { address: historyAddress, source: historySource } = useMemo(
    () =>
      resolveTradeHistoryAddress({
        connectedAddress: address,
        botFunderCandidates,
      }),
    [address, botFunderCandidates],
  );
  const { trades, loading, error, refresh } = useTradeHistory(historyAddress, { limit: 200 });
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [manualEntries, setManualEntries] = useState(() => loadManualEntries(historyAddress));
  const [newManualDate, setNewManualDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [newManualAmount, setNewManualAmount] = useState('');
  const [newManualLabel, setNewManualLabel] = useState('');
  const chartGradId = `trade-cumul-${useId().replace(/:/g, '')}`;
  const [chartMode, setChartMode] = useState('balance');
  const {
    loading: bridgeLoading,
    error: bridgeError,
    depositAddress: bridgeDepositAddress,
    items: bridgeDeposits,
    unsupportedItems: bridgeUnsupportedDeposits,
    inferredTopupItems: bridgeInferredTopups,
    totalApproxUsdc: bridgeTotalApproxUsdc,
    refresh: refreshBridgeDeposits,
  } = useBridgeDeposits(historyAddress);

  useEffect(() => {
    if (!historyAddress) return;
    // setState différé: évite le pattern sync setState-in-effect
    // tout en rechargeant correctement les entrées quand l'adresse change.
    const id = setTimeout(() => {
      setManualEntries(loadManualEntries(historyAddress));
    }, 0);
    return () => clearTimeout(id);
  }, [historyAddress]);

  useEffect(() => {
    if (!historyAddress) return;
    try {
      localStorage.setItem(`trade-history-topups:${historyAddress.toLowerCase()}`, JSON.stringify(manualEntries));
    } catch {
      // ignore localStorage write errors
    }
  }, [historyAddress, manualEntries]);

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
      const sa = tradeStakeUsdc(a) ?? 0;
      const sb = tradeStakeUsdc(b) ?? 0;
      if (sortBy === 'date_asc') return ta - tb;
      if (sortBy === 'stake_desc') return sb - sa;
      if (sortBy === 'stake_asc') return sa - sb;
      return tb - ta;
    });
  }, [trades, search, dateFrom, dateTo, sortBy]);

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
    return tradesToday.reduce((acc, t) => acc + tradeCashflowSigned(t), 0);
  }, [tradesToday]);

  const buysToday = useMemo(() => {
    return tradesToday.reduce((acc, t) => {
      if (t?.side !== 'BUY') return acc;
      const stake = tradeStakeUsdc(t);
      return acc + (stake ?? 0);
    }, 0);
  }, [tradesToday]);

  const sellsToday = useMemo(() => {
    return tradesToday.reduce((acc, t) => {
      if (t?.side !== 'SELL') return acc;
      const stake = tradeStakeUsdc(t);
      return acc + (stake ?? 0);
    }, 0);
  }, [tradesToday]);

  const realPnlToday = useMemo(() => {
    if (!useRealBalancePnl) return null;
    const history = Array.isArray(balanceHistory) ? balanceHistory : [];
    if (history.length === 0) return null;
    const start = today.start;
    const dayPoints = history
      .map((p) => ({
        atMs: p?.at ? new Date(p.at).getTime() : NaN,
        balance: Number(p?.balance),
      }))
      .filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.balance))
      .sort((a, b) => a.atMs - b.atMs);
    if (dayPoints.length === 0) return null;
    const firstIdx = dayPoints.findIndex((p) => p.atMs >= start);
    const first = firstIdx >= 0 ? dayPoints[firstIdx] : dayPoints[0];
    const lastBalance = Number.isFinite(Number(currentBalanceUsd))
      ? Number(currentBalanceUsd)
      : dayPoints[dayPoints.length - 1].balance;
    if (!Number.isFinite(first.balance) || !Number.isFinite(lastBalance)) return null;
    return lastBalance - first.balance;
  }, [balanceHistory, currentBalanceUsd, today.start, useRealBalancePnl]);

  const manualAdjustment = useMemo(
    () =>
      (manualEntries || []).reduce((acc, e) => {
        const n = Number(e?.amount);
        return acc + (Number.isFinite(n) && n >= 0 ? n : 0);
      }, 0),
    [manualEntries],
  );

  const netPnlSinceTopup = useMemo(() => {
    const balance = Number(currentBalanceUsd);
    if (!Number.isFinite(balance)) return null;
    return balance - bridgeTotalApproxUsdc - manualAdjustment;
  }, [currentBalanceUsd, bridgeTotalApproxUsdc, manualAdjustment]);

  const overviewMetricValue = realPnlToday != null ? realPnlToday : netPnlSinceTopup;
  const overviewMetricLabel =
    realPnlToday != null
      ? 'PnL réel du jour (solde bot)'
      : netPnlSinceTopup != null
        ? 'PnL net session (solde - dépôts)'
        : 'Cashflow trades du jour (estim.)';
  const overviewFallbackValue = overviewMetricValue ?? fluxToday;

  const pnlCurve = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      const ta = a.timestamp != null ? (a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000) : 0;
      const tb = b.timestamp != null ? (b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000) : 0;
      return ta - tb;
    });
    return sorted.reduce((acc, t) => {
      const prevCum = acc.length ? acc[acc.length - 1].cumul : 0;
      const cum = prevCum + tradeCashflowSigned(t);
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

  const realBalanceCurve = useMemo(() => {
    const history = Array.isArray(balanceHistory) ? balanceHistory : [];
    const points = history
      .map((p) => {
        const ts = p?.at ? new Date(p.at).getTime() : NaN;
        const balance = Number(p?.balance);
        return { ts, balance };
      })
      .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.balance))
      .sort((a, b) => a.ts - b.ts);
    return points.map((p) => ({
      cumul: Math.round(p.balance * 100) / 100,
      ts: p.ts,
      date: format(new Date(p.ts), 'dd/MM/yy HH:mm', { locale: fr }),
      axisDate: format(new Date(p.ts), 'dd/MM', { locale: fr }),
    }));
  }, [balanceHistory]);

  const hasRealBalanceCurve = realBalanceCurve.length > 1;
  const effectiveChartMode = chartMode === 'balance' && hasRealBalanceCurve ? 'balance' : 'flow';
  const chartData = effectiveChartMode === 'balance' ? realBalanceCurve : pnlCurve;
  const chartTitle =
    effectiveChartMode === 'balance'
      ? 'Courbe solde bot (USDC, inclut redeem)'
      : 'Flux cumulé trades (coût achats − ventes, USDC)';
  const chartHint =
    effectiveChartMode === 'flow'
      ? 'Basé sur la Data API (fills marché uniquement). N’inclut pas les redeem, dépôts bridge ni les frais au-delà du notionnel size×price — peut diverger du solde réel.'
      : effectiveChartMode === 'balance' && hasRealBalanceCurve && !balanceReconcilesWithDisplayedBalance
        ? 'Courbe = relevés bot (status). Le solde affiché en vue d’ensemble peut être l’USDC on-chain du wallet.'
        : null;

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
            Trades Polymarket (Data API) pour l’adresse affichée ci‑dessous : en priorité{' '}
            <code className="trade-history-code-inline">VITE_TRADE_HISTORY_ADDRESS</code>, sinon le{' '}
            <strong>funder</strong> remonté par le bot (<code className="trade-history-code-inline">last-order</code>
            ), sinon le wallet connecté. Sur un compte email / proxy, l’adresse du <strong>profil Polymarket</strong> peut
            différer de l’EOA MetaMask — d’où cette résolution automatique.
          </p>
        </div>
        <div className="trade-history-actions">
          <button
            type="button"
            onClick={() => exportCSV(filtered, csvColumns)}
            disabled={!historyAddress || filtered.length === 0}
            className="btn btn--default btn--outline trade-history-action-btn"
          >
            Exporter CSV
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading || !historyAddress}
            className="btn btn--default btn--outline trade-history-action-btn"
          >
            Rafraîchir
          </button>
        </div>
      </div>

      <div className="trade-history-content">
        {!historyAddress ? (
          <p className="trade-history-connect-msg">
            Aucune adresse pour l’historique : définis{' '}
            <code className="trade-history-code-inline">VITE_TRADE_HISTORY_ADDRESS</code> (adresse Profil Polymarket),
            ou laisse le bot enregistrer un <code className="trade-history-code-inline">last-order</code> avec{' '}
            <code className="trade-history-code-inline">clobFunderAddress</code>, ou connecte un wallet.
          </p>
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
                <span className="trade-stat-label">{overviewMetricLabel}</span>
                <span
                  className={`trade-stat-value ${
                    overviewFallbackValue >= 0 ? 'trade-stat-value--green' : 'trade-stat-value--red'
                  }`}
                >
                  {overviewFallbackValue >= 0 ? '+' : ''}
                  {overviewFallbackValue.toFixed(2)} $
                </span>
                <span className="trade-stat-sub">
                  Cashflow trades: {fluxToday >= 0 ? '+' : ''}{fluxToday.toFixed(2)} $ (achats {buysToday.toFixed(2)} $ / ventes {sellsToday.toFixed(2)} $)
                </span>
              </div>
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Total trades</span>
                <span className="trade-stat-value">{trades.length}</span>
              </div>
              <div className="trade-stat-cell">
                <span className="trade-stat-label">Adresse (Data API)</span>
                <span className="trade-stat-value trade-stat-value--mono" title={historyAddress}>
                  {formatWalletShort(historyAddress)}
                </span>
                <span className="trade-stat-sub">{tradeHistorySourceLabel(historySource)}</span>
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
              <label className="trade-filter-label">
                <span>Tri</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input-trade">
                  <option value="date_desc">Date (récent → ancien)</option>
                  <option value="date_asc">Date (ancien → récent)</option>
                  <option value="stake_desc">Stake (grand → petit)</option>
                  <option value="stake_asc">Stake (petit → grand)</option>
                </select>
              </label>
            </div>

            <div className="trade-filters-row trade-filters-row--overview">
              <label className="trade-filter-label">
                <span>Date apport</span>
                <input
                  type="date"
                  value={newManualDate}
                  onChange={(e) => setNewManualDate(e.target.value)}
                  className="input-trade"
                />
              </label>
              <label className="trade-filter-label">
                <span>Montant (USDC)</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="ex. 1.25"
                  value={newManualAmount}
                  onChange={(e) => setNewManualAmount(e.target.value)}
                  className="input-trade"
                />
              </label>
              <label className="trade-filter-label">
                <span>Libellé</span>
                <input
                  type="text"
                  placeholder="ex. Dépôt POL"
                  value={newManualLabel}
                  onChange={(e) => setNewManualLabel(e.target.value)}
                  className="input-trade"
                />
              </label>
              <div className="trade-filter-label">
                <span>Ajout manuel</span>
                <button
                  type="button"
                  className="btn btn--default btn--outline trade-history-action-btn"
                  onClick={() => {
                    const n = Number(String(newManualAmount || '').replace(',', '.').trim());
                    if (!Number.isFinite(n) || n <= 0) return;
                    setManualEntries((prev) => [
                      {
                        id: makeEntryId(),
                        date: newManualDate || format(new Date(), 'yyyy-MM-dd'),
                        amount: Math.round(n * 100) / 100,
                        label: (newManualLabel || 'Dépôt manuel').trim(),
                      },
                      ...(prev || []),
                    ]);
                    setNewManualAmount('');
                    setNewManualLabel('');
                  }}
                >
                  Ajouter
                </button>
              </div>
              <div className="trade-filter-label">
                <span>Total manuel</span>
                <div className="trade-stat-value">{manualAdjustment.toFixed(2)} $</div>
              </div>
              <div className="trade-filter-label">
                <span>PNL net 15m (solde - dépôts bridge - ajustement)</span>
                <div className={`trade-stat-value ${(netPnlSinceTopup ?? 0) >= 0 ? 'trade-stat-value--green' : 'trade-stat-value--red'}`}>
                  {netPnlSinceTopup == null ? '—' : `${netPnlSinceTopup >= 0 ? '+' : ''}${netPnlSinceTopup.toFixed(2)} $`}
                </div>
              </div>
            </div>

            {manualEntries.length > 0 && (
              <div className="strat-table-wrap trade-history-table-wrap">
                <table className="strat-table">
                  <thead>
                    <tr>
                      <th className="strat-th">Date</th>
                      <th className="strat-th">Libellé</th>
                      <th className="strat-th strat-th--right">Montant</th>
                      <th className="strat-th">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualEntries.map((e, i) => (
                      <tr key={e.id || `man-${i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                        <td className="strat-td strat-muted">{e.date || '—'}</td>
                        <td className="strat-td">{e.label || 'Dépôt manuel'}</td>
                        <td className="strat-td strat-td--right">{Number(e.amount || 0).toFixed(2)} $</td>
                        <td className="strat-td">
                          <button
                            type="button"
                            className="btn btn--default btn--outline trade-history-action-btn"
                            onClick={() => setManualEntries((prev) => (prev || []).filter((x) => x.id !== e.id))}
                          >
                            Supprimer
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="trade-filters-row trade-filters-row--overview">
              <div className="trade-filter-label">
                <span>Dépôts bridge détectés (auto)</span>
                <div className="trade-stat-value">{bridgeTotalApproxUsdc.toFixed(2)} $</div>
                <span className="trade-stat-sub">
                  {bridgeLoading
                    ? 'Chargement…'
                    : `${bridgeDeposits.length} dépôt(s) bridge + ${bridgeInferredTopups.length} transfert(s) USDC entrants détectés`}
                </span>
                {bridgeError && <span className="trade-stat-sub strat-text-red">{bridgeError}</span>}
                {bridgeUnsupportedDeposits.length > 0 && (
                  <span className="trade-stat-sub">
                    Les dépôts non résolus sont exclus du total auto ; utilise l’ajustement manuel si besoin.
                  </span>
                )}
                {bridgeDepositAddress && (
                  <span className="trade-stat-sub trade-stat-value--mono" title={bridgeDepositAddress}>
                    adresse dépôt: {formatWalletShort(bridgeDepositAddress)}
                  </span>
                )}
              </div>
              <div className="trade-filter-label">
                <span>Actions</span>
                <button type="button" onClick={refreshBridgeDeposits} disabled={bridgeLoading || !historyAddress} className="btn btn--default btn--outline trade-history-action-btn">
                  Rafraîchir dépôts
                </button>
              </div>
            </div>

            {bridgeDeposits.length > 0 && (
              <div className="strat-table-wrap trade-history-table-wrap">
                <table className="strat-table">
                  <thead>
                    <tr>
                      <th className="strat-th">Date</th>
                      <th className="strat-th">Token source</th>
                      <th className="strat-th strat-th--right">Montant approx</th>
                      <th className="strat-th">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bridgeDeposits.slice(0, 50).map((d, i) => (
                      <tr key={`${d.txHash || 'dep'}-${i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                        <td className="strat-td strat-muted strat-td--nowrap">
                          {d.createdTimeMs ? formatDate(d.createdTimeMs) : '—'}
                        </td>
                        <td className="strat-td strat-muted">
                          {d.fromSymbol || 'token'} (chain {d.fromChainId || '—'})
                        </td>
                        <td className="strat-td strat-td--right">
                          {d.amountUsdc != null ? `${Number(d.amountUsdc).toFixed(2)} $` : '—'}
                        </td>
                        <td className="strat-td trade-stat-value--mono" title={d.txHash || ''}>
                          {d.txHash ? `${d.txHash.slice(0, 10)}…${d.txHash.slice(-6)}` : '—'}
                          {d.valuationSource === 'onchain' ? ' (on-chain)' : d.valuationSource === 'approx_source' ? ' (approx)' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {bridgeInferredTopups.length > 0 && (
              <div className="strat-table-wrap trade-history-table-wrap">
                <table className="strat-table">
                  <thead>
                    <tr>
                      <th className="strat-th">Top-up détecté</th>
                      <th className="strat-th strat-th--right">Montant</th>
                      <th className="strat-th">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bridgeInferredTopups.slice(0, 50).map((d, i) => (
                      <tr key={`${d.txHash || 'inferred'}-${i}`} className={`strat-tbody-row ${i % 2 === 1 ? 'strat-tbody-row--stripe' : ''}`}>
                        <td className="strat-td strat-muted">Transfert entrant USDC.e (hors TRADE/REDEEM)</td>
                        <td className="strat-td strat-td--right">{d.amountUsdc != null ? `${Number(d.amountUsdc).toFixed(2)} $` : '—'}</td>
                        <td className="strat-td trade-stat-value--mono" title={d.txHash || ''}>
                          {d.txHash ? `${d.txHash.slice(0, 10)}…${d.txHash.slice(-6)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {chartData.length > 0 && (
              <div className="trade-chart-panel trade-chart-panel--overview">
                <div className="trade-history-top trade-history-top--chart">
                  <p className="trade-chart-panel-title">{chartTitle}</p>
                  {chartHint && (
                    <p className="trade-chart-panel-hint" style={{ fontSize: 11, color: 'var(--text-3)', margin: '4px 0 0', lineHeight: 1.45, maxWidth: 720 }}>
                      {chartHint}
                    </p>
                  )}
                  <div className="trade-history-actions">
                    <button
                      type="button"
                      onClick={() => setChartMode('balance')}
                      disabled={!hasRealBalanceCurve}
                      className="btn btn--default btn--outline trade-history-action-btn"
                      aria-pressed={effectiveChartMode === 'balance'}
                    >
                      Solde bot
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartMode('flow')}
                      className="btn btn--default btn--outline trade-history-action-btn"
                      aria-pressed={effectiveChartMode === 'flow'}
                    >
                      Flux trades
                    </button>
                  </div>
                </div>
                <div className="trade-chart-h trade-chart-h--overview">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
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
              <span>
                {tradeHistorySourceLabel(historySource)} · {formatWalletShort(historyAddress)}
              </span>
              <span className="trade-footer-sep"> — </span>
              <span className="trade-footer-api">Data API Polymarket</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
