import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { liquidityUsdFromAsks } from '@/lib/orderBookLiquidity.js';
import { parseUpDownTokenIdsFromMarket } from '@/lib/gammaPolymarket.js';

const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_BOOK_URL = import.meta.env.DEV ? '/api-clob/book' : 'https://clob.polymarket.com/book';
const BITCOIN_UP_DOWN_15M = 'btc-updown-15m';
const SLOT_SEC = 15 * 60;

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
    return [];
  }
}

function medianSorted(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Moyenne de la « mise max » carnet sur N créneaux 15m : max(liquidité Up, Down) dans 97–97,5 %.
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastAt, setLastAt] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setAvgUsd(null);
      setMinUsd(null);
      setMaxUsd(null);
      setMedianUsd(null);
      setSampleSize(0);
      setSlotsAttempted(0);
      setCurrentSlotMiseMaxUsd(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const slotEnds = get15mSlotEndSecs(slotCount);
    const values = [];
    let firstSlotMise = null;
    let attempted = 0;

    try {
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
        const liqUp = liquidityUsdFromAsks(asksUp);
        const liqDown = liquidityUsdFromAsks(asksDown);
        const mise = Math.max(liqUp, liqDown);
        values.push(mise);
        if (i === 0) firstSlotMise = mise;
        if (staggerMs > 0 && i < slotEnds.length - 1) await new Promise((r) => setTimeout(r, staggerMs));
      }

      if (!mounted.current) return;

      setSlotsAttempted(attempted);
      setCurrentSlotMiseMaxUsd(firstSlotMise);

      if (values.length === 0) {
        setAvgUsd(null);
        setMinUsd(null);
        setMaxUsd(null);
        setMedianUsd(null);
        setSampleSize(0);
        setError(
          'Aucun marché 15m trouvé (Gamma) ou carnets vides. En local : vérifie le proxy Vite (/api, /api-clob).'
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
    loading,
    error,
    lastAt,
    refresh,
  };
}
