export function isInsufficientBalanceOrAllowance(errLike) {
  const msg = String(errLike?.message || errLike || '').toLowerCase();
  const status = Number(errLike?.response?.status ?? errLike?.status);
  if (status !== 400 && status !== 422 && !msg) return false;
  return /not enough balance|insufficient balance|allowance|insufficient funds|size too large/.test(msg);
}

export function resolveSellAmountFromSpendable(requestedTokens, spendableTokens, bufferTokens = 0.00001) {
  const requested = Number(requestedTokens);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const spendable = Number(spendableTokens);
  if (!Number.isFinite(spendable) || spendable <= 0) return requested;
  const safeSpendable = Math.max(0, spendable - Math.max(0, Number(bufferTokens) || 0));
  if (safeSpendable <= 0) return null;
  return Math.min(requested, safeSpendable);
}
