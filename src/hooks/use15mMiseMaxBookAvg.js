import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import {
  liquidityUsdFromAsks,
  ORDER_BOOK_SIGNAL_MAX_P,
  ORDER_BOOK_SIGNAL_MIN_P,
} from '@/lib/orderBookLiquidity.js';
import { parseUpDownTokenIdsFromMarket } from '@/lib/gammaPolymarket.js';
import {
  format15mSlotEndFr,
  getPrevious15mSlotEndSec,
  getResolvedWinnerFromGammaMarket,
} from '@/lib/btc15mLastSlotWinner.js';

const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_BOOK_URL = import.meta.env.DEV ? '/apiClob/book' : 'https://clob.polymarket.com/book';
const CLOB_BOOK_DIRECT = 'https://clob.polymarket.com/book';
const BITCOIN_UP_DOWN_15M = 'btc-updown-15m';
const SLOT_SEC = 15 * 60;
/** Rafraîchissement léger : carnet créneau actuel + gagnant dernier créneau (sans rescanner les N créneaux). */
const ORDERBOOK_SNAPSHOT_POLL_MS = 1000;

/**
 * Fin du créneau 15m UTC (secondes) — même convention que getCurrent15mEventSlug (Polymarket / Gamma).
 */
function getCurrent15mSlotEndSec() {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.ceil(nowSec / SLOT_SEC) * SLOT_SEC;
}

/** Timestamps de fin de chaque créneau : actuel puis plus anciens. */
function get15mSlotEndSecs(count) {
  const end0 = getCurrent15mSlotEndSec();
  const n = Math.max(1, Math.min(96, count));
  const ends = [];
  for (let i = 0; i < n; i++) {
    ends.push(end0 - i * SLOT_SEC);
  }
  return ends;
}

/**
 * Résout Up/Down : events/slug puis markets/slug pour btc-updown-15m-{endTs}.
 */
async function fetchTokenIdsForSlotEnd(endSec) {
  const slug = `${BITCOIN_UP_DOWN_15M}-${endSec}`;
  try {
    const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 12000 });
    const markets = ev?.markets;
    if (Array.isArray(markets)) {
      for (const m of markets) {
        const out = parseUpDownTokenIdsFromMarket(m);
        if (out.tokenIdUp || out.tokenIdDown) return out;
      }
    }
  } catch {
    /* 404 / réseau */
  }
  try {
    const { data: m } = await axios.get(`${GAMMA_MARKET_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 12000 });
    const out = parseUpDownTokenIdsFromMarket(m);
    if (out.tokenIdUp || out.tokenIdDown) return out;
  } catch {
    /* 404 */
  }
  return { tokenIdUp: null, tokenIdDown: null };
}

async function fetchAsks(tokenId) {
  if (!tokenId) return [];
  try {
    const { data } = await axios.get(CLOB_BOOK_URL, {
      params: { token_id: tokenId },
      timeout: 12000,
    });
    const asks = data?.asks ?? [];
    return Array.isArray(asks) ? asks : [];
  } catch {
    // En DEV, le proxy Vite peut parfois ne pas être pris en compte (ou nécessiter un redémarrage).
    // En navigateur, l'appel direct à CLOB est généralement bloqué par CORS, donc on ne retente
    // en direct que hors navigateur (ex: SSR / tests Node).
    if (
      import.meta.env.DEV &&
      String(CLOB_BOOK_URL).startsWith('/') &&
      typeof window === 'undefined'
    ) {
      try {
        const { data } = await axios.get(CLOB_BOOK_DIRECT, {
          params: { token_id: tokenId },
          timeout: 12000,
        });
        const asks = data?.asks ?? [];
        return Array.isArray(asks) ? asks : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

/** Dernier créneau **terminé** (pas l’actuel) : gagnant Up/Down via Gamma outcomePrices. */
async function fetchPreviousSlotWinnerFromGamma() {
  const slotEndSec = getPrevious15mSlotEndSec();
  const slug = `${BITCOIN_UP_DOWN_15M}-${slotEndSec}`;
  let winner = null;
  try {
    const { data: m } = await axios.get(`${GAMMA_MARKET_BY_SLUG_URL}/${encodeURIComponent(slug)}`, {
      timeout: 10000,
    });
    winner = getResolvedWinnerFromGammaMarket(m);
  } catch {
    /* marché introuvable ou proxy */
  }
  if (winner == null) {
    try {
      const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, {
        timeout: 10000,
      });
      const markets = ev?.markets;
      if (Array.isArray(markets)) {
        for (const m of markets) {
          winner = getResolvedWinnerFromGammaMarket(m);
          if (winner) break;
        }
      }
    } catch {
      /* */
    }
  }
  return { winner, slotEndSec, slug };
}

function medianSorted(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Moyenne de la « mise max » carnet sur N créneaux 15m :
 * max(liquidité Up, Down) dans 97 % – 97,5 % (`ORDER_BOOK_SIGNAL_*`, aligné bot / `orderBookLiquidity`).
 *
 * Quand `enabled`, le **carnet du créneau ouvert** et le **gagnant du dernier créneau** sont aussi
 * rafraîchis automatiquement toutes les ~1 s (sans refaire le scan complet des N créneaux).
 *
 * @param {{ enabled?: boolean, slotCount?: number, staggerMs?: number }} opts
 */
export function use15mMiseMaxBookAvg({ enabled = true, slotCount = 36, staggerMs = 45 } = {}) {
  const [avgUsd, setAvgUsd] = useState(null);
  const [minUsd, setMinUsd] = useState(null);
  const [maxUsd, setMaxUsd] = useState(null);
  const [medianUsd, setMedianUsd] = useState(null);
  const [sampleSize, setSampleSize] = useState(0);
  const [slotsAttempted, setSlotsAttempted] = useState(0);
  const [currentSlotMiseMaxUsd, setCurrentSlotMiseMaxUsd] = useState(null);
  /** Série temporelle : un point par créneau où Gamma+CLOB ont répondu (même si mise = 0). */
  const [seriesBySlot, setSeriesBySlot] = useState([]);
  /** @deprecated Utiliser currentSlotBookAsksUp / Down — carnet dominant (97–97,5 %). */
  const [currentSlotBookAsks, setCurrentSlotBookAsks] = useState([]);
  /** Asks CLOB créneau actuel : Up et Down (profondeur type Polymarket). */
  const [currentSlotBookAsksUp, setCurrentSlotBookAsksUp] = useState([]);
  const [currentSlotBookAsksDown, setCurrentSlotBookAsksDown] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastAt, setLastAt] = useState(null);
  /** Dernier créneau résolu : { winner: 'Up'|'Down'|null, slotEndSec, label } */
  const [lastResolved15mSlot, setLastResolved15mSlot] = useState(null);
  const mounted = useRef(true);
  const snapshotInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Mise à jour « live » du carnet (créneau ouvert) et du bandeau (dernier clos) — rapide, pour polling.
   * Ne recalcule pas moyenne / min / max / série sur N créneaux.
   */
  const refreshOrderBookSnapshot = useCallback(async () => {
    if (!enabled || !mounted.current || snapshotInFlight.current) return;
    snapshotInFlight.current = true;
    try {
      const end0 = getCurrent15mSlotEndSec();
      const [prev, { tokenIdUp, tokenIdDown }] = await Promise.all([
        fetchPreviousSlotWinnerFromGamma(),
        fetchTokenIdsForSlotEnd(end0),
      ]);
      if (mounted.current) {
        setLastResolved15mSlot({
          winner: prev.winner,
          slotEndSec: prev.slotEndSec,
          label: format15mSlotEndFr(prev.slotEndSec),
        });
      }
      if (!mounted.current) return;
      if (!tokenIdUp && !tokenIdDown) return;
      const [asksUp, asksDown] = await Promise.all([fetchAsks(tokenIdUp), fetchAsks(tokenIdDown)]);
      if (!mounted.current) return;
      const liqUp = liquidityUsdFromAsks(asksUp, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P);
      const liqDown = liquidityUsdFromAsks(asksDown, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P);
      const mise = Math.max(liqUp, liqDown);
      const dominantAsks = liqUp >= liqDown ? asksUp : asksDown;
      setCurrentSlotMiseMaxUsd(mise);
      setCurrentSlotBookAsks(Array.isArray(dominantAsks) ? dominantAsks : []);
      setCurrentSlotBookAsksUp(Array.isArray(asksUp) ? asksUp : []);
      setCurrentSlotBookAsksDown(Array.isArray(asksDown) ? asksDown : []);
      setLastAt(new Date().toISOString());
    } catch {
      /* conserver le dernier affichage */
    } finally {
      snapshotInFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => {
      refreshOrderBookSnapshot();
    }, ORDERBOOK_SNAPSHOT_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refreshOrderBookSnapshot]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setAvgUsd(null);
      setMinUsd(null);
      setMaxUsd(null);
      setMedianUsd(null);
      setSampleSize(0);
      setSlotsAttempted(0);
      setCurrentSlotMiseMaxUsd(null);
      setSeriesBySlot([]);
      setCurrentSlotBookAsks([]);
      setCurrentSlotBookAsksUp([]);
      setCurrentSlotBookAsksDown([]);
      setLastResolved15mSlot(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setSeriesBySlot([]);
    setCurrentSlotBookAsks([]);
    setCurrentSlotBookAsksUp([]);
    setCurrentSlotBookAsksDown([]);
    const slotEnds = get15mSlotEndSecs(slotCount);
    const values = [];
    const seriesPoints = [];
    let firstSlotMise = null;
    let attempted = 0;

    try {
      const prevSlot = await fetchPreviousSlotWinnerFromGamma();
      if (mounted.current) {
        setLastResolved15mSlot({
          winner: prevSlot.winner,
          slotEndSec: prevSlot.slotEndSec,
          label: format15mSlotEndFr(prevSlot.slotEndSec),
        });
      }

      for (let i = 0; i < slotEnds.length; i++) {
        if (!mounted.current) break;
        const endSec = slotEnds[i];
        attempted += 1;
        const { tokenIdUp, tokenIdDown } = await fetchTokenIdsForSlotEnd(endSec);
        if (!tokenIdUp && !tokenIdDown) {
          if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
          continue;
        }
        const [asksUp, asksDown] = await Promise.all([fetchAsks(tokenIdUp), fetchAsks(tokenIdDown)]);
        const liqUp = liquidityUsdFromAsks(asksUp, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P);
        const liqDown = liquidityUsdFromAsks(asksDown, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P);
        const mise = Math.max(liqUp, liqDown);
        values.push(mise);
        // Pour le graphique : un point par créneau où Gamma+CLOB a répondu.
        seriesPoints.push({ slotEndSec: endSec, miseMaxUsd: mise });
        if (i === 0) {
          firstSlotMise = mise;
          const dominantAsks = liqUp >= liqDown ? asksUp : asksDown;
          setCurrentSlotBookAsks(Array.isArray(dominantAsks) ? dominantAsks : []);
          setCurrentSlotBookAsksUp(Array.isArray(asksUp) ? asksUp : []);
          setCurrentSlotBookAsksDown(Array.isArray(asksDown) ? asksDown : []);
        }
        if (staggerMs > 0 && i < slotEnds.length - 1) await new Promise((r) => setTimeout(r, staggerMs));
      }

      if (!mounted.current) return;

      setSlotsAttempted(attempted);
      setCurrentSlotMiseMaxUsd(firstSlotMise);
      setSeriesBySlot(seriesPoints);

      if (values.length === 0) {
        setAvgUsd(null);
        setMinUsd(null);
        setMaxUsd(null);
        setMedianUsd(null);
        setSampleSize(0);
        setError(
          'Aucun marché 15m trouvé (Gamma) ou carnets vides. En local : vérifie le proxy Vite (/api, /apiClob).'
        );
      } else {
        const sum = values.reduce((a, b) => a + b, 0);
        setAvgUsd(Math.round((sum / values.length) * 100) / 100);
        setMinUsd(Math.min(...values));
        setMaxUsd(Math.max(...values));
        setMedianUsd(medianSorted(values));
        setSampleSize(values.length);
        setError(null);
      }
      setLastAt(new Date().toISOString());
    } catch (e) {
      if (!mounted.current) return;
      setError(e?.message || 'Erreur chargement carnets 15m');
      setAvgUsd(null);
      setMinUsd(null);
      setMaxUsd(null);
      setMedianUsd(null);
      setSampleSize(0);
      setSeriesBySlot([]);
      setCurrentSlotBookAsks([]);
      setCurrentSlotBookAsksUp([]);
      setCurrentSlotBookAsksDown([]);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [enabled, slotCount, staggerMs]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    avgUsd,
    minUsd,
    maxUsd,
    medianUsd,
    sampleSize,
    slotsAttempted,
    currentSlotMiseMaxUsd,
    seriesBySlot,
    currentSlotBookAsks,
    currentSlotBookAsksUp,
    currentSlotBookAsksDown,
    loading,
    error,
    lastAt,
    lastResolved15mSlot,
    refresh,
  };
}
