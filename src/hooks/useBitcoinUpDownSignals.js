import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  parseUpDownTokenIdsFromMarket,
  parseGammaOutcomePrices,
  getUpDownOutcomeIndices,
  resolveGammaMarketForBtcUpDown,
} from '@/lib/gammaPolymarket.js';
import { isLive15mEntryForbiddenNow } from '@/lib/bitcoin15mSlotEntryTiming.js';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
/**
 * GET /price : side=SELL → best **ask** (prix pour acheter le token). side=BUY → best **bid** (doc OpenAPI Polymarket).
 */
const CLOB_PRICE_URL = import.meta.env.DEV ? '/apiClob/price' : 'https://clob.polymarket.com/price';
const CLOB_PRICE_DIRECT = 'https://clob.polymarket.com/price';
const CLOB_BOOK_URL = import.meta.env.DEV ? '/apiClob/book' : 'https://clob.polymarket.com/book';
const CLOB_BOOK_DIRECT = 'https://clob.polymarket.com/book';
/** Fenêtre signal affichée / alignée bot (dashboard + `.env` bot). */
const MIN_PRICE = 0.96;
const MAX_SIGNAL_PRICE = 0.98;

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

async function getBestAskFromBookAtBase(bookUrl, tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(bookUrl, { params: { token_id: tokenId }, timeout: 5000 });
    const asks = data?.asks;
    if (!Array.isArray(asks) || asks.length === 0) return null;
    let best = Infinity;
    for (const level of asks) {
      const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
      if (Number.isFinite(p) && p > 0 && p < best) best = p;
    }
    return best === Infinity ? null : best;
  } catch {
    return null;
  }
}

/** Best ask CLOB — GET /price?side=SELL (doc Polymarket). Secours : premier niveau du carnet /book. */
async function getBestAskPriceAtBase(priceUrl, tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(priceUrl, {
      params: { token_id: tokenId, side: 'SELL' },
      timeout: 5000,
    });
    const p = parseFloat(data?.price);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

async function getBestAskPrice(tokenId) {
  let p = await getBestAskPriceAtBase(CLOB_PRICE_URL, tokenId);
  if (p == null && import.meta.env.DEV && String(CLOB_PRICE_URL).startsWith('/')) {
    p = await getBestAskPriceAtBase(CLOB_PRICE_DIRECT, tokenId);
  }
  if (p != null) return p;
  p = await getBestAskFromBookAtBase(CLOB_BOOK_URL, tokenId);
  if (p == null && import.meta.env.DEV && String(CLOB_BOOK_URL).startsWith('/')) {
    p = await getBestAskFromBookAtBase(CLOB_BOOK_DIRECT, tokenId);
  }
  return p;
}

/** Token à acheter pour un côté — marché éventuellement fusionné avec l’event parent. */
function getTokenIdToBuy(mergedMarket, takeSide) {
  const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(mergedMarket);
  return takeSide === 'Up' ? tokenIdUp : tokenIdDown;
}

/** Charge les events 15m actifs : GET /events?active=true&closed=false (OpenAPI), filtre slug client. */
async function fetchActive15mEvents() {
  const slugMatch = BITCOIN_UP_DOWN_15M_SLUG;
  const { data } = await axios.get(GAMMA_EVENTS_URL, {
    params: { active: true, closed: false, limit: 200 },
    timeout: 15000,
  });
  let events = (Array.isArray(data) ? data : data?.data ?? data?.results ?? []).filter((ev) =>
    (ev.slug ?? '').toLowerCase().includes(slugMatch)
  );
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
 * Signaux dans la fenêtre prix (MIN_PRICE–MAX_SIGNAL_PRICE, ex. 96–98 %) pour le marché horaire ou 15 min.
 * @param {'hourly' | '15m'} marketMode — défaut `hourly`. En `15m`, secours GET /events/slug/{slug} créneau courant.
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
        const nowMs = Date.now();
        if (marketMode === '15m' && slotEndMs != null && Number.isFinite(slotEndMs) && nowMs >= slotEndMs) {
          continue;
        }
        if (marketMode === '15m' && isLive15mEntryForbiddenNow(nowMs)) {
          continue;
        }

        for (const m of ev.markets) {
          const mm = await resolveGammaMarketForBtcUpDown(axios, GAMMA_MARKET_BY_SLUG_URL, ev, m);
          const rawPrices = parseGammaOutcomePrices(mm);
          if (!rawPrices) continue;
          const { idxUp, idxDown } = getUpDownOutcomeIndices(mm);
          const baseUp = rawPrices[idxUp];
          const baseDown = rawPrices[idxDown];
          let priceUp;
          let priceDown;
          if (marketMode === '15m') {
            const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(mm);
            const [askUp, askDown] = await Promise.all([
              tokenIdUp ? getBestAskPrice(tokenIdUp) : Promise.resolve(null),
              tokenIdDown ? getBestAskPrice(tokenIdDown) : Promise.resolve(null),
            ]);
            priceUp = askUp != null ? askUp : baseUp;
            priceDown = askDown != null ? askDown : baseDown;
            if (priceUp == null || priceDown == null) continue;
          } else {
            priceUp = baseUp;
            priceDown = baseDown;
          }
          /** Fenêtre signal : [MIN_PRICE, MAX_SIGNAL_PRICE] (ex. 96–98¢). */
          const upQualifies = priceUp >= MIN_PRICE && priceUp <= MAX_SIGNAL_PRICE;
          const downQualifies = priceDown >= MIN_PRICE && priceDown <= MAX_SIGNAL_PRICE;
          const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
          /** Pour 15m : fin de créneau depuis le slug (Gamma `endDate` souvent décalé). */
          const endDateForSignal =
            slotEndMs != null && Number.isFinite(slotEndMs) ? new Date(slotEndMs).toISOString() : marketEndDate;

          if (upQualifies) {
            const takeSide = 'Up';
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide,
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(mm, takeSide),
              marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
              endDate: endDateForSignal,
            });
          } else if (downQualifies) {
            const takeSide = 'Down';
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide,
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(mm, takeSide),
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
