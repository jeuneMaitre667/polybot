import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';

/** Fenêtre de prix pour la liquidité affichée : 97 % – 97,5 % (aligné avec le bot). */
const MIN_PRICE_TARGET = 0.97;
const MAX_PRICE_TARGET = 0.975;

/**
 * Récupère le carnet d'ordres pour un token et calcule la liquidité (en USD) disponible
 * dans la bande 97 % – 97,5 %. La moyenne sur 3 jours est collectée par le bot et exposée via l'API status.
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
      if (!Array.isArray(asks)) {
        setLiquidityUsd(null);
        return;
      }
      let totalUsd = 0;
      for (const level of asks) {
        const p = parseFloat(level?.price ?? level?.[0] ?? 0);
        const s = parseFloat(level?.size ?? level?.[1] ?? 0);
        if (p >= MIN_PRICE_TARGET && p <= MAX_PRICE_TARGET && s > 0) {
          totalUsd += p * s;
        }
      }
      setLiquidityUsd(totalUsd > 0 ? Math.round(totalUsd * 100) / 100 : null);
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
