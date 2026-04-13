import { normalizeConditionId } from '@/lib/bitcoin15mBacktestDedupe.js';

/**
 * Fusionne un document d’enrichissement BTC+PM (pipeline Python ou autre) dans les lignes backtest.
 * Ne modifie pas les champs existants (`botWouldTake`, etc.) : ajoute seulement `btcPmAugment` par ligne.
 *
 * @param {Array<Record<string, unknown>>} rows — lignes `enrichedFinal` du dashboard
 * @param {unknown} augmentDoc — `{ schemaVersion, generatedAt?, items: [...] }`
 * @returns {Array<Record<string, unknown>>} nouvelles lignes (shallow copy par ligne fusionnée)
 */
export function mergeBtcPmAugment(rows, augmentDoc) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (!augmentDoc || typeof augmentDoc !== 'object') return rows;
  const items = augmentDoc.items;
  if (!Array.isArray(items) || items.length === 0) return rows;

  const bySlot = new Map();
  const byCid = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const ses = item.slotEndSec;
    if (ses != null && Number.isFinite(Number(ses))) {
      bySlot.set(Math.floor(Number(ses)), item);
    }
    const cid = normalizeConditionId(item.conditionId);
    if (cid) byCid.set(cid, item);
  }

  return rows.map((row) => {
    const r = row;
    const ses = r?.slotEndSec != null && Number.isFinite(Number(r.slotEndSec)) ? Math.floor(Number(r.slotEndSec)) : null;
    const cid = normalizeConditionId(r?.normalizedConditionId ?? r?.conditionId);
    let aug = ses != null ? bySlot.get(ses) : null;
    if (!aug && cid) aug = byCid.get(cid);
    if (!aug) return r;
    return { ...r, btcPmAugment: aug };
  });
}
