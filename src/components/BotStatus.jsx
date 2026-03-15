import { useState, useEffect, useCallback } from 'react';

const DEFAULT_STATUS_URL = import.meta.env.VITE_BOT_STATUS_URL || '';

export function useBotStatus(url, refreshIntervalMs = 15000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    if (!url || !url.startsWith('http')) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setError(null);
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/bot-status`, { method: 'GET' });
      if (!res.ok) throw new Error(res.status === 401 ? 'Token invalide' : `HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e?.message || 'Hors ligne ou indisponible');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    fetchStatus();
    if (!url || !url.startsWith('http')) {
      setLoading(false);
      return;
    }
    const t = setInterval(fetchStatus, refreshIntervalMs);
    return () => clearInterval(t);
  }, [url, refreshIntervalMs, fetchStatus]);

  return { data, loading, error, refresh: fetchStatus };
}

function uptimeStrFrom(uptimeMs) {
  if (uptimeMs == null) return null;
  const s = Math.floor(uptimeMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

/** Badge compact pour le header : pastille + statut + uptime + config (marché · 3s) + résultats + Rafraîchir */
export function BotStatusBadge() {
  const statusUrl = DEFAULT_STATUS_URL;
  const { data, loading, error, refresh } = useBotStatus(statusUrl);

  if (!statusUrl) return null;

  const isOnline = data?.status === 'online';
  const uptimeMs = data?.uptime ? Date.now() - data.uptime : null;
  const uptimeStr = uptimeStrFrom(uptimeMs);
  const orderLabel = data?.useMarketOrder !== false ? 'marché' : 'limite';
  const pollSec = data?.pollIntervalSec ?? 3;
  const balanceUsd = data?.balanceUsd;
  const lastOrder = data?.lastOrder;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-2.5 w-2.5 rounded-full shrink-0 ${
            loading ? 'animate-pulse bg-slate-500' : isOnline ? 'bg-emerald-500' : 'bg-red-500'
          }`}
          title={isOnline ? 'En ligne' : 'Hors ligne'}
        />
        <span className="text-sm font-medium text-slate-300">
          {loading ? '…' : isOnline ? 'En ligne' : error || 'Hors ligne'}
        </span>
        {uptimeStr && isOnline && (
          <span className="text-xs text-slate-500">(uptime {uptimeStr})</span>
        )}
        {isOnline && !loading && (
          <span className="text-xs text-slate-500" title="Ordre au marché, poll toutes les 3 s">
            {orderLabel} · {pollSec}s
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-lg border border-slate-600 bg-slate-800/50 px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-700/50 hover:text-slate-300 disabled:opacity-50 transition-colors"
        >
          Rafraîchir
        </button>
      </div>
      {isOnline && !loading && (balanceUsd != null || lastOrder) && (
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {balanceUsd != null && (
            <span>Solde : <span className="font-medium text-emerald-400/90">{Number(balanceUsd).toFixed(2)} $</span></span>
          )}
          {lastOrder && (
            <span title={lastOrder.at ? new Date(lastOrder.at).toLocaleString('fr-FR') : ''}>
              Dernier : <span className="font-medium text-slate-400">{lastOrder.takeSide}</span>
              {lastOrder.amountUsd != null && ` ${Number(lastOrder.amountUsd).toFixed(2)} $`}
              {lastOrder.at && ` · ${new Date(lastOrder.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
