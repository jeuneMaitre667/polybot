/**
 * Génère `public/data/btc-15m-cache.json` pour le backtest 15m (évite des centaines d’appels API dans le navigateur).
 * Usage : `npm run cache:15m`
 * 30 j : `BACKTEST_WINDOW_HOURS=720` (défaut).
 * Bande + seuil SL (détection historique) : ex. `BACKTEST_SIGNAL_MIN_C=77 BACKTEST_SIGNAL_MAX_C=78 BACKTEST_SL_C=60`
 * PnL agrégé (dashboard / `simulateReinvestMaxStake`) : perte SL = fraction du stake — `SL_FIXED_LOSS_FRAC` (défaut 0,25), indépendante du prix de sortie.
 * Optionnel : `BACKTEST_15M_CACHE_DEBUG=1`
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from '../src/lib/bitcoin15mResolvedDataFetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const windowHours = Number(process.env.BACKTEST_WINDOW_HOURS || 720);
const minC = Number(process.env.BACKTEST_SIGNAL_MIN_C);
const maxC = Number(process.env.BACKTEST_SIGNAL_MAX_C);
const slC = Number(process.env.BACKTEST_SL_C);
const slFixedLossFracRaw = Number(process.env.SL_FIXED_LOSS_FRAC ?? 0.25);
const slFixedLossFractionForPnl =
  Number.isFinite(slFixedLossFracRaw) && slFixedLossFracRaw > 0 && slFixedLossFracRaw <= 1
    ? slFixedLossFracRaw
    : 0.25;

const simCfg = resolve15mSimConfig({
  simConfig: {
    ...(Number.isFinite(minC) && minC >= 50 && minC <= 99
      ? { detectMinP: minC / 100, entryMinP: minC / 100 }
      : {}),
    ...(Number.isFinite(maxC) && maxC >= 50 && maxC <= 99 ? { entryMaxP: maxC / 100 } : {}),
    ...(Number.isFinite(slC) && slC >= 50 && slC <= 95 ? { stopLossTriggerPriceP: slC / 100 } : {}),
  },
});
const debug = process.env.BACKTEST_15M_CACHE_DEBUG === '1' || process.env.BACKTEST_15M_CACHE_DEBUG === 'true';

console.info(
  `[cache:15m] windowHours=${windowHours} debug=${debug} simCfg=${JSON.stringify(simCfg)} slFixedLossFractionForPnl=${slFixedLossFractionForPnl}`,
);

const { enrichedFinal, debugSummary } = await fetchBitcoin15mResolvedData(windowHours, simCfg, debug);
const out = {
  generatedAt: new Date().toISOString(),
  windowHours,
  simConfig: {
    signalMinC: Number.isFinite(minC) && minC >= 50 ? minC : null,
    signalMaxC: Number.isFinite(maxC) && maxC >= 50 ? maxC : null,
    slC: Number.isFinite(slC) && slC >= 50 ? slC : null,
  },
  /**
   * Aligné dashboard (`VITE_BACKTEST_SL_FIXED_LOSS_FRAC`) et `recalc` : au PnL, chaque SL = −fraction × stake − frais.
   * `simConfig.slC` sert uniquement à la détection SL sur les séries ; les lignes n’incluent pas le PnL simulé.
   */
  pnlModel: {
    slFixedLossFractionForPnl: slFixedLossFractionForPnl,
  },
  rows: enrichedFinal,
  ...(debug && debugSummary ? { debugSummary } : {}),
};
const dir = join(__dirname, '..', 'public', 'data');
await mkdir(dir, { recursive: true });
const outPath = join(dir, 'btc-15m-cache.json');
await writeFile(outPath, JSON.stringify(out), 'utf8');
console.info(`[cache:15m] écrit ${outPath} (${out.rows.length} lignes)`);
