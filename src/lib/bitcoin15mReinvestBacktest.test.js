import { describe, it, expect } from 'vitest';
import { getCalendarDayEt, hourOfDayEt, simulateReinvestMaxStake } from './bitcoin15mReinvestBacktest.js';

describe('getCalendarDayEt', () => {
  it('retourne une date YYYY-MM-DD en fuseau America/New_York', () => {
    const s = getCalendarDayEt('2026-03-27T12:00:00.000Z');
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('hourOfDayEt', () => {
  it('retourne une heure 0–23', () => {
    const h = hourOfDayEt('2026-07-15T04:00:00.000Z');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });
});

describe('simulateReinvestMaxStake', () => {
  const baseRow = (over) => ({
    endDate: '2026-03-27T18:00:00.000Z',
    winner: 'Up',
    botWouldTake: 'Up',
    botEntryPrice: 0.77,
    botWon: true,
    botStopLossExit: false,
    conditionId: '0xabc',
    ...over,
  });

  it('plafonne la mise au capital et à la mise max', () => {
    const rows = [
      baseRow({ endDate: '2026-03-27T17:00:00.000Z' }),
      baseRow({ endDate: '2026-03-27T17:15:00.000Z', botWon: false }),
    ];
    const todayEt = getCalendarDayEt(rows[0].endDate);
    const r = simulateReinvestMaxStake(rows, {
      initialBalance: 20,
      maxStakeEur: 500,
      backtestSlC: 57,
      includeFees: false,
      todayEt,
    });
    expect(r.trades).toBe(2);
    expect(r.day?.trades).toBe(2);
    expect(r.day?.pnl).toBeCloseTo(r.capital - 20, 5);
  });

  it('SL : perte fixe en fraction du stake si slFixedLossFractionOfStake', () => {
    const rows = [
      baseRow({
        endDate: '2026-03-27T17:00:00.000Z',
        botStopLossExit: true,
        botWon: false,
        botEntryPrice: 0.77,
      }),
    ];
    const r = simulateReinvestMaxStake(rows, {
      initialBalance: 100,
      maxStakeEur: 100,
      backtestSlC: 60,
      includeFees: false,
      slFixedLossFractionOfStake: 0.25,
    });
    expect(r.trades).toBe(1);
    expect(r.capital).toBeCloseTo(75, 5);
  });

  it('hourlyBreakdownEt : trade vs fin de créneau', () => {
    const row = baseRow({
      endDate: '2026-03-27T14:00:00.000Z',
      botEntryTimestamp: Math.floor(Date.parse('2026-03-27T07:00:00.000Z') / 1000),
    });
    const rSlot = simulateReinvestMaxStake([row], {
      initialBalance: 100,
      maxStakeEur: 100,
      backtestSlC: 60,
      includeFees: false,
      hourlyBreakdownEt: true,
      hourlyBreakdownBy: 'slotEnd',
    });
    const rTrade = simulateReinvestMaxStake([row], {
      initialBalance: 100,
      maxStakeEur: 100,
      backtestSlC: 60,
      includeFees: false,
      hourlyBreakdownEt: true,
      hourlyBreakdownBy: 'trade',
    });
    const hEnd = hourOfDayEt(row.endDate);
    const hTrade = hourOfDayEt(new Date(Number(row.botEntryTimestamp) * 1000));
    expect(hEnd).not.toBe(hTrade);
    expect(rSlot.hourlyTradesEt?.[hEnd]).toBe(1);
    expect(rTrade.hourlyTradesEt?.[hTrade]).toBe(1);
  });
});
