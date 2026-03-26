import { describe, it, expect } from 'vitest';
import { isInsufficientBalanceOrAllowance, resolveSellAmountFromSpendable } from './stopLossUtils.js';

describe('isInsufficientBalanceOrAllowance', () => {
  it('détecte les erreurs balance/allowance textuelles', () => {
    expect(isInsufficientBalanceOrAllowance('not enough balance / allowance')).toBe(true);
    expect(isInsufficientBalanceOrAllowance('insufficient funds for transfer')).toBe(true);
    expect(isInsufficientBalanceOrAllowance('size too large')).toBe(true);
  });

  it('ne détecte pas une erreur réseau non liée', () => {
    expect(isInsufficientBalanceOrAllowance('timeout ECONNRESET')).toBe(false);
  });
});

describe('resolveSellAmountFromSpendable', () => {
  it('retourne la quantité demandée si spendable indisponible', () => {
    expect(resolveSellAmountFromSpendable(10, null)).toBe(10);
  });

  it('cappe la vente au spendable avec buffer', () => {
    expect(resolveSellAmountFromSpendable(10, 7, 0.1)).toBe(6.9);
  });

  it('retourne null si rien de vendable après buffer', () => {
    expect(resolveSellAmountFromSpendable(10, 0.000005, 0.00001)).toBe(null);
  });
});
