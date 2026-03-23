import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { liquidityUsdFromAsks, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P } from '@/lib/orderBookLiquidity.js';

const CLOB_BOOK_URL = import.meta.env.DEV ? '/apiClob/book' : 'https://clob.polymarket.com/book';

/**
 * Récupère le carnet d'ordres pour un token et calcule la liquidité (en USD) disponible
 * dans la bande signal (ex. 96 % – 98 %, `ORDER_BOOK_SIGNAL_*`). La moyenne sur 3 jours est collectée par le bot et exposée via l'API status.
 * @param {string | null} tokenId - token_id du côté à acheter (Up ou Down)
 * @returns {{ liquidityUsd: number | null, loading: boolean, error: string | null, refresh: () => void }}
 */
export function useOrderBookLiquidity(tokenId) {
  const [liquidityUsd, setLiquidityUsd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchBook = useCallback(async () => {
    if (!tokenId || typeof tokenId !== 'string') {
      setLiquidityUsd(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(CLOB_BOOK_URL, {
        params: { token_id: tokenId },
        timeout: 8000,
      });
      const asks = data?.asks ?? [];
      const totalUsd = liquidityUsdFromAsks(asks, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P);
      setLiquidityUsd(totalUsd > 0 ? totalUsd : null);
    } catch (err) {
      setError(err.message || 'Impossible de charger le carnet');
      setLiquidityUsd(null);
    } finally {
      setLoading(false);
    }
  }, [tokenId]);

  useEffect(() => {
    fetchBook();
  }, [fetchBook]);

  return { liquidityUsd, loading, error, refresh: fetchBook };
}
