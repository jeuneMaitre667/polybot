import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const MIN_PRICE = 0.968;
const MAX_PRICE = 0.97;

// Uniquement les événements "Bitcoin Up or Down - Hourly" (slug du type bitcoin-up-or-down-march-14-6pm-et)
const BITCOIN_UP_DOWN_HOURLY_SLUG = 'bitcoin-up-or-down';

function parsePrices(market) {
  try {
    const raw = market.outcomePrices ?? market.outcome_prices;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const p0 = parseFloat(arr[0]) ?? 0.5;
    const p1 = parseFloat(arr[1]) ?? 0.5;
    return [p0, p1];
  } catch {
    return null;
  }
}

/** Récupère le token ID à acheter : index 0 = Up, index 1 = Down. */
function getTokenIdToBuy(market, takeSide) {
  const idx = takeSide === 'Up' ? 0 : 1;
  const ids = market.clobTokenIds ?? market.clob_token_ids;
  if (Array.isArray(ids) && ids[idx]) return String(ids[idx]);
  const tokens = market.tokens;
  if (Array.isArray(tokens) && tokens[idx]?.token_id) return String(tokens[idx].token_id);
  return null;
}

/**
 * Détecte les marchés Bitcoin Up or Down - Hourly où un des deux prix est entre 96,8 % et 97 %.
 * Cible: https://polymarket.com/event/bitcoin-up-or-down-...
 */
export function useBitcoinUpDownSignals() {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSignals = useCallback(async () => {
    setError(null);
    try {
      const { data } = await axios.get(GAMMA_EVENTS_URL, {
        params: { active: true, closed: false, limit: 150 },
        timeout: 15000,
      });
      const events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
      const results = [];
      for (const ev of events) {
        if (!ev?.markets?.length) continue;
        const eventSlug = (ev.slug ?? '').toLowerCase();
        // Uniquement Bitcoin Up or Down - Hourly (slug du type bitcoin-up-or-down-march-14-6pm-et)
        if (!eventSlug.includes(BITCOIN_UP_DOWN_HOURLY_SLUG)) continue;
        const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
        for (const m of ev.markets) {
          const prices = parsePrices(m);
          if (!prices) continue;
          const [priceUp, priceDown] = prices;
          const upInRange = priceUp >= MIN_PRICE && priceUp <= MAX_PRICE;
          const downInRange = priceDown >= MIN_PRICE && priceDown <= MAX_PRICE;
          const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
          if (upInRange) {
            const takeSide = 'Up';
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide,
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(m, takeSide),
              marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
              endDate: marketEndDate,
            });
          } else if (downInRange) {
            const takeSide = 'Down';
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide,
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(m, takeSide),
              marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
              endDate: marketEndDate,
            });
          }
        }
      }
      setSignals(results);
    } catch (err) {
      setError(err.message || 'Erreur lors du chargement des signaux');
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSignals();
  }, [fetchSignals]);

  // Polling toutes les 5 s pour réduire la latence de détection du signal (compromis charge API)
  const POLL_INTERVAL_MS = 5 * 1000;
  useEffect(() => {
    const interval = setInterval(fetchSignals, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSignals, POLL_INTERVAL_MS]);

  return { signals, loading, error, refresh: fetchSignals };
}
