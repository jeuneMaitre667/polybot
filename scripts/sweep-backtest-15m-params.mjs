/**
 * Balayage de grille sur les paramètres du backtest 15m (signal min/max, SL, minutes interdites début/fin).
 *
 * **Une seule passe réseau** : `fetchBitcoin15mPreSimRows` (Gamma + CLOB + trades), puis pour chaque
 * combinaison `applySimConfigToPreSimRows` + PnL (CPU uniquement).
 *
 * ---
 * Paramétrer les combinaisons (grille = produit cartésien des listes) :
 *
 * Chaque variable est une liste de nombres séparés par des **virgules** (sans espaces ou avec).
 *
 *   SWEEP_SIGNAL_MIN_C     signal minimum, en **centimes** (ex. 77,78)
 *   SWEEP_SIGNAL_MAX_C     signal maximum, en **centimes** (ex. 78,79)
 *   SWEEP_SL_C             stop-loss déclenché, en **centimes** (ex. 58,60)
 *   SWEEP_FORBID_FIRST_MIN  première(s) minute(s) du quart **interdites** pour l’entrée, 0–14 (ex. 0,6)
 *   SWEEP_FORBID_LAST_MIN   dernière(s) minute(s) du quart interdites, 0–14 (ex. 0,4)
 *
 * Exemples :
 *   Un seul cas : SWEEP_SIGNAL_MIN_C=77 SWEEP_SIGNAL_MAX_C=78 SWEEP_SL_C=60 SWEEP_FORBID_FIRST_MIN=6 SWEEP_FORBID_LAST_MIN=4
 *   Petite grille : lists avec 2–3 valeurs chacune → 2³ à 3⁵ combinaisons possibles
 *
 * Autres :
 *   BACKTEST_WINDOW_HOURS  défaut 72 (SWEEP_ALLOW_WIDE=1 au-delà de 168 h)
 *   INITIAL_BALANCE_EUR, MAX_STAKE_EUR
 *   SWEEP_MIN_TRADES       minimum de trades pour le classement « top » (défaut 8)
 *   SWEEP_MAX_COMBOS       plafond sécurité sur le nombre de combinaisons (défaut 500)
 *   SWEEP_OUT              fichier JSON de sortie (défaut scripts/output/sweep-15m-*.json)
 *   SWEEP_RANK_BY          `pnl` (défaut) = meilleur PnL net d’abord ; `winRate` = trier comme avant (WR puis PnL)
 *
 * Usage :
 *   npm run sweep:15m
 *   npx vite-node --config vite.config.js scripts/sweep-backtest-15m-params.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySimConfigToPreSimRows,
  fetchBitcoin15mPreSimRows,
} from '../src/lib/bitcoin15mResolvedDataFetch.js';
import { simulateReinvestMaxStake } from '../src/lib/bitcoin15mReinvestBacktest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseNumList(envKey, fallbackCsv) {
  const raw = process.env[envKey] ?? fallbackCsv;
  return String(raw)
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n));
}

let windowHours = Number(process.env.BACKTEST_WINDOW_HOURS);
if (!Number.isFinite(windowHours) || windowHours <= 0) windowHours = 72;
if (windowHours > 168 && process.env.SWEEP_ALLOW_WIDE !== '1') {
  console.warn(`[sweep-15m] BACKTEST_WINDOW_HOURS=${windowHours} plafonné à 168 (SWEEP_ALLOW_WIDE=1 pour forcer).`);
  windowHours = 168;
}

const initialBalance = Number(process.env.INITIAL_BALANCE_EUR || 20);
const maxStakeEur = Number(process.env.MAX_STAKE_EUR || 500);
const minTradesFilter = Math.max(0, Number(process.env.SWEEP_MIN_TRADES || 8));
const maxCombos = Math.max(1, Number(process.env.SWEEP_MAX_COMBOS || 500));

const mins = parseNumList('SWEEP_SIGNAL_MIN_C', '77,78');
const maxs = parseNumList('SWEEP_SIGNAL_MAX_C', '78,79');
const sls = parseNumList('SWEEP_SL_C', '58,60');
const forbidFirst = parseNumList('SWEEP_FORBID_FIRST_MIN', '0,6');
const forbidLast = parseNumList('SWEEP_FORBID_LAST_MIN', '0,4');

/** @type {Array<{ minC: number, maxC: number, slC: number, f1: number, f2: number }>} */
const combos = [];
for (const minC of mins) {
  for (const maxC of maxs) {
    for (const slC of sls) {
      for (const f1 of forbidFirst) {
        for (const f2 of forbidLast) {
          if (minC < 50 || minC > 99 || maxC < 50 || maxC > 99) continue;
          if (slC < 50 || slC > 95) continue;
          if (minC > maxC) continue;
          if (f1 < 0 || f1 > 14 || f2 < 0 || f2 > 14) continue;
          combos.push({ minC, maxC, slC, f1, f2 });
        }
      }
    }
  }
}

if (combos.length > maxCombos) {
  console.error(
    `[sweep-15m] Trop de combinaisons (${combos.length}) > SWEEP_MAX_COMBOS=${maxCombos}. Réduisez les listes ou augmentez SWEEP_MAX_COMBOS.`,
  );
  process.exit(1);
}

const outPath =
  process.env.SWEEP_OUT ||
  join(__dirname, 'output', `sweep-15m-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const rankByRaw = String(process.env.SWEEP_RANK_BY || 'pnl').toLowerCase();
const rankByWinRateFirst = rankByRaw === 'winrate' || rankByRaw === 'wr';

console.info(`[sweep-15m] Fenêtre ${windowHours} h · ${combos.length} combinaison(s) · min trades affichés ≥ ${minTradesFilter}`);
console.info(
  `[sweep-15m] Classement : ${rankByWinRateFirst ? 'WR puis PnL' : 'PnL puis WR'} (SWEEP_RANK_BY=${rankByWinRateFirst ? 'winRate' : 'pnl'})`,
);
console.info(`[sweep-15m] Capital ${initialBalance} € · plafond mise ${maxStakeEur} €`);
console.info('[sweep-15m] Téléchargement unique (Gamma + CLOB + trades)…');

const tFetch0 = Date.now();
const pack = await fetchBitcoin15mPreSimRows(windowHours);
const fetchSec = ((Date.now() - tFetch0) / 1000).toFixed(1);
console.info(
  `[sweep-15m] Pré-sim OK en ${fetchSec}s · ${pack.preSimRows.length} créneaux (stats: ${pack.stats.rowsAfter15mSlotDedupe} lignes après dédup slot)`,
);

function rawSimConfigFromCombo({ minC, maxC, slC, f1, f2 }) {
  return {
    detectMinP: minC / 100,
    entryMinP: minC / 100,
    entryMaxP: maxC / 100,
    stopLossTriggerPriceP: slC / 100,
    entryForbiddenFirstMin: f1,
    entryForbiddenLastMin: f2,
  };
}

const results = [];
let idx = 0;
let simMsTotal = 0;
for (const combo of combos) {
  idx += 1;
  const simCfg = rawSimConfigFromCombo(combo);
  const { minC, maxC, slC, f1, f2 } = combo;

  const label = `${minC}–${maxC}¢ · SL ${slC}¢ · interdit ${f1}/${f2} min`;
  const t0 = Date.now();
  const { enrichedFinal } = applySimConfigToPreSimRows(pack.preSimRows, simCfg, false, pack.windowHours, pack.stats, {
    quiet: true,
  });
  simMsTotal += Date.now() - t0;

  const withSignal = enrichedFinal.filter((r) => r.botWouldTake != null);
  const withSimul = withSignal.filter((r) => r.winner === 'Up' || r.winner === 'Down');
  const sorted = [...withSimul].sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  const sim = simulateReinvestMaxStake(sorted, {
    initialBalance,
    maxStakeEur,
    backtestSlC: slC,
    includeFees: true,
    liveStopLossConditionId: null,
  });

  if (idx === 1 || idx === combos.length || combos.length <= 5) {
    console.info(`[sweep-15m] (${idx}/${combos.length}) ${label} · lignes ${enrichedFinal.length} · trades ${sim.trades}`);
  } else if (idx === 2) {
    console.info(`[sweep-15m] … (${combos.length - 2} combinaisons intermédiaires sans log détaillé) …`);
  }

  results.push({
    signalMinC: minC,
    signalMaxC: maxC,
    slC,
    forbidFirstMin: f1,
    forbidLastMin: f2,
    resolved: { totalRows: enrichedFinal.length, tradeRows: sorted.length },
    ...pickMetrics(sim),
  });
}

function pickMetrics(sim) {
  return {
    trades: sim.trades,
    winRateNetPct: sim.winRateNetPct,
    winRateResolutionPct: sim.winRateResolutionPct,
    pnl: sim.pnl,
    capital: sim.capital,
    slCount: sim.slCount,
    resolutionLossNoSl: sim.resolutionLossNoSl,
    maxDrawdown: sim.maxDrawdown,
    feesPaid: sim.feesPaid,
  };
}

function compareSweepRows(a, b) {
  const wrA = a.winRateNetPct ?? -1;
  const wrB = b.winRateNetPct ?? -1;
  if (rankByWinRateFirst) {
    if (wrB !== wrA) return wrB - wrA;
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    return b.trades - a.trades;
  }
  /** Par défaut : PnL net décroissant (rentabilité), puis WR, puis nombre de trades. */
  if (b.pnl !== a.pnl) return b.pnl - a.pnl;
  if (wrB !== wrA) return wrB - wrA;
  return b.trades - a.trades;
}

const ranked = [...results].filter((r) => r.trades >= minTradesFilter).sort(compareSweepRows);

const payload = {
  generatedAt: new Date().toISOString(),
  windowHours,
  fetchSeconds: Number(fetchSec),
  simTotalSeconds: Math.round((simMsTotal / 1000) * 100) / 100,
  preSimRows: pack.preSimRows.length,
  initialBalance,
  maxStakeEur,
  minTradesFilter,
  rankBy: rankByWinRateFirst ? 'winRate' : 'pnl',
  grids: { mins, maxs, sls, forbidFirst, forbidLast },
  topRanked: ranked.slice(0, 30),
  all: results,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

console.info('');
console.info(
  `[sweep-15m] Simu locale cumulée : ${(simMsTotal / 1000).toFixed(2)}s pour ${combos.length} combinaison(s)`,
);
console.info(`[sweep-15m] Terminé. Résultats : ${outPath}`);
const bestLabel = rankByWinRateFirst ? 'Meilleur WR net' : 'Meilleur PnL net';
console.info(`[sweep-15m] ${bestLabel} (≥${minTradesFilter} trades) :`);
if (ranked[0]) {
  const x = ranked[0];
  console.info(
    `  ${x.signalMinC}–${x.signalMaxC}¢ · SL ${x.slC}¢ · interdit ${x.forbidFirstMin}/${x.forbidLastMin} min → PnL ${x.pnl.toFixed(2)} € · WR ${x.winRateNetPct}% (${x.trades} trades)`,
  );
} else {
  console.info('  (aucune combinaison ne dépasse le seuil de trades — baissez SWEEP_MIN_TRADES)');
}
