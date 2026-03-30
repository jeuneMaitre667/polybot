import { describe, it, expect } from 'vitest';
import { firstEntryTimestampIntoBand } from './bitcoin15mResolvedDataFetch.js';

const lo = 0.77;
const hi = 0.78;

describe('firstEntryTimestampIntoBand', () => {
  it('détecte un saut 0,50 → 0,99 sans tick dans la bande (historique clairsemé)', () => {
    const prev = { t: 100, price: 0.5 };
    const ts = firstEntryTimestampIntoBand(prev, 200, 0.99, lo, hi);
    expect(ts).not.toBeNull();
    expect(ts).toBeGreaterThan(100);
    expect(ts).toBeLessThan(200);
    /* Premier instant dans la bande = franchissement de lo en montant */
    const u = (lo - 0.5) / (0.99 - 0.5);
    expect(ts).toBeCloseTo(100 + u * 100, 8);
  });

  it('null si le segment reste sous la bande', () => {
    const prev = { t: 0, price: 0.4 };
    expect(firstEntryTimestampIntoBand(prev, 100, 0.5, lo, hi)).toBeNull();
  });

  it('échantillon explicite dans la bande', () => {
    const prev = { t: 0, price: 0.5 };
    const ts = firstEntryTimestampIntoBand(prev, 100, 0.775, lo, hi);
    expect(ts).not.toBeNull();
  });

  it('pas de nouvelle entrée si déjà dans la bande au point précédent', () => {
    const prev = { t: 0, price: 0.775 };
    expect(firstEntryTimestampIntoBand(prev, 100, 0.776, lo, hi)).toBeNull();
  });
});
