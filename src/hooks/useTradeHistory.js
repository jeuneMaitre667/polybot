import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const DATA_API_TRADES = '/apiData/trades';

/**
 * Récupère l'historique des trades Polymarket pour une adresse wallet (Data API).
 * @param {string | null} address - Adresse 0x du wallet connecté (ou null)
 * @param {{ limit?: number }} options - limit (défaut 100)
 */
export function useTradeHistory(address, options = {}) {
  const { limit = 100 } = options;
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchTrades = useCallback(async () => {
    if (!address || typeof address !== 'string' || !address.startsWith('0x')) {
      setTrades([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const normalizedAddress = address.toLowerCase();
      // data-api.polymarket.com usually expects 'user' or 'userAddress' parameter
      const { data } = await axios.get(DATA_API_TRADES, {
        params: { user: normalizedAddress, limit },
        timeout: 10000,
      });
      setTrades(Array.isArray(data) ? data : (data?.data || []));
    } catch (err) {
      const resp = err.response;
      if (resp?.status === 400) {
        // Fallback or more info
        console.warn(`[TradeHistory] 400 for ${address}. Resp:`, resp.data);
      }
      setError(err?.message || 'Erreur lors du chargement des trades');
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, [address, limit]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  return { trades, loading, error, refresh: fetchTrades };
}
