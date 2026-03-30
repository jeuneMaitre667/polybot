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
  is15mMarketSlotEntryTimeForbidden,
  normalizeForbidWindowMinutes,
  ENTRY_TIMING_ET_TIMEZONE,
} from '@/lib/bitcoin15mSlotEntryTiming.js';
import { applyManualStopLossOverride } from '@/lib/bitcoin15mManualSlOverrides.js';

/** En navigateur + dev Vite : proxy ; Node (script cache) ou prod = HTTPS direct (évite `/api/...` sans serveur). */
const useDevApiProxy =
  typeof window !== 'undefined' &&
  typeof import.meta !== 'undefined' &&
  import.meta.env?.DEV;
const GAMMA_EVENTS_URL = useDevApiProxy ? '/api/events' : 'https://gamma-api.polymarket.com/events';
const GAMMA_EVENT_BY_SLUG_URL = useDevApiProxy
  ? '/api/events/slug'
  : 'https://gamma-api.polymarket.com/events/slug';
const GAMMA_MARKET_BY_SLUG_URL = useDevApiProxy
  ? '/api/markets/slug'
  : 'https://gamma-api.polymarket.com/markets/slug';
const CLOB_PRICES_HISTORY_URL = useDevApiProxy
  ? '/apiClob/prices-history'
  : 'https://clob.polymarket.com/prices-history';
/**
 * Data API : seuls `market` / `eventId` sont documentés (OpenAPI) — pas de `asset_id`/`after`/`before`.
 * On fetch par `conditionId` puis on filtre le créneau côté client.
 */
const DATA_API_TRADES_URL = useDevApiProxy ? '/apiData/trades' : 'https://data-api.polymarket.com/trades';
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
 * **Signal** : premier passage dans la bande **77–78¢** (entryMinP–entryMaxP), comme le bot (pas « ≥ 77¢ » seul).
 */
const DEFAULT_DETECT_MIN_P = 0.77;
const DEFAULT_SIM_ENTRY_MIN_P = 0.77;
const DEFAULT_SIM_ENTRY_MAX_P = 0.78;

export function resolve15mSimConfig(options) {
  const cfg = options?.simulation ?? options?.simConfig ?? null;
  const detectMinP = Number(cfg?.detectMinP);
  const entryMinP = Number(cfg?.entryMinP);
  const entryMaxP = Number(cfg?.entryMaxP);
  const stopLossTriggerPriceP = Number(cfg?.stopLossTriggerPriceP);
  const dwellFromCfg = cfg?.signalMinDwellSec;
  const dwellFromEnv = import.meta.env.VITE_BACKTEST_SIGNAL_MIN_DWELL_SEC;
  const dwellRaw = dwellFromCfg !== undefined && dwellFromCfg !== null ? dwellFromCfg : dwellFromEnv;
  const signalMinDwellSec =
    dwellRaw === undefined || dwellRaw === '' || dwellRaw === null
      ? 1.5
      : Math.max(0, Number(dwellRaw) || 0);
  const efMin = cfg?.entryForbiddenFirstMin;
  const elMin = cfg?.entryForbiddenLastMin;
  let forbidFirstSec;
  let forbidLastSec;
  if (
    cfg != null &&
    Number.isFinite(Number(cfg.forbidFirstSec)) &&
    Number.isFinite(Number(cfg.forbidLastSec))
  ) {
    forbidFirstSec = Math.max(0, Number(cfg.forbidFirstSec));
    forbidLastSec = Math.max(0, Number(cfg.forbidLastSec));
  } else {
    const w = normalizeForbidWindowMinutes(
      efMin !== undefined && efMin !== null ? efMin : undefined,
      elMin !== undefined && elMin !== null ? elMin : undefined,
    );
    forbidFirstSec = w.forbidFirstSec;
    forbidLastSec = w.forbidLastSec;
  }
  const out = {
    detectMinP:
      Number.isFinite(detectMinP) && detectMinP > 0 && detectMinP < 1 ? detectMinP : DEFAULT_DETECT_MIN_P,
    entryMinP: Number.isFinite(entryMinP) && entryMinP > 0 && entryMinP < 1 ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P,
    entryMaxP: Number.isFinite(entryMaxP) && entryMaxP > 0 && entryMaxP < 1 ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P,
    stopLossTriggerPriceP:
      Number.isFinite(stopLossTriggerPriceP) && stopLossTriggerPriceP > 0 && stopLossTriggerPriceP < 1
        ? stopLossTriggerPriceP
        : BACKTEST_STOP_LOSS_TRIGGER_PRICE_P,
    /** Secondes : le prix du token choisi doit rester ≥ detectMinP sur [ts entrée, ts + dwell] (alignement poll bot). */
    signalMinDwellSec,
    /** Backtest uniquement : fenêtres interdites début/fin de quart (ET), en secondes. */
    forbidFirstSec,
    forbidLastSec,
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

/**
 * Stop-loss backtest 15m : mêmes défauts **numériques** que `STOP_LOSS_*` dans `bot-24-7/index.js`.
 * Le bot utilise le **best bid** CLOB pour le SL ; le backtest utilise le prix **historique** (mid / trades). Pour coller
 * au serveur, définir `VITE_BACKTEST_STOP_LOSS_TRIGGER_PRICE_P` comme `STOP_LOSS_TRIGGER_PRICE_P` (défaut **0.60**).
 */
const envBacktestSl = import.meta.env.VITE_BACKTEST_STOP_LOSS_ENABLED;
const BACKTEST_STOP_LOSS_ENABLED = envBacktestSl !== 'false' && envBacktestSl !== '0';
/** Export UI : seuil SL simulé (défaut 0.75 = 75¢, aligné bot). */
export const BACKTEST_STOP_LOSS_TRIGGER_PRICE_P = Math.max(
  0.01,
  Math.min(0.99, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_TRIGGER_PRICE_P) || 0.6),
);
export const BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT = Math.max(
  1,
  Math.min(95, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT) || 30),
);
export const BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED = import.meta.env.VITE_BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED !== 'false';
const BACKTEST_STOP_LOSS_WORST_PRICE_P = Math.max(
  0.001,
  Math.min(0.99, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_WORST_PRICE_P) || 0.01),
);
export const BACKTEST_STOP_LOSS_MIN_HOLD_SEC =
  Math.max(0, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_MIN_HOLD_MS) || 10_000) / 1000;

export const BACKTEST_ENTRY_SLIPPAGE_P = Math.max(
  0,
  Math.min(0.1, Number(import.meta.env.VITE_BACKTEST_ENTRY_SLIPPAGE_P) || 0.01)
);
export const BACKTEST_SL_SLIPPAGE_P = Math.max(
  0,
  Math.min(0.2, Number(import.meta.env.VITE_BACKTEST_SL_SLIPPAGE_P) || 0.035)
);

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

/** Point dans la bande de signal (entrée bot). */
function isPriceInEntryBand(p, entryMinP, entryMaxP) {
  const lo = Number.isFinite(entryMinP) ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P;
  const hi = Number.isFinite(entryMaxP) ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P;
  return Number.isFinite(p) && p >= lo && p <= hi;
}

/**
 * Timestamp du premier franchissement dans [lo, hi] sur le segment prev → (t, price).
 * Prend en charge les **sauts** (historique clairsemé) : ex. 0,50 → 0,99 entre deux points traverse 77–78¢
 * sans échantillon dans la bande — on interpole le passage à la borne inférieure (montée) ou supérieure (descente).
 */
export function firstEntryTimestampIntoBand(prev, t, price, lo, hi) {
  const p1 = price;
  if (prev == null) {
    return isPriceInEntryBand(p1, lo, hi) ? t : null;
  }
  const p0 = prev.price;
  const t0 = prev.t;
  const t1 = t;
  if (t1 < t0) return null;
  const dt = t1 - t0;
  const dp = p1 - p0;
  if (Math.abs(dp) < 1e-15) {
    if (isPriceInEntryBand(p1, lo, hi) && !isPriceInEntryBand(p0, lo, hi)) return t1;
    return null;
  }

  if (isPriceInEntryBand(p0, lo, hi)) return null;

  /** Échantillon final dans la bande (avec interpolation franchissement lo/hi si besoin). */
  if (isPriceInEntryBand(p1, lo, hi)) {
    if (p0 < lo && p1 >= lo) {
      const u = (lo - p0) / dp;
      if (u >= 0 && u <= 1) return t0 + u * dt;
    }
    if (p0 > hi && p1 <= hi) {
      const u = (hi - p0) / dp;
      if (u >= 0 && u <= 1) return t0 + u * dt;
    }
    return t1;
  }

  /* Saut par-dessus toute la bande (aucun tick dans [lo, hi]) : premier instant dans la bande = franchissement de lo (montée) ou hi (descente). */
  if (p0 < lo && p1 > hi) {
    const u = (lo - p0) / dp;
    if (u > 0 && u < 1) return t0 + u * dt;
    return null;
  }
  if (p0 > hi && p1 < lo) {
    const u = (hi - p0) / dp;
    if (u > 0 && u < 1) return t0 + u * dt;
    return null;
  }

  return null;
}

function evalLinearPrice(t1, p1, t2, p2, t) {
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(p1) || !Number.isFinite(p2)) return NaN;
  if (t2 === t1) return p1;
  return p1 + ((p2 - p1) * (t - t1)) / (t2 - t1);
}

/**
 * Prix minimum du token (série Up ou Down seule) sur [tLo, tHi] par interpolation linéaire entre points.
 * Utilisé pour exiger que le signal « reste » dans la bande au moins `dwell` secondes (comme un poll bot ~1 s).
 */
function minSidePriceBetween(historySide, tLo, tHi) {
  if (!Number.isFinite(tLo) || !Number.isFinite(tHi) || tHi < tLo) return null;
  const pts = [];
  for (const pt of Array.isArray(historySide) ? historySide : []) {
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    if (t == null || !Number.isFinite(p)) continue;
    pts.push({ t, p });
  }
  pts.sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  let minP = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].t >= tLo && pts[i].t <= tHi) minP = Math.min(minP, pts[i].p);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b.t < tLo || a.t > tHi) continue;
    const lo = Math.max(a.t, tLo);
    const hi = Math.min(b.t, tHi);
    if (lo > hi) continue;
    const pLo = evalLinearPrice(a.t, a.p, b.t, b.p, lo);
    const pHi = evalLinearPrice(a.t, a.p, b.t, b.p, hi);
    if (Number.isFinite(pLo)) minP = Math.min(minP, pLo);
    if (Number.isFinite(pHi)) minP = Math.min(minP, pHi);
  }
  return Number.isFinite(minP) ? minP : null;
}

function passesSignalMinDwell(side, historyUp, historyDown, detectMinP, tsUsed, dwellSec) {
  if (!Number.isFinite(dwellSec) || dwellSec <= 0) return true;
  const series = side === 'Up' ? historyUp : historyDown;
  const tLo = tsUsed;
  const tHi = tsUsed + dwellSec;
  const minP = minSidePriceBetween(series, tLo, tHi);
  if (minP == null || !Number.isFinite(minP)) return false;
  const d = Number.isFinite(detectMinP) ? detectMinP : DEFAULT_DETECT_MIN_P;
  return minP >= d - 1e-9;
}

/** Prix d’entrée reporté : plancher 77¢, plafond 78¢ (défaut ; simConfig UI peut override). */
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

function seriesHasPointInEntryBand(series, lo, hi) {
  for (const pt of Array.isArray(series) ? series : []) {
    const p = normalizeOutcomePrice(pt?.p ?? pt?.price);
    if (isPriceInEntryBand(p, lo, hi)) return true;
  }
  return false;
}

/**
 * L’API `prices-history` ne fournit pas le best bid tick par tick. Pour coller au bot (`getBestBid` sur `/book`),
 * on approxime le prix « vente » (bid) par **mid − offset** (défaut ~0,7¢, même ordre que l’écart mid/bid documenté).
 * Désactiver : `VITE_BACKTEST_SL_BID_PROXY_FROM_MID=false` (retombe sur le mid brut pour le SL).
 */
const BACKTEST_SL_USE_BID_PROXY_FROM_MID =
  import.meta.env.VITE_BACKTEST_SL_BID_PROXY_FROM_MID !== 'false' &&
  import.meta.env.VITE_BACKTEST_SL_BID_PROXY_FROM_MID !== '0';
const BACKTEST_SL_BID_FROM_MID_OFFSET_P = Math.max(
  0,
  Math.min(0.05, Number(import.meta.env.VITE_BACKTEST_SL_BID_FROM_MID_OFFSET_P) || 0.007),
);

function midToBestBidProxyForSl(midP) {
  const m = Number(midP);
  if (!Number.isFinite(m) || m <= 0) return NaN;
  return Math.max(0.001, Math.min(0.99, m - BACKTEST_SL_BID_FROM_MID_OFFSET_P));
}

/** Prix utilisé pour la détection SL backtest (alignement best bid bot). */
function slPriceForBacktestSl(pt) {
  const mid = normalizeOutcomePrice(pt?.p ?? pt?.price);
  if (!Number.isFinite(mid)) return NaN;
  if (!BACKTEST_SL_USE_BID_PROXY_FROM_MID) return mid;
  return midToBestBidProxyForSl(mid);
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

export const DEFAULT_WINDOW_HOURS = 72;
// 1 h = 4 créneaux 15 min. 30 j = 720 h = 2880 créneaux. Plafond requêtes slug aligné sur la fenêtre max UI.
const SLOTS_PER_HOUR = 4;
const MAX_15M_SLUG_FETCH = 30 * 24 * SLOTS_PER_HOUR;
const PROCESS_EVENTS_CONCURRENCY = Math.max(1, Math.min(12, Number(import.meta.env.VITE_BACKTEST_15M_PROCESS_CONCURRENCY) || 6));
const ENRICH_ROWS_CONCURRENCY = Math.max(1, Math.min(12, Number(import.meta.env.VITE_BACKTEST_15M_ENRICH_CONCURRENCY) || 4));

async function mapWithConcurrency(items, limit, mapper) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return [];
  const out = new Array(arr.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= arr.length) break;
      out[idx] = await mapper(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

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
async function fetch15mEventsBySlugBatches(slugs, batchSize = 4, pauseMs = 120) {
  const fetchSlugOnce = async (slug) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const { data: ev } = await axios.get(`${GAMMA_EVENT_BY_SLUG_URL}/${encodeURIComponent(slug)}`, {
          timeout: 12000,
        });
        if (ev && (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG)) return ev;
        return null;
      } catch (e) {
        const st = e?.response?.status;
        if (st === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1) ** 2));
          continue;
        }
        /* 404 ou autre */
        return null;
      }
    }
    return null;
  };
  const events = [];
  for (let i = 0; i < slugs.length; i += batchSize) {
    const chunk = slugs.slice(i, i + batchSize);
    const parts = await Promise.all(chunk.map((slug) => fetchSlugOnce(slug)));
    for (const ev of parts) if (ev) events.push(ev);
    if (i + batchSize < slugs.length && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
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
 * Après entrée : premier instant où le **proxy best bid** (mid CLOB historique − offset, ou mid si désactivé)
 * déclenche le stop hybride (prix ≤ seuil **ou** drawdown ≤ −X %), comme `getBestBid` côté bot (pas d’historique bid tick par tick).
 */
function findStopLossAfterEntry(heldSeries, entryTs, entryPrice, minHoldSec, simCfg) {
  if (!BACKTEST_STOP_LOSS_ENABLED) return { triggered: false };
  const holdEnd = entryTs + minHoldSec;
  const slTriggerPriceP =
    Number.isFinite(simCfg?.stopLossTriggerPriceP) && simCfg.stopLossTriggerPriceP > 0 && simCfg.stopLossTriggerPriceP < 1
      ? simCfg.stopLossTriggerPriceP
      : BACKTEST_STOP_LOSS_TRIGGER_PRICE_P;
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
    const bidProxy = slPriceForBacktestSl(pt);
    if (!Number.isFinite(bidProxy)) continue;
    const drawdownPct = ((bidProxy - entryPrice) / entryPrice) * 100;
    /** ≤ seuil : un point à exactement 58¢ doit déclencher si SL = 58¢ (éviter 100 % « gagné » fantôme). */
    const triggerByPrice = bidProxy <= slTriggerPriceP;
    const triggerByDrawdown =
      BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED && drawdownPct <= -Math.abs(BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT);
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
  /**
   * Repli aligné sur l’analyse « % SL touché » (minObservedAfterEntry) : si le plus bas proxy après min-hold
   * est au seuil ou en dessous, on déclenche même si la grille de points a des trous (CLOB rarefaction).
   */
  const minAfter = minObservedPriceAfterEntry(heldSeries, entryTs, minHoldSec);
  if (minAfter != null && Number.isFinite(minAfter) && minAfter <= slTriggerPriceP) {
    let pickT = null;
    let pickP = null;
    for (const pt of arr) {
      const t = toSeconds(pt?.t ?? pt?.timestamp);
      if (t == null || t < holdEnd) continue;
      const bidProxy = slPriceForBacktestSl(pt);
      if (!Number.isFinite(bidProxy)) continue;
      if (bidProxy <= slTriggerPriceP) {
        pickT = t;
        pickP = bidProxy;
        break;
      }
    }
    const pUse = pickP != null ? pickP : minAfter;
    const tUse = pickT != null ? pickT : holdEnd;
    const ddUse = ((pUse - entryPrice) / entryPrice) * 100;
    return {
      triggered: true,
      reason: 'min_observed_below_threshold',
      t: tUse,
      observedP: pUse,
      drawdownPct: Math.round(ddUse * 100) / 100,
    };
  }
  return { triggered: false };
}

/**
 * Plus bas **proxy best bid** (ou mid si proxy désactivé) après l’entrée, après le délai min hold.
 * Aligné sur `findStopLossAfterEntry` pour l’analyse « % SL touché ».
 */
function minObservedPriceAfterEntry(heldSeries, entryTs, minHoldSec) {
  const holdEnd = entryTs + minHoldSec;
  const arr = Array.isArray(heldSeries) ? heldSeries : [];
  let minP = Infinity;
  for (const pt of arr) {
    const t = toSeconds(pt?.t ?? pt?.timestamp);
    if (t == null || t < holdEnd) continue;
    const p = slPriceForBacktestSl(pt);
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
    if (isPriceInEntryBand(p, DEFAULT_SIM_ENTRY_MIN_P, DEFAULT_SIM_ENTRY_MAX_P)) inBand += 1;
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
function buildForbiddenMinuteRuleEt(forbidFirstSec, forbidLastSec) {
  const f = Math.round(Number(forbidFirstSec) || 0);
  const l = Math.round(Number(forbidLastSec) || 0);
  return {
    basis: 'et_quarter_hour',
    displayTimezone: ENTRY_TIMING_ET_TIMEZONE,
    appliedInSimulation: true,
    slotDurationSec: SLOT_15M_SEC,
    forbidFirstSecondsFromSlotStart: f,
    forbidLastSecondsBeforeSlotEnd: l,
    label: `Pas d’entrée : dans chaque quart d’heure local ${ENTRY_TIMING_ET_TIMEZONE} (:00,:15,:30,:45), interdit les ${f / 60} premières minutes et les ${l / 60} dernières — aligné sur l’heure ET du trade (comme le tableau).`,
  };
}

/**
 * Candidats d’entrée (événements triés, interpolation, exclusion début / fin de quart d’heure **en heure ET**).
 * @returns {{ candidates: Array<{side:string,price:number,ts:number}>, endTsSec: number|null, forbiddenMinuteRule: ReturnType<typeof buildForbiddenMinuteRuleEt> }}
 */
function collectSimEntryCandidatesWithConfig(historyUp, historyDown, endDateStr, slotEndSecExplicit, simCfg) {
  const cfg = resolve15mSimConfig({ simConfig: simCfg });
  const { detectMinP, entryMinP, entryMaxP, signalMinDwellSec = 0, forbidFirstSec, forbidLastSec } = cfg;
  const lo = Number.isFinite(entryMinP) ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P;
  const hi = Number.isFinite(entryMaxP) ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P;
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
  /** Fin du créneau 15m marché (UTC) — pour ignorer la marge fetch (−30 min) dans la détection d’entrée. */
  const slotStartSec =
    endTsSec != null && Number.isFinite(endTsSec) ? Math.floor(endTsSec) - SLOT_15M_SEC : null;

  /**
   * Points avec t < début du créneau servent seulement à initialiser `lastBySide`, sans candidat :
   * sinon une entrée dans la bande **avant** l’ouverture du slot faisait rejeter le ts (hors fenêtre),
   * puis le prix restait en bande **pendant** le slot sans nouveau franchissement → faux négatifs massifs.
   */
  if (slotStartSec != null) {
    for (const ev of events) {
      if (ev.t >= slotStartSec) break;
      lastBySide[ev.side] = { t: ev.t, price: ev.price };
    }
    /** Déjà dans la bande à l’ouverture du créneau (dernier point avant slot dans la marge) → entrée au 1er instant du slot. */
    for (const side of ['Up', 'Down']) {
      const last = lastBySide[side];
      if (last == null || last.t >= slotStartSec) continue;
      if (!isPriceInEntryBand(last.price, lo, hi)) continue;
      let tsUsed = slotStartSec;
      if (tsUsed > endTsSec + SLOT_ENTRY_MAX_AFTER_END_SEC || tsUsed < slotStartSec) continue;
      if (is15mMarketSlotEntryTimeForbidden(tsUsed, endTsSec, forbidFirstSec, forbidLastSec)) continue;
      if (
        signalMinDwellSec > 0 &&
        !passesSignalMinDwell(side, historyUp, historyDown, detectMinP, tsUsed, signalMinDwellSec)
      ) {
        continue;
      }
      candidates.push({ side, price: clampEntryPrice(last.price, entryMinP, entryMaxP), ts: tsUsed });
      break;
    }
  }

  const eventsFromSlotOpen = slotStartSec == null ? events : events.filter((ev) => ev.t >= slotStartSec);
  for (const ev of eventsFromSlotOpen) {
    const { t, side, price } = ev;
    const prev = lastBySide[side];
    const tsEntry = firstEntryTimestampIntoBand(prev, t, price, lo, hi);
    if (tsEntry == null) {
      lastBySide[side] = { t, price };
      continue;
    }
    let tsUsed = tsEntry;
    if (endTsSec != null && Number.isFinite(endTsSec)) {
      const slotStartSec = endTsSec - SLOT_15M_SEC;
      if (tsUsed > endTsSec + SLOT_ENTRY_MAX_AFTER_END_SEC || tsUsed < slotStartSec) {
        lastBySide[side] = { t, price };
        continue;
      }
      if (is15mMarketSlotEntryTimeForbidden(tsUsed, endTsSec, forbidFirstSec, forbidLastSec)) {
        lastBySide[side] = { t, price };
        continue;
      }
    }
    if (
      signalMinDwellSec > 0 &&
      !passesSignalMinDwell(side, historyUp, historyDown, detectMinP, tsUsed, signalMinDwellSec)
    ) {
      lastBySide[side] = { t, price };
      continue;
    }
    candidates.push({ side, price: clampEntryPrice(price, entryMinP, entryMaxP), ts: tsUsed });
    lastBySide[side] = { t, price };
  }
  return {
    candidates,
    endTsSec,
    forbiddenMinuteRule: buildForbiddenMinuteRuleEt(forbidFirstSec, forbidLastSec),
  };
}

function debugWhyNoSignalWithConfig(historyUp, historyDown, endDateStr, slotEndSecExplicit, simCfg) {
  const cfg = resolve15mSimConfig({ simConfig: simCfg });
  const { detectMinP, entryMinP, entryMaxP, forbidFirstSec, forbidLastSec } = cfg;
  const lo = Number.isFinite(entryMinP) ? entryMinP : DEFAULT_SIM_ENTRY_MIN_P;
  const hi = Number.isFinite(entryMaxP) ? entryMaxP : DEFAULT_SIM_ENTRY_MAX_P;
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
  const hadBandTouch = seriesHasPointInEntryBand(up, lo, hi) || seriesHasPointInEntryBand(down, lo, hi);
  if (hadBandTouch) {
    return {
      code: 'excluded_by_15m_slot_forbidden_window',
      detail: `Prix dans la bande ${lo}–${hi} présent, mais ts (ou interpolé) dans les ${forbidFirstSec / 60} premières min ou les ${forbidLastSec / 60} dernières **du créneau marché 15m** (UTC, aligné slug / slotEndSec) ; hors fenêtre stricte du slot, repli sur la grille ET.`,
      forbiddenMinuteRule,
      endTsSec,
      maxBinaryConvictionUpToken: maxU,
      maxBinaryConvictionDownToken: maxD,
    };
  }
  return {
    code: 'no_price_in_band',
    detail: `Aucun passage dans la bande signal ${lo}–${hi} après filtre créneau (détection alignée bot, pas « ≥ ${detectMinP} » seul).`,
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
  const sl = findStopLossAfterEntry(heldSeries, first.ts, first.price, BACKTEST_STOP_LOSS_MIN_HOLD_SEC, simCfg);
  const minAfter = minObservedPriceAfterEntry(heldSeries, first.ts, BACKTEST_STOP_LOSS_MIN_HOLD_SEC);

  if (sl.triggered) {
    let rawSlExit = sl.observedP != null ? Number(sl.observedP) - BACKTEST_SL_SLIPPAGE_P : BACKTEST_STOP_LOSS_WORST_PRICE_P;
    rawSlExit = Math.max(0.001, rawSlExit);
    return {
      botWouldTake: first.side,
      botWon: null,
      botEntryPrice: Math.min(0.99, first.price + BACKTEST_ENTRY_SLIPPAGE_P),
      botEntryTimestamp: first.ts,
      botOrderType: 'Marché',
      botStopLossExit: true,
      botStopLossReason: sl.reason,
      botStopLossExitPriceP: Math.round(rawSlExit * 1e6) / 1e6,
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
    botEntryPrice: Math.min(0.99, first.price + BACKTEST_ENTRY_SLIPPAGE_P),
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
 * Une ligne « pré-simulation » : prix + métadonnées fetch ; la simu bot (`computeBotSimulationWithConfig`) n’est pas encore appliquée.
 * Permet de balayer plusieurs `simCfg` sans refaire Gamma/CLOB/trades.
 */
async function buildBitcoin15mPreSimRow(r) {
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
  const cidForTrades = r.normalizedConditionId ?? normalizeConditionId(r.conditionId);
  const [clobResUp, clobResDown, trRes] = await Promise.all([
    r.tokenIdUp ? fetchPriceHistory(r.tokenIdUp, historyEndIso) : Promise.resolve(null),
    r.tokenIdDown ? fetchPriceHistory(r.tokenIdDown, historyEndIso) : Promise.resolve(null),
    cidForTrades
      ? fetchDataApiTradePointsByToken(
          cidForTrades,
          r.tokenIdUp,
          r.tokenIdDown,
          historyEndIso,
          r.gammaEventId
        )
      : Promise.resolve(null),
  ]);

  debugDataFetchError = trRes?.error ?? null;
  tradesMeta = trRes?.meta ?? null;
  const tradePointsUp = Array.isArray(trRes?.pointsUp) ? trRes.pointsUp : [];
  const tradePointsDown = Array.isArray(trRes?.pointsDown) ? trRes.pointsDown : [];

  if (clobResUp) {
    upBeforeSlot = clobResUp.history;
    debugClobFetchError = clobResUp.error;
    clobUpMeta = clobResUp.meta;
    if (upBeforeSlot.length > 0) historySource = 'clob';
  }
  if (clobResDown) {
    downBeforeSlot = clobResDown.history;
    debugClobDownFetchError = clobResDown.error;
    clobDownMeta = clobResDown.meta;
    if (downBeforeSlot.length > 0 && historySource === 'none') historySource = 'clob';
  }
  const hadClobUpBeforeTrades = upBeforeSlot.length > 0;
  const hadClobDownBeforeTrades = downBeforeSlot.length > 0;
  if (tradePointsUp.length > 0) {
    upBeforeSlot = mergePriceSeriesSorted(upBeforeSlot, tradePointsUp);
  }
  if (tradePointsDown.length > 0) {
    downBeforeSlot = mergePriceSeriesSorted(downBeforeSlot, tradePointsDown);
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

  return {
    base: { ...r },
    historyUp,
    historyDown,
    historyEndIso,
    upBeforeSlot,
    downBeforeSlot,
    historyPointCount,
    historySource,
    debugClobFetchError,
    debugClobDownFetchError,
    debugDataFetchError,
    clobUpMeta,
    clobDownMeta,
    tradesMeta,
    cidForTrades,
  };
}

function applyResolvedSimToPreSimRow(pre, simResolved, debug) {
  const r = pre.base;
  const {
    historyUp,
    historyDown,
    historyEndIso,
    upBeforeSlot,
    downBeforeSlot,
    historyPointCount,
    historySource,
    debugClobFetchError,
    debugClobDownFetchError,
    debugDataFetchError,
    clobUpMeta,
    clobDownMeta,
    tradesMeta,
    cidForTrades,
  } = pre;

  const emptySim = { ...EMPTY_BOT_SIM_15M };
  let sim =
    historyUp.length > 0 || historyDown.length > 0
      ? computeBotSimulationWithConfig(historyUp, historyDown, r.winner, historyEndIso, r.slotEndSec, simResolved)
      : emptySim;
  if (
    sim.botWouldTake != null &&
    r.slotEndSec != null &&
    Number.isFinite(r.slotEndSec) &&
    is15mMarketSlotEntryTimeForbidden(
      sim.botEntryTimestamp,
      r.slotEndSec,
      simResolved.forbidFirstSec,
      simResolved.forbidLastSec,
    )
  ) {
    sim = emptySim;
  }

  sim = applyManualStopLossOverride(sim, r);

  let simDebug = null;
  if (debug) {
    const why =
      sim.botWouldTake == null
        ? debugWhyNoSignalWithConfig(historyUp, historyDown, historyEndIso, r.slotEndSec, simResolved)
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
        detectMinP: simResolved.detectMinP,
        simEntryMinP: simResolved.entryMinP,
        simEntryMaxP: simResolved.entryMaxP,
        signalMinDwellSec: simResolved.signalMinDwellSec ?? 0,
        forbiddenMinuteWindowsUtc: buildForbiddenMinuteRuleEt(
          simResolved.forbidFirstSec,
          simResolved.forbidLastSec,
        ),
        entryMaxAfterEndSec: SLOT_ENTRY_MAX_AFTER_END_SEC,
        seriesHiPaddingSec: SLOT_SERIES_HI_PADDING_SEC,
        dataApiTradeFetchPaddingAfterSec: SLOT_END_PADDING_SEC,
        marginBeforeSec: SLOT_15M_MARGIN_SEC,
        entryForbiddenSlotFirstSec: simResolved.forbidFirstSec,
        entryForbiddenSlotLastSec: simResolved.forbidLastSec,
        stopLoss: {
          enabled: BACKTEST_STOP_LOSS_ENABLED,
          triggerPriceP: simResolved.stopLossTriggerPriceP,
          drawdownEnabled: BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED,
          maxDrawdownPct: BACKTEST_STOP_LOSS_DRAWDOWN_ENABLED ? BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT : null,
          worstExitPriceP: BACKTEST_STOP_LOSS_WORST_PRICE_P,
          minHoldSec: BACKTEST_STOP_LOSS_MIN_HOLD_SEC,
          bidProxyFromMid: BACKTEST_SL_USE_BID_PROXY_FROM_MID,
          bidProxyOffsetP: BACKTEST_SL_BID_FROM_MID_OFFSET_P,
        },
        label:
          'Détection ≥90¢ · séries = fetch trades (fin slug +45 min) · entrée ≤ fin slug +30 s · 90–91¢ · complément 1−p · pas d’entrée 6 premières / 4 dernières min du créneau slug · stop-loss hybride (proxy prix &lt; seuil OU drawdown ≤ −X %) puis sortie worst FAK ~ worstExitPriceP',
      },
    };
  }

  return {
    ...r,
    ...sim,
    debugHistoryPoints: historyPointCount,
    debugHistorySource: historySource,
    debugHasTokenUp: Boolean(r.tokenIdUp),
    debugClobFetchError,
    debugDataFetchError,
    ...(simDebug ? { simDebug } : {}),
  };
}

/**
 * Applique une config de simu à des lignes pré-fetch (voir `fetchBitcoin15mPreSimRows`).
 * @param {{ quiet?: boolean }} [options] — si `quiet: true`, pas de `console.info` dev à chaque appel (ex. balayage de grille).
 * @returns {{ enrichedFinal: object[], debugSummary: object|null }}
 */
export function applySimConfigToPreSimRows(preSimRows, simCfg, debug, windowHours, stats, options = {}) {
  const quiet = options.quiet === true;
  const simResolved = resolve15mSimConfig({ simConfig: simCfg });
  const enriched = preSimRows.map((pre) => applyResolvedSimToPreSimRow(pre, simResolved, debug));
  const enrichedFinal = dedupeEnrichedOnePer15mTradeWindow(enriched);
  let debugSummaryOut = null;
  if (debug) {
    const geMinBinary = (v) => v != null && Number.isFinite(v) && v >= simResolved.detectMinP;
    const highConvBefore = (e) => geMinBinary(e.simDebug?.maxBinaryBeforeSlot);
    const highConvAfter = (e) => geMinBinary(e.simDebug?.maxBinaryAfterSlot);
    const strippedBySlot = enrichedFinal.filter(
      (e) =>
        highConvBefore(e) &&
        !highConvAfter(e) &&
        e.simDebug?.why?.code === 'no_price_in_band'
    );
    debugSummaryOut = {
      at: new Date().toISOString(),
      windowHours,
      rowsBefore15mSlotDedupe: stats.rowsBefore15mSlotDedupe,
      rowsAfter15mSlotDedupe: stats.rowsAfter15mSlotDedupe,
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
      slugFetchCount: stats.slugWalkSlots,
      slugBatchSize: stats.slugBatchSize,
      slugPauseMs: stats.slugPauseMs,
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
      forbiddenMinuteWindowsUtc: buildForbiddenMinuteRuleEt(
        simResolved.forbidFirstSec,
        simResolved.forbidLastSec,
      ),
      urls: { clob: CLOB_PRICES_HISTORY_URL, trades: DATA_API_TRADES_URL },
    };
    console.info('[15m résolus] mode DEBUG — résumé', debugSummaryOut);
  }

  if (!quiet && typeof import.meta !== 'undefined' && import.meta.env?.DEV && !debug) {
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
      forbiddenMinuteWindowsUtc: buildForbiddenMinuteRuleEt(
        simResolved.forbidFirstSec,
        simResolved.forbidLastSec,
      ),
      exempleErreurFetch:
        sampleErr != null
          ? [sampleErr.debugClobFetchError, sampleErr.debugDataFetchError].filter(Boolean).join(' | ') || '200 vide ?'
          : null,
    });
  }
  return { enrichedFinal, debugSummary: debugSummaryOut };
}

/**
 * Fetch uniquement : marchés résolus + historiques CLOB/Data API par créneau, **sans** appliquer une config de simu.
 * Enchaîner avec `applySimConfigToPreSimRows` pour chaque grille de paramètres (évite N× appels réseau).
 */
export async function fetchBitcoin15mPreSimRows(windowHours) {
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
      /**
       * Il faut parcourir **un slug par créneau** sur toute la fenêtre (ex. 30 j ≈ 2880 slugs).
       * La liste Gamma `closed` mélange tous les marchés : très peu de lignes `btc-updown-15m` par page,
       * donc seule la marche sur les slugs garantit la couverture complète.
       */
      const slugWalkSlots = slotCount;
      const slugBatchSize = slugWalkSlots > 1600 ? 2 : slugWalkSlots > 800 ? 3 : 4;
      const slugPauseMs = slugWalkSlots > 1600 ? 240 : slugWalkSlots > 800 ? 180 : 120;
      const recent15mSlugs = getRecent15mSlugs(slugWalkSlots);
      const slugEventsFirst = await fetch15mEventsBySlugBatches(recent15mSlugs, slugBatchSize, slugPauseMs);
      await mapWithConcurrency(slugEventsFirst, PROCESS_EVENTS_CONCURRENCY, processEvent);

      const endDateMinIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      const MAX_CLOSED_OFFSET = 20000;
      const CLOSED_PAGE_PAUSE_MS = 60;
      try {
        for (let offset = 0; offset < MAX_CLOSED_OFFSET; offset += 100) {
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
          const only15m = page.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG));
          await mapWithConcurrency(only15m, PROCESS_EVENTS_CONCURRENCY, processEvent);
          if (page.length < 100) break;
          if (offset + 100 < MAX_CLOSED_OFFSET && CLOSED_PAGE_PAUSE_MS > 0) {
            await new Promise((r) => setTimeout(r, CLOSED_PAGE_PAUSE_MS));
          }
        }
      } catch {
        // Ne jamais throw : un 429/503/timeout sur la liste « closed » ne doit pas effacer les events déjà chargés par slug.
        try {
          const { data } = await axios.get(GAMMA_EVENTS_URL, {
            params: { closed: true, end_date_min: endDateMinIso, limit: 500, order: 'end_date', ascending: false },
            timeout: 15000,
          });
          const arr = Array.isArray(data) ? data : data?.data ?? data?.results ?? [];
          const only15m = arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG));
          await mapWithConcurrency(only15m, PROCESS_EVENTS_CONCURRENCY, processEvent);
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
        const only15m = activeEvents.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG));
        await mapWithConcurrency(only15m, PROCESS_EVENTS_CONCURRENCY, processEvent);
      } catch {
        try {
          const { data: activeRes } = await axios.get(GAMMA_EVENTS_URL, { params: { active: true, closed: false, limit: 300 }, timeout: 15000 });
          const arr = Array.isArray(activeRes) ? activeRes : activeRes?.data ?? activeRes?.results ?? [];
          const only15m = arr.filter((ev) => (ev.slug ?? '').toLowerCase().includes(BITCOIN_UP_DOWN_15M_SLUG));
          await mapWithConcurrency(only15m, PROCESS_EVENTS_CONCURRENCY, processEvent);
        } catch {
          /* inchangé : phase slug + closed déjà fusionnés */
        }
      }

      results.sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());
      const resultsOnePerSlot = dedupeResultsOnePer15mSlot(results);

      await mapWithConcurrency(resultsOnePerSlot, PROCESS_EVENTS_CONCURRENCY, async (r) => {
        if (!r.tokenIdUp && r.eventSlug) {
          const { tokenIdUp, tokenIdDown } = await fetchTokenIdsByMarketSlug(r.eventSlug);
          r.tokenIdUp = tokenIdUp;
          r.tokenIdDown = tokenIdDown;
        }
      });

      const enrichedRows = await mapWithConcurrency(resultsOnePerSlot, ENRICH_ROWS_CONCURRENCY, buildBitcoin15mPreSimRow);
      const preSimRows = enrichedRows.filter(Boolean);
      return {
        preSimRows,
        windowHours,
        stats: {
          rowsBefore15mSlotDedupe: results.length,
          rowsAfter15mSlotDedupe: resultsOnePerSlot.length,
          slugWalkSlots,
          slugBatchSize,
          slugPauseMs,
        },
      };
}

/**
 * Charge et enrichit les marchés Bitcoin Up or Down 15 min résolus (slug btc-updown-15m-*).
 * Utilisable depuis le hook React ou un script Node (`vite-node`) pour générer un cache JSON.
 */
export async function fetchBitcoin15mResolvedData(windowHours, simCfg, debug) {
  const pack = await fetchBitcoin15mPreSimRows(windowHours);
  return applySimConfigToPreSimRows(pack.preSimRows, simCfg, debug, pack.windowHours, pack.stats);
}
