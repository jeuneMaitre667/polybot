import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// Documentation: https://docs.polymarket.com/market-data/fetching-markets
// On utilise l'endpoint Events (recommandé) puis on aplatit les marchés.
const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_MARKETS_URL = import.meta.env.DEV ? '/api/markets' : 'https://gamma-api.polymarket.com/markets';

const REFRESH_INTERVAL_MS = 60 * 1000; // 60 secondes

/**
 * Extrait une liste plate de marchés depuis la réponse Gamma API.
 * - Si c'est un tableau d'events : on prend event.markets pour chaque event.
 * - Si c'est un tableau de marchés (fallback /markets) : on l'utilise tel quel.
 * - Normalise les champs (endDate / end_date_iso, etc.)
 */
function normalizeMarketsFromResponse(data) {
  if (!data) return [];
  // Réponse possible : { data: [...] } ou { results: [...] }
  let list = Array.isArray(data) ? data : data.data ?? data.results ?? [];
  if (!Array.isArray(list)) return [];

  const first = list[0];
  const isEventList =
    first &&
    typeof first === 'object' &&
    Array.isArray(first.markets);

  if (isEventList) {
    list = list.flatMap((ev) => {
      const eventEndDate =
        ev.endDate ??
        ev.end_date_iso ??
        ev.end_date ??
        ev.endDateIso ??
        ev.closedTime ??
        ev.finishedTimestamp ??
        '';
      const eventTags = ev.tags ?? [];
      const eventCategory = ev.category ?? ev.subcategory;
      const eventCategories = ev.categories ?? [];
      const tagsFromCategories = [
        ...(eventCategory ? [{ slug: String(eventCategory).toLowerCase().replace(/\s+/g, '-'), label: eventCategory }] : []),
        ...(Array.isArray(eventCategories) ? eventCategories.map((c) => ({
          slug: (c?.slug ?? c?.label ?? String(c)).toLowerCase().replace(/\s+/g, '-'),
          label: c?.label ?? c?.slug ?? String(c),
        })) : []),
      ];
      const allTags = [...eventTags, ...tagsFromCategories];
      const eventSlug = ev.slug ?? '';
      return (ev.markets ?? []).map((m) => ({
        ...m,
        endDate: m.endDate ?? m.end_date_iso ?? m.end_date ?? m.endDateIso ?? eventEndDate,
        tags: m.tags?.length ? m.tags : allTags,
        eventSlug: eventSlug || m.eventSlug,
      }));
    });
  }

  return list
    .filter((m) => m && (m.question || m.id || m.conditionId || m.slug))
    .map((m) => ({
      ...m,
      endDate: m.endDate ?? m.end_date_iso ?? m.endDateIso ?? '',
      volume: m.volume ?? m.volumeNum ?? '0',
      outcomePrices:
        m.outcomePrices ??
        (m.tokens && Array.isArray(m.tokens)
          ? JSON.stringify(m.tokens.map((t) => String(t.price ?? '0.5')))
          : '["0.5","0.5"]'),
      outcomes:
        m.outcomes ??
        (m.tokens && Array.isArray(m.tokens)
          ? JSON.stringify(m.tokens.map((t) => t.outcome ?? 'Yes'))
          : '["Yes","No"]'),
      tags: Array.isArray(m.tags) ? m.tags : [],
    }));
}

export function useMarkets() {
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);
    const limit = 200;

    try {
      const allEvents = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, limit, offset },
          timeout: 20000,
        });
        const list = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
        if (list.length === 0) break;
        allEvents.push(...list);
        if (list.length < limit) break;
        offset += limit;
      }

      const normalized = normalizeMarketsFromResponse(allEvents);
      if (normalized.length > 0) {
        setMarkets(normalized);
        setLoading(false);
        return;
      }
    } catch {
      // Ignorer, on tente le fallback
    }

    try {
      const allMarkets = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data } = await axios.get(GAMMA_MARKETS_URL, {
          params: { active: true, closed: false, limit, offset },
          timeout: 20000,
        });
        const list = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
        if (list.length === 0) break;
        allMarkets.push(...list);
        if (list.length < limit) break;
        offset += limit;
      }

      setMarkets(normalizeMarketsFromResponse(allMarkets));
    } catch (err) {
      const message =
        err.response?.status === 0 || err.code === 'ERR_NETWORK'
          ? 'Erreur réseau (CORS ou connexion). Relancez le serveur (npm run dev) pour activer le proxy.'
          : err.message || 'Erreur lors du chargement des marchés';
      setError(message);
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  useEffect(() => {
    const interval = setInterval(fetchMarkets, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  return { markets, loading, error, refresh: fetchMarkets };
}
