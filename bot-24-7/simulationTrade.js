/**
 * Mode simulation (paper) : solde USDC virtuel, pas d’ordre CLOB réel.
 * Activé par SIMULATION_TRADE_ENABLED=true — voir .env.example.
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const PAPER_FILE = 'simulation-paper.json';

export function isSimulationTradeEnabled() {
  return process.env.SIMULATION_TRADE_ENABLED === 'true';
}

export function getSimulationStartUsd() {
  const n = Number(process.env.SIMULATION_START_USD);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function paperPath(botDir) {
  return path.join(botDir, PAPER_FILE);
}

export function readPaperState(botDir) {
  try {
    const raw = fs.readFileSync(paperPath(botDir), 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch {
    return null;
  }
}

export function writePaperState(botDir, state) {
  const p = paperPath(botDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

export function getPaperBalanceUsd(botDir) {
  const st = readPaperState(botDir);
  if (st && Number.isFinite(Number(st.balanceUsd))) return Number(st.balanceUsd);
  return getSimulationStartUsd();
}

/** Crée simulation-paper.json au premier lancement du mode paper. */
export function initPaperBalanceIfNeeded(botDir) {
  if (!isSimulationTradeEnabled()) return;
  try {
    if (fs.existsSync(paperPath(botDir))) return;
    writePaperState(botDir, {
      balanceUsd: getSimulationStartUsd(),
      paperRedeemedCids: [],
      updatedAt: new Date().toISOString(),
    });
    console.log(`[PAPER] Fichier ${PAPER_FILE} créé — solde initial ${getSimulationStartUsd()} USDC (aucun ordre réel).`);
  } catch (e) {
    console.warn('[PAPER] init impossible:', e?.message || e);
  }
}

export function adjustPaperBalance(botDir, deltaUsd) {
  const cur = getPaperBalanceUsd(botDir);
  const next = Math.max(0, cur + Number(deltaUsd));
  const st = readPaperState(botDir) || {};
  st.balanceUsd = Math.round(next * 1e6) / 1e6;
  st.updatedAt = new Date().toISOString();
  if (!Array.isArray(st.paperRedeemedCids)) st.paperRedeemedCids = [];
  writePaperState(botDir, st);
  return st.balanceUsd;
}

export function isPaperRedeemed(botDir, cid) {
  const st = readPaperState(botDir);
  const arr = Array.isArray(st?.paperRedeemedCids) ? st.paperRedeemedCids : [];
  return arr.includes(String(cid).trim());
}

export function markPaperRedeemed(botDir, cid) {
  const k = String(cid).trim();
  const st = readPaperState(botDir) || { balanceUsd: getSimulationStartUsd(), paperRedeemedCids: [] };
  if (!Array.isArray(st.paperRedeemedCids)) st.paperRedeemedCids = [];
  if (!st.paperRedeemedCids.includes(k)) st.paperRedeemedCids.push(k);
  st.updatedAt = new Date().toISOString();
  writePaperState(botDir, st);
}

export function buildSimulatedBuyFill({ amountUsd, bestAskP, conditionId }) {
  const ask = Number(bestAskP);
  const usd = Number(amountUsd);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return { ok: false, error: 'best ask invalide pour PAPER' };
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, error: 'montant invalide' };
  const filledUsdc = Math.round(usd * 100) / 100;
  // v9.3.1 : Déduction des frais Polymarket réels (Maker Order = 0%)
  const netUsdc = filledUsdc;
  const filledOutcomeTokens = netUsdc / ask;
  return {
    ok: true,
    orderID: `sim-${Date.now()}-${String(conditionId || '').slice(0, 10)}`,
    filledUsdc,
    filledOutcomeTokens,
    averageFillPriceP: ask,
    fillRatio: 1,
    clobStatus: 'simulated',
    clobSuccess: true,
    preSignCacheHit: false,
    partialFillRetries: 0,
    simulationTrade: true,
  };
}

export async function fetchGammaMarketForCondition(conditionId) {
  const id = encodeURIComponent(String(conditionId).trim());
  const url = `https://gamma-api.polymarket.com/markets?condition_ids=${id}&limit=1`;
  const { data } = await axios.get(url, { 
    timeout: 15000, 
    headers: { Accept: 'application/json' },
    httpsAgent: null // v34.3: Direct connection to Gamma
  });
  return Array.isArray(data) ? data[0] : data?.[0] ?? null;
}

/** @returns {Promise<'Up'|'Down'|null>} */
export async function fetchGammaWinnerForCondition(conditionId) {
  const m = await fetchGammaMarketForCondition(conditionId);
  return winnerFromGammaMarket(m);
}

/** @param {any} m */
export function winnerFromGammaMarket(m) {
  if (!m) return null;
  const op = m.outcomePrices;
  if (typeof op === 'string') {
    try {
      const arr = JSON.parse(op);
      if (Array.isArray(arr) && arr.length >= 2) {
        const up = parseFloat(arr[0]);
        const down = parseFloat(arr[1]);
        if (up >= 0.98) return 'Up';
        if (down >= 0.98) return 'Down';
      }
    } catch {
      /* ignore */
    }
  }
  const outcomes = m.outcomes;
  if (typeof outcomes === 'string') {
    try {
      const names = JSON.parse(outcomes);
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(names) && Array.isArray(prices) && names.length === prices.length) {
        let hi = -1;
        let idx = 0;
        for (let i = 0; i < prices.length; i++) {
          const p = parseFloat(prices[i]);
          if (p > hi) {
            hi = p;
            idx = i;
          }
        }
        if (hi >= 0.95 && names[idx]) {
          const n = String(names[idx]).toLowerCase();
          if (n.includes('up')) return 'Up';
          if (n.includes('down')) return 'Down';
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function isGammaMarketClosed(m) {
  return m && (m.closed === true || m.closed === 'true');
}

export function ordersLogLastEntryForCondition(ordersLogPath, conditionId) {
  const k = String(conditionId).trim();
  let last = null;
  try {
    const raw = fs.readFileSync(ordersLogPath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        const cid = String(o?.conditionId ?? o?.condition_id ?? '').trim();
        if (cid === k) last = o;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return last;
}

export function conditionHasSimulationTrade(ordersLogPath, conditionId) {
  const o = ordersLogLastEntryForCondition(ordersLogPath, conditionId);
  return o?.simulationTrade === true;
}
