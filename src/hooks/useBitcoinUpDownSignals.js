import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const MIN_PRICE = 0.97;
const MAX_PRICE = 0.975;

// Uniquement les événements "Bitcoin Up or Down - Hourly" (slug du type bitcoin-up-or-down-march-14-6pm-et)
const BITCOIN_UP_DOWN_HOURLY_SLUG = 'bitcoin-up-or-down';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';

/** Fin de créneau UTC (ms) depuis le slug btc-updown-15m-{unixSec} — aligné bot / Polymarket. */
function slotEndMsFrom15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const ts = parseInt(m[1], 10);
  if (!Number.isFinite(ts)) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

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

/** Charge les events 15m actifs (liste Gamma + secours slug courant, comme le bot). */
async function fetchActive15mEvents() {
  const slugMatch = BITCOIN_UP_DOWN_15M_SLUG;
  let events = [];
  try {
    const { data } = await axios.get(GAMMA_EVENTS_URL, {
      params: { active: true, closed: false, limit: 150, slug_contains: slugMatch },
      timeout: 15000,
    });
    events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
  } catch (err) {
    if (err.response?.status === 422 || err.response?.status === 400) {
      const { data } = await axios.get(GAMMA_EVENTS_URL, {
        params: { active: true, closed: false, limit: 200 },
        timeout: 15000,
      });
      events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) =>
        (ev.slug ?? '').toLowerCase().includes(slugMatch)
      );
    } else {
      throw err;
    }
  }
  const hasMatch = events.some((ev) => (ev.slug ?? '').toLowerCase().includes(slugMatch));
  if (!hasMatch) {
    const nowSec = Math.floor(Date.now() / 1000);
    const slotEnd = Math.ceil(nowSec / 900) * 900;
    const currentSlug = `${BITCOIN_UP_DOWN_15M_SLUG}-${slotEnd}`;
    try {
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(currentSlug)}`, {
        timeout: 8000,
      });
      if (ev && (ev.slug ?? '').toLowerCase().includes(slugMatch)) events = [ev];
    } catch {
      /* 404 ou réseau */
    }
  }
  return events;
}

/**
 * Signaux 97–97,5 % pour le marché horaire ou 15 min.
 * @param {'hourly' | '15m'} marketMode — défaut `hourly`. En `15m`, même logique que le bot (slug_contains + secours slug).
 */
export function useBitcoinUpDownSignals(marketMode = 'hourly') {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSignals = useCallback(async () => {
    setError(null);
    try {
      let events = [];
      if (marketMode === '15m') {
        events = await fetchActive15mEvents();
      } else {
        const { data } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, limit: 150 },
          timeout: 15000,
        });
        events = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
      }

      const results = [];
      for (const ev of events) {
        if (!ev?.markets?.length) continue;
        const eventSlug = (ev.slug ?? '').toLowerCase();
        if (marketMode === '15m') {
          if (!eventSlug.includes(BITCOIN_UP_DOWN_15M_SLUG)) continue;
        } else if (!eventSlug.includes(BITCOIN_UP_DOWN_HOURLY_SLUG)) continue;

        const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
        const slotEndMs = marketMode === '15m' ? slotEndMsFrom15mSlug(ev.slug ?? '') : null;

        for (const m of ev.markets) {
          const prices = parsePrices(m);
          if (!prices) continue;
          const [priceUp, priceDown] = prices;
          const upInRange = priceUp >= MIN_PRICE && priceUp <= MAX_PRICE;
          const downInRange = priceDown >= MIN_PRICE && priceDown <= MAX_PRICE;
          const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
          /** Pour 15m : fin de créneau depuis le slug (Gamma `endDate` souvent décalé). */
          const endDateForSignal =
            slotEndMs != null && Number.isFinite(slotEndMs) ? new Date(slotEndMs).toISOString() : marketEndDate;

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
              endDate: endDateForSignal,
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
              endDate: endDateForSignal,
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
  }, [marketMode]);

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
