import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_PRICES_HISTORY_URL = 'https://clob.polymarket.com/prices-history';
const DATA_API_TRADES_URL = 'https://data-api.polymarket.com/trades';
const BITCOIN_UP_DOWN_SLUG = 'bitcoin-up-or-down';
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

/** Seuil pour considérer un outcome comme gagnant (résolu). */
const RESOLVED_WIN_THRESHOLD = 0.98;

/** Retourne le gagnant d'un marché résolu : 'Up' | 'Down' | null. */
function getResolvedWinner(market) {
  const prices = parseOutcomePrices(market);
  if (!prices) return null;
  if (prices[0] >= RESOLVED_WIN_THRESHOLD && prices[1] < 0.5) return 'Up';
  if (prices[1] >= RESOLVED_WIN_THRESHOLD && prices[0] < 0.5) return 'Down';
  return null;
}

/** Extrait un libellé heure du slug (ex. bitcoin-up-or-down-march-15-2026-4pm-et → 15 mars 16h). */
function getHourLabelFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return slug || '—';
  const withYear = slug.match(/march-(\d+)-(\d+)-(\d+)(am|pm)-et/i);
  const noYear = slug.match(/march-(\d+)-(\d+)(am|pm)-et/i);
  const m = withYear || noYear;
  if (m) {
    const day = m[1];
    const hourGroup = withYear ? m[3] : m[2];
    const ampmGroup = withYear ? m[4] : m[3];
    let h = parseInt(hourGroup, 10) || 0;
    if (ampmGroup?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampmGroup?.toLowerCase() === 'am' && h === 12) h = 0;
    return `${day} mars ${h}h`;
  }
  const parts = slug.replace(/-et$/, '').split('-').filter(Boolean);
  const tail = parts.slice(-4).join(' ');
  return tail || slug;
}

/** Fenêtre par défaut (en heures). 72 = 3 jours. */
const DEFAULT_WINDOW_HOURS = 72;

/** Vérifie si la date (ISO ou timestamp) est dans les dernières heures (pour inclure l'heure passée même si résolution en retard). */
function isWithinLastHours(dateStr, hours) {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  const now = Date.now();
  return d <= now && now - d <= hours * 60 * 60 * 1000;
}

/** Génère les slugs Polymarket pour les N dernières heures (heure ET). Format: bitcoin-up-or-down-march-15-2026-4pm-et (avec année). */
function getRecentHourSlugs(count = 72) {
  const slugs = [];
  const tz = 'America/New_York';
  const now = new Date();
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const month = d.toLocaleString('en-US', { timeZone: tz, month: 'long' }).toLowerCase();
    const day = parseInt(d.toLocaleString('en-US', { timeZone: tz, day: 'numeric' }), 10);
    const year = parseInt(d.toLocaleString('en-US', { timeZone: tz, year: 'numeric' }), 10);
    let hour = parseInt(d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
    const ampm = hour >= 12 ? 'pm' : 'am';
    hour = hour % 12 || 12;
    slugs.push(`${BITCOIN_UP_DOWN_SLUG}-${month}-${day}-${year}-${hour}${ampm}-et`);
  }
  return slugs;
}

/** Normalise le conditionId pour l'API Data (attend 0x + 64 caractères hex). */
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

/**
 * Historique des prix à partir des trades (API Data) — secours quand le CLOB renvoie vide.
 * Chaque trade a price, timestamp, outcomeIndex (0 = Up, 1 = Down). On déduit le prix Up.
 */
async function fetchPriceHistoryFromTrades(conditionId, endDateStr) {
  const cid = normalizeConditionId(conditionId);
  if (!cid) return [];
  const endMs = new Date(endDateStr).getTime();
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 14400;
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

/** Récupère les token IDs (Up, Down) depuis l'API Gamma marché par slug si l'event n'en avait pas. */
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

/**
 * Récupère l'historique des prix pour un token depuis le CLOB (pas d'auth).
 * Pour les marchés résolus : utiliser UNIQUEMENT startTs, endTs et fidelity (sans interval),
 * sinon l'API renvoie vide (cf. GitHub Polymarket/py-clob-client #216).
 */
async function fetchPriceHistory(tokenId, endDateStr) {
  const endMs = new Date(endDateStr).getTime();
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 14400; // 4 h avant
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
    // Marchés résolus : SANS interval, uniquement startTs + endTs + fidelity
    const fidelityAttempts = [60, 15, 5]; // 1h, 15min, 5min
    for (const fidelity of fidelityAttempts) {
      const res = await axios.get(CLOB_PRICES_HISTORY_URL, {
        params: { market: tokenId, startTs, endTs, fidelity },
        timeout: 10000,
      });
      const history = toHistory(res.data);
      if (history.length > 0) return history;
    }
    // Fallback : interval 12h+ (fonctionne pour résolus selon la doc)
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

/** Normalise un timestamp (s ou ms) en secondes. */
function toSeconds(t) {
  if (t == null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (n < 1e12 ? n : Math.floor(n / 1000)) : null;
}

const ONE_MINUTE_SEC = 60;

/**
 * À partir de l'historique du token Up (prix p = proba Up), détermine si le bot aurait pris Up ou Down
 * (règle : côté à 96,8–97 %) et si ça aurait gagné. Retourne aussi l'heure et le type d'ordre (Limit).
 * Règle : pas d'entrée dans la dernière minute avant la fin de l'événement (aligné avec le bot live).
 */
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
    if (endTsSec != null && ts >= endTsSec - ONE_MINUTE_SEC) continue;
    if (pUp >= MIN_P && pUp <= MAX_P) return { botWouldTake: 'Up', botWon: winner === 'Up', botEntryPrice: pUp, botEntryTimestamp: ts, botOrderType: 'Limit' };
    if (pDown >= MIN_P && pDown <= MAX_P) return { botWouldTake: 'Down', botWon: winner === 'Down', botEntryPrice: pDown, botEntryTimestamp: ts, botOrderType: 'Limit' };
  }
  return empty;
}

/**
 * Récupère les marchés Bitcoin Up or Down résolus (fermés) de la journée.
 * Pour chaque marché : slug, heure, résultat (Up/Down).
 * Permet d'afficher les résultats des heures passées et de simuler "si le bot avait joué".
 */
export function useBitcoinUpDownResolved(windowHours = DEFAULT_WINDOW_HOURS) {
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
        if (!eventSlug.includes(BITCOIN_UP_DOWN_SLUG)) return;
        const endDate = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? ev.finishedTimestamp ?? '';
        if (!isWithinLastHours(endDate, windowHours)) return;
        const hourLabel = getHourLabelFromSlug(ev.slug ?? '');
        const endMs = endDate ? new Date(endDate).getTime() : NaN;
        const hourEndedAtLeast2MinAgo = Number.isFinite(endMs) && Date.now() >= endMs + 120000;
        for (const m of ev.markets ?? []) {
          let winner = getResolvedWinner(m);
          if (!winner && !hourEndedAtLeast2MinAgo) continue;
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
            hourLabel,
            endDate,
            winner: winner || null,
            conditionId: cid,
            tokenIdUp,
            tokenIdDown,
          });
        }
      };

      // 0) Priorité : récupérer l'heure qui vient de se terminer (slug de la dernière heure passée)
      const lastHourSlugs = getRecentHourSlugs(1);
      if (lastHourSlugs.length > 0) {
        const slugWithYear = lastHourSlugs[0];
        const slugNoYear = slugWithYear.replace(/-\d{4}-/, '-');
        for (const slug of [slugWithYear, slugNoYear]) {
          try {
            const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
            if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
              processEvent(ev);
              break;
            }
          } catch {
            // 404 = essayer l'autre format
          }
        }
      }

      // 1) Récupérer en masse les événements fermés Bitcoin Up or Down (pagination)
      const needed = Math.min(200, Math.ceil(windowHours) + 20);
      try {
        for (let offset = 0; offset < needed; offset += 100) {
          const { data: closedPage } = await axios.get(GAMMA_EVENTS_URL, {
            params: { closed: true, slug_contains: BITCOIN_UP_DOWN_SLUG, limit: 100, offset },
            timeout: 15000,
          });
          const page = Array.isArray(closedPage) ? closedPage : closedPage?.data ?? closedPage?.results ?? [];
          page.forEach(processEvent);
          if (page.length < 100) break;
        }
      } catch (err) {
        if (err.response?.status === 422 || err.response?.status === 400) {
          const [closedRes] = await Promise.all([
            axios.get(GAMMA_EVENTS_URL, { params: { closed: true, limit: 500 }, timeout: 15000 }),
          ]);
          const closedEvents = Array.isArray(closedRes.data) ? closedRes.data : closedRes.data?.data ?? closedRes.data?.results ?? [];
          closedEvents.forEach(processEvent);
        } else throw err;
      }

      // 2) Événements actifs
      try {
        const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, slug_contains: BITCOIN_UP_DOWN_SLUG, limit: 100 },
          timeout: 15000,
        });
        const activeEvents = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
        activeEvents.forEach(processEvent);
      } catch (err) {
        if (err.response?.status === 422 || err.response?.status === 400) {
          const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 300 }, timeout: 15000 });
          const activeEvents = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
          activeEvents.forEach(processEvent);
        }
      }

      // 3) Secours par slug (créneaux récents manquants) : essayer avec année puis sans année
      const recentSlugs = getRecentHourSlugs(Math.max(48, Math.ceil(windowHours)));
      const slugCount = recentSlugs.length;
      for (let i = 0; i < slugCount; i++) {
        const slugWithYear = recentSlugs[i];
        const slugNoYear = slugWithYear.replace(/-\d{4}-/, '-'); // ...-march-15-2026-4pm-et → ...-march-15-4pm-et
        const toTry = [slugWithYear];
        if (slugNoYear !== slugWithYear) toTry.push(slugNoYear);
        for (const slug of toTry) {
          try {
            const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 6000 });
            if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_SLUG)) {
              processEvent(ev);
              break; // trouvé, pas besoin d'essayer l'autre format
            }
          } catch {
            // 404 ou erreur = essayer l'autre format ou passer à l'heure suivante
          }
        }
      }
      results.sort((a, b) => (new Date(b.endDate).getTime() - new Date(a.endDate).getTime()));

      // Compléter les token IDs manquants via Gamma /markets/slug (souvent le cas pour les events récupérés par slug)
      for (const r of results) {
        if (!r.tokenIdUp && r.eventSlug) {
          const { tokenIdUp, tokenIdDown } = await fetchTokenIdsByMarketSlug(r.eventSlug);
          r.tokenIdUp = tokenIdUp;
          r.tokenIdDown = tokenIdDown;
        }
      }
      // Enrichir avec la simulation bot : CLOB prices-history, puis secours API Data (trades)
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
      setError(err.message || 'Erreur lors du chargement des résultats.');
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
