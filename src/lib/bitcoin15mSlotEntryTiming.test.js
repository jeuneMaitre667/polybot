import { describe, expect, it } from 'vitest';
import {
  is15mSlotEntryTimeForbidden,
  isLive15mEntryForbiddenNow,
  offsetSecondsInEtQuarterHour,
} from './bitcoin15mSlotEntryTiming.js';

/** Mars 2026 : EDT (UTC−4) — aligné affichage ET Polymarket. */
function sec(isoUtc) {
  return Math.floor(Date.parse(isoUtc) / 1000);
}

describe('offsetSecondsInEtQuarterHour (ET)', () => {
  it('3:30:05 PM ET → 5 s dans le quart (début du bloc interdit)', () => {
    const o = offsetSecondsInEtQuarterHour(sec('2026-03-20T19:30:05Z'));
    expect(o).toBe(5);
  });

  it('3:40 PM ET → 600 s dans le quart (milieu autorisé)', () => {
    const o = offsetSecondsInEtQuarterHour(sec('2026-03-20T19:40:00Z'));
    expect(o).toBe(10 * 60);
  });
});

describe('is15mSlotEntryTimeForbidden (grille ET :00 / :15 / :30 / :45)', () => {
  it('interdit les ~3 premières minutes du quart (ex. 3:30:05 PM ET)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:30:05Z'), null)).toBe(true);
  });

  it('interdit les ~4 dernières minutes (ex. 3:14:01 PM ET, fin du bloc 3:00–3:15)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:14:01Z'), null)).toBe(true);
  });

  it('interdit fin de bloc 2:45–3:00 (ex. 2:59:11 PM ET)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T18:59:11Z'), null)).toBe(true);
  });

  it('autorise le milieu du quart (ex. 3:40 PM ET)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:40:00Z'), null)).toBe(false);
  });

  it('autorise juste après les 3 premières minutes (ex. 3:33:00 PM ET)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:33:00Z'), null)).toBe(false);
  });

  it('ignore slotEndSec (paramètre de compat)', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:30:05Z'), 9999999999)).toBe(true);
  });
});

describe('isLive15mEntryForbiddenNow', () => {
  it('reflète la même grille sur nowMs', () => {
    const ms = Date.parse('2026-03-20T19:30:05Z');
    expect(isLive15mEntryForbiddenNow(ms, null)).toBe(true);
  });
});
