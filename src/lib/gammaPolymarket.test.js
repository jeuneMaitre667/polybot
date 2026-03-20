import { describe, it, expect } from 'vitest';
import { coalesceClobTokenIds, parseUpDownTokenIdsFromMarket } from './gammaPolymarket.js';

describe('coalesceClobTokenIds', () => {
  it('retourne null pour null / undefined', () => {
    expect(coalesceClobTokenIds(null)).toBeNull();
    expect(coalesceClobTokenIds(undefined)).toBeNull();
  });

  it('normalise un tableau de strings', () => {
    expect(coalesceClobTokenIds(['111', '222'])).toEqual(['111', '222']);
  });

  it('parse une chaîne JSON type Gamma', () => {
    const s = '["96824730952619885369684940515638199749929816590729570971177503983544327566672","45110149248594058422981178646553755739554643170960388777683519449527075405313"]';
    const out = coalesceClobTokenIds(s);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\d+$/);
  });

  it('retourne null pour chaîne vide ou JSON invalide', () => {
    expect(coalesceClobTokenIds('')).toBeNull();
    expect(coalesceClobTokenIds('not-json')).toBeNull();
  });

  it('accepte un seul id numérique en string brute', () => {
    expect(coalesceClobTokenIds('12345678901234567890')).toEqual(['12345678901234567890']);
  });
});

describe('parseUpDownTokenIdsFromMarket', () => {
  it('lit clobTokenIds stringifié (cas API Gamma réel)', () => {
    const m = {
      clobTokenIds:
        '["11111111111111111111111111111111111111111111111111111111111111111","22222222222222222222222222222222222222222222222222222222222222222"]',
    };
    const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(m);
    expect(tokenIdUp?.startsWith('111')).toBe(true);
    expect(tokenIdDown?.startsWith('222')).toBe(true);
  });

  it('utilise tokens[] en secours', () => {
    const m = {
      tokens: [{ token_id: 'up-id' }, { token_id: 'down-id' }],
    };
    expect(parseUpDownTokenIdsFromMarket(m)).toEqual({ tokenIdUp: 'up-id', tokenIdDown: 'down-id' });
  });

  it('retourne nulls si objet invalide', () => {
    expect(parseUpDownTokenIdsFromMarket(null)).toEqual({ tokenIdUp: null, tokenIdDown: null });
    expect(parseUpDownTokenIdsFromMarket({})).toEqual({ tokenIdUp: null, tokenIdDown: null });
  });
});
