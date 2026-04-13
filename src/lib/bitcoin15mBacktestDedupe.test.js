import { describe, it, expect } from 'vitest';
import {
  dedupeResultsOnePer15mSlot,
  dedupeEnrichedOnePer15mTradeWindow,
  slotEndMsFrom15mSlug,
} from './bitcoin15mBacktestDedupe.js';

const SLOT = 15 * 60;

describe('dedupeResultsOnePer15mSlot', () => {
  it('garde une seule ligne par fin de slug', () => {
    const start = 1_700_000_000;
    const slug = `btc-updown-15m-${start}`;
    const a = { eventSlug: slug, tokenIdUp: null };
    const b = { eventSlug: slug, tokenIdUp: 'tok', winner: 'Up' };
    const out = dedupeResultsOnePer15mSlot([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].tokenIdUp).toBe('tok');
  });
});

describe('dedupeEnrichedOnePer15mTradeWindow', () => {
  it('fusionne deux lignes même fenêtre d’entrée et garde celle avec signal', () => {
    const ts = 1_700_000_000 + 120;
    const periodEnd = Math.floor(ts / SLOT) * SLOT + SLOT;
    const periodStart = periodEnd - SLOT;
    const slug = `btc-updown-15m-${periodStart}`;
    const noSignal = {
      eventSlug: slug,
      slotEndSec: periodEnd,
      botWouldTake: null,
      debugHistoryPoints: 100,
    };
    const withSignal = {
      eventSlug: slug,
      slotEndSec: periodEnd,
      botWouldTake: 'Up',
      botEntryTimestamp: ts,
      botEntryPrice: 0.975,
      debugHistoryPoints: 50,
    };
    const out = dedupeEnrichedOnePer15mTradeWindow([noSignal, withSignal]);
    expect(out).toHaveLength(1);
    expect(out[0].botWouldTake).toBe('Up');
  });

  it('si la ligne avec signal arrive en premier, elle reste (ordre préservé par première occurrence de clé)', () => {
    const ts = 1_700_000_000 + 60;
    const periodEnd = Math.floor(ts / SLOT) * SLOT + SLOT;
    const slug = `btc-updown-15m-${periodEnd}`;
    const withSignal = {
      eventSlug: slug,
      botWouldTake: 'Down',
      botEntryTimestamp: ts,
      debugHistoryPoints: 10,
    };
    const noSignal = { eventSlug: slug, botWouldTake: null, debugHistoryPoints: 200 };
    const out = dedupeEnrichedOnePer15mTradeWindow([withSignal, noSignal]);
    expect(out).toHaveLength(1);
    expect(out[0].botWouldTake).toBe('Down');
  });

  it('ne fusionne pas deux marchés via botEntryTimestamp : la clé suit le slug (fin de créneau)', () => {
    const slotAEnd = 1_700_000_000;
    const slotBEnd = slotAEnd + SLOT;
    const slugA = `btc-updown-15m-${slotAEnd - SLOT}`;
    const slugB = `btc-updown-15m-${slotBEnd - SLOT}`;
    const rowA = {
      eventSlug: slugA,
      slotEndSec: slotAEnd,
      winner: 'Down',
      botWouldTake: 'Up',
      botEntryTimestamp: slotBEnd - 30,
      debugHistoryPoints: 100,
    };
    const rowB = {
      eventSlug: slugB,
      slotEndSec: slotBEnd,
      winner: 'Up',
      botWouldTake: null,
      debugHistoryPoints: 50,
    };
    const out = dedupeEnrichedOnePer15mTradeWindow([rowA, rowB]);
    expect(out).toHaveLength(2);
    const bySlug = Object.fromEntries(out.map((r) => [r.eventSlug, r.winner]));
    expect(bySlug[slugA]).toBe('Down');
    expect(bySlug[slugB]).toBe('Up');
  });
});

describe('slotEndMsFrom15mSlug', () => {
  it('suffixe = début Gamma → ms fin = (start + 900) * 1000', () => {
    const startSec = 1_711_031_700;
    expect(slotEndMsFrom15mSlug(`btc-updown-15m-${startSec}`)).toBe((startSec + SLOT) * 1000);
  });
});
