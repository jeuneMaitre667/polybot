import { useState, useEffect, useCallback } from 'react';

export const DEFAULT_BOT_STATUS_URL = import.meta.env.VITE_BOT_STATUS_URL || '';

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
