/**
 * SL **live** déclenché (Telegram) mais vente FAK refusée (worst &gt; best bid) : le proxy
 * d’historique backtest peut ne pas reproduire le franchissement du seuil. On force alors
 * `botStopLossExit` pour ces créneaux afin que le tableau / PnL alignent la réalité.
 *
 * Surcharges optionnelles (`.env`) :
 * - `VITE_BACKTEST_MANUAL_SL_SLOT_END_SECS` — fins de créneau UTC (s), séparées par des virgules
 * - `VITE_BACKTEST_MANUAL_SL_CONDITION_IDS` — `conditionId` complets, séparés par des virgules
 */

function parseCommaList(envVal) {
  if (!envVal || typeof envVal !== 'string') return [];
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Aligné sur `BACKTEST_STOP_LOSS_WORST_PRICE_P` dans `bitcoin15mResolvedDataFetch.js`. */
const WORST_EXIT_P = Math.max(
  0.001,
  Math.min(0.99, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_WORST_PRICE_P) || 0.01),
);

const envSlotEnds = parseCommaList(import.meta.env.VITE_BACKTEST_MANUAL_SL_SLOT_END_SECS)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));
const envCids = parseCommaList(import.meta.env.VITE_BACKTEST_MANUAL_SL_CONDITION_IDS).map((s) =>
  s.toLowerCase(),
);

/**
 * Créneaux connus : 28 mars **10:15** et **10:30** ET (fin de quart d’heure), années 2024 et 2026,
 * pour couvrir un éventuel décal d’affichage date dans l’UI.
 */
const DEFAULT_SLOT_END_SECS_ET = [
  Math.floor(new Date('2024-03-28T10:15:00-04:00').getTime() / 1000),
  Math.floor(new Date('2024-03-28T10:30:00-04:00').getTime() / 1000),
  Math.floor(new Date('2026-03-28T10:15:00-04:00').getTime() / 1000),
  Math.floor(new Date('2026-03-28T10:30:00-04:00').getTime() / 1000),
];

const manualSlotEndSecs = new Set([...DEFAULT_SLOT_END_SECS_ET, ...envSlotEnds]);
const manualConditionIds = new Set(envCids);

export function rowMatchesManualStopLossOverride(r) {
  if (!r) return false;
  const cid = typeof r.conditionId === 'string' ? r.conditionId.toLowerCase() : null;
  if (cid && manualConditionIds.has(cid)) return true;
  const sec = r.slotEndSec != null && Number.isFinite(Number(r.slotEndSec)) ? Math.floor(Number(r.slotEndSec)) : null;
  if (sec != null && manualSlotEndSecs.has(sec)) return true;
  return false;
}

/**
 * @param {object} sim — résultat `computeBotSimulationWithConfig`
 * @param {object} r — ligne marché (`winner`, etc.)
 */
export function applyManualStopLossOverride(sim, r) {
  if (!sim || sim.botWouldTake == null) return sim;
  if (sim.botStopLossExit === true) return sim;
  if (!rowMatchesManualStopLossOverride(r)) return sim;

  const side = sim.botWouldTake;
  const settled = r.winner === 'Up' || r.winner === 'Down';
  const resolutionWin = settled ? r.winner === side : null;
  const entryP = sim.botEntryPrice != null ? Number(sim.botEntryPrice) : null;
  const minObs = sim.botMinObservedAfterEntryP != null ? Number(sim.botMinObservedAfterEntryP) : null;
  let drawdownPct = null;
  if (Number.isFinite(entryP) && entryP > 0 && Number.isFinite(minObs)) {
    drawdownPct = Math.round(((minObs - entryP) / entryP) * 100 * 100) / 100;
  }

  return {
    ...sim,
    botWon: null,
    botStopLossExit: true,
    botStopLossReason: 'manual_live_sl_triggered_exit_failed',
    botStopLossExitPriceP: Math.round(WORST_EXIT_P * 1e6) / 1e6,
    botStopLossObservedPriceP:
      Number.isFinite(minObs) && minObs > 0 ? Math.round(minObs * 1e6) / 1e6 : null,
    botStopLossObservedDrawdownPct: drawdownPct,
    botStopLossAtTimestamp: sim.botEntryTimestamp,
    botResolutionWouldWin: resolutionWin,
  };
}
