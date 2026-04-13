/**
 * Résultat du dernier créneau 15m Bitcoin Up/Down (Gamma / outcomePrices).
 * Délègue à `getResolvedUpDownWinnerFromGammaMarket` (ordre réel Up/Down via `outcomes`).
 */

import {
  getResolvedUpDownWinnerFromGammaMarket,
  mergeGammaEventMarketForUpDown,
} from '@/lib/gammaPolymarket.js';
import { formatBitcoin15mSlotRangeEt } from '@/lib/polymarketDisplayTime.js';

const SLOT_SEC = 15 * 60;

/**
 * Borde UTC entre deux créneaux 15m alignés Polymarket (= instant de **clôture** du créneau précédent
 * et d’**ouverture** du créneau courant). Égal à `floor(epoch/900)*900`.
 */
export function getCurrent15mUtcBoundarySec(nowSec = Math.floor(Date.now() / 1000)) {
  if (nowSec == null || !Number.isFinite(Number(nowSec))) return 0;
  return Math.floor(Number(nowSec) / SLOT_SEC) * SLOT_SEC;
}

/**
 * Suffixe de slug du dernier marché **terminé** : `btc-updown-15m-{startSec}` (Gamma : `eventStartTime` en s Unix).
 * Pas le suffixe du créneau **ouvert** : l’ancien `ceil(now/900)*900 - 900` pointait souvent un cran en avance.
 */
export function getPrevious15mResolvedSlugStartSec(nowSec = Math.floor(Date.now() / 1000)) {
  return getCurrent15mUtcBoundarySec(nowSec) - SLOT_SEC;
}

/** @deprecated Alias — slug start du dernier créneau résolu (voir `getPrevious15mResolvedSlugStartSec`). */
export function getPrevious15mSlotEndSec(nowSec = Math.floor(Date.now() / 1000)) {
  return getPrevious15mResolvedSlugStartSec(nowSec);
}

/** Libellé créneau 15m comme sur Polymarket (plage en Eastern Time). */
export function format15mSlotEndFr(endSec) {
  return formatBitcoin15mSlotRangeEt(endSec);
}

/**
 * @param {object} market - marché Gamma
 * @param {object} [ev] - événement parent (outcomes/tokens souvent ici seulement)
 */
export function getResolvedWinnerFromGammaMarket(market, ev = null) {
  const merged = mergeGammaEventMarketForUpDown(ev, market);
  return getResolvedUpDownWinnerFromGammaMarket(merged);
}
