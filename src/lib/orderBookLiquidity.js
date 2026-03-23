/** Bande prix signal / « mise max » carnet (alignée bot : 97 % – 97,5 %). */
export const ORDER_BOOK_SIGNAL_MIN_P = 0.97;
export const ORDER_BOOK_SIGNAL_MAX_P = 0.975;
/** Plafond exécution marché type bot (`MARKET_WORST_PRICE_P` / FAK) : liquidité cumulée jusqu’à ce prix. */
export const ORDER_BOOK_MARKET_WORST_P = 0.98;

/**
 * Liquidité côté asks (USDC) entre minP et maxP : somme (prix × taille).
 * @param {unknown} asks - réponse CLOB `asks`
 * @returns {number} 0 si aucune ligne dans la bande
 */
export function liquidityUsdFromAsks(
  asks,
  minP = ORDER_BOOK_SIGNAL_MIN_P,
  maxP = ORDER_BOOK_SIGNAL_MAX_P
) {
  if (!Array.isArray(asks)) return 0;
  let totalUsd = 0;
  for (const level of asks) {
    // Réponse CLOB peut varier : { price, size } ou { p, s } / { p, q } ou tuple [price, size].
    const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? 0);
    const s = parseFloat(level?.size ?? level?.s ?? level?.q ?? level?.qty ?? level?.[1] ?? 0);

    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
    if (p >= minP && p <= maxP && s > 0) totalUsd += p * s;
  }
  return Math.round(totalUsd * 100) / 100;
}

/**
 * Meilleur ask (achat au prix le plus bas) parmi les niveaux avec taille > 0.
 * @param {unknown} asks
 * @returns {number|null} probabilité 0–1 ou null si vide
 */
export function getBestAskPriceFromRawAsks(asks) {
  if (!Array.isArray(asks)) return null;
  let min = Infinity;
  for (const level of asks) {
    const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
    const s = parseFloat(level?.size ?? level?.s ?? level?.q ?? level?.qty ?? level?.[1] ?? 0);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (p > 0 && p < min) min = p;
  }
  return min === Infinity ? null : min;
}

/**
 * Nombre de niveaux d’asks dans [minP, maxP] avec taille > 0.
 */
export function countAskLevelsInBand(asks, minP = ORDER_BOOK_SIGNAL_MIN_P, maxP = ORDER_BOOK_SIGNAL_MAX_P) {
  if (!Array.isArray(asks)) return 0;
  let n = 0;
  for (const level of asks) {
    const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
    const s = parseFloat(level?.size ?? level?.s ?? level?.q ?? level?.qty ?? level?.[1] ?? 0);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (p >= minP && p <= maxP) n += 1;
  }
  return n;
}
