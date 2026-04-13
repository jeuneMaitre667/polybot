import { describe, expect, it } from 'vitest';
import {
  is15mSlotEntryTimeForbidden,
  is15mSlotEntryTimeForbiddenWithWindows,
  is15mMarketSlotEntryTimeForbidden,
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

describe('is15mSlotEntryTimeForbidden (défaut 0/0 = pas de grille)', () => {
  it('n’interdit pas lorsque les constantes défaut sont 0/0', () => {
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:30:05Z'))).toBe(false);
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:14:01Z'))).toBe(false);
    expect(is15mSlotEntryTimeForbidden(sec('2026-03-20T19:40:00Z'))).toBe(false);
  });
});

describe('is15mSlotEntryTimeForbiddenWithWindows (grille ex. 6+4 min)', () => {
  const f = 6 * 60;
  const l = 4 * 60;

  it('interdit les ~6 premières minutes du quart (ex. 3:30:05 PM ET)', () => {
    expect(is15mSlotEntryTimeForbiddenWithWindows(sec('2026-03-20T19:30:05Z'), f, l)).toBe(true);
  });

  it('interdit les ~4 dernières minutes (ex. 3:14:01 PM ET, fin du bloc 3:00–3:15)', () => {
    expect(is15mSlotEntryTimeForbiddenWithWindows(sec('2026-03-20T19:14:01Z'), f, l)).toBe(true);
  });

  it('interdit fin de bloc 2:45–3:00 (ex. 2:59:11 PM ET)', () => {
    expect(is15mSlotEntryTimeForbiddenWithWindows(sec('2026-03-20T18:59:11Z'), f, l)).toBe(true);
  });

  it('autorise le milieu du quart (ex. 3:40 PM ET)', () => {
    expect(is15mSlotEntryTimeForbiddenWithWindows(sec('2026-03-20T19:40:00Z'), f, l)).toBe(false);
  });

  it('autorise juste après les 6 premières minutes (ex. 3:36:00 PM ET)', () => {
    expect(is15mSlotEntryTimeForbiddenWithWindows(sec('2026-03-20T19:36:00Z'), f, l)).toBe(false);
  });
});

describe('isLive15mEntryForbiddenNow', () => {
  it('avec défaut 0/0, ne bloque pas sur une date en « début de quart »', () => {
    const ms = Date.parse('2026-03-20T19:30:05Z');
    expect(isLive15mEntryForbiddenNow(ms)).toBe(false);
  });
});

describe('is15mMarketSlotEntryTimeForbidden (offset dans le créneau slug UTC)', () => {
  const slotEndSec = 1_000_000;
  const slotStartSec = slotEndSec - 15 * 60;

  it('interdit les N premières secondes du créneau [slotStart, slotEnd], indépendamment du quart ET', () => {
    const tsEarly = slotStartSec + 120;
    expect(is15mMarketSlotEntryTimeForbidden(tsEarly, slotEndSec, 600, 0)).toBe(true);
    const tsLate = slotStartSec + 700;
    expect(is15mMarketSlotEntryTimeForbidden(tsLate, slotEndSec, 600, 0)).toBe(false);
  });

  it('interdit les M dernières secondes du créneau', () => {
    const tsInLast2Min = slotEndSec - 60;
    expect(is15mMarketSlotEntryTimeForbidden(tsInLast2Min, slotEndSec, 0, 120)).toBe(true);
    const tsMid = slotStartSec + 400;
    expect(is15mMarketSlotEntryTimeForbidden(tsMid, slotEndSec, 0, 120)).toBe(false);
  });
});
