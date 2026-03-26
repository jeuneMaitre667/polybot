import { describe, it, expect } from 'vitest';
import { liquidityUsdFromAsks, ORDER_BOOK_SIGNAL_MIN_P, ORDER_BOOK_SIGNAL_MAX_P } from './orderBookLiquidity.js';

describe('liquidityUsdFromAsks', () => {
  it('retourne 0 si asks non tableau', () => {
    expect(liquidityUsdFromAsks(null)).toBe(0);
    expect(liquidityUsdFromAsks(undefined)).toBe(0);
    expect(liquidityUsdFromAsks({})).toBe(0);
  });

  it('retourne 0 pour tableau vide', () => {
    expect(liquidityUsdFromAsks([])).toBe(0);
  });

  it('somme prix×taille pour objets { price, size } dans la bande', () => {
    const asks = [
      { price: '0.96', size: '100' },
      { price: '0.97', size: '10' },
      { price: '0.975', size: '20' },
      { price: '0.98', size: '50' },
    ];
    // Bande défaut 95–96¢ : inclut 0,96 → 0.96*100 = 96
    expect(liquidityUsdFromAsks(asks)).toBe(96);
  });

  it('accepte tuples [price, size]', () => {
    const asks = [
      [0.97, 100],
      [0.98, 200],
    ];
    // Bande défaut 95–96¢ : rien dans la bande
    expect(liquidityUsdFromAsks(asks)).toBe(0);
  });

  it('respecte min/max personnalisés', () => {
    const asks = [{ price: 0.5, size: 1000 }];
    expect(liquidityUsdFromAsks(asks, 0.4, 0.6)).toBe(500);
  });

  it('expose les constantes de bande signal', () => {
    expect(ORDER_BOOK_SIGNAL_MIN_P).toBe(0.95);
    expect(ORDER_BOOK_SIGNAL_MAX_P).toBe(0.96);
  });
});
