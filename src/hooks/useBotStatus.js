import { useState, useEffect, useCallback } from 'react';

export const DEFAULT_BOT_STATUS_URL = import.meta.env.VITE_BOT_STATUS_URL || '';
/** URL du serveur de statut du bot 15m (optionnel). Ex. http://IP_BOT15M:3001 */
export const DEFAULT_BOT_STATUS_URL_15M = import.meta.env.VITE_BOT_STATUS_URL_15M || '';

/** Normalise une URL de statut pour comparaison (trim, sans slash final). */
export function normalizeBotStatusUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Vrai si les deux variables pointent vers le même endpoint : le dashboard ne peut pas
 * distinguer le bot 1h du 15m (même JSON /api/bot-status).
 */
export function areBotStatusUrlsDuplicate(url1h, url15m) {
  const a = normalizeBotStatusUrl(url1h);
  const b = normalizeBotStatusUrl(url15m);
  return a !== '' && b !== '' && a === b;
}

export function useBotStatus(url, refreshIntervalMs = 15000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const baseUrl = (url && url.startsWith('http'))
    ? url.replace(/\/$/, '') + '/api/bot-status'
    : null;

  const fetchStatus = useCallback(async () => {
    if (!baseUrl) return;

    const fetchUrl = `${baseUrl}?t=${Date.now()}`;
    setError(null);
    try {
      const res = await fetch(fetchUrl, { method: 'GET' });
      if (!res.ok) throw new Error(res.status === 401 ? 'Token invalide' : `HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e?.message || 'Hors ligne ou indisponible');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (!baseUrl) {
      setLoading(false);
      return;
    }

    fetchStatus();
    const t = setInterval(fetchStatus, refreshIntervalMs);
    return () => clearInterval(t);
  }, [baseUrl, refreshIntervalMs, fetchStatus]);

  return { data, loading, error, refresh: fetchStatus };
}
