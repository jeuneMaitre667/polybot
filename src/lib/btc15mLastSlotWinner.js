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

export function getPrevious15mSlotEndSec(nowSec = Math.floor(Date.now() / 1000)) {
  const currentEnd = Math.ceil(nowSec / SLOT_SEC) * SLOT_SEC;
  return currentEnd - SLOT_SEC;
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
