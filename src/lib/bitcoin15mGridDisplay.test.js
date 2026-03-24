import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  canonicalSlotEndSecFor15mBacktestRow,
  build15mBacktestDisplayRows,
  SLOT_15M_SEC,
} from './bitcoin15mGridDisplay.js';

describe('canonicalSlotEndSecFor15mBacktestRow', () => {
  it('priorise slotEndSec sur botEntryTimestamp (évite décalage d’un quart d’heure)', () => {
    const slotEnd = 1_800_000_000 - (1_800_000_000 % SLOT_15M_SEC);
    const wrongEntryTs = slotEnd - 400;
    const r = {
      eventSlug: '',
      slotEndSec: slotEnd,
      botEntryTimestamp: wrongEntryTs,
    };
    expect(canonicalSlotEndSecFor15mBacktestRow(r)).toBe(slotEnd);
  });

  it('lit le suffixe slug btc-updown-15m-* (début → fin +900 s)', () => {
    const startSec = 1_711_031_700;
    expect(
      canonicalSlotEndSecFor15mBacktestRow({ eventSlug: `btc-updown-15m-${startSec}`, slotEndSec: 999 })
    ).toBe(startSec + SLOT_15M_SEC);
  });
});

describe('build15mBacktestDisplayRows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('met le créneau ouvert (topEnd) en première ligne', () => {
    const nowSec = 1_700_000_700;
    const boundary = Math.floor(nowSec / SLOT_15M_SEC) * SLOT_15M_SEC;
    const topEnd = boundary + SLOT_15M_SEC;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);

    const currentRow = {
      eventSlug: `btc-updown-15m-${boundary}`,
      winner: null,
      slotEndSec: topEnd,
    };
    const prevStart = boundary - SLOT_15M_SEC;
    const prevEnd = prevStart + SLOT_15M_SEC;
    const prevRow = {
      eventSlug: `btc-updown-15m-${prevStart}`,
      winner: 'Down',
      slotEndSec: prevEnd,
    };

    const merged = build15mBacktestDisplayRows([prevRow, currentRow], 72);
    expect(merged.length).toBeGreaterThanOrEqual(2);
    expect(merged[0].eventSlug).toBe(currentRow.eventSlug);
    expect(merged[1].eventSlug).toBe(prevRow.eventSlug);
  });
});
