import { useEffect, useMemo, useState } from 'react';
import { loadManualEntries } from '@/lib/tradeHistoryManualTopups.js';

/**
 * Relecture périodique du localStorage pour rester aligné avec `TradeHistory` (même onglet).
 */
export function useManualTopupEntries(historyAddress) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!historyAddress) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 2500);
    return () => clearInterval(id);
  }, [historyAddress]);
  // `tick` force un rechargement quand TradeHistory met à jour le localStorage (même onglet).
  return useMemo(
    () => loadManualEntries(historyAddress),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick volontaire
    [historyAddress, tick],
  );
}
