import { format } from 'date-fns';

export function makeEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultManualEntries() {
  return [
    { id: makeEntryId(), date: format(new Date(Date.now() - 24 * 60 * 60 * 1000), 'yyyy-MM-dd'), amount: 4.71, label: 'Depot manuel' },
    { id: makeEntryId(), date: format(new Date(), 'yyyy-MM-dd'), amount: 10.37, label: 'Depot manuel' },
  ];
}

/**
 * Entrées manuelles (dépôts) persistées — même clé localStorage que `TradeHistory`.
 * @param {string | null | undefined} historyAddress
 * @returns {Array<{ id?: string, date?: string, amount?: number, label?: string }>}
 */
export function loadManualEntries(historyAddress) {
  if (!historyAddress) return [];
  try {
    const key = `trade-history-topups:${historyAddress.toLowerCase()}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    let best = null;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('trade-history-topups:')) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      try {
        const arr = JSON.parse(v);
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (!best || arr.length > best.length) best = arr;
      } catch {
        // ignore
      }
    }
    if (best) return best;
    return defaultManualEntries();
  } catch {
    return defaultManualEntries();
  }
}

/** Somme des montants manuels (USDC), comme dans `TradeHistory`. */
export function sumManualTopupUsd(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((acc, e) => {
    const n = Number(e?.amount);
    return acc + (Number.isFinite(n) && n >= 0 ? n : 0);
  }, 0);
}
