import { describe, it, expect } from 'vitest';
import { mergeBtcPmAugment } from './mergeBtcPmAugment.js';

describe('mergeBtcPmAugment', () => {
  it('fusionne par slotEndSec', () => {
    const rows = [{ slotEndSec: 100, conditionId: '0x' + 'a'.repeat(64), x: 1 }];
    const aug = {
      schemaVersion: '1',
      items: [
        {
          slotEndSec: 100,
          btc: { signalTriggeredAtSec: 50 },
        },
      ],
    };
    const out = mergeBtcPmAugment(rows, aug);
    expect(out[0].btcPmAugment.btc.signalTriggeredAtSec).toBe(50);
    expect(out[0].x).toBe(1);
  });

  it('ignore si items vide', () => {
    const rows = [{ slotEndSec: 1 }];
    expect(mergeBtcPmAugment(rows, { schemaVersion: '1', items: [] })).toEqual(rows);
  });
});
