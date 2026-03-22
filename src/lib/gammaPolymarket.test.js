import { describe, it, expect } from 'vitest';
import {
  coalesceClobTokenIds,
  parseUpDownTokenIdsFromMarket,
  getResolvedUpDownWinnerFromGammaMarket,
  getUpDownOutcomeIndices,
  mergeGammaEventMarketForUpDown,
  parseGammaOutcomesLabels,
} from './gammaPolymarket.js';

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

  it('aligne les tokens sur outcomes Gamma ["Down","Up"] (ordre alphabétique)', () => {
    const m = {
      outcomes: '["Down","Up"]',
      clobTokenIds:
        '["22222222222222222222222222222222222222222222222222222222222222222","11111111111111111111111111111111111111111111111111111111111111111"]',
    };
    const { tokenIdUp, tokenIdDown } = parseUpDownTokenIdsFromMarket(m);
    expect(tokenIdUp?.startsWith('111')).toBe(true);
    expect(tokenIdDown?.startsWith('222')).toBe(true);
  });
});

describe('parseGammaOutcomesLabels / shortOutcomes', () => {
  it('utilise shortOutcomes si outcomes absent (schéma Market OpenAPI)', () => {
    const m = {
      shortOutcomes: '["Down","Up"]',
      outcomePrices: '["0.02","0.98"]',
    };
    expect(parseGammaOutcomesLabels(m)).toEqual(['Down', 'Up']);
    expect(getResolvedUpDownWinnerFromGammaMarket(m)).toBe('Up');
  });
});

describe('getResolvedUpDownWinnerFromGammaMarket', () => {
  it('Down gagnant quand outcomePrices suit ["Down","Up"]', () => {
    const m = {
      outcomes: '["Down","Up"]',
      outcomePrices: '["0.999","0.001"]',
    };
    expect(getResolvedUpDownWinnerFromGammaMarket(m)).toBe('Down');
  });

  it('Up gagnant quand outcomePrices suit ["Down","Up"]', () => {
    const m = {
      outcomes: '["Down","Up"]',
      outcomePrices: '["0.02","0.98"]',
    };
    expect(getResolvedUpDownWinnerFromGammaMarket(m)).toBe('Up');
  });

  it('repli [0]=Up [1]=Down si pas d’outcomes', () => {
    const m = { outcomePrices: '["0.99","0.01"]' };
    expect(getResolvedUpDownWinnerFromGammaMarket(m)).toBe('Up');
  });
});

describe('getUpDownOutcomeIndices', () => {
  it('lit tokens[].outcome si outcomes absent', () => {
    const m = {
      tokens: [{ outcome: 'Down', token_id: 'd' }, { outcome: 'Up', token_id: 'u' }],
    };
    expect(getUpDownOutcomeIndices(m)).toEqual({ idxUp: 1, idxDown: 0 });
  });
});

describe('mergeGammaEventMarketForUpDown', () => {
  it('recopie outcomes depuis l’event si absent du market (winner cohérent)', () => {
    const ev = { outcomes: '["Down","Up"]' };
    const m = { outcomePrices: '["0.999","0.001"]' };
    const mm = mergeGammaEventMarketForUpDown(ev, m);
    expect(getResolvedUpDownWinnerFromGammaMarket(mm)).toBe('Down');
  });
});
