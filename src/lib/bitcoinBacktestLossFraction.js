/**
 * Perte max simulée par créneau perdant = fraction du capital réinvesti (même défaut que
 * `VITE_BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT` dans useBitcoinUpDownResolved15m / bot).
 */
export function getBacktestMaxLossFractionOfStake() {
  const pct = Math.max(
    1,
    Math.min(100, Number(import.meta.env.VITE_BACKTEST_STOP_LOSS_MAX_DRAWDOWN_PCT) || 30),
  );
  return pct / 100;
}
