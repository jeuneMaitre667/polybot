/** Bande prix signal / « mise max » carnet (alignée bot : 97 % – 97,5 %). */
export const ORDER_BOOK_SIGNAL_MIN_P = 0.97;
export const ORDER_BOOK_SIGNAL_MAX_P = 0.975;

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
    const p = parseFloat(level?.price ?? level?.[0] ?? 0);
    const s = parseFloat(level?.size ?? level?.[1] ?? 0);
    if (p >= minP && p <= maxP && s > 0) {
      totalUsd += p * s;
    }
  }
  return Math.round(totalUsd * 100) / 100;
}
