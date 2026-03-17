import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_PRICES_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const DATA_API_TRADES_URL = 'https://data-api.polymarket.com/trades';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';
const MIN_P = 0.968;
const MAX_P = 0.97;

function parseOutcomePrices(market) {
  try {
    const raw = market.outcomePrices ?? market.outcome_prices;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return [parseFloat(arr[0]) ?? 0, parseFloat(arr[1]) ?? 0];
  } catch {
    return null;
  }
}

const RESOLVED_WIN_THRESHOLD = 0.98;

function getResolvedWinner(market) {
  const prices = parseOutcomePrices(market);
  if (!prices) return null;
  if (prices[0] >= RESOLVED_WIN_THRESHOLD && prices[1] < 0.5) return 'Up';
  if (prices[1] >= RESOLVED_WIN_THRESHOLD && prices[0] < 0.5) return 'Down';
  return null;
}

/** Slug 15m = btc-updown-15m-{timestamp}. Extrait un libellé date/heure. */
function get15mLabelFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return slug || '—';
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (m) {
    const ts = parseInt(m[1], 10);
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  }
  return slug;
}

const DEFAULT_WINDOW_HOURS = 72;
// 1 h = 4 créneaux 15 min. 3 jours = 72 h = 288 créneaux ; 7 jours = 168 h = 672 créneaux.
const SLOTS_PER_HOUR = 4;
const MAX_15M_SLUG_FETCH = 168 * SLOTS_PER_HOUR; // 672 = 7 jours max (pour « un jour de plus »)

/** Polymarket utilise le début du créneau en secondes UTC. Génère les slugs btc-updown-15m-{timestamp} pour les N derniers créneaux. */
function getRecent15mSlugs(slotCount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotSec = 15 * 60;
  const currentSlotStart = Math.floor(nowSec / slotSec) * slotSec;
  const slugs = [];
  const n = Math.min(slotCount, MAX_15M_SLUG_FETCH);
  for (let i = 1; i <= n; i++) {
    slugs.push(`${BITCOIN_UP_DOWN_15M_SLUG}-${currentSlotStart - i * slotSec}`);
  }
  return slugs;
}

function isWithinLastHours(dateStr, hours) {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  const now = Date.now();
  return d <= now && now - d <= hours * 60 * 60 * 1000;
}

function normalizeConditionId(cid) {
  if (!cid) return null;
  const s = String(cid).trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(s)) return s;
  if (/^0x[a-fA-F0-9]+$/.test(s)) return '0x' + s.slice(2).padStart(64, '0');
  if (/^[a-fA-F0-9]{64}$/.test(s)) return '0x' + s;
  if (/^\d+$/.test(s)) {
    const hex = BigInt(s).toString(16);
    return '0x' + hex.padStart(64, '0');
  }
  return null;
}

async function fetchPriceHistoryFromTrades(conditionId, endDateStr) {
  const cid = normalizeConditionId(conditionId);
  if (!cid) return [];
  const endMs = new Date(endDateStr).getTime();
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 3600;
  try {
    const { data: trades } = await axios.get(DATA_API_TRADES_URL, {
      params: { market: cid, limit: 2000, takerOnly: true },
      timeout: 12000,
    });
    if (!Array.isArray(trades) || trades.length === 0) return [];
    const points = [];
    for (const tr of trades) {
      const t = tr.timestamp != null ? (Number(tr.timestamp) < 1e12 ? Number(tr.timestamp) : Math.floor(Number(tr.timestamp) / 1000)) : null;
      if (t == null || t < startTs || t > endTs) continue;
      const price = tr.price != null ? Number(tr.price) : null;
      if (price == null) continue;
      const outcomeIndex = tr.outcomeIndex ?? 0;
      const pUp = outcomeIndex === 0 ? price : 1 - price;
      points.push({ t, p: pUp });
    }
    points.sort((a, b) => a.t - b.t);
    return points;
  } catch {
    return [];
  }
}

async function fetchTokenIdsByMarketSlug(eventSlug) {
  if (!eventSlug) return { tokenIdUp: null, tokenIdDown: null };
  try {
    const { data: m } = await axios.get(`${GAMMA_MARKET_BY_SLUG_URL}/${encodeURIComponent(eventSlug)}`, { timeout: 8000 });
    const ids = m?.clobTokenIds ?? m?.clob_token_ids;
    const tokens = m?.tokens;
    const tokenIdUp = Array.isArray(ids) && ids[0] ? String(ids[0]) : (Array.isArray(tokens) && tokens[0]?.token_id ? String(tokens[0].token_id) : null);
    const tokenIdDown = Array.isArray(ids) && ids[1] ? String(ids[1]) : (Array.isArray(tokens) && tokens[1]?.token_id ? String(tokens[1].token_id) : null);
    return { tokenIdUp, tokenIdDown };
  } catch {
    return { tokenIdUp: null, tokenIdDown: null };
  }
}

async function fetchPriceHistory(tokenId, endDateStr) {
  const endMs = new Date(endDateStr).getTime();
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 3600;
  const toHistory = (data) => {
    const h = data?.history ?? data ?? [];
    return Array.isArray(h) ? h : [];
  };
  const filterByWindow = (raw) =>
    raw.filter((pt) => {
      const t = pt?.t ?? pt?.timestamp;
      if (t == null) return false;
      const ts = Number(t) < 1e12 ? Number(t) : Math.floor(Number(t) / 1000);
      return ts >= startTs && ts <= endTs;
    });
  try {
    for (const fidelity of [60, 15, 5]) {
      const res = await axios.get(CLOB_PRICES_HISTORY_URL, {
        params: { market: tokenId, startTs, endTs, fidelity },
        timeout: 10000,
      });
      const history = toHistory(res.data);
      if (history.length > 0) return history;
    }
    const res = await axios.get(CLOB_PRICES_HISTORY_URL, {
      params: { market: tokenId, startTs, endTs, interval: '12h' },
      timeout: 10000,
    });
    let history = toHistory(res.data);
    if (history.length === 0) {
      const resMax = await axios.get(CLOB_PRICES_HISTORY_URL, {
        params: { market: tokenId, startTs, endTs, interval: 'max' },
        timeout: 10000,
      });
      history = filterByWindow(toHistory(resMax.data));
    }
    return history;
  } catch {
    return [];
  }
}

function toSeconds(t) {
  if (t == null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (n < 1e12 ? n : Math.floor(n / 1000)) : null;
}

/** Pas d'entrée dans les 4 dernières minutes avant la fin du créneau 15 min (vs 1 min pour l'horaire). */
const NO_TRADE_LAST_SEC_15M = 4 * 60; // 240 s

function computeBotSimulation(history, winner, endDateStr) {
  const empty = { botWouldTake: null, botWon: null, botEntryPrice: null, botEntryTimestamp: null, botOrderType: null };
  if (!history.length) return empty;
  let endTsSec = null;
  if (endDateStr) {
    const raw = endDateStr;
    const endMs = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
    if (Number.isFinite(endMs)) endTsSec = Math.floor(endMs / 1000);
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const pt = history[i];
    const p = pt?.p ?? pt?.price;
    if (p == null) continue;
    const pUp = Number(p);
    const pDown = 1 - pUp;
    const ts = toSeconds(pt?.t ?? pt?.timestamp);
    if (ts == null) continue;
    if (endTsSec != null && ts >= endTsSec - NO_TRADE_LAST_SEC_15M) continue;
    if (pUp >= MIN_P && pUp <= MAX_P) return { botWouldTake: 'Up', botWon: winner === 'Up', botEntryPrice: pUp, botEntryTimestamp: ts, botOrderType: 'Limit' };
    if (pDown >= MIN_P && pDown <= MAX_P) return { botWouldTake: 'Down', botWon: winner === 'Down', botEntryPrice: pDown, botEntryTimestamp: ts, botOrderType: 'Limit' };
  }
  return empty;
}

/**
 * Récupère les marchés Bitcoin Up or Down 15 min résolus (slug btc-updown-15m-*).
 * Même logique que useBitcoinUpDownResolved mais pour les créneaux 15 min.
 */
export function useBitcoinUpDownResolved15m(windowHours = DEFAULT_WINDOW_HOURS) {
  const [resolved, setResolved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchResolved = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const seen = new Set();
      const results = [];

      const processEvent = (ev) => {
        const eventSlug = (ev.slug ?? '').toLowerCase();
        if (!eventSlug.includes(BITCOIN_UP_DOWN_15M_SLUG)) return;
        const endDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? ev.finishedTimestamp ?? '';
        if (!isWithinLastHours(endDate, windowHours)) return;
        const slotLabel = get15mLabelFromSlug(ev.slug ?? '');
        const endMs = endDate ? new Date(endDate).getTime() : NaN;
        const slotEndedAtLeast2MinAgo = Number.isFinite(endMs) && Date.now() >= endMs + 120000;
        for (const m of ev.markets ?? []) {
          let winner = getResolvedWinner(m);
          if (!winner && !slotEndedAtLeast2MinAgo) continue;
          const cid = m.conditionId ?? m.condition_id ?? ev.slug;
          if (seen.has(cid)) continue;
          seen.add(cid);
          const ids = m.clobTokenIds ?? m.clob_token_ids;
          const tokens = m.tokens;
          const tokenIdUp = Array.isArray(ids) && ids[0] ? String(ids[0]) : (Array.isArray(tokens) && tokens[0]?.token_id ? String(tokens[0].token_id) : null);
          const tokenIdDown = Array.isArray(ids) && ids[1] ? String(ids[1]) : (Array.isArray(tokens) && tokens[1]?.token_id ? String(tokens[1].token_id) : null);
          results.push({
            eventSlug: ev.slug,
            question: m.question ?? ev.title ?? ev.slug ?? '',
            hourLabel: slotLabel,
            endDate,
            winner: winner || null,
            conditionId: cid,
            tokenIdUp,
            tokenIdDown,
          });
        }
      };

      try {
        for (let offset = 0; offset < 500; offset += 100) {
          const { data: closedPage } = await axios.get(GAMMA_EVENTS_URL, {
            params: { closed: true, slug_contains: BITCOIN_UP_DOWN_15M_SLUG, limit: 100, offset },
            timeout: 15000,
          });
          const page = Array.isArray(closedPage) ? closedPage : closedPage?.data ?? closedPage?.results ?? [];
          page.forEach(processEvent);
          if (page.length < 100) break;
        }
      } catch (err) {
        if (err.response?.status === 422 || err.response?.status === 400) {
          const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { closed: true, limit: 500 }, timeout: 15000 });
          const arr = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
          arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)).forEach(processEvent);
        } else throw err;
      }

      try {
        const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, slug_contains: BITCOIN_UP_DOWN_15M_SLUG, limit: 100 },
          timeout: 15000,
        });
        const activeEvents = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
        activeEvents.forEach(processEvent);
      } catch (err) {
        if (err.response?.status === 422 || err.response?.status === 400) {
          const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 300 }, timeout: 15000 });
          const arr = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
          arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)).forEach(processEvent);
        } else throw err;
      }

      // Secours par slug : l’API liste ne renvoie parfois aucun event 15m fermé ; on récupère par slug (comme pour l’horaire).
      // windowHours en heures → nombre de créneaux 15 min = windowHours * 4 (ex. 72 h → 288 créneaux pour 3 jours).
      const slotCount = Math.min(MAX_15M_SLUG_FETCH, Math.ceil(windowHours * SLOTS_PER_HOUR));
      const recent15mSlugs = getRecent15mSlugs(slotCount);
      for (const slug of recent15mSlugs) {
        try {
          const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 6000 });
          if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) processEvent(ev);
        } catch {
          // 404 ou erreur = créneau inexistant ou pas encore créé, ignorer
        }
      }

      results.sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());

      for (const r of results) {
        if (!r.tokenIdUp && r.eventSlug) {
          const { tokenIdUp, tokenIdDown } = await fetchTokenIdsByMarketSlug(r.eventSlug);
          r.tokenIdUp = tokenIdUp;
          r.tokenIdDown = tokenIdDown;
        }
      }

      const enriched = [];
      for (const r of results) {
        let history = [];
        if (r.tokenIdUp) history = await fetchPriceHistory(r.tokenIdUp, r.endDate);
        if (history.length === 0 && r.conditionId) history = await fetchPriceHistoryFromTrades(r.conditionId, r.endDate);
        const sim = history.length > 0 ? computeBotSimulation(history, r.winner, r.endDate) : { botWouldTake: null, botWon: null, botEntryPrice: null, botEntryTimestamp: null, botOrderType: null };
        enriched.push({ ...r, ...sim });
      }
      setResolved(enriched);
    } catch (err) {
      setError(err.message || 'Erreur lors du chargement des résultats 15 min.');
      setResolved([]);
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    fetchResolved();
  }, [fetchResolved]);

  return { resolved, loading, error, refresh: fetchResolved };
}
