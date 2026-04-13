import { ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P } from '@/lib/orderBookLiquidity.js';

/** Affichage profondeur (prix min → max sur l’axe vertical). */
export const DEPTH_DISPLAY_MIN_P = 0.94;
export const DEPTH_DISPLAY_MAX_P = 0.985;

/**
 * Parse une ligne d’ask CLOB.
 * @param {unknown} level
 */
function parseAskLevel(level) {
  const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? 0);
  const s = parseFloat(level?.size ?? level?.s ?? level?.q ?? level?.qty ?? level?.[1] ?? 0);
  if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) return null;
  return { price: p, size: s, usd: Math.round(p * s * 100) / 100 };
}

/**
 * @param {unknown} asks - réponse CLOB `asks`
 * @returns {{ price: number, size: number, usd: number }[]}
 */
export function normalizeAskLevels(asks) {
  if (!Array.isArray(asks)) return [];
  const rows = [];
  for (const level of asks) {
    const row = parseAskLevel(level);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.price - a.price);
  return rows;
}

/**
 * @param {{ price: number, size: number, usd: number }[]} levels
 * @param {number} minP
 * @param {number} maxP
 */
export function filterLevelsInPriceRange(levels, minP, maxP) {
  return levels.filter((l) => l.price >= minP && l.price <= maxP);
}

/**
 * Aligné maquette : cher (rose), fenêtre signal (vert + ✓), bas (bordeaux).
 * @param {number} price
 */
export function depthRowTier(price) {
  if (price > ORDER_BOOK_SIGNAL_MAX_P) return 'expensive';
  if (price >= ORDER_BOOK_SIGNAL_MIN_P && price <= ORDER_BOOK_SIGNAL_MAX_P) return 'signal';
  return 'cheap';
}
