import { describe, it, expect } from 'vitest';
import { applyManualStopLossOverride, rowMatchesManualStopLossOverride } from './bitcoin15mManualSlOverrides.js';

describe('bitcoin15mManualSlOverrides', () => {
  it('rowMatchesManualStopLossOverride : fin de créneau 28 mars 2026 10:30 ET', () => {
    const sec = Math.floor(new Date('2026-03-28T10:30:00-04:00').getTime() / 1000);
    expect(rowMatchesManualStopLossOverride({ slotEndSec: sec })).toBe(true);
  });

  it('applyManualStopLossOverride : force SL si entrée simulée et résolution gagnante', () => {
    const sec = Math.floor(new Date('2026-03-28T10:15:00-04:00').getTime() / 1000);
    const sim = {
      botWouldTake: 'Up',
      botWon: true,
      botStopLossExit: false,
      botEntryPrice: 0.78,
      botEntryTimestamp: 1_700_000_000,
      botMinObservedAfterEntryP: 0.59,
    };
    const r = { winner: 'Up', slotEndSec: sec };
    const out = applyManualStopLossOverride(sim, r);
    expect(out.botStopLossExit).toBe(true);
    expect(out.botResolutionWouldWin).toBe(true);
    expect(out.botWon).toBe(null);
    expect(out.botStopLossReason).toBe('manual_live_sl_triggered_exit_failed');
  });

  it('ne modifie pas si SL déjà simulé par le proxy', () => {
    const sec = Math.floor(new Date('2026-03-28T10:15:00-04:00').getTime() / 1000);
    const sim = {
      botWouldTake: 'Up',
      botStopLossExit: true,
      botEntryPrice: 0.78,
    };
    const r = { winner: 'Up', slotEndSec: sec };
    expect(applyManualStopLossOverride(sim, r)).toBe(sim);
  });
});
