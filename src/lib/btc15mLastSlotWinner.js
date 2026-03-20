/**
 * Résultat du dernier créneau 15m Bitcoin Up/Down (Gamma / outcomePrices).
 * Aligné sur useBitcoinUpDownResolved15m (getResolvedWinner).
 */

const SLOT_SEC = 15 * 60;
const RESOLVED_WIN_THRESHOLD = 0.98;

export function getPrevious15mSlotEndSec(nowSec = Math.floor(Date.now() / 1000)) {
  const currentEnd = Math.ceil(nowSec / SLOT_SEC) * SLOT_SEC;
  return currentEnd - SLOT_SEC;
}

export function format15mSlotEndFr(endSec) {
  if (endSec == null || !Number.isFinite(endSec)) return '—';
  return new Date(endSec * 1000).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseOutcomePrices(market) {
  try {
    const raw = market?.outcomePrices ?? market?.outcome_prices;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return [parseFloat(arr[0]) ?? 0, parseFloat(arr[1]) ?? 0];
  } catch {
    return null;
  }
}

/**
 * @param {object} market - marché Gamma (outcomePrices : [Up, Down])
 * @returns {'Up' | 'Down' | null}
 */
export function getResolvedWinnerFromGammaMarket(market) {
  const prices = parseOutcomePrices(market);
  if (!prices) return null;
  if (prices[0] >= RESOLVED_WIN_THRESHOLD && prices[1] < 0.5) return 'Up';
  if (prices[1] >= RESOLVED_WIN_THRESHOLD && prices[0] < 0.5) return 'Down';
  return null;
}
