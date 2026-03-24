/**
 * Grille d’affichage backtest 15m : une ligne par **fin** de créneau UTC.
 * Slug Polymarket = `btc-updown-15m-{eventStartSec}` ; fin = start + 900 s.
 * Créneau ouvert en tête : `topEnd = floor(now/900)*900 + 900`.
 */

export const SLOT_15M_SEC = 15 * 60;
export const MAX_15M_GRID_SLOTS = 168 * 4;

/** Fin de fenêtre (s UTC) depuis le slug `btc-updown-15m-{eventStartSec}`. */
export function slotEndSecFromBitcoin15mSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/btc-updown-15m-(\d+)$/i);
  if (!m) return null;
  const ts = parseInt(m[1], 10);
  if (!Number.isFinite(ts)) return null;
  const startSec = ts < 1e12 ? ts : Math.floor(ts / 1000);
  return startSec + SLOT_15M_SEC;
}

/**
 * Clé de grille : **slug** > **slotEndSec** (API) > **endDate** > **botEntryTimestamp** (dernier recours).
 * Ne pas lire botEntryTimestamp avant slotEndSec : le trade peut tomber dans le quart d’heure suivant
 * → ligne dupliquée / décalée d’un créneau vs l’horloge réelle.
 */
export function canonicalSlotEndSecFor15mBacktestRow(r) {
  const fromSlug = slotEndSecFromBitcoin15mSlug(r.eventSlug ?? '');
  if (fromSlug != null) return fromSlug;
  if (r.slotEndSec != null && Number.isFinite(Number(r.slotEndSec))) {
    const s = Number(r.slotEndSec);
    return Math.round(s / SLOT_15M_SEC) * SLOT_15M_SEC;
  }
  if (r.endDate) {
    const ms = new Date(r.endDate).getTime();
    if (Number.isFinite(ms)) {
      const sec = Math.floor(ms / 1000);
      return Math.round(sec / SLOT_15M_SEC) * SLOT_15M_SEC;
    }
  }
  if (r.botEntryTimestamp != null && Number.isFinite(Number(r.botEntryTimestamp))) {
    const ts = Number(r.botEntryTimestamp);
    return Math.floor(ts / SLOT_15M_SEC) * SLOT_15M_SEC + SLOT_15M_SEC;
  }
  return null;
}

function prefer15mBacktestRowForSameSlot(a, b, slotEndSec) {
  const slugEnd = (row) => slotEndSecFromBitcoin15mSlug(row.eventSlug ?? '');
  const matchA = slugEnd(a) === slotEndSec;
  const matchB = slugEnd(b) === slotEndSec;
  if (matchA && !matchB) return a;
  if (!matchA && matchB) return b;
  const score = (row) => {
    let s = 0;
    if (row?.botWouldTake != null) s += 4;
    if (row?.botEntryTimestamp != null) s += 2;
    if (row?.winner === 'Up' || row?.winner === 'Down') s += 1;
    return s;
  };
  return score(b) > score(a) ? b : a;
}

/**
 * Une ligne par créneau 15m (récent → ancien) : d’abord le créneau **ouvert** (fin = topEnd), puis les terminés.
 */
export function build15mBacktestDisplayRows(resolvedRows, windowHours) {
  const SLOT = SLOT_15M_SEC;
  const maxSlots = Math.min(MAX_15M_GRID_SLOTS, Math.ceil(windowHours * 4));
  const nowSec = Math.floor(Date.now() / 1000);
  const boundary = Math.floor(nowSec / SLOT) * SLOT;
  const topEnd = boundary + SLOT;
  const windowBottom = topEnd - maxSlots * SLOT;

  const bySlot = new Map();
  for (const row of resolvedRows) {
    const k = canonicalSlotEndSecFor15mBacktestRow(row);
    if (k == null) continue;
    const prev = bySlot.get(k);
    bySlot.set(k, prev === undefined ? row : prefer15mBacktestRowForSameSlot(prev, row, k));
  }

  const dataKeys = [...bySlot.keys()].filter((x) => Number.isFinite(x));
  const minDataEnd = dataKeys.length > 0 ? Math.min(...dataKeys) : null;
  const bottom = minDataEnd != null ? Math.min(windowBottom, minDataEnd) : windowBottom;

  const maxIterations = maxSlots + 200;
  const merged = [];
  const rangeEnds = new Set();
  /** Inclure `topEnd` : créneau en cours en tête (plus d’orphelin en fin de tableau). */
  let end = topEnd;
  let iterations = 0;
  while (end >= bottom && iterations < maxIterations) {
    rangeEnds.add(end);
    iterations += 1;
    const row = bySlot.get(end);
    if (row) merged.push(row);
    else merged.push({ __placeholder15m: true, slotEndSec: end });
    end -= SLOT;
  }

  const orphans = [];
  for (const [k, row] of bySlot) {
    if (!rangeEnds.has(k)) orphans.push({ k, row });
  }
  orphans.sort((a, b) => b.k - a.k);
  merged.push(...orphans.map((o) => o.row));

  return merged;
}
