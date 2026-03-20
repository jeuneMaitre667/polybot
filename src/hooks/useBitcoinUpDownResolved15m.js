import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { parseUpDownTokenIdsFromMarket } from '@/lib/gammaPolymarket.js';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_PRICES_HISTORY_URL = import.meta.env.DEV
  ? '/apiClob/prices-history'
  : 'https://clob.polymarket.com/prices-history';
const DATA_API_TRADES_URL = import.meta.env.DEV ? '/apiData/trades' : 'https://data-api.polymarket.com/trades';
const CLOB_PRICES_HISTORY_DIRECT = 'https://clob.polymarket.com/prices-history';
const DATA_API_TRADES_DIRECT = 'https://data-api.polymarket.com/trades';
const BITCOIN_UP_DOWN_15M_SLUG = 'btc-updown-15m';

function formatAxiosError(err) {
  if (err?.response) {
    const s = err.response.status;
    const t = err.response.statusText || '';
    const d = err.response.data;
    const extra = typeof d === 'string' && d.length && d.length < 120 ? ` ${d}` : '';
    return `${s} ${t}${extra}`.trim();
  }
  if (err?.code === 'ECONNABORTED') return 'Timeout';
  return err?.message || 'Erreur réseau';
}
const MIN_P = 0.97;
const MAX_P = 0.975;

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

/**
 * Slug Polymarket = btc-updown-15m-{timestamp} avec **la fin du créneau** en secondes UTC
 * (aligné sur bot-24-7 getCurrent15mEventSlug et use15mMiseMaxBookAvg). Avant : floor(début)
 * → décalage de 15 min et 404 sur /events/slug → aucun résultat passé.
 */
function getRecent15mSlugs(slotCount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotSec = 15 * 60;
  const currentSlotEnd = Math.ceil(nowSec / slotSec) * slotSec;
  const slugs = [];
  const n = Math.min(slotCount, MAX_15M_SLUG_FETCH);
  for (let i = 1; i <= n; i++) {
    slugs.push(`${BITCOIN_UP_DOWN_15M_SLUG}-${currentSlotEnd - i * slotSec}`);
  }
  return slugs;
}

/** Fin de créneau (ms UTC) depuis le slug Polymarket btc-updown-15m-{unixSec}. */
function slotEndMsFrom15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const ts = parseInt(m[1], 10);
  if (!Number.isFinite(ts)) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Fenêtre temporelle basée sur une fin de créneau (ms). */
function isWithinLastHoursByRefEndMs(refEndMs, hours) {
  if (refEndMs == null || !Number.isFinite(refEndMs)) return false;
  const now = Date.now();
  return refEndMs <= now && now - refEndMs <= hours * 60 * 60 * 1000;
}

/**
 * Fin de créneau pour filtrage, fenêtre CLOB/prices-history et simulation.
 * On privilégie le timestamp du slug `btc-updown-15m-{finUtcSec}` : même convention que
 * le bot (`getCurrent15mEventSlug`) et que Polymarket.
 * Sur Gamma, `ev.endDate` peut être décalé d’environ un créneau (~900s) par rapport au slug,
 * ce qui décale la fenêtre d’historique et fausse les entrées simulées.
 */
function resolve15mRefEndMs(ev) {
  const slugEnd = slotEndMsFrom15mSlug(ev.slug ?? '');
  if (slugEnd != null && Number.isFinite(slugEnd)) return slugEnd;
  const raw = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? ev.finishedTimestamp ?? '';
  const evEnd = raw ? new Date(raw).getTime() : NaN;
  if (Number.isFinite(evEnd)) return evEnd;
  return null;
}

/** GET /events/slug en parallèle par petits paquets + pause (évite 429 Gamma qui vide tout le chargement). */
async function fetch15mEventsBySlugBatches(slugs, batchSize = 4) {
  const events = [];
  for (let i = 0; i < slugs.length; i += batchSize) {
    const chunk = slugs.slice(i, i + batchSize);
    const parts = await Promise.all(
      chunk.map(async (slug) => {
        try {
          const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, { timeout: 8000 });
          if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) return ev;
        } catch {
          /* 404 ou réseau */
        }
        return null;
      })
    );
    for (const ev of parts) if (ev) events.push(ev);
    if (i + batchSize < slugs.length) await new Promise((r) => setTimeout(r, 120));
  }
  return events;
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

async function fetchTradesHistoryAtBase(baseUrl, conditionId, endDateStr) {
  const cid = normalizeConditionId(conditionId);
  if (!cid) return { history: [], error: 'conditionId invalide' };
  const endMs = new Date(endDateStr).getTime();
  if (!Number.isFinite(endMs)) return { history: [], error: 'endDate invalide' };
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 14400;
  try {
    const { data: trades } = await axios.get(baseUrl, {
      params: { market: cid, limit: 2000, takerOnly: true },
      timeout: 12000,
    });
    if (!Array.isArray(trades) || trades.length === 0) return { history: [], error: null };
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
    return { history: points, error: null };
  } catch (e) {
    return { history: [], error: formatAxiosError(e) };
  }
}

/** Secours URL directe en dev si le proxy `/apiData` échoue. */
async function fetchPriceHistoryFromTrades(conditionId, endDateStr) {
  const primary = await fetchTradesHistoryAtBase(DATA_API_TRADES_URL, conditionId, endDateStr);
  if (primary.history.length > 0) return { ...primary, usedDirectDataApi: false };
  if (import.meta.env.DEV && String(DATA_API_TRADES_URL).startsWith('/')) {
    const direct = await fetchTradesHistoryAtBase(DATA_API_TRADES_DIRECT, conditionId, endDateStr);
    if (direct.history.length > 0) return { ...direct, usedDirectDataApi: true };
    const parts = [primary.error, direct.error].filter(Boolean);
    return { history: [], error: parts.length ? parts.join(' → ') : null, usedDirectDataApi: false };
  }
  return { ...primary, usedDirectDataApi: false };
}

async function fetchTokenIdsByMarketSlug(eventSlug) {
  if (!eventSlug) return { tokenIdUp: null, tokenIdDown: null };
  try {
    const { data: m } = await axios.get(`${GAMMA_MARKET_BY_SLUG_URL}/${encodeURIComponent(eventSlug)}`, { timeout: 8000 });
    return parseUpDownTokenIdsFromMarket(m);
  } catch {
    return { tokenIdUp: null, tokenIdDown: null };
  }
}

async function fetchClobPriceHistoryAtBase(baseUrl, tokenId, endDateStr) {
  const endMs = new Date(endDateStr).getTime();
  if (!Number.isFinite(endMs)) return { history: [], error: 'endDate invalide' };
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 14400;
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
    const market = String(tokenId);
    // Sur les 15m, les entrées dans 97–97,5% sont souvent des "pics" :
    // si on s'arrête au premier fidelity non-vide (ex. 60), on les rate.
    // On privilégie donc la granularité la plus fine (1 minute) d'abord.
    for (const fidelity of [1, 5, 15, 60]) {
      const res = await axios.get(baseUrl, {
        params: { market, startTs, endTs, fidelity },
        timeout: 10000,
      });
      const history = toHistory(res.data);
      if (history.length > 0) return { history, error: null };
    }
    const res = await axios.get(baseUrl, {
      params: { market, startTs, endTs, interval: '12h' },
      timeout: 10000,
    });
    let history = toHistory(res.data);
    if (history.length === 0) {
      const resMax = await axios.get(baseUrl, {
        params: { market, startTs, endTs, interval: 'max' },
        timeout: 10000,
      });
      history = filterByWindow(toHistory(resMax.data));
    }
    return { history, error: null };
  } catch (e) {
    return { history: [], error: formatAxiosError(e) };
  }
}

/**
 * En dev, si le proxy `/apiClob` échoue ou renvoie vide alors que le marché existe, retente en direct sur clob.polymarket.com.
 */
async function fetchPriceHistory(tokenId, endDateStr) {
  const primary = await fetchClobPriceHistoryAtBase(CLOB_PRICES_HISTORY_URL, tokenId, endDateStr);
  if (primary.history.length > 0) return { ...primary, usedDirectClob: false };
  if (import.meta.env.DEV && String(CLOB_PRICES_HISTORY_URL).startsWith('/')) {
    const direct = await fetchClobPriceHistoryAtBase(CLOB_PRICES_HISTORY_DIRECT, tokenId, endDateStr);
    if (direct.history.length > 0) return { history: direct.history, error: null, usedDirectClob: true };
    const parts = [primary.error, direct.error].filter(Boolean);
    return { history: [], error: parts.length ? parts.join(' → ') : null, usedDirectClob: false };
  }
  return { ...primary, usedDirectClob: false };
}

function toSeconds(t) {
  if (t == null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (n < 1e12 ? n : Math.floor(n / 1000)) : null;
}

/**
 * Exclusion des dernières minutes avant la fin du créneau 15 min (alignée bot live).
 * Temporairement à 0 : réactiver `4 * 60` quand tu voudras remettre la règle des 4 minutes.
 */
const NO_TRADE_LAST_SEC_15M = 0; // était : 4 * 60

function computeBotSimulation(historyUp, historyDown, winner, endDateStr) {
  const empty = { botWouldTake: null, botWon: null, botEntryPrice: null, botEntryTimestamp: null, botOrderType: null };
  const up = Array.isArray(historyUp) ? historyUp : [];
  const down = Array.isArray(historyDown) ? historyDown : [];
  if (up.length === 0 && down.length === 0) return empty;

  let endTsSec = null;
  if (endDateStr) {
    const raw = endDateStr;
    const endMs = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
    if (Number.isFinite(endMs)) endTsSec = Math.floor(endMs / 1000);
  }
  const endCutSec = endTsSec != null ? endTsSec - NO_TRADE_LAST_SEC_15M : null;

  // On prend le plus tôt entre (token Up entre en bande) et (token Down entre en bande).
  // Si l'historique Down est absent, on retombe sur le complément (1 - pUp) pour rester robuste.
  const candidates = [];

  for (const pt of up) {
    const p = pt?.p ?? pt?.price;
    const pUp = Number(p);
    const ts = toSeconds(pt?.t ?? pt?.timestamp);
    if (!Number.isFinite(pUp) || ts == null) continue;
    if (endCutSec != null && ts >= endCutSec) continue;
    if (pUp >= MIN_P && pUp <= MAX_P) candidates.push({ side: 'Up', price: pUp, ts });
    if (down.length === 0) {
      const pDown = 1 - pUp;
      if (pDown >= MIN_P && pDown <= MAX_P) candidates.push({ side: 'Down', price: pDown, ts });
    }
  }

  if (down.length > 0) {
    for (const pt of down) {
      const p = pt?.p ?? pt?.price;
      const pDown = Number(p);
      const ts = toSeconds(pt?.t ?? pt?.timestamp);
      if (!Number.isFinite(pDown) || ts == null) continue;
      if (endCutSec != null && ts >= endCutSec) continue;
      if (pDown >= MIN_P && pDown <= MAX_P) candidates.push({ side: 'Down', price: pDown, ts });
    }
  }

  if (candidates.length === 0) return empty;
  // Tie-breaker : Up avant Down si ts identiques
  candidates.sort((a, b) => a.ts - b.ts || (a.side === 'Up' ? -1 : 1) - (b.side === 'Up' ? -1 : 1));
  const first = candidates[0];
  return {
    botWouldTake: first.side,
    botWon: winner === first.side,
    botEntryPrice: first.price,
    botEntryTimestamp: first.ts,
    botOrderType: 'Marché',
  };
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
        const refEndMs = resolve15mRefEndMs(ev);
        if (!isWithinLastHoursByRefEndMs(refEndMs, windowHours)) return;
        const endDateRaw = ev.endDate ?? ev.end_date_iso ?? ev.closedTime ?? ev.finishedTimestamp ?? '';
        const m0 = ev.markets?.[0];
        const endDate =
          endDateRaw ||
          (refEndMs != null ? new Date(refEndMs).toISOString() : '') ||
          (m0?.endDate ?? m0?.endDateIso ?? '');
        if (!endDate) return;
        const slotLabel = get15mLabelFromSlug(ev.slug ?? '');
        const slotEndedAtLeast2MinAgo = refEndMs != null && Date.now() >= refEndMs + 120000;
        for (const m of ev.markets ?? []) {
          let winner = getResolvedWinner(m);
          if (!winner && !slotEndedAtLeast2MinAgo) continue;
          const cid = m.conditionId ?? m.condition_id ?? ev.slug;
          if (seen.has(cid)) continue;
          seen.add(cid);
          const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(m);
          results.push({
            eventSlug: ev.slug,
            question: m.question ?? ev.title ?? ev.slug ?? '',
            hourLabel: slotLabel,
            endDate,
            /** Fin de créneau UTC (s) : référence CLOB / bot (dérivée de `ev.endDate` si possible). */
            slotEndSec: refEndMs != null ? Math.floor(refEndMs / 1000) : null,
            winner: winner || null,
            conditionId: cid,
            tokenIdUp,
            tokenIdDown,
          });
        }
      };

      const slotCount = Math.min(MAX_15M_SLUG_FETCH, Math.ceil(windowHours * SLOTS_PER_HOUR));
      const recent15mSlugs = getRecent15mSlugs(slotCount);
      const slugEventsFirst = await fetch15mEventsBySlugBatches(recent15mSlugs, 4);
      slugEventsFirst.forEach(processEvent);

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
      } catch {
        // Ne jamais throw : un 429/503/timeout sur la liste « closed » ne doit pas effacer les events déjà chargés par slug.
        try {
          const { data } = await axios.get(GAMMA_EVENTS_URL, { params: { closed: true, limit: 500 }, timeout: 15000 });
          const arr = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
          arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)).forEach(processEvent);
        } catch {
          /* on garde ce que la phase slug a récupéré */
        }
      }

      try {
        const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, slug_contains: BITCOIN_UP_DOWN_15M_SLUG, limit: 100 },
          timeout: 15000,
        });
        const activeEvents = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
        activeEvents.forEach(processEvent);
      } catch {
        try {
          const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 300 }, timeout: 15000 });
          const arr = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
          arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)).forEach(processEvent);
        } catch {
          /* inchangé : phase slug + closed déjà fusionnés */
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
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (i > 0) await new Promise((res) => setTimeout(res, 40));
        const historyEndIso =
          r.slotEndSec != null && Number.isFinite(r.slotEndSec)
            ? new Date(r.slotEndSec * 1000).toISOString()
            : r.endDate;
        let historyUp = [];
        let historyDown = [];
        let historySource = 'none';
        let debugClobFetchError = null;
        let debugDataFetchError = null;
        let debugUsedDirectClob = false;
        let debugUsedDirectDataApi = false;
        if (r.tokenIdUp) {
          const clobRes = await fetchPriceHistory(r.tokenIdUp, historyEndIso);
          historyUp = clobRes.history;
          debugClobFetchError = clobRes.error;
          debugUsedDirectClob = Boolean(clobRes.usedDirectClob);
          if (historyUp.length > 0) historySource = clobRes.usedDirectClob ? 'clob-direct' : 'clob';
        }
        if (r.tokenIdDown) {
          // Série CLOB sur le token Down pour coller davantage au bestAsk token du bot.
          const downRes = await fetchPriceHistory(r.tokenIdDown, historyEndIso);
          historyDown = downRes.history;
        }
        if (historyUp.length === 0 && r.conditionId) {
          const trRes = await fetchPriceHistoryFromTrades(r.conditionId, historyEndIso);
          historyUp = trRes.history;
          debugDataFetchError = trRes.error;
          debugUsedDirectDataApi = Boolean(trRes.usedDirectDataApi);
          if (historyUp.length > 0) historySource = trRes.usedDirectDataApi ? 'trades-direct' : 'trades';
        }
        const historyPointCount = historyUp.length;
        const sim =
          historyUp.length > 0 || historyDown.length > 0
            ? computeBotSimulation(historyUp, historyDown, r.winner, historyEndIso)
            : { botWouldTake: null, botWon: null, botEntryPrice: null, botEntryTimestamp: null, botOrderType: null };
        enriched.push({
          ...r,
          ...sim,
          debugHistoryPoints: historyPointCount,
          debugHistorySource: historySource,
          debugHasTokenUp: Boolean(r.tokenIdUp),
          debugClobFetchError,
          debugDataFetchError,
          debugUsedDirectClob,
          debugUsedDirectDataApi,
        });
      }
      if (import.meta.env.DEV) {
        const clob = enriched.filter((e) => e.debugHistorySource === 'clob').length;
        const clobDir = enriched.filter((e) => e.debugHistorySource === 'clob-direct').length;
        const trades = enriched.filter((e) => e.debugHistorySource === 'trades').length;
        const tradesDir = enriched.filter((e) => e.debugHistorySource === 'trades-direct').length;
        const none = enriched.filter((e) => e.debugHistorySource === 'none').length;
        const noToken = enriched.filter((e) => !e.debugHasTokenUp).length;
        const sampleErr = enriched.find(
          (e) => e.debugHistorySource === 'none' && (e.debugClobFetchError || e.debugDataFetchError)
        );
        console.info('[15m résolus] historique prix', {
          créneaux: enriched.length,
          sourceClob: clob,
          sourceClobDirect: clobDir,
          sourceDataApiTrades: trades,
          sourceDataDirect: tradesDir,
          sansHistorique: none,
          sansTokenUp: noToken,
          clobUrl: CLOB_PRICES_HISTORY_URL,
          dataUrl: DATA_API_TRADES_URL,
          noTradeLastSec: NO_TRADE_LAST_SEC_15M,
          exempleErreurFetch:
            sampleErr != null
              ? [sampleErr.debugClobFetchError, sampleErr.debugDataFetchError].filter(Boolean).join(' | ') || '200 vide ?'
              : null,
        });
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
