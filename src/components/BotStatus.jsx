import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const DEFAULT_STATUS_URL = import.meta.env.VITE_BOT_STATUS_URL || '';

function useBotStatus(url, refreshIntervalMs = 15000) {
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
      const res = await fetch(`${url.replace(/\/$/, '')}/api/bot-status?lines=25`, { method: 'GET' });
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

export function BotStatus() {
  const statusUrl = DEFAULT_STATUS_URL;
  const { data, loading, error, refresh } = useBotStatus(statusUrl);

  if (!statusUrl) {
    return (
      <Card className="border border-amber-500/30 bg-card/90 backdrop-blur-md rounded-2xl overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-xl font-semibold tracking-tight">Statut du bot</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Définis <code className="rounded bg-muted px-1">VITE_BOT_STATUS_URL</code> (ex. http://TON_IP:3001) dans un fichier <code className="rounded bg-muted px-1">.env</code> à la racine du projet pour afficher le statut.
          </p>
        </CardHeader>
      </Card>
    );
  }

  const isOnline = data?.status === 'online';
  const uptimeMs = data?.uptime ? Date.now() - data.uptime : null;
  const uptimeStr = uptimeMs != null
    ? (() => {
        const s = Math.floor(uptimeMs / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h) return `${h}h ${m % 60}min`;
        if (m) return `${m} min`;
        return `${s} s`;
      })()
    : null;

  return (
    <Card className="border border-border/60 bg-card/90 backdrop-blur-md shadow-xl shadow-black/10 rounded-2xl overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-xl font-semibold tracking-tight">Statut du bot</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Lightsail — dernier refresh toutes les 15 s.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-3 w-3 rounded-full ${
                loading ? 'animate-pulse bg-muted' : isOnline ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              title={isOnline ? 'En ligne' : 'Hors ligne'}
            />
            <span className="text-sm font-medium text-muted-foreground">
              {loading ? '…' : isOnline ? 'En ligne' : error || 'Hors ligne'}
            </span>
            {uptimeStr && isOnline && (
              <span className="text-xs text-muted-foreground">(uptime {uptimeStr})</span>
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
            >
              Rafraîchir
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error && !data && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Impossible de joindre le serveur de statut. Vérifie que le port 3001 est ouvert sur Lightsail et que <code className="rounded bg-muted px-1">bot-status-server</code> tourne (pm2 list).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
