function viteP(key, fallback) {
  const n = Number(import.meta.env[key]);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

/** Bande prix signal / « mise max » carnet (alignée bot : 90 % – 91 % ; override VITE_ORDER_BOOK_SIGNAL_*). */
export const ORDER_BOOK_SIGNAL_MIN_P = viteP('VITE_ORDER_BOOK_SIGNAL_MIN_P', 0.9);
export const ORDER_BOOK_SIGNAL_MAX_P = viteP('VITE_ORDER_BOOK_SIGNAL_MAX_P', 0.91);
/** Plafond exécution marché type bot (`MARKET_WORST_PRICE_P` / FAK) : liquidité cumulée jusqu’à ce prix. */
export const ORDER_BOOK_MARKET_WORST_P = 0.99;

/** Prix d’un niveau ask CLOB (plusieurs schémas possibles). */
function parseAskLevelPrice(level) {
  const p = parseFloat(level?.price ?? level?.p ?? level?.[0] ?? NaN);
  return Number.isFinite(p) ? p : NaN;
}

/** Taille d’un niveau ask (clés supplémentaires : amount, remaining — selon versions / proxies). */
function parseAskLevelSize(level) {
  const s = parseFloat(
    level?.size ??
      level?.s ??
      level?.q ??
      level?.qty ??
      level?.quantity ??
      level?.amount ??
      level?.remaining ??
      level?.[1] ??
      0
  );
  return Number.isFinite(s) ? s : 0;
}

/**
 * Meilleur prix ask affiché (plus bas > 0), **sans** exiger de taille — aligné `useBitcoinUpDownSignals` / carnet Polymarket.
 * Utile quand la taille est absente ou sous un champ non parsé : `/price` peut alors renvoyer un mid ~50¢ alors que le carnet montre 38¢/63¢.
 * @param {unknown} asks
 * @returns {number|null}
 */
export function getBestAskPriceLenientFromRawAsks(asks) {
  if (!Array.isArray(asks)) return null;
  let min = Infinity;
  for (const level of asks) {
    const p = parseAskLevelPrice(level);
    if (Number.isFinite(p) && p > 0 && p < min) min = p;
  }
  return min === Infinity ? null : min;
}

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
    const p = parseAskLevelPrice(level);
    const s = parseAskLevelSize(level);

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
    const p = parseAskLevelPrice(level);
    const s = parseAskLevelSize(level);
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
    const p = parseAskLevelPrice(level);
    const s = parseAskLevelSize(level);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (p >= minP && p <= maxP) n += 1;
  }
  return n;
}
