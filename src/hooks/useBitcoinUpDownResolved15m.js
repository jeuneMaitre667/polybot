import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import {
  parseUpDownTokenIdsFromMarket,
  getResolvedUpDownWinnerFromGammaMarket,
  resolveGammaMarketForBtcUpDown,
} from '@/lib/gammaPolymarket.js';
import {
  normalizeConditionId,
  slotEndMsFrom15mSlug,
  dedupeResultsOnePer15mSlot,
  dedupeEnrichedOnePer15mTradeWindow,
} from '@/lib/bitcoin15mBacktestDedupe.js';
import { formatBitcoin15mSlotRangeEt } from '@/lib/polymarketDisplayTime.js';
import {
  is15mSlotEntryTimeForbidden,
  SLOT_15M_ENTRY_FORBID_FIRST_SEC,
  SLOT_15M_ENTRY_FORBID_LAST_SEC,
  ENTRY_TIMING_ET_TIMEZONE,
} from '@/lib/bitcoin15mSlotEntryTiming.js';

const GAMMA_EVENTS_URL = import.meta.env.DEV ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = import.meta.env.DEV ? '/api/events/slug' : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = import.meta.env.DEV ? '/api/markets/slug' : 'https://gamma-api.polymarket.com/markets/slug';
/** En dev, proxy Vite évite CORS ; en prod, URL directe. */
const CLOB_PRICES_HISTORY_URL = import.meta.env.DEV
  ? '/apiClob/prices-history'
  : 'https://clob.polymarket.com/prices-history';
/**
 * Data API : seuls `market` / `eventId` sont documentés (OpenAPI) — pas de `asset_id`/`after`/`before`.
 * On fetch par `conditionId` puis on filtre le créneau côté client.
 */
const DATA_API_TRADES_URL = import.meta.env.DEV ? '/apiData/trades' : 'https://data-api.polymarket.com/trades';
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
/**
 * Simu 15m : détection sur **bid / mid** prices-history (souvent ~0,5–1¢ sous le best ask live).
 * Seuil détection : ≥ 97¢ (aligné bot 15m) ; entrée simulée **97–98¢**.
 */
const DEFAULT_DETECT_MIN_P = 0.97;
const DEFAULT_SIM_ENTRY_MIN_P = 0.97;
const DEFAULT_SIM_ENTRY_MAX_P = 0.98;

function resolve15mSimConfig(options) {
  const cfg = options?.simulation ?? options?.simConfig ?? null;
  const detectMinP = Number(cfg?.detectMinP);
  const entryMinP = Number(cfg?.entryMinP);
  const entryMaxP = Number(cfg?.entryMaxP);
  const out = {
    detectMinP:
      Number.isFinite(detectMinP) && detectMinP > 0 && detectMinP < 1 ? detectMinP : DEFAULT_DETECT_MIN_P,
    entryMinP: Number.isFinite(entryMinP) && entryMinP > 0 && entryMinP < 1 ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P,
    entryMaxP: Number.isFinite(entryMaxP) && entryMaxP > 0 && entryMaxP < 1 ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P,
  };
  if (out.entryMaxP < out.entryMinP) {
    const tmp = out.entryMaxP;
    out.entryMaxP = out.entryMinP;
    out.entryMinP = tmp;
  }
  // La détection ne peut pas être plus haute que l’entrée mini (sinon “pas de signal” artificiel).
  out.detectMinP = Math.min(out.detectMinP, out.entryMinP);
  return out;
}

/** Stop-loss backtest 15m : mêmes défauts que le bot (`STOP_LOSS_*` dans `bot-24-7/index.js`). */
const envBacktestSl = import.meta.env.VITE_BACKTEST_STOP_LOSS_ENABLED;
const BACKTEST_STOP_LOSS_ENABLED = envBacktestSl !== 'false' && envBacktestSl !== '0';
const BACKTEST_STOP_LOSS_TRIGGER_PRICE_P = Math.max(
  0.01,
  Math.min(0.99, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_TRIGGER_PRICE_P) || 0.75),
);
const BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT = Math.max(
  1,
  Math.min(95, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT) || 30),
);
const BACKTEST_STOP_LOSS_WORST_PRICE_P = Math.max(
  0.001,
  Math.min(0.99, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_WORST_PRICE_P) || 0.01),
);
const BACKTEST_STOP_LOSS_MIN_HOLD_SEC =
  Math.max(0, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_MIN_HOLD_MS) || 10_000) / 1000;

const EMPTY_BOT_SIM_15M = {
  botWouldTake: null,
  botWon: null,
  botEntryPrice: null,
  botEntryTimestamp: null,
  botOrderType: null,
  botStopLossExit: false,
  botStopLossReason: null,
  botStopLossExitPriceP: null,
  botStopLossObservedPriceP: null,
  botStopLossObservedDrawdownPct: null,
  botStopLossAtTimestamp: null,
  /** Plus bas proxy prix observé après l’entrée (utile pour analyser des SL absolus). */
  botMinObservedAfterEntryP: null,
  botResolutionWouldWin: null,
};

/** Détection : franchissement de la zone « haute » (bid ~ sous ask) — jusqu’à 1. */
function hasCrossedHighConviction(p, detectMinP) {
  const d = Number.isFinite(detectMinP) ? detectMinP : DEFAULT_DETECT_MIN_P;
  return Number.isFinite(p) && p >= d && p <= 1;
}

/** Prix d’entrée reporté : plancher 96¢, plafond 98¢. */
function clampEntryPrice(p, entryMinP, entryMaxP) {
  const lo = Number.isFinite(entryMinP) ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P;
  const hi = Number.isFinite(entryMaxP) ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P;
  if (!Number.isFinite(p) || p < lo) return lo;
  return Math.min(p, hi);
}

/** Meilleur max(p, 1−p) sur une série token (conviction max d’un côté du binaire). */
function maxBinaryConvictionInSeries(series) {
  const arr = Array.isArray(series) ? series : [];
  let m = -Infinity;
  for (const pt of arr) {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    if (!Number.isFinite(p)) continue;
    m = Math.max(m, p, 1 - p);
  }
  return Number.isFinite(m) ? Math.round(m * 10000) / 10000 : null;
}

/** Max de max(p,1−p) sur les deux séries (même logique que la simu binaire). */
function maxBinaryAcrossBothSeries(up, down) {
  const a = maxBinaryConvictionInSeries(up);
  const b = maxBinaryConvictionInSeries(down);
  const vals = [a, b].filter((x) => x != null && Number.isFinite(x));
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

/**
 * Prix outcome 0–1. Si l’API renvoie des centièmes (ex. 97 → 0,97), on normalise.
 */
function normalizeOutcomePrice(raw) {
  if (raw == null) return NaN;
  const p0 = typeof raw === 'string' ? parseFloat(String(raw).replace(',', '.')) : Number(raw);
  if (!Number.isFinite(p0)) return NaN;
  let p = p0;
  if (p > 1 && p <= 100) p = p / 100;
  if (p > 1) p = 1;
  if (p < 0) p = 0;
  return p;
}

/** Applique `normalizeOutcomePrice` sur chaque point (champ `p` écrasé pour la simu). */
function normalizeHistorySeriesPoints(series) {
  const arr = Array.isArray(series) ? series : [];
  return arr.map((pt) => {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    return { ...pt, p };
  });
}

/** Slug 15m = btc-updown-15m-{eventStartUtcSec} — `formatBitcoin15mSlotRangeEt` attend la **fin** de fenêtre. */
function get15mLabelFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return slug || '—';
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (m) {
    const ts = parseInt(m[1], 10);
    const startSec = ts < 1e12 ? ts : Math.floor(ts / 1000);
    return formatBitcoin15mSlotRangeEt(startSec + 15 * 60);
  }
  return slug;
}

const DEFAULT_WINDOW_HOURS = 72;
// 1 h = 4 créneaux 15 min. 3 jours = 72 h = 288 créneaux ; 7 jours = 168 h = 672 créneaux.
const SLOTS_PER_HOUR = 4;
const MAX_15M_SLUG_FETCH = 168 * SLOTS_PER_HOUR; // 672 = 7 jours max (pour « un jour de plus »)

/**
 * Slugs récents : suffixe = **eventStart** UTC (`floor(now/900)*900`, puis -900, -1800, …).
 * Aligné Gamma / Polymarket / bot (`getCurrent15mEventSlug`).
 */
function getRecent15mSlugs(slotCount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const slotSec = 15 * 60;
  const currentStart = Math.floor(nowSec / slotSec) * slotSec;
  const slugs = [];
  const n = Math.min(slotCount, MAX_15M_SLUG_FETCH);
  for (let i = 0; i < n; i++) {
    slugs.push(`${BITCOIN_UP_DOWN_15M_SLUG}-${currentStart - i * slotSec}`);
  }
  return slugs;
}

/** Fenêtre temporelle basée sur une fin de créneau (ms). */
function isWithinLastHoursByRefEndMs(refEndMs, hours) {
  if (refEndMs == null || !Number.isFinite(refEndMs)) return false;
  const now = Date.now();
  return refEndMs <= now && now - refEndMs <= hours * 60 * 60 * 1000;
}

/**
 * Fin de créneau pour filtrage, fenêtre CLOB/prices-history et simulation.
 * `slotEndMsFrom15mSlug` renvoie la **fin** (= début slug + 900 s, Gamma `eventStartTime`).
 * Sur Gamma, `ev.endDate` peut différer légèrement ; le slug reste la vérité affichage Polymarket.
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

/** Créneau 15m (s) + marge : filtre **après** fetch comme le 1h (4 h), pour ne simuler que pendant le slot. */
const SLOT_15M_SEC = 15 * 60;
/**
 * Marge **avant** le début du créneau : le fetch Data API garde une fenêtre large ; le filtre simu exclut
 * les points avant `slotStart` dans `collectSimEntryCandidatesWithConfig`.
 */
const SLOT_15M_MARGIN_SEC = 30 * 60;
/**
 * Fenêtre **après** la fin slug : `tradeHi` côté Data API **et** borne haute du filtre séries.
 * Doit être **identique** : sinon on fetch des trades jusqu’à +45 min puis on les jette au `filterSeriesTo15mSlot`
 * (pics haute conviction souvent horodatés entre +15 et +45 min → `rowsMaxBinaryGeMinAfterSlotFilter: 0`).
 */
const SLOT_END_PADDING_SEC = 45 * 60;
/**
 * Rejet des candidats d’entrée si `ts` dépasse **fin slug + cette marge** (doit matcher la borne haute des séries
 * / `tradeHi`, sinon les pics visibles dans l’historique sont tous exclus → 0 signal en tableau).
 */
const SLOT_ENTRY_MAX_AFTER_END_SEC = SLOT_END_PADDING_SEC;
/**
 * @deprecated Ancien nom (30 s puis retiré) — **alias** de `SLOT_ENTRY_MAX_AFTER_END_SEC` pour éviter
 * « SLOT_END_SIM_SLOP_SEC is not defined » (cache Vite, HMR, onglet).
 */
const SLOT_END_SIM_SLOP_SEC = SLOT_ENTRY_MAX_AFTER_END_SEC;
/**
 * Ancien nom — **alias** de `SLOT_END_PADDING_SEC` pour éviter erreurs « not defined »
 * (cache Vite / onglet / copier-coller d’une vieille version).
 */
const SLOT_SERIES_HI_PADDING_SEC = SLOT_END_PADDING_SEC;

/**
 * Historique CLOB `prices-history` — souvent **prix mid** (~50¢), pas le best ask ; utile comme contexte,
 * les **vrais** prix d’exécution élevés viennent surtout des trades Data API (`fetchDataApiTradePointsByToken`).
 */
async function fetchPriceHistory(tokenId, endDateStr) {
  const endMs = new Date(endDateStr).getTime();
  if (!Number.isFinite(endMs)) return { history: [], error: 'endDate invalide', meta: null };
  const endTs = Math.floor(endMs / 1000);
  const startTs = endTs - 14400;
  const baseMeta = { startTs, endTs, tokenIdTail: String(tokenId).slice(-8) };
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
    /** Inclure 1 min en premier : un pic court sur 1–2 min entre deux points fidelity=5 était invisible (~3 points / 15 min). */
    const fidelityAttempts = [1, 5, 15, 60];
    for (const fidelity of fidelityAttempts) {
      const res = await axios.get(CLOB_PRICES_HISTORY_URL, {
        params: { market: String(tokenId), startTs, endTs, fidelity },
        timeout: 10000,
      });
      const history = toHistory(res.data);
      if (history.length > 0) return { history, error: null, meta: { ...baseMeta, path: 'fidelity', fidelity } };
    }
    const res = await axios.get(CLOB_PRICES_HISTORY_URL, {
      params: { market: String(tokenId), startTs, endTs, interval: '12h' },
      timeout: 10000,
    });
    let history = toHistory(res.data);
    if (history.length === 0) {
      const resMax = await axios.get(CLOB_PRICES_HISTORY_URL, {
        params: { market: String(tokenId), startTs, endTs, interval: 'max' },
        timeout: 10000,
      });
      history = filterByWindow(toHistory(resMax.data));
      if (history.length > 0) return { history, error: null, meta: { ...baseMeta, path: 'interval:max+filter' } };
    } else {
      return { history, error: null, meta: { ...baseMeta, path: 'interval:12h' } };
    }
    return { history, error: null, meta: { ...baseMeta, path: 'empty' } };
  } catch (e) {
    return { history: [], error: formatAxiosError(e), meta: { ...baseMeta, path: 'error' } };
  }
}

/** Compare `asset` (trade) et clobTokenId (Gamma) — chaînes ou grands entiers. */
function assetsMatch(assetRaw, tokenIdRaw) {
  if (assetRaw == null || tokenIdRaw == null) return false;
  const a = String(assetRaw).trim();
  const b = String(tokenIdRaw).trim();
  if (a === b) return true;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    try {
      return BigInt(a) === BigInt(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** La Data API renvoie souvent un tableau brut ; le CLOB documenté renvoie `{ data: [...] }`. */
function unwrapTradesPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.trades)) return payload.trades;
  return [];
}

function parseTimeToUnixSec(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return n < 1e12 ? n : Math.floor(n / 1000);
    }
    if (/[T\-:]/.test(s)) {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n : Math.floor(n / 1000);
}

function tradeTimestampSec(tr) {
  const ts = parseTimeToUnixSec(tr?.timestamp);
  if (ts != null) return ts;
  return parseTimeToUnixSec(tr?.createdAt);
}

/** Identifiant token côté trade (Data API `asset`, CLOB-style `asset_id`). */
function tradeAssetId(tr) {
  const v = tr?.asset ?? tr?.asset_id ?? tr?.assetId;
  return v != null ? String(v).trim() : '';
}

/** Outcome explicite « Up » / « Down » (souvent présent sur les trades agrégés). */
function outcomeLabelToSide(outcome) {
  if (outcome == null) return null;
  const o = String(outcome).trim().toLowerCase();
  if (o === 'up' || o === 'yes') return 'up';
  if (o === 'down' || o === 'no') return 'down';
  return null;
}

async function fetchDataApiTradesAllPages(extraParams) {
  const merged = [];
  for (let offset = 0; offset < 60000; offset += 10000) {
    const { data } = await axios.get(DATA_API_TRADES_URL, {
      params: { ...extraParams, limit: 10000, offset, takerOnly: false },
      timeout: 25000,
    });
    const page = unwrapTradesPayload(data);
    if (page.length === 0) break;
    merged.push(...page);
    if (page.length < 10000) break;
  }
  return merged;
}

/**
 * Trades par `asset_id` (token). La Data API ne documente pas `after`/`before` : pagination puis **filtre temps en JS**.
 */
async function fetchDataApiTradesByAsset(tokenId, afterTs, beforeTs) {
  const merged = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const { data } = await axios.get(DATA_API_TRADES_URL, {
      params: {
        asset_id: String(tokenId),
        limit: 500,
        offset,
        takerOnly: false,
      },
      timeout: 10000,
    });
    const raw = unwrapTradesPayload(data);
    const inWindow = raw.filter((tr) => {
      const t = tradeTimestampSec(tr);
      return t != null && t >= afterTs && t <= beforeTs;
    });
    merged.push(...inWindow);
    if (raw.length < 500) break;
  }
  return merged;
}

/**
 * Trades Data API (public) : **prix d’exécution** par token (`asset` = clobTokenId).
 * Priorité : `asset_id` + filtre créneau client ; repli `market` / `eventId`.
 */
async function fetchDataApiTradePointsByToken(conditionId, tokenIdUp, tokenIdDown, endDateStr, gammaEventId = null) {
  const cid = normalizeConditionId(conditionId);
  if (!cid) {
    return {
      pointsUp: [],
      pointsDown: [],
      error: 'conditionId invalide',
      meta: { reason: 'cid' },
    };
  }
  const endMs = new Date(endDateStr).getTime();
  if (!Number.isFinite(endMs)) {
    return {
      pointsUp: [],
      pointsDown: [],
      error: 'endDate invalide',
      meta: { reason: 'endDate' },
    };
  }
  const endTs = Math.floor(endMs / 1000);
  /** Fenêtre collée au créneau (~15 min + marge avant) : évite 72 h de pagination / timeouts ; filtre simu affine encore. */
  const tradeLo = endTs - SLOT_15M_SEC - SLOT_15M_MARGIN_SEC;
  const tradeHi = endTs + SLOT_END_PADDING_SEC;
  const tidUp = tokenIdUp != null && String(tokenIdUp).trim() !== '' ? String(tokenIdUp).trim() : null;
  const tidDown = tokenIdDown != null && String(tokenIdDown).trim() !== '' ? String(tokenIdDown).trim() : null;

  try {
    let trades = [];
    let fetchMode = 'asset_id';
    if (tidUp || tidDown) {
      const [tradesUp, tradesDown] = await Promise.all([
        tidUp ? fetchDataApiTradesByAsset(tidUp, tradeLo, tradeHi).catch(() => []) : Promise.resolve([]),
        tidDown ? fetchDataApiTradesByAsset(tidDown, tradeLo, tradeHi).catch(() => []) : Promise.resolve([]),
      ]);
      trades = [...tradesUp, ...tradesDown];
    }
    if (trades.length === 0) {
      trades = await fetchDataApiTradesAllPages({ market: cid });
      fetchMode = 'market';
      if (trades.length === 0 && gammaEventId != null && Number.isFinite(Number(gammaEventId))) {
        const byEvent = await fetchDataApiTradesAllPages({ eventId: Number(gammaEventId) });
        trades = byEvent.filter((tr) => normalizeConditionId(tr.conditionId ?? tr.condition_id) === cid);
        fetchMode = 'eventId+filter';
      }
    }
    const rawLen = trades.length;
    if (rawLen === 0) {
      return {
        pointsUp: [],
        pointsDown: [],
        error: null,
        meta: {
          tradeLo,
          tradeHi,
          rawTrades: 0,
          pointsUp: 0,
          pointsDown: 0,
          byAssetUp: 0,
          byAssetDown: 0,
          bySkippedUnclassified: 0,
          fetchMode,
          note: 'Aucun trade Data API (asset_id puis market/eventId + filtre créneau client)',
        },
      };
    }
    const pointsUp = [];
    const pointsDown = [];
    let byAssetUp = 0;
    let byAssetDown = 0;
    let byOutcomeNameUp = 0;
    let byOutcomeNameDown = 0;
    /** Trades sans `asset` reconnu ni outcome explicite — on ne devine pas via outcomeIndex (souvent Down=0 sur Gamma). */
    let bySkippedUnclassified = 0;

    for (const tr of trades) {
      const t = tradeTimestampSec(tr);
      if (t == null || t < tradeLo || t > tradeHi) continue;
      const rawPrice = tr.price;
      if (rawPrice == null) continue;
      const price = normalizeOutcomePrice(rawPrice);
      if (!Number.isFinite(price)) continue;

      const aid = tradeAssetId(tr);
      if (tidUp && assetsMatch(aid || tr.asset, tidUp)) {
        pointsUp.push({ t, p: price, src: 'data-api' });
        byAssetUp += 1;
        continue;
      }
      if (tidDown && assetsMatch(aid || tr.asset, tidDown)) {
        pointsDown.push({ t, p: price, src: 'data-api' });
        byAssetDown += 1;
        continue;
      }

      const side = outcomeLabelToSide(tr.outcome);
      if (side === 'up') {
        pointsUp.push({ t, p: price, src: 'data-api-outcome' });
        byOutcomeNameUp += 1;
        continue;
      }
      if (side === 'down') {
        pointsDown.push({ t, p: price, src: 'data-api-outcome' });
        byOutcomeNameDown += 1;
        continue;
      }

      bySkippedUnclassified += 1;
    }
    pointsUp.sort((a, b) => a.t - b.t);
    pointsDown.sort((a, b) => a.t - b.t);
    return {
      pointsUp,
      pointsDown,
      error: null,
      meta: {
        tradeLo,
        tradeHi,
        rawTrades: rawLen,
        pointsUp: pointsUp.length,
        pointsDown: pointsDown.length,
        byAssetUp,
        byAssetDown,
        byOutcomeNameUp,
        byOutcomeNameDown,
        bySkippedUnclassified,
        market: `${cid.slice(0, 10)}…`,
        fetchMode,
        note: 'CLOB GET /trades = auth L2 (pas depuis le navigateur) ; ici Data API publique (asset / asset_id / outcome)',
      },
    };
  } catch (e) {
    return {
      pointsUp: [],
      pointsDown: [],
      error: formatAxiosError(e),
      meta: { tradeLo, tradeHi, rawTrades: null },
    };
  }
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

function toSeconds(t) {
  return parseTimeToUnixSec(t);
}

/** Fusionne deux séries { t, p } triées par temps (CLOB + trades). */
function mergePriceSeriesSorted(a, b) {
  const out = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  out.sort((x, y) => {
    const tx = toSeconds(x?.t ?? x?.timestamp);
    const ty = toSeconds(y?.t ?? y?.timestamp);
    if (tx == null && ty == null) return 0;
    if (tx == null) return 1;
    if (ty == null) return -1;
    return tx - ty;
  });
  return out;
}

/**
 * Après entrée : premier instant (série du token acheté) où un proxy prix déclenche le stop hybride bot
 * (prix &lt; seuil **ou** drawdown depuis l’entrée ≤ −X %). Proxy = même `p` que la détection (mid / trades).
 */
function findStopLossAfterEntry(heldSeries, entryTs, entryPrice, minHoldSec) {
  if (!BACKTEST_STOP_LOSS_ENABLED) return { triggered: false };
  const holdEnd = entryTs + minHoldSec;
  const arr = Array.isArray(heldSeries) ? [...heldSeries] : [];
  arr.sort((a, b) => {
    const ta = toSeconds(a?.t ?? a?.timestamp);
    const tb = toSeconds(b?.t ?? b?.timestamp);
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  });
  for (const pt of arr) {
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (t == null || t < holdEnd) continue;
    const bidProxy = normalizeOutcomePrice(pt?.p ?? pt?.price);
    if (!Number.isFinite(bidProxy)) continue;
    const drawdownPct = ((bidProxy - entryPrice) / entryPrice) * 100;
    const triggerByPrice = bidProxy < BACKTEST_STOP_LOSS_TRIGGER_PRICE_P;
    const triggerByDrawdown = drawdownPct <= -Math.abs(BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT);
    if (triggerByPrice || triggerByDrawdown) {
      return {
        triggered: true,
        reason: triggerByPrice ? 'price_below_threshold' : 'drawdown_limit',
        t,
        observedP: bidProxy,
        drawdownPct: Math.round(drawdownPct * 100) / 100,
      };
    }
  }
  return { triggered: false };
}

/**
 * Plus bas prix (proxy) observé après l’entrée, après le délai min hold.
 * Proxy = même `p` que la détection (mid / trades normalisés).
 */
function minObservedPriceAfterEntry(heldSeries, entryTs, minHoldSec) {
  const holdEnd = entryTs + minHoldSec;
  const arr = Array.isArray(heldSeries) ? heldSeries : [];
  let minP = Infinity;
  for (const pt of arr) {
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (t == null || t < holdEnd) continue;
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    if (!Number.isFinite(p)) continue;
    minP = Math.min(minP, p);
  }
  return Number.isFinite(minP) ? Math.round(minP * 1e6) / 1e6 : null;
}

/**
 * Filtre les points pour la simu : fenêtre autour du créneau ; **hi** large pour garder trades tardifs.
 * L’entrée simulée accepte un `ts` jusqu’à `SLOT_ENTRY_MAX_AFTER_END_SEC` après la fin slug (trades tardifs).
 */
function filterSeriesTo15mSlot(series, slotEndSec) {
  if (slotEndSec == null || !Number.isFinite(slotEndSec)) return Array.isArray(series) ? series : [];
  const lo = slotEndSec - SLOT_15M_SEC - SLOT_15M_MARGIN_SEC;
  const hi = slotEndSec + SLOT_END_PADDING_SEC;
  const arr = Array.isArray(series) ? series : [];
  return arr.filter((pt) => {
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    return t != null && t >= lo && t <= hi;
  });
}

function slotFilterBounds(slotEndSec) {
  if (slotEndSec == null || !Number.isFinite(slotEndSec)) return null;
  const lo = slotEndSec - SLOT_15M_SEC - SLOT_15M_MARGIN_SEC;
  const hi = slotEndSec + SLOT_END_PADDING_SEC;
  return {
    loSec: lo,
    hiSec: hi,
    loIso: new Date(lo * 1000).toISOString(),
    hiIso: new Date(hi * 1000).toISOString(),
    dataApiFetchPaddingAfterSec: SLOT_END_PADDING_SEC,
    entryMaxAfterSlotSec: SLOT_ENTRY_MAX_AFTER_END_SEC,
  };
}

/** Stats prix sur une série CLOB/trades (points déjà { t, p } ou champs équivalents). */
function summarizeSeriesForDebug(series) {
  const arr = Array.isArray(series) ? series : [];
  let minP = Infinity;
  let maxP = -Infinity;
  let inBand = 0;
  let first = null;
  let last = null;
  for (const pt of arr) {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (!Number.isFinite(p) || t == null) continue;
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);
    if (hasCrossedHighConviction(p, DEFAULT_DETECT_MIN_P)) inBand += 1;
    const cur = { t, p };
    if (first == null) first = cur;
    last = cur;
  }
  return {
    count: arr.length,
    minP: Number.isFinite(minP) ? Math.round(minP * 10000) / 10000 : null,
    maxP: Number.isFinite(maxP) ? Math.round(maxP * 10000) / 10000 : null,
    pointsInBand: inBand,
    firstT: first?.t ?? null,
    lastT: last?.t ?? null,
  };
}

/** Export debug / UI (clé historique `forbiddenMinuteWindowsUtc` conservée pour le JSON de debug). */
const BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC = {
  basis: 'et_quarter_hour',
  displayTimezone: ENTRY_TIMING_ET_TIMEZONE,
  appliedInSimulation: true,
  slotDurationSec: SLOT_15M_SEC,
  forbidFirstSecondsFromSlotStart: SLOT_15M_ENTRY_FORBID_FIRST_SEC,
  forbidLastSecondsBeforeSlotEnd: SLOT_15M_ENTRY_FORBID_LAST_SEC,
  label:
    `Pas d’entrée : dans chaque quart d’heure local ${ENTRY_TIMING_ET_TIMEZONE} (:00,:15,:30,:45), interdit les ${SLOT_15M_ENTRY_FORBID_FIRST_SEC / 60} premières minutes et les ${SLOT_15M_ENTRY_FORBID_LAST_SEC / 60} dernières — aligné sur l’heure ET du trade (comme le tableau).`,
};

/**
 * Candidats d’entrée (événements triés, interpolation, exclusion début / fin de quart d’heure **en heure ET**).
 * @returns {{ candidates: Array<{side:string,price:number,ts:number}>, endTsSec: number|null, forbiddenMinuteRule: typeof BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC }}
 */
function collectSimEntryCandidatesWithConfig(historyUp, historyDown, endDateStr, slotEndSecExplicit, simCfg) {
  const { detectMinP, entryMinP, entryMaxP } = simCfg || resolve15mSimConfig(null);
  const up = Array.isArray(historyUp) ? historyUp : [];
  const down = Array.isArray(historyDown) ? historyDown : [];
  let endTsSec = null;
  if (slotEndSecExplicit != null && Number.isFinite(Number(slotEndSecExplicit))) {
    endTsSec = Math.floor(Number(slotEndSecExplicit));
  } else if (endDateStr) {
    const raw = endDateStr;
    const endMs = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : new Date(raw).getTime();
    if (Number.isFinite(endMs)) endTsSec = Math.floor(endMs / 1000);
  }
  const events = [];
  for (const pt of up) {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (!Number.isFinite(p) || t == null) continue;
    events.push({ t, side: 'Up', price: p });
    events.push({ t, side: 'Down', price: 1 - p });
  }
  for (const pt of down) {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (!Number.isFinite(p) || t == null) continue;
    events.push({ t, side: 'Down', price: p });
    events.push({ t, side: 'Up', price: 1 - p });
  }
  events.sort((a, b) => a.t - b.t);
  const lastBySide = { Up: null, Down: null };
  const candidates = [];
  for (const ev of events) {
    const { t, side, price } = ev;
    if (!hasCrossedHighConviction(price, detectMinP)) {
      lastBySide[side] = { t, price };
      continue;
    }
    const prev = lastBySide[side];
    let tsUsed = t;
    if (prev != null && prev.price < detectMinP && price > prev.price) {
      const numer = detectMinP - prev.price;
      const denom = price - prev.price;
      if (denom > 0) tsUsed = prev.t + (t - prev.t) * (numer / denom);
    }
    if (endTsSec != null && Number.isFinite(endTsSec)) {
      const slotStartSec = endTsSec - SLOT_15M_SEC;
      if (tsUsed > endTsSec + SLOT_ENTRY_MAX_AFTER_END_SEC || tsUsed < slotStartSec) {
        lastBySide[side] = { t, price };
        continue;
      }
      if (is15mSlotEntryTimeForbidden(tsUsed)) {
        lastBySide[side] = { t, price };
        continue;
      }
    }
    candidates.push({ side, price: clampEntryPrice(price, entryMinP, entryMaxP), ts: tsUsed });
    lastBySide[side] = { t, price };
  }
  return { candidates, endTsSec, forbiddenMinuteRule: BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC };
}

function debugWhyNoSignalWithConfig(historyUp, historyDown, endDateStr, slotEndSecExplicit, simCfg) {
  const { detectMinP, entryMinP, entryMaxP } = simCfg || resolve15mSimConfig(null);
  const up = Array.isArray(historyUp) ? historyUp : [];
  const down = Array.isArray(historyDown) ? historyDown : [];
  if (up.length === 0 && down.length === 0) {
    return { code: 'empty_after_slot_filter', detail: 'Aucun point après filtre créneau (voir slotBounds dans simDebug).' };
  }
  const { candidates, endTsSec, forbiddenMinuteRule } = collectSimEntryCandidatesWithConfig(
    historyUp,
    historyDown,
    endDateStr,
    slotEndSecExplicit,
    simCfg
  );
  if (candidates.length > 0) {
    const touchesBand = candidates.slice(0, 5).map((c) => ({
      side: c.side,
      p: Math.round(c.price * 10000) / 10000,
      ts: c.ts,
    }));
    return { code: 'would_signal', touchesBand };
  }
  const maxU = maxBinaryConvictionInSeries(up);
  const maxD = maxBinaryConvictionInSeries(down);
  const maxBin = [maxU, maxD].filter((x) => x != null && Number.isFinite(x));
  const peak = maxBin.length ? Math.max(...maxBin) : null;
  const hadHigh = peak != null && peak >= detectMinP;
  if (hadHigh) {
    return {
      code: 'excluded_by_15m_slot_forbidden_window',
      detail: `Franchissement ≥ ${detectMinP} présent, mais ts (ou interpolé) dans les ${SLOT_15M_ENTRY_FORBID_FIRST_SEC / 60} premières min ou les ${SLOT_15M_ENTRY_FORBID_LAST_SEC / 60} dernières d’un quart d’heure ${ENTRY_TIMING_ET_TIMEZONE} (:00,:15,:30,:45).`,
      forbiddenMinuteRule,
      endTsSec,
      maxBinaryConvictionUpToken: maxU,
      maxBinaryConvictionDownToken: maxD,
    };
  }
  return {
    code: 'no_price_in_band',
    detail: `Aucun franchissement ≥ ${detectMinP} après filtre créneau (entrée simulée ${entryMinP}–${entryMaxP}).`,
    maxBinaryConvictionUpToken: maxU,
    maxBinaryConvictionDownToken: maxD,
  };
}

function computeBotSimulationWithConfig(historyUp, historyDown, winner, endDateStr, slotEndSecExplicit, simCfg) {
  const up = Array.isArray(historyUp) ? historyUp : [];
  const down = Array.isArray(historyDown) ? historyDown : [];
  if (up.length === 0 && down.length === 0) return { ...EMPTY_BOT_SIM_15M };

  const { candidates } = collectSimEntryCandidatesWithConfig(historyUp, historyDown, endDateStr, slotEndSecExplicit, simCfg);
  if (candidates.length === 0) return { ...EMPTY_BOT_SIM_15M };

  candidates.sort((a, b) => a.ts - b.ts || (a.side === 'Up' ? -1 : 1) - (b.side === 'Up' ? -1 : 1));
  const first = candidates[0];
  const settled = winner === 'Up' || winner === 'Down';
  const resolutionWin = settled ? winner === first.side : null;
  const heldSeries = first.side === 'Up' ? up : down;
  const sl = findStopLossAfterEntry(heldSeries, first.ts, first.price, BACKTEST_STOP_LOSS_MIN_HOLD_SEC);
  const minAfter = minObservedPriceAfterEntry(heldSeries, first.ts, BACKTEST_STOP_LOSS_MIN_HOLD_SEC);

  if (sl.triggered) {
    return {
      botWouldTake: first.side,
      botWon: null,
      botEntryPrice: first.price,
      botEntryTimestamp: first.ts,
      botOrderType: 'Marché',
      botStopLossExit: true,
      botStopLossReason: sl.reason,
      botStopLossExitPriceP: Math.round(BACKTEST_STOP_LOSS_WORST_PRICE_P * 1e6) / 1e6,
      botStopLossObservedPriceP: sl.observedP != null ? Math.round(Number(sl.observedP) * 1e6) / 1e6 : null,
      botStopLossObservedDrawdownPct: sl.drawdownPct,
      botStopLossAtTimestamp: sl.t,
      botMinObservedAfterEntryP: minAfter,
      botResolutionWouldWin: resolutionWin,
    };
  }

  return {
    botWouldTake: first.side,
    botWon: resolutionWin,
    botEntryPrice: first.price,
    botEntryTimestamp: first.ts,
    botOrderType: 'Marché',
    botStopLossExit: false,
    botStopLossReason: null,
    botStopLossExitPriceP: null,
    botStopLossObservedPriceP: null,
    botStopLossObservedDrawdownPct: null,
    botStopLossAtTimestamp: null,
    botMinObservedAfterEntryP: minAfter,
    botResolutionWouldWin: null,
  };
}

/**
 * Récupère les marchés Bitcoin Up or Down 15 min résolus (slug btc-updown-15m-*).
 * Même logique que useBitcoinUpDownResolved mais pour les créneaux 15 min.
 * @param {number} windowHours
 * @param {{ debug?: boolean }} [options] — `debug: true` : remplit `simDebug` par ligne + `debugSummary` (coût mémoire / logs).
 */
export function useBitcoinUpDownResolved15m(windowHours = DEFAULT_WINDOW_HOURS, options = {}) {
  const debug = Boolean(options.debug);
  // Dépendances sur les champs numériques : `options` est souvent un objet inline (nouvelle ref à chaque render).
  /* eslint-disable react-hooks/exhaustive-deps -- resolve15mSimConfig(options) : seuils listés dans le tableau */
  const simCfg = useMemo(
    () => resolve15mSimConfig(options),
    [
      options?.simulation?.detectMinP,
      options?.simulation?.entryMinP,
      options?.simulation?.entryMaxP,
      options?.simConfig?.detectMinP,
      options?.simConfig?.entryMinP,
      options?.simConfig?.entryMaxP,
    ]
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const [resolved, setResolved] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [debugSummary, setDebugSummary] = useState(null);

  const fetchResolved = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const seen = new Set();
      const results = [];

      const processEvent = async (ev) => {
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
        const slugEndMsForOutcome = slotEndMsFrom15mSlug(ev.slug ?? '');
        /** Fin officielle du créneau : **slug** d’abord (vérité Polymarket UTC), sinon refEndMs. */
        const officialSlotEndMs =
          slugEndMsForOutcome != null && Number.isFinite(slugEndMsForOutcome) ? slugEndMsForOutcome : refEndMs;
        const slotEndedAtLeast2MinAgo = refEndMs != null && Date.now() >= refEndMs + 120000;
        for (const m of ev.markets ?? []) {
          const mm = await resolveGammaMarketForBtcUpDown(axios, GAMMA_MARKET_BY_SLUG_URL, ev, m);
          let winner = getResolvedUpDownWinnerFromGammaMarket(mm);
          /**
           * Gamma peut mettre des outcomePrices « résolus » (≥ 98 %) **avant** l’heure de fin du slug UTC.
           * Sans ce garde-fou, le tableau affiche Gagné/Perdu alors que le créneau est encore en cours côté horloge réelle.
           */
          if (
            winner &&
            officialSlotEndMs != null &&
            Number.isFinite(officialSlotEndMs) &&
            Date.now() < officialSlotEndMs
          ) {
            winner = null;
          }
          if (!winner && !slotEndedAtLeast2MinAgo) continue;
          const rawCid = m.conditionId ?? m.condition_id ?? null;
          const normCid = normalizeConditionId(rawCid);
          /** Ne jamais utiliser le slug comme `market` Data API (invalide) — déduplication stable. */
          const seenKey = normCid ?? `slug:${ev.slug ?? ''}:${m.id ?? m.question ?? ''}`;
          if (seen.has(seenKey)) continue;
          seen.add(seenKey);
          const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(mm);
          results.push({
            eventSlug: ev.slug,
            /** Pour Data API : repli `?eventId=` si `?market=conditionId` est vide. */
            gammaEventId: ev.id ?? ev.event_id ?? ev.eventId ?? null,
            question: m.question ?? ev.title ?? ev.slug ?? '',
            hourLabel: slotLabel,
            endDate,
            /** Fin de créneau UTC (s) : **slug** en priorité (vérité Polymarket), pas seulement `refEndMs`/Gamma (décalages ~15 min). */
            slotEndSec:
              officialSlotEndMs != null && Number.isFinite(officialSlotEndMs)
                ? Math.floor(officialSlotEndMs / 1000)
                : refEndMs != null
                  ? Math.floor(refEndMs / 1000)
                  : null,
            winner: winner || null,
            conditionId: normCid ?? rawCid ?? null,
            normalizedConditionId: normCid,
            tokenIdUp,
            tokenIdDown,
          });
        }
      };

      const slotCount = Math.min(MAX_15M_SLUG_FETCH, Math.ceil(windowHours * SLOTS_PER_HOUR));
      const recent15mSlugs = getRecent15mSlugs(slotCount);
      const slugEventsFirst = await fetch15mEventsBySlugBatches(recent15mSlugs, 4);
      for (const ev of slugEventsFirst) await processEvent(ev);

      const endDateMinIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      try {
        for (let offset = 0; offset < 500; offset += 100) {
          const { data: closedPage } = await axios.get(GAMMA_EVENTS_URL, {
            params: {
              closed: true,
              end_date_min: endDateMinIso,
              limit: 100,
              offset,
              order: 'end_date',
              ascending: false,
            },
            timeout: 15000,
          });
          const page = Array.isArray(closedPage) ? closedPage : closedPage?.data ?? closedPage?.results ?? [];
          for (const ev of page) {
            if ((ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) await processEvent(ev);
          }
          if (page.length < 100) break;
        }
      } catch {
        // Ne jamais throw : un 429/503/timeout sur la liste « closed » ne doit pas effacer les events déjà chargés par slug.
        try {
          const { data } = await axios.get(GAMMA_EVENTS_URL, {
            params: { closed: true, end_date_min: endDateMinIso, limit: 500, order: 'end_date', ascending: false },
            timeout: 15000,
          });
          const arr = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
          for (const ev of arr) {
            if ((ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) await processEvent(ev);
          }
        } catch {
          /* on garde ce que la phase slug a récupéré */
        }
      }

      try {
        const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, {
          params: { active: true, closed: false, limit: 300 },
          timeout: 15000,
        });
        const activeEvents = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
        for (const ev of activeEvents) {
          if ((ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) await processEvent(ev);
        }
      } catch {
        try {
          const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 300 }, timeout: 15000 });
          const arr = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
          for (const ev of arr) {
            if ((ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) await processEvent(ev);
          }
        } catch {
          /* inchangé : phase slug + closed déjà fusionnés */
        }
      }

      results.sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());
      const resultsOnePerSlot = dedupeResultsOnePer15mSlot(results);

      for (const r of resultsOnePerSlot) {
        if (!r.tokenIdUp && r.eventSlug) {
          const { tokenIdUp, tokenIdDown } = await fetchTokenIdsByMarketSlug(r.eventSlug);
          r.tokenIdUp = tokenIdUp;
          r.tokenIdDown = tokenIdDown;
        }
      }

      const enriched = [];
      for (let i = 0; i < resultsOnePerSlot.length; i++) {
        const r = resultsOnePerSlot[i];
        if (i > 0) await new Promise((res) => setTimeout(res, 40));
        const historyEndIso =
          r.slotEndSec != null && Number.isFinite(r.slotEndSec)
            ? new Date(r.slotEndSec * 1000).toISOString()
            : r.endDate;
        let upBeforeSlot = [];
        let downBeforeSlot = [];
        let historySource = 'none';
        let debugClobFetchError = null;
        let debugClobDownFetchError = null;
        let debugDataFetchError = null;
        let clobUpMeta = null;
        let clobDownMeta = null;
        let tradesMeta = null;
        if (r.tokenIdUp) {
          const clobRes = await fetchPriceHistory(r.tokenIdUp, historyEndIso);
          upBeforeSlot = clobRes.history;
          debugClobFetchError = clobRes.error;
          clobUpMeta = clobRes.meta;
          if (upBeforeSlot.length > 0) historySource = 'clob';
        }
        if (r.tokenIdDown) {
          const downRes = await fetchPriceHistory(r.tokenIdDown, historyEndIso);
          downBeforeSlot = downRes.history;
          debugClobDownFetchError = downRes.error;
          clobDownMeta = downRes.meta;
          if (downBeforeSlot.length > 0 && historySource === 'none') historySource = 'clob';
        }
        const cidForTrades = r.normalizedConditionId ?? normalizeConditionId(r.conditionId);
        const hadClobUpBeforeTrades = upBeforeSlot.length > 0;
        const hadClobDownBeforeTrades = downBeforeSlot.length > 0;
        let tradePointsUp = [];
        let tradePointsDown = [];
        if (cidForTrades) {
          const trRes = await fetchDataApiTradePointsByToken(
            cidForTrades,
            r.tokenIdUp,
            r.tokenIdDown,
            historyEndIso,
            r.gammaEventId
          );
          debugDataFetchError = trRes.error;
          tradesMeta = trRes.meta ?? null;
          tradePointsUp = Array.isArray(trRes.pointsUp) ? trRes.pointsUp : [];
          tradePointsDown = Array.isArray(trRes.pointsDown) ? trRes.pointsDown : [];
          if (tradePointsUp.length > 0) {
            upBeforeSlot = mergePriceSeriesSorted(upBeforeSlot, tradePointsUp);
          }
          if (tradePointsDown.length > 0) {
            downBeforeSlot = mergePriceSeriesSorted(downBeforeSlot, tradePointsDown);
          }
        }
        const hadTradePoints = tradePointsUp.length + tradePointsDown.length > 0;
        if (upBeforeSlot.length > 0) {
          const hadAnyClob = hadClobUpBeforeTrades || hadClobDownBeforeTrades;
          if (hadAnyClob && hadTradePoints) historySource = 'clob+trades';
          else if (hadTradePoints && !hadClobUpBeforeTrades && !hadClobDownBeforeTrades) historySource = 'trades';
          else historySource = 'clob';
        } else if (downBeforeSlot.length > 0) {
          if (hadTradePoints) historySource = 'clob+trades';
          else if (historySource === 'none') historySource = 'clob';
        } else {
          historySource = 'none';
        }
        upBeforeSlot = normalizeHistorySeriesPoints(upBeforeSlot);
        downBeforeSlot = normalizeHistorySeriesPoints(downBeforeSlot);
        const historyUp = filterSeriesTo15mSlot(upBeforeSlot, r.slotEndSec);
        const historyDown = filterSeriesTo15mSlot(downBeforeSlot, r.slotEndSec);
        const historyPointCount = historyUp.length + historyDown.length;
        const emptySim = { ...EMPTY_BOT_SIM_15M };
        let sim =
          historyUp.length > 0 || historyDown.length > 0
            ? computeBotSimulationWithConfig(historyUp, historyDown, r.winner, historyEndIso, r.slotEndSec, simCfg)
            : emptySim;
        if (
          sim.botWouldTake != null &&
          r.slotEndSec != null &&
          Number.isFinite(r.slotEndSec) &&
          is15mSlotEntryTimeForbidden(sim.botEntryTimestamp)
        ) {
          sim = emptySim;
        }

        let simDebug = null;
        if (debug) {
          const why =
            sim.botWouldTake == null
              ? debugWhyNoSignalWithConfig(historyUp, historyDown, historyEndIso, r.slotEndSec, simCfg)
              : { code: 'signal', side: sim.botWouldTake, p: sim.botEntryPrice, ts: sim.botEntryTimestamp };
          simDebug = {
            slug: r.eventSlug,
            historyEndIso,
            slotBounds: slotFilterBounds(r.slotEndSec),
            conditionIdRaw: r.conditionId,
            normalizedConditionId: r.normalizedConditionId ?? null,
            cidForTrades: cidForTrades ?? null,
            gammaEventId: r.gammaEventId ?? null,
            historySource,
            urls: { clob: CLOB_PRICES_HISTORY_URL, trades: DATA_API_TRADES_URL },
            clobUp: {
              error: debugClobFetchError,
              meta: clobUpMeta,
              beforeSlot: summarizeSeriesForDebug(upBeforeSlot),
              afterSlot: summarizeSeriesForDebug(historyUp),
            },
            clobDown: {
              error: debugClobDownFetchError,
              meta: clobDownMeta,
              beforeSlot: summarizeSeriesForDebug(downBeforeSlot),
              afterSlot: summarizeSeriesForDebug(historyDown),
            },
            tradesFallback: tradesMeta,
            tradesError: debugDataFetchError,
            pointsAfterSlotFilter: historyPointCount,
            /** Aligné sur la simu (inclut complément 1−p par point). */
            maxBinaryBeforeSlot: maxBinaryAcrossBothSeries(upBeforeSlot, downBeforeSlot),
            maxBinaryAfterSlot: maxBinaryAcrossBothSeries(historyUp, historyDown),
            why,
            rule: {
              detectMinP: simCfg.detectMinP,
              simEntryMinP: simCfg.entryMinP,
              simEntryMaxP: simCfg.entryMaxP,
              forbiddenMinuteWindowsUtc: BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC,
              entryMaxAfterEndSec: SLOT_ENTRY_MAX_AFTER_END_SEC,
              seriesHiPaddingSec: SLOT_SERIES_HI_PADDING_SEC,
              dataApiTradeFetchPaddingAfterSec: SLOT_END_PADDING_SEC,
              marginBeforeSec: SLOT_15M_MARGIN_SEC,
              entryForbiddenSlotFirstSec: SLOT_15M_ENTRY_FORBID_FIRST_SEC,
              entryForbiddenSlotLastSec: SLOT_15M_ENTRY_FORBID_LAST_SEC,
              stopLoss: {
                enabled: BACKTEST_STOP_LOSS_ENABLED,
                triggerPriceP: BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
                maxDrawdownPct: BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT,
                worstExitPriceP: BACKTEST_STOP_LOSS_WORST_PRICE_P,
                minHoldSec: BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
              },
              label:
                'Détection ≥97¢ · séries = fetch trades (fin slug +45 min) · entrée ≤ fin slug +30 s · 97–98¢ · complément 1−p · pas d’entrée 3 premières / 4 dernières min du créneau slug · stop-loss hybride (proxy prix &lt; seuil OU drawdown ≤ −X %) puis sortie worst FAK ~ worstExitPriceP',
            },
          };
        }

        enriched.push({
          ...r,
          ...sim,
          debugHistoryPoints: historyPointCount,
          debugHistorySource: historySource,
          debugHasTokenUp: Boolean(r.tokenIdUp),
          debugClobFetchError,
          debugDataFetchError,
          ...(simDebug ? { simDebug } : {}),
        });
      }
      const enrichedFinal = dedupeEnrichedOnePer15mTradeWindow(enriched);
      if (debug) {
        const geMinBinary = (v) => v != null && Number.isFinite(v) && v >= simCfg.detectMinP;
        const highConvBefore = (e) => geMinBinary(e.simDebug?.maxBinaryBeforeSlot);
        const highConvAfter = (e) => geMinBinary(e.simDebug?.maxBinaryAfterSlot);
        const strippedBySlot = enrichedFinal.filter(
          (e) =>
            highConvBefore(e) &&
            !highConvAfter(e) &&
            e.simDebug?.why?.code === 'no_price_in_band'
        );
        const summary = {
          at: new Date().toISOString(),
          windowHours,
          rowsBefore15mSlotDedupe: results.length,
          rowsAfter15mSlotDedupe: resultsOnePerSlot.length,
          rowsBefore15mTradeWindowDedupe: enriched.length,
          rowsAfter15mTradeWindowDedupe: enrichedFinal.length,
          rows: enrichedFinal.length,
          withBotSignal: enrichedFinal.filter((e) => e.botWouldTake != null).length,
          sourceClob: enrichedFinal.filter((e) => e.debugHistorySource === 'clob').length,
          sourceClobTrades: enrichedFinal.filter((e) => e.debugHistorySource === 'clob+trades').length,
          sourceTrades: enrichedFinal.filter((e) => e.debugHistorySource === 'trades').length,
          sourceNone: enrichedFinal.filter((e) => e.debugHistorySource === 'none').length,
          noTokenUp: enrichedFinal.filter((e) => !e.debugHasTokenUp).length,
          /** Conviction max (avec 1−p) avant / après filtre créneau — si « before » haut et « after » bas, le créneau exclut les bons trades. */
          rowsMaxBinaryGeMinBeforeSlotFilter: enrichedFinal.filter(highConvBefore).length,
          rowsMaxBinaryGeMinAfterSlotFilter: enrichedFinal.filter(highConvAfter).length,
          rowsLikelyHighConvictionStrippedBySlotFilter: strippedBySlot.length,
          whyNoSignalCounts: enrichedFinal.reduce((acc, e) => {
            const c = e.simDebug?.why?.code;
            if (c) acc[c] = (acc[c] ?? 0) + 1;
            return acc;
          }, {}),
          slotFilter: {
            marginBeforeSec: SLOT_15M_MARGIN_SEC,
            seriesHiPaddingSec: SLOT_SERIES_HI_PADDING_SEC,
            entryMaxAfterSlotSec: SLOT_ENTRY_MAX_AFTER_END_SEC,
            dataApiTradeFetchPaddingAfterSec: SLOT_END_PADDING_SEC,
            simSeriesWindowSec: SLOT_15M_SEC + SLOT_15M_MARGIN_SEC + SLOT_END_PADDING_SEC,
          },
          forbiddenMinuteWindowsUtc: BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC,
          urls: { clob: CLOB_PRICES_HISTORY_URL, trades: DATA_API_TRADES_URL },
        };
        setDebugSummary(summary);
        console.info('[15m résolus] mode DEBUG — résumé', summary);
      } else {
        setDebugSummary(null);
      }

      if (import.meta.env.DEV && !debug) {
        const clob = enrichedFinal.filter((e) => e.debugHistorySource === 'clob').length;
        const trades = enrichedFinal.filter((e) => e.debugHistorySource === 'trades').length;
        const none = enrichedFinal.filter((e) => e.debugHistorySource === 'none').length;
        const noToken = enrichedFinal.filter((e) => !e.debugHasTokenUp).length;
        const sampleErr = enrichedFinal.find(
          (e) => e.debugHistorySource === 'none' && (e.debugClobFetchError || e.debugDataFetchError)
        );
        console.info('[15m résolus] historique prix (aligné hook 1h + filtre créneau)', {
          créneaux: enrichedFinal.length,
          sourceClob: clob,
          sourceDataApiTrades: trades,
          sansHistorique: none,
          sansTokenUp: noToken,
          clobUrl: CLOB_PRICES_HISTORY_URL,
          dataUrl: DATA_API_TRADES_URL,
          forbiddenMinuteWindowsUtc: BACKTEST_15M_FORBIDDEN_MINUTE_WINDOWS_UTC,
          exempleErreurFetch:
            sampleErr != null
              ? [sampleErr.debugClobFetchError, sampleErr.debugDataFetchError].filter(Boolean).join(' | ') || '200 vide ?'
              : null,
        });
      }
      setResolved(enrichedFinal);
    } catch (err) {
      setError(err.message || 'Erreur lors du chargement des résultats 15 min.');
      setResolved([]);
    } finally {
      setLoading(false);
    }
  }, [windowHours, debug, simCfg]);

  useEffect(() => {
    fetchResolved();
  }, [fetchResolved]);

  return { resolved, loading, error, refresh: fetchResolved, debugSummary };
}
