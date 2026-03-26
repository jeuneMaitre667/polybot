import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
 * GET /price (doc Polymarket officielle — Orderbook / Prices) :
 * - **side=BUY** → meilleur **ask** (prix payé pour **acheter** le token / onglet Acheter).
 * - **side=SELL** → meilleur **bid** (prix reçu pour **vendre** le token).
 * L’ancien code inversait BUY/SELL, ce qui affichait ~50/50 (bids / mid) au lieu des asks du site.
 */
const CLOB_PRICE_URL = import.meta.env.DEV ? '/apiClob/price' : 'https://clob.polymarket.com/price';
const CLOB_PRICE_DIRECT = 'https://clob.polymarket.com/price';
const CLOB_BOOK_URL = import.meta.env.DEV ? '/apiClob/book' : 'https://clob.polymarket.com/book';
const CLOB_BOOK_DIRECT = 'https://clob.polymarket.com/book';
/** Même endpoint que le bot Node (`bot-24-7/index.js`) — événements `best_bid_ask`. */
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Fenêtre signal affichée / alignée bot (dashboard + `.env` bot). */
const MIN_PRICE = 0.95;
const MAX_SIGNAL_PRICE = 0.96;

/** Mode horaire : polling complet (Gamma) — compromis charge API. */
const HOURLY_POLL_MS = 5 * 1000;
/** Mode 15m : Gamma + résolution marché (token IDs) — moins souvent. */
const POLL_15M_METADATA_MS = 12 * 1000;
/** REST plancher en 15m (en parallèle du WS) — 500 ms = plus d’appels CLOB, pics plus courts visibles. */
const POLL_15M_PRICE_REST_MS = 500;
const WS_RECONNECT_MS = 4000;

// Uniquement les événements "Bitcoin Up or Down - Hourly" (slug du type bitcoin-up-or-down-march-14-6pm-et)
const BITCOIN_UP_DOWN_HOURLY_SLUG = 'bitcoin-up-or-down';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';

/** Fin de fenêtre 15m (ms UTC) : suffixe slug = début Gamma → +900 s (aligné bot / dashboard). */
function slotEndMsFrom15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const raw = parseInt(m[1], 10);
  if (!Number.isFinite(raw)) return null;
  const startSec = raw < 1e12 ? raw : Math.floor(raw / 1000);
  return (startSec + 900) * 1000;
}

/**
 * Slug événement 15m attendu : `btc-updown-15m-{eventStartSec}`, start = floor(nowUTC/900)*900.
 */
function preferred15mEventSlugLower(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const slotStartSec = Math.floor(nowSec / 900) * 900;
  return `${BITCOIN_UP_DOWN_15M_SLUG}-${slotStartSec}`.toLowerCase();
}

/**
 * Repli si la liste Gamma ne contient pas le créneau exact (ordre des events non garanti).
 */
function pickCurrent15mEvent(events, nowMs) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const preferredSlug = preferred15mEventSlugLower(nowMs);
  const bySlug = events.find((e) => (e.slug ?? '').toLowerCase() === preferredSlug);
  if (bySlug) return bySlug;
  const stillOpen = events.filter((e) => {
    const end = slotEndMsFrom15mSlug(e.slug ?? '');
    return end != null && Number.isFinite(end) && nowMs < end;
  });
  stillOpen.sort((a, b) => {
    const ea = slotEndMsFrom15mSlug(a.slug ?? '') ?? 0;
    const eb = slotEndMsFrom15mSlug(b.slug ?? '') ?? 0;
    return ea - eb;
  });
  return stillOpen[0] ?? events[0];
}

/**
 * Résout l’event du **créneau exact** : évite un autre `btc-updown-15m-*` quand `/events` renvoie
 * plusieurs marchés — sinon prix Gamma ~50/50 alors que le bon carnet CLOB est à 10¢/91¢.
 */
async function resolve15mGammaEventForNow(events, nowMs) {
  const expectedSlug = preferred15mEventSlugLower(nowMs);
  const inList = events.find((e) => (e.slug ?? '').toLowerCase() === expectedSlug);
  if (inList?.markets?.length) {
    return { ev: inList, expectedSlug, slugMismatch: false };
  }

  try {
    const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(expectedSlug)}`, {
      timeout: 8000,
    });
    if (ev?.markets?.length && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) {
      const sl = (ev.slug ?? '').toLowerCase();
      return { ev, expectedSlug, slugMismatch: sl !== expectedSlug };
    }
  } catch {
    /* 404 ou réseau */
  }

  const fallback = pickCurrent15mEvent(events, nowMs);
  if (fallback?.markets?.length) {
    const sl = (fallback.slug ?? '').toLowerCase();
    return { ev: fallback, expectedSlug, slugMismatch: sl !== expectedSlug };
  }
  return { ev: null, expectedSlug, slugMismatch: false };
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

/** Best ask CLOB — GET /price?side=BUY (prix d’achat = ask, doc Polymarket). */
async function getBestAskPriceAtBase(priceUrl, tokenId) {
  if (!tokenId) return null;
  try {
    const { data } = await axios.get(priceUrl, {
      params: { token_id: tokenId, side: 'BUY' },
      timeout: 5000,
    });
    const p = parseFloat(data?.price);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/** D’abord `/book` (carnet réel), puis `/price` — évite un mid ~50/50 quand le site montre 10¢/91¢. */
async function getBestAskPrice(tokenId) {
  let p = await getBestAskFromBookAtBase(CLOB_BOOK_URL, tokenId);
  if (p == null && import.meta.env.DEV && String(CLOB_BOOK_URL).startsWith('/')) {
    p = await getBestAskFromBookAtBase(CLOB_BOOK_DIRECT, tokenId);
  }
  if (p != null) return p;
  p = await getBestAskPriceAtBase(CLOB_PRICE_URL, tokenId);
  if (p == null && import.meta.env.DEV && String(CLOB_PRICE_URL).startsWith('/')) {
    p = await getBestAskPriceAtBase(CLOB_PRICE_DIRECT, tokenId);
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
    const slotStart = Math.floor(nowSec / 900) * 900;
    const currentSlug = `${BITCOIN_UP_DOWN_15M_SLUG}-${slotStart}`;
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
 * Construit les objets signal à partir du marché résolu + prix live (CLOB).
 */
function buildSignalEntries15m({
  ev,
  m,
  mm,
  eventSlug,
  eventEndDate,
  slotEndMs,
  priceUp,
  priceDown,
}) {
  const results = [];
  if (priceUp == null || priceDown == null) return results;

  const upQualifies = priceUp >= MIN_PRICE && priceUp <= MAX_SIGNAL_PRICE;
  const downQualifies = priceDown >= MIN_PRICE && priceDown <= MAX_SIGNAL_PRICE;
  const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;
  const endDateForSignal =
    slotEndMs != null && Number.isFinite(slotEndMs) ? new Date(slotEndMs).toISOString() : marketEndDate;

  if (upQualifies) {
    results.push({
      market: m,
      eventSlug: ev.slug ?? eventSlug,
      eventTitle: ev.title ?? ev.question ?? '',
      question: m.question ?? ev.title ?? ev.slug ?? '',
      takeSide: 'Up',
      priceUp,
      priceDown,
      tokenIdToBuy: getTokenIdToBuy(mm, 'Up'),
      marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
      endDate: endDateForSignal,
    });
  } else if (downQualifies) {
    results.push({
      market: m,
      eventSlug: ev.slug ?? eventSlug,
      eventTitle: ev.title ?? ev.question ?? '',
      question: m.question ?? ev.title ?? ev.slug ?? '',
      takeSide: 'Down',
      priceUp,
      priceDown,
      tokenIdToBuy: getTokenIdToBuy(mm, 'Down'),
      marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
      endDate: endDateForSignal,
    });
  }
  return results;
}

/**
 * Signaux dans la fenêtre prix (MIN_PRICE–MAX_SIGNAL_PRICE, ex. 97–98 %) pour le marché horaire ou 15 min.
 * En **15m** : prix quasi temps réel (WebSocket CLOB `best_bid_ask`) + REST ~500 ms ; métadonnées Gamma ~12 s.
 * En **hourly** : polling complet toutes les 5 s (inchangé).
 * @param {'hourly' | '15m'} marketMode — défaut `hourly`. En `15m`, secours GET /events/slug/{slug} créneau courant.
 */
export function useBitcoinUpDownSignals(marketMode = 'hourly') {
  const [signalsHourly, setSignalsHourly] = useState([]);
  const [loadingHourly, setLoadingHourly] = useState(true);
  const [errorHourly, setErrorHourly] = useState(null);

  /** @type {import('react').MutableRefObject<{ ev: object, m: object, mm: object, tokenIdUp: string, tokenIdDown: string, baseUp: number, baseDown: number, slotEndMs: number | null, eventEndDate: string } | null>} */
  const base15mRef = useRef(null);
  const [base15mVersion, setBase15mVersion] = useState(0);
  const [askUp, setAskUp] = useState(null);
  const [askDown, setAskDown] = useState(null);
  const [loading15m, setLoading15m] = useState(true);
  const [error15m, setError15m] = useState(null);
  /** Horloge 1 s : fenêtres interdites ET + fin de créneau. */
  const [nowTick, setNowTick] = useState(() => Date.now());

  const fetchSignalsHourly = useCallback(async () => {
    setErrorHourly(null);
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
        if (!eventSlug.includes(BITCOIN_UP_DOWN_HOURLY_SLUG)) continue;

        const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';

        for (const m of ev.markets) {
          const mm = await resolveGammaMarketForBtcUpDown(axios, GAMMA_MARKET_BY_SLUG_URL, ev, m);
          const rawPrices = parseGammaOutcomePrices(mm);
          if (!rawPrices) continue;
          const { idxUp, idxDown } = getUpDownOutcomeIndices(mm);
          const priceUp = rawPrices[idxUp];
          const priceDown = rawPrices[idxDown];
          if (priceUp == null || priceDown == null) continue;

          const upQualifies = priceUp >= MIN_PRICE && priceUp <= MAX_SIGNAL_PRICE;
          const downQualifies = priceDown >= MIN_PRICE && priceDown <= MAX_SIGNAL_PRICE;
          const marketEndDate = m.endDate ?? m.end_date_iso ?? eventEndDate;

          if (upQualifies) {
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide: 'Up',
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(mm, 'Up'),
              marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
              endDate: marketEndDate,
            });
          } else if (downQualifies) {
            results.push({
              market: m,
              eventSlug: ev.slug ?? eventSlug,
              eventTitle: ev.title ?? ev.question ?? '',
              question: m.question ?? ev.title ?? ev.slug ?? '',
              takeSide: 'Down',
              priceUp,
              priceDown,
              tokenIdToBuy: getTokenIdToBuy(mm, 'Down'),
              marketUrl: `https://polymarket.com/event/${ev.slug ?? eventSlug}`,
              endDate: marketEndDate,
            });
          }
        }
      }
      setSignalsHourly(results);
    } catch (err) {
      setErrorHourly(err.message || 'Erreur lors du chargement des signaux');
      setSignalsHourly([]);
    } finally {
      setLoadingHourly(false);
    }
  }, []);

  const load15mMetadata = useCallback(async () => {
    setError15m(null);
    try {
      const events = await fetchActive15mEvents();
      const nowMs = Date.now();
      const { ev, expectedSlug, slugMismatch } = await resolve15mGammaEventForNow(events, nowMs);
      if (!ev?.markets?.length) {
        base15mRef.current = null;
        setAskUp(null);
        setAskDown(null);
        setBase15mVersion((v) => v + 1);
        return;
      }

      const eventSlug = (ev.slug ?? '').toLowerCase();
      if (!eventSlug.includes(BITCOIN_UP_DOWN_15M_SLUG)) {
        base15mRef.current = null;
        setBase15mVersion((v) => v + 1);
        return;
      }

      const eventEndDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? '';
      const slotEndMs = slotEndMsFrom15mSlug(ev.slug ?? '');

      for (const m of ev.markets) {
        const mm = await resolveGammaMarketForBtcUpDown(axios, GAMMA_MARKET_BY_SLUG_URL, ev, m);
        const rawPrices = parseGammaOutcomePrices(mm);
        if (!rawPrices) continue;
        const { idxUp, idxDown } = getUpDownOutcomeIndices(mm);
        const baseUp = rawPrices[idxUp];
        const baseDown = rawPrices[idxDown];
        const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(mm);
        const [askU, askD] = await Promise.all([
          tokenIdUp ? getBestAskPrice(tokenIdUp) : Promise.resolve(null),
          tokenIdDown ? getBestAskPrice(tokenIdDown) : Promise.resolve(null),
        ]);
        const priceUp = askU != null ? askU : baseUp;
        const priceDown = askD != null ? askD : baseDown;

        const livePriceSource =
          askU != null && askD != null
            ? 'clob'
            : askU == null && askD == null
              ? 'gamma_fallback'
              : 'partial_clob';

        base15mRef.current = {
          ev,
          m,
          mm,
          tokenIdUp: tokenIdUp ?? '',
          tokenIdDown: tokenIdDown ?? '',
          baseUp,
          baseDown,
          slotEndMs,
          eventEndDate,
          expectedSlug,
          slugMismatch,
          livePriceSource,
        };
        setAskUp(priceUp ?? null);
        setAskDown(priceDown ?? null);
        setBase15mVersion((v) => v + 1);
        return;
      }

      base15mRef.current = null;
      setAskUp(null);
      setAskDown(null);
      setBase15mVersion((v) => v + 1);
    } catch (err) {
      setError15m(err.message || 'Erreur lors du chargement des signaux 15m');
      base15mRef.current = null;
      setBase15mVersion((v) => v + 1);
    } finally {
      setLoading15m(false);
    }
  }, []);

  /** Même logique prix que `signals15m`, mais **sans** filtre grille ET — pour diagnostic / UI « prix OK, entrée interdite ». */
  const signals15mIgnoringTiming = useMemo(() => {
    const base = base15mRef.current;
    if (!base) return [];

    const { ev, m, mm, slotEndMs, eventEndDate, baseUp, baseDown } = base;
    const eventSlug = (ev.slug ?? '').toLowerCase();

    if (slotEndMs != null && Number.isFinite(slotEndMs) && nowTick >= slotEndMs) {
      return [];
    }

    const priceUp = askUp != null ? askUp : baseUp;
    const priceDown = askDown != null ? askDown : baseDown;

    return buildSignalEntries15m({
      ev,
      m,
      mm,
      eventSlug,
      eventEndDate,
      slotEndMs,
      priceUp,
      priceDown,
    });
  }, [askUp, askDown, nowTick]);

  const signals15m = useMemo(() => {
    if (isLive15mEntryForbiddenNow(nowTick)) {
      return [];
    }
    return signals15mIgnoringTiming;
  }, [signals15mIgnoringTiming, nowTick]);

  // ——— Hourly : polling 5 s ———
  useEffect(() => {
    if (marketMode !== 'hourly') return;
    fetchSignalsHourly();
  }, [marketMode, fetchSignalsHourly]);

  useEffect(() => {
    if (marketMode !== 'hourly') return;
    const interval = setInterval(fetchSignalsHourly, HOURLY_POLL_MS);
    return () => clearInterval(interval);
  }, [marketMode, fetchSignalsHourly]);

  // ——— 15m : tick 1 s (grille ET + fin créneau) ———
  useEffect(() => {
    if (marketMode !== '15m') return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [marketMode]);

  // ——— 15m : métadonnées Gamma ———
  useEffect(() => {
    if (marketMode !== '15m') return;
    load15mMetadata();
  }, [marketMode, load15mMetadata]);

  useEffect(() => {
    if (marketMode !== '15m') return;
    const interval = setInterval(load15mMetadata, POLL_15M_METADATA_MS);
    return () => clearInterval(interval);
  }, [marketMode, load15mMetadata]);

  // ——— 15m : WebSocket CLOB (instantané) + REST 500 ms (plancher si le WS saute un tick) ———
  useEffect(() => {
    if (marketMode !== '15m') return;

    const tokenIdUp = base15mRef.current?.tokenIdUp;
    const tokenIdDown = base15mRef.current?.tokenIdDown;
    if (!tokenIdUp || !tokenIdDown) return;

    let ws = null;
    let reconnectTimer = null;
    let restInterval = null;
    let cancelled = false;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const pollPricesRest = async () => {
      const up = base15mRef.current?.tokenIdUp;
      const down = base15mRef.current?.tokenIdDown;
      if (!up || !down || cancelled) return;
      const [u, d] = await Promise.all([getBestAskPrice(up), getBestAskPrice(down)]);
      if (cancelled) return;
      if (u != null) setAskUp(u);
      if (d != null) setAskDown(d);
    };

    restInterval = setInterval(pollPricesRest, POLL_15M_PRICE_REST_MS);
    pollPricesRest();

    const subscribe = (socket, upId, downId) => {
      try {
        socket.send(
          JSON.stringify({
            type: 'market',
            assets_ids: [upId, downId],
            custom_feature_enabled: true,
          })
        );
      } catch {
        /* ignore */
      }
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(CLOB_WS_URL);
      } catch {
        reconnectTimer = setTimeout(connect, WS_RECONNECT_MS);
        return;
      }

      ws.onopen = () => {
        const upId = base15mRef.current?.tokenIdUp;
        const downId = base15mRef.current?.tokenIdDown;
        if (upId && downId) subscribe(ws, upId, downId);
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data?.event_type !== 'best_bid_ask') return;
          const rawAid = data.asset_id;
          const assetId = rawAid != null ? String(rawAid).trim() : '';
          const bestAsk = parseFloat(data.best_ask);
          if (!Number.isFinite(bestAsk)) return;

          const upId = base15mRef.current?.tokenIdUp;
          const downId = base15mRef.current?.tokenIdDown;
          const match = (tid) => {
            if (!tid || !assetId) return false;
            const t = String(tid).trim();
            if (t === assetId) return true;
            try {
              if (/^\d+$/.test(t) && /^\d+$/.test(assetId)) return BigInt(t) === BigInt(assetId);
            } catch {
              /* ignore */
            }
            return false;
          };
          if (match(upId)) setAskUp(bestAsk);
          else if (match(downId)) setAskDown(bestAsk);
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, WS_RECONNECT_MS);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (restInterval) {
        clearInterval(restInterval);
        restInterval = null;
      }
      clearReconnect();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [marketMode, base15mVersion]);

  const signals = marketMode === '15m' ? signals15m : signalsHourly;
  const loading = marketMode === '15m' ? loading15m : loadingHourly;
  const error = marketMode === '15m' ? error15m : errorHourly;

  const live15mEntryForbiddenNow = marketMode === '15m' ? isLive15mEntryForbiddenNow(nowTick) : false;
  const signal15mHiddenByTiming =
    marketMode === '15m' && live15mEntryForbiddenNow && signals15mIgnoringTiming.length > 0;

  const refresh = useCallback(() => {
    if (marketMode === '15m') return load15mMetadata();
    return fetchSignalsHourly();
  }, [marketMode, load15mMetadata, fetchSignalsHourly]);

  return {
    signals,
    loading,
    error,
    refresh,
    /** 15m uniquement : métadonnées live pour expliquer « pas de signal » alors que le prix est dans la bande. */
    live15mMeta:
      marketMode === '15m'
        ? {
            entryForbiddenNow: live15mEntryForbiddenNow,
            hiddenByTiming: signal15mHiddenByTiming,
            /** Signaux tels qu’affichés (vide si grille ET interdit). */
            signalsIfTimingIgnored: signals15mIgnoringTiming,
            liveAskUp: askUp,
            liveAskDown: askDown,
            /** Slug du créneau UTC attendu (même convention que l’URL Polymarket). */
            expectedEventSlug: base15mRef.current?.expectedSlug ?? null,
            resolvedEventSlug: base15mRef.current?.ev?.slug ?? null,
            /** True si l’event utilisé n’est pas le slug exact du créneau courant. */
            slugMismatch: base15mRef.current?.slugMismatch ?? false,
            /** `clob` = best asks ; sinon affichage partiellement ou totalement dérivé de Gamma (peut diverger fortement du site). */
            livePriceSource: base15mRef.current?.livePriceSource ?? null,
          }
        : null,
  };
}
