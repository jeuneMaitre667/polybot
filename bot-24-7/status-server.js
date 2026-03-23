/**
 * Petit serveur HTTP sur Lightsail : expose le statut PM2 et les derniers logs du bot.
 * Redéploiement : déclenché par push sur main (workflow Redeploy bot on Lightsail).
 * À lancer avec PM2 : pm2 start status-server.js --name bot-status-server
 * Ouvrir le port 3001 dans le pare-feu Lightsail (Réseau de l'instance).
 *
 * Variables d'env : BOT_STATUS_PORT=3001, BOT_STATUS_SECRET=optionnel (pour ?token=...)
 */
import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Même dossier que le bot (où se trouvent balance.json et last-order.json). */
const BOT_DIR = process.env.BOT_DIR || path.resolve(__dirname);

const PORT = Number(process.env.BOT_STATUS_PORT) || 3001;
const SECRET = process.env.BOT_STATUS_SECRET || '';
const includeActiveWindowLiquidity = process.env.INCLUDE_ACTIVE_WINDOW_LIQUIDITY === 'true';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getPm2List() {
  // Cache pour éviter que des échecs transitoires de `pm2 jlist` (timeout / charge CPU)
  // fassent passer brutalement le dashboard en `status:"error"` (offline côté UI).
  if (!getPm2List._cache) {
    getPm2List._cache = { at: 0, value: null };
  }

  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
    const list = JSON.parse(out);
    const bot = Array.isArray(list) ? list.find((p) => p.name === 'polymarket-bot') : null;
    const value = {
      status: bot?.pm2_env?.status === 'online' ? 'online' : 'offline',
      uptime: bot?.pm2_env?.pm_uptime ?? null,
      pid: bot?.pid ?? null,
    };
    getPm2List._cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    // Si l'appel à pm2 jlist échoue mais qu'on a déjà une valeur récente,
    // on la renvoie pour stabiliser l'UI (pas de "flicker" sur échec transitoire).
    const cached = getPm2List._cache?.value;
    if (cached) {
      return cached;
    }
    return { status: 'error', error: String(e.message) };
  }
}

function getLogs(lines = 40) {
  try {
    const out = execSync(`pm2 logs polymarket-bot --nostream --lines ${lines} 2>&1`, { encoding: 'utf8', timeout: 5000 });
    return String(out).trim();
  } catch (e) {
    return `Erreur logs: ${e.message}`;
  }
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getLastOrder() {
  return readJsonFile(path.join(BOT_DIR, 'last-order.json'));
}

function getBalanceFromFile() {
  const o = readJsonFile(path.join(BOT_DIR, 'balance.json'));
  return o && typeof o.balance === 'number' ? o.balance : null;
}

/** Lit balance-history.json (tableau { balance, at }[]) et retourne les N derniers points (7 jours max). */
function getBalanceHistory(maxPoints = 500) {
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'balance-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return arr.filter((p) => p && p.at && new Date(p.at).getTime() >= cutoff).slice(-maxPoints);
  } catch {
    return [];
  }
}

/**
 * Compte les ordres dans orders.log sur les 24 dernières heures + stats remplissage (fillRatio, compléments FAK).
 * Win rate : toujours sur toutes les lignes avec champ `won` (comportement historique).
 */
function getStats24h() {
  const ordersPath = path.join(BOT_DIR, 'orders.log');
  let ordersLast24h = 0;
  let won = 0;
  let totalWithResult = 0;
  let fillRatioCount = 0;
  let fillRatioSum = 0;
  let fillRatioMin = null;
  let fillRatioMax = null;
  let ordersWithPartialRetries = 0;
  let partialRetriesSum = 0;
  try {
    const raw = fs.readFileSync(ordersPath, 'utf8');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        const at = o.at ? new Date(o.at).getTime() : 0;
        if (at >= cutoff) {
          ordersLast24h++;
          const fr = o.fillRatio;
          if (fr != null && Number.isFinite(Number(fr))) {
            const n = Number(fr);
            fillRatioCount += 1;
            fillRatioSum += n;
            if (fillRatioMin == null || n < fillRatioMin) fillRatioMin = n;
            if (fillRatioMax == null || n > fillRatioMax) fillRatioMax = n;
          }
          const pr = Number(o.partialFillRetries);
          if (Number.isFinite(pr) && pr > 0) {
            ordersWithPartialRetries += 1;
            partialRetriesSum += pr;
          }
        }
        if (typeof o.won === 'boolean') {
          totalWithResult++;
          if (o.won) won++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  const winRate = totalWithResult > 0 ? Math.round((won / totalWithResult) * 1000) / 1000 : null;
  return {
    ordersLast24h,
    winRate,
    fillExecutionStats24h: {
      fillRatioCount,
      avgFillRatio:
        fillRatioCount > 0 ? Math.round((fillRatioSum / fillRatioCount) * 10000) / 10000 : null,
      minFillRatio: fillRatioMin != null ? Math.round(fillRatioMin * 10000) / 10000 : null,
      maxFillRatio: fillRatioMax != null ? Math.round(fillRatioMax * 10000) / 10000 : null,
      ordersWithPartialRetries,
      totalPartialRetryLegs: partialRetriesSum,
      avgPartialRetriesWhenUsed:
        ordersWithPartialRetries > 0
          ? Math.round((partialRetriesSum / ordersWithPartialRetries) * 100) / 100
          : null,
    },
  };
}

/** Lit health.json (écrit par le bot : WS, dernier ordre, geoblock, kill switch). */
function getHealth() {
  const o = readJsonFile(path.join(BOT_DIR, 'health.json'));
  if (!o || typeof o !== 'object') return null;
  return {
    wsConnected: !!o.wsConnected,
    wsLastChangeAt: o.wsLastChangeAt ?? null,
    wsLastConnectedAt: o.wsLastConnectedAt ?? null,
    wsLastBidAskAt: o.wsLastBidAskAt ?? null,
    lastOrderAt: o.lastOrderAt ?? null,
    lastOrderSource: o.lastOrderSource ?? null,
    geoblockOk: o.geoblockOk,
    killSwitchActive: !!o.killSwitchActive,
    polymarketDegraded: !!o.polymarketDegraded,
    degradedReason: o.degradedReason ?? null,
    degradedUntil: o.degradedUntil ?? null,
    staleWsData: !!o.staleWsData,
    staleWsDataAt: o.staleWsDataAt ?? null,
    executionDelayed: !!o.executionDelayed,
    executionDelayedAt: o.executionDelayedAt ?? null,
    lastSkipReason: o.lastSkipReason ?? null,
    lastSkipSource: o.lastSkipSource ?? null,
    lastSkipAt: o.lastSkipAt ?? null,
    lastSkipDetails: o.lastSkipDetails ?? null,
    at: o.at ?? null,
  };
}

const LIQUIDITY_SERIES_CAP = 800;

function emptyLiquidityStats() {
  return {
    avg: null,
    min: null,
    max: null,
    median: null,
    p95: null,
    lastUsd: null,
    count: 0,
    lastAt: null,
  };
}

/** Agrège des entrées { at, liquidityUsd, takeSide? } en stats scalaires. */
function summarizeLiquidityEntries(entries) {
  const empty = emptyLiquidityStats();
  const valid = entries.filter((e) => {
    const n = Number(e?.liquidityUsd);
    return e?.at && Number.isFinite(n) && n > 0;
  });
  if (valid.length === 0) return { ...empty };
  const values = valid.map((e) => Number(e.liquidityUsd));
  let lastEntry = null;
  for (const e of valid) {
    if (!lastEntry || e.at > lastEntry.at) lastEntry = e;
  }
  const lastAt = lastEntry?.at ?? null;
  const lastUsd = lastEntry != null ? Math.round(Number(lastEntry.liquidityUsd) * 100) / 100 : null;
  const sum = values.reduce((a, b) => a + b, 0);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
  const p95Idx = Math.max(0, Math.floor(0.95 * (sorted.length - 1)));
  const p95 = sorted[p95Idx];
  return {
    avg: Math.round((sum / values.length) * 100) / 100,
    min: Math.round(Math.min(...values) * 100) / 100,
    max: Math.round(Math.max(...values) * 100) / 100,
    median: Math.round(median * 100) / 100,
    p95: Math.round(p95 * 100) / 100,
    lastUsd,
    count: values.length,
    lastAt,
  };
}

function filterLiquidityByMs(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  return arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
}

function liquiditySeriesFromFiltered(filtered) {
  const valid = filtered.filter((e) => {
    const n = Number(e?.liquidityUsd);
    return e?.at && Number.isFinite(n) && n > 0;
  });
  valid.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const slice = valid.length > LIQUIDITY_SERIES_CAP ? valid.slice(-LIQUIDITY_SERIES_CAP) : valid;
  return slice.map((e) => ({
    at: e.at,
    liquidityUsd: Math.round(Number(e.liquidityUsd) * 100) / 100,
    takeSide: e.takeSide === 'Up' || e.takeSide === 'Down' ? e.takeSide : null,
    signalPriceP:
      Number.isFinite(Number(e?.signalPriceP)) && Number(e?.signalPriceP) > 0
        ? Math.round(Number(e.signalPriceP) * 1000000) / 1000000
        : null,
  }));
}

function liquidityBySignalFromFiltered(filtered) {
  const valid = filtered.filter((e) => {
    const n = Number(e?.liquidityUsd);
    const p = Number(e?.signalPriceP);
    return e?.at && Number.isFinite(n) && n > 0 && Number.isFinite(p) && p >= 0.96 && p <= 0.98;
  });
  const byBucket = new Map(); // key: 96.0..98.0 (0.1%)
  for (const e of valid) {
    const pPct = Number(e.signalPriceP) * 100;
    const bucketPct = Math.round(pPct * 10) / 10;
    const key = bucketPct.toFixed(1);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(e);
  }
  return Array.from(byBucket.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, entries]) => {
      const up = entries.filter((e) => e.takeSide === 'Up');
      const down = entries.filter((e) => e.takeSide === 'Down');
      return {
        signalLabel: `${key}%`,
        signalPct: Number(key),
        all: summarizeLiquidityEntries(entries),
        Up: summarizeLiquidityEntries(up),
        Down: summarizeLiquidityEntries(down),
      };
    });
}

function buildLiquidityWindow(filtered) {
  const valid = filtered.filter((e) => {
    const n = Number(e?.liquidityUsd);
    return e?.at && Number.isFinite(n) && n > 0;
  });
  const up = valid.filter((e) => e.takeSide === 'Up');
  const down = valid.filter((e) => e.takeSide === 'Down');
  return {
    all: summarizeLiquidityEntries(valid),
    Up: summarizeLiquidityEntries(up),
    Down: summarizeLiquidityEntries(down),
  };
}

/**
 * Rapport liquidité : fenêtres 24h / 3j, par côté, + séries pour graphique.
 * @returns {{ windows: { '24h': object, '72h': object }, series: { '24h': array, '72h': array }, bySignal: { '24h': array, '72h': array } }}
 */
function getLiquidityReport() {
  const emptyWin = { all: emptyLiquidityStats(), Up: emptyLiquidityStats(), Down: emptyLiquidityStats() };
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'liquidity-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      return {
        windows: { '24h': { ...emptyWin }, '72h': { ...emptyWin } },
        series: { '24h': [], '72h': [] },
        bySignal: { '24h': [], '72h': [] },
      };
    }
    const filteredSources = includeActiveWindowLiquidity
      ? arr
      : arr.filter((e) => String(e?.source || '').toLowerCase() !== 'active_window');
    const f24 = filterLiquidityByMs(filteredSources, 24 * 60 * 60 * 1000);
    const f72 = filterLiquidityByMs(filteredSources, 3 * 24 * 60 * 60 * 1000);
    // bySignal : toutes les sources dans la fenêtre (y compris active_window si signalPriceP),
    // sinon les seuls relevés avec niveau de signal sont exclus quand INCLUDE_ACTIVE_WINDOW_LIQUIDITY=false.
    const f24BySignal = filterLiquidityByMs(arr, 24 * 60 * 60 * 1000);
    const f72BySignal = filterLiquidityByMs(arr, 3 * 24 * 60 * 60 * 1000);
    return {
      windows: {
        '24h': buildLiquidityWindow(f24),
        '72h': buildLiquidityWindow(f72),
      },
      series: {
        '24h': liquiditySeriesFromFiltered(f24),
        '72h': liquiditySeriesFromFiltered(f72),
      },
      bySignal: {
        '24h': liquidityBySignalFromFiltered(f24BySignal),
        '72h': liquidityBySignalFromFiltered(f72BySignal),
      },
    };
  } catch {
    return {
      windows: { '24h': { ...emptyWin }, '72h': { ...emptyWin } },
      series: { '24h': [], '72h': [] },
      bySignal: { '24h': [], '72h': [] },
    };
  }
}

/** Rétrocompat : stats globales 3 j (tous relevés). */
function getLiquidityStats() {
  try {
    return getLiquidityReport().windows['72h'].all;
  } catch {
    return emptyLiquidityStats();
  }
}

function summarizeLatency(values, lastAt) {
  if (!values?.length) return { avgMs: null, p95Ms: null, count: 0, lastAt };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95 = sorted[Math.max(0, Math.floor(0.95 * (sorted.length - 1)))];
  return {
    avgMs: Math.round(sum / sorted.length),
    p95Ms: Math.round(p95),
    count: sorted.length,
    lastAt,
  };
}

/** Lit trade-latency-history.json et retourne stats globales + par source (ws/poll) sur les 24 dernières heures. */
function getTradeLatencyStats24h() {
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'trade-latency-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      return {
        all: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
        ws: { avgMs: null, p95Ms: null, count: 0, lastAt: null, lastLatencyMs: null, lastLatencyAt: null },
        poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null, lastLatencyMs: null, lastLatencyAt: null },
        preSignCacheHits: 0,
        preSignCacheTotal: 0,
        preSignCacheHitRate: null,
      };
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    const all = [];
    const ws = [];
    const poll = [];
    let preSignCacheHits = 0;
    let preSignCacheTotal = 0;
    let lastWsAtMs = null;
    let lastWsLatencyMs = null;
    let lastPollAtMs = null;
    let lastPollLatencyMs = null;
    for (const e of filtered) {
      const n = Number(e?.latencyMs);
      if (!Number.isFinite(n) || n <= 0) continue;
      all.push(n);
      const src = String(e?.source || '').toLowerCase();
      const atMs = e?.at ? new Date(e.at).getTime() : null;
      if (src === 'ws') {
        ws.push(n);
        if (Number.isFinite(atMs) && (lastWsAtMs == null || atMs > lastWsAtMs)) {
          lastWsAtMs = atMs;
          lastWsLatencyMs = n;
        }
      }
      if (src === 'poll') {
        poll.push(n);
        if (Number.isFinite(atMs) && (lastPollAtMs == null || atMs > lastPollAtMs)) {
          lastPollAtMs = atMs;
          lastPollLatencyMs = n;
        }
      }
      if (e && typeof e.preSignCacheHit === 'boolean') {
        preSignCacheTotal += 1;
        if (e.preSignCacheHit) preSignCacheHits += 1;
      }
    }
    return {
      all: summarizeLatency(all, lastAt),
      ws: {
        ...summarizeLatency(ws, lastAt),
        lastLatencyMs: lastWsLatencyMs,
        lastLatencyAt: lastWsAtMs != null ? new Date(lastWsAtMs).toISOString() : null,
      },
      poll: {
        ...summarizeLatency(poll, lastAt),
        lastLatencyMs: lastPollLatencyMs,
        lastLatencyAt: lastPollAtMs != null ? new Date(lastPollAtMs).toISOString() : null,
      },
      preSignCacheHits,
      preSignCacheTotal,
      preSignCacheHitRate: preSignCacheTotal > 0 ? Math.round((100 * preSignCacheHits) / preSignCacheTotal) : null,
    };
  } catch {
    return {
      all: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
      ws: { avgMs: null, p95Ms: null, count: 0, lastAt: null, lastLatencyMs: null, lastLatencyAt: null },
      poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null, lastLatencyMs: null, lastLatencyAt: null },
      preSignCacheHits: 0,
      preSignCacheTotal: 0,
      preSignCacheHitRate: null,
    };
  }
}

function summarizeTimingObjects(entries, getMs, lastAt) {
  const values = [];
  for (const e of entries) {
    const n = Number(getMs(e));
    if (Number.isFinite(n) && n >= 0) values.push(n);
  }
  return summarizeLatency(values.filter((n) => n > 0), lastAt);
}

/** Sous-mesures de latence trade (bestAsk/creds/balance/book/placeOrder) sur 24h, global + ws/poll. */
function getTradeLatencyBreakdownStats24h() {
  const empty = {
    all: { bestAsk: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, creds: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, balance: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, book: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, placeOrder: { avgMs: null, p95Ms: null, count: 0, lastAt: null } },
    ws: { bestAsk: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, creds: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, balance: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, book: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, placeOrder: { avgMs: null, p95Ms: null, count: 0, lastAt: null } },
    poll: { bestAsk: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, creds: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, balance: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, book: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, placeOrder: { avgMs: null, p95Ms: null, count: 0, lastAt: null } },
  };
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'trade-latency-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return empty;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    const ws = filtered.filter((e) => String(e?.source || '').toLowerCase() === 'ws');
    const poll = filtered.filter((e) => String(e?.source || '').toLowerCase() === 'poll');
    const mk = (entries) => ({
      bestAsk: summarizeTimingObjects(entries, (e) => e?.timingsMs?.bestAsk, lastAt),
      creds: summarizeTimingObjects(entries, (e) => e?.timingsMs?.creds, lastAt),
      balance: summarizeTimingObjects(entries, (e) => e?.timingsMs?.balance, lastAt),
      book: summarizeTimingObjects(entries, (e) => e?.timingsMs?.book, lastAt),
      placeOrder: summarizeTimingObjects(entries, (e) => e?.timingsMs?.placeOrder, lastAt),
    });
    return { all: mk(filtered), ws: mk(ws), poll: mk(poll) };
  } catch {
    return empty;
  }
}

function getCycleLatencyStats24h() {
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'cycle-latency-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return { avgMs: null, p95Ms: null, count: 0, lastAt: null };
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    const values = filtered.map((e) => Number(e.cycleMs)).filter((n) => Number.isFinite(n) && n > 0);
    return summarizeLatency(values, lastAt);
  } catch {
    return { avgMs: null, p95Ms: null, count: 0, lastAt: null };
  }
}

function getSignalDecisionLatencyStats24h() {
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'signal-decision-latency-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) {
      return {
        all: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
        poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
        byStrategy: {},
        reasonCounts: { no_signal: 0, liquidity_ok: 0, liquidity_null: 0, other: 0 },
      };
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    const all = [];
    const poll = [];
    const byStrategy = {};
    const reasonCounts = { no_signal: 0, liquidity_ok: 0, liquidity_null: 0, other: 0 };
    for (const e of filtered) {
      const n = Number(e?.decisionMs);
      if (!Number.isFinite(n) || n <= 0) continue;
      all.push(n);
      const src = String(e?.source || '').toLowerCase();
      if (src === 'poll') poll.push(n);
      const strategy = String(e?.fetchSignalsStrategy || '').trim() || 'unknown';
      if (!byStrategy[strategy]) byStrategy[strategy] = [];
      byStrategy[strategy].push(n);
      const reason = String(e?.reason || '').toLowerCase();
      if (reason === 'no_signal') reasonCounts.no_signal++;
      else if (reason === 'liquidity_ok') reasonCounts.liquidity_ok++;
      else if (reason === 'liquidity_null') reasonCounts.liquidity_null++;
      else reasonCounts.other++;
    }
    const byStrategySummary = {};
    for (const [strategy, values] of Object.entries(byStrategy)) {
      byStrategySummary[strategy] = summarizeLatency(values, lastAt);
    }
    return { all: summarizeLatency(all, lastAt), poll: summarizeLatency(poll, lastAt), byStrategy: byStrategySummary, reasonCounts };
  } catch {
    return {
      all: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
      poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null },
      byStrategy: {},
      reasonCounts: { no_signal: 0, liquidity_ok: 0, liquidity_null: 0, other: 0 },
    };
  }
}

/** Lit .env du bot (aligné sur index.js du bot). */
function getBotConfig() {
  const envPath = path.join(BOT_DIR, '.env');
  const defaults = {
    useMarketOrder: true,
    pollIntervalSec: 1,
    useWebSocket: true,
    marketMode: 'hourly',
    signalPriceSource: 'gamma',
  };
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    let useMarketOrder = true;
    let pollIntervalSec = 1;
    let useWebSocket = true;
    let marketModeRaw = 'hourly';
    let signalPriceSourceLine = '';
    for (const line of raw.split('\n')) {
      const t = line.replace(/#.*/, '').trim();
      if (t.startsWith('USE_MARKET_ORDER=')) {
        useMarketOrder = t.slice('USE_MARKET_ORDER='.length).trim().toLowerCase() !== 'false';
      }
      if (t.startsWith('POLL_INTERVAL_SEC=')) {
        const n = parseInt(t.slice('POLL_INTERVAL_SEC='.length).trim(), 10);
        if (Number.isFinite(n)) pollIntervalSec = n;
      }
      if (t.startsWith('USE_WEBSOCKET=')) {
        useWebSocket = t.slice('USE_WEBSOCKET='.length).trim().toLowerCase() !== 'false';
      }
      if (t.startsWith('MARKET_MODE=')) {
        marketModeRaw = t.slice('MARKET_MODE='.length).trim().toLowerCase() || 'hourly';
      }
      if (t.startsWith('SIGNAL_PRICE_SOURCE=')) {
        signalPriceSourceLine = t.slice('SIGNAL_PRICE_SOURCE='.length).trim().toLowerCase();
      }
    }
    const marketMode = marketModeRaw === '15m' ? '15m' : 'hourly';
    const signalPriceSource =
      signalPriceSourceLine === 'gamma' || signalPriceSourceLine === 'clob'
        ? signalPriceSourceLine
        : marketMode === '15m'
          ? 'clob'
          : 'gamma';
    return { useMarketOrder, pollIntervalSec, useWebSocket, marketMode, signalPriceSource };
  } catch {
    return { ...defaults };
  }
}

function getHealthAlerts(health, config) {
  const alerts = [];
  const now = Date.now();
  const wsAlertAfterSec = Number(process.env.WS_ALERT_AFTER_SEC) || 120;
  const staleWsAfterSec = Number(process.env.WS_STALE_ALERT_AFTER_SEC) || 8;
  if (config?.useWebSocket && health) {
    const lastChangeMs = health.wsLastChangeAt ? new Date(health.wsLastChangeAt).getTime() : null;
    if (health.wsConnected === false && lastChangeMs && Number.isFinite(lastChangeMs)) {
      const disconnectedForSec = Math.max(0, Math.floor((now - lastChangeMs) / 1000));
      if (disconnectedForSec >= wsAlertAfterSec) {
        alerts.push({ kind: 'ws_disconnected', severity: 'warn', disconnectedForSec, thresholdSec: wsAlertAfterSec });
      }
    }
    const lastBidAskMs = health.wsLastBidAskAt ? new Date(health.wsLastBidAskAt).getTime() : null;
    if (health.wsConnected === true && lastBidAskMs && Number.isFinite(lastBidAskMs)) {
      const staleForSec = Math.max(0, Math.floor((now - lastBidAskMs) / 1000));
      if (staleForSec >= staleWsAfterSec) {
        alerts.push({ kind: 'stale_ws_data', severity: 'warn', staleForSec, thresholdSec: staleWsAfterSec });
      }
    }
  }
  if (health?.killSwitchActive) {
    alerts.push({ kind: 'kill_switch', severity: 'error' });
  }
  if (health?.geoblockOk === false) {
    alerts.push({ kind: 'geoblock', severity: 'error' });
  }
  if (health?.polymarketDegraded) {
    alerts.push({
      kind: 'polymarket_degraded',
      severity: 'error',
      reason: health?.degradedReason ?? null,
      until: health?.degradedUntil ?? null,
    });
  }
  if (health?.staleWsData) {
    alerts.push({ kind: 'stale_ws_data', severity: 'warn', at: health?.staleWsDataAt ?? null });
  }
  if (health?.executionDelayed) {
    alerts.push({ kind: 'execution_delayed', severity: 'warn', at: health?.executionDelayedAt ?? null });
  }
  return alerts;
}

function getSignalInRangeNoOrderRecent(limit = 12) {
  const filePath = path.join(BOT_DIR, 'bot.log');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return [];
    const lines = raw.trim().split('\n').filter(Boolean);
    if (!lines.length) return [];
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row?.message !== 'signal_in_range_but_no_order') continue;
        out.push({
          ts: row?.ts ?? null,
          source: row?.source ?? null,
          reason: row?.reason ?? null,
          takeSide: row?.takeSide ?? null,
          bestAskP:
            Number.isFinite(Number(row?.bestAskP)) ? Math.round(Number(row.bestAskP) * 1e6) / 1e6 : null,
          conditionId: row?.conditionId ?? null,
          tokenId: row?.tokenId ?? null,
          remainingMs: Number.isFinite(Number(row?.remainingMs)) ? Math.round(Number(row.remainingMs)) : null,
          amountUsd: Number.isFinite(Number(row?.amountUsd)) ? Math.round(Number(row.amountUsd) * 100) / 100 : null,
          error: row?.error ?? null,
        });
      } catch (_) {}
    }
    return out;
  } catch {
    return [];
  }
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, { error: 'Method not allowed' }, 405);
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const debugRequested = url.searchParams.get('debug') === '1';
  if (SECRET && token !== SECRET) {
    json(res, { error: 'Unauthorized' }, 401);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/api/health') {
    return json(res, { ok: true, service: 'bot-status' });
  }

  if (url.pathname === '/api/bot-status') {
    const pm2 = getPm2List();
    const lastOrder = getLastOrder();
    const balanceUsd = getBalanceFromFile();
    const balanceHistory = getBalanceHistory();
    const config = getBotConfig();
    const stats = getStats24h();
    const liquidityReport = getLiquidityReport();
    const liquidityStats = liquidityReport.windows['72h'].all;
    const liquidityStats24h = liquidityReport.windows['24h'].all;
    const tradeLatencyStats = getTradeLatencyStats24h();
    const tradeLatencyBreakdownStats = getTradeLatencyBreakdownStats24h();
    const cycleLatencyStats = getCycleLatencyStats24h();
    const signalDecisionLatencyStats = getSignalDecisionLatencyStats24h();
    const signalInRangeNoOrderRecent = getSignalInRangeNoOrderRecent();
    const health = getHealth();
    const alerts = getHealthAlerts(health, config);
    const payload = {
      status: pm2.status,
      uptime: pm2.uptime,
      pid: pm2.pid,
      balanceUsd,
      lastOrder,
      balanceHistory,
      useMarketOrder: config.useMarketOrder,
      pollIntervalSec: config.pollIntervalSec,
      useWebSocket: config.useWebSocket,
      marketMode: config.marketMode,
      signalPriceSource: config.signalPriceSource,
      ordersLast24h: stats.ordersLast24h,
      winRate: stats.winRate,
      fillExecutionStats24h: stats.fillExecutionStats24h,
      health,
      alerts,
      liquidityStats,
      liquidityStats24h,
      liquidityReport,
      tradeLatencyStats,
      tradeLatencyBreakdownStats,
      cycleLatencyStats,
      signalDecisionLatencyStats,
      signalInRangeNoOrderRecent,
      at: new Date().toISOString(),
    };
    if (debugRequested) {
      const balancePath = path.join(BOT_DIR, 'balance.json');
      const lastOrderPath = path.join(BOT_DIR, 'last-order.json');
      const liquidityPath = path.join(BOT_DIR, 'liquidity-history.json');
      payload._debug = {
        balanceFileExists: fs.existsSync(balancePath),
        lastOrderFileExists: fs.existsSync(lastOrderPath),
        liquidityHistoryFileExists: fs.existsSync(liquidityPath),
        healthFileExists: fs.existsSync(path.join(BOT_DIR, 'health.json')),
        tradeLatencyHistoryFileExists: fs.existsSync(path.join(BOT_DIR, 'trade-latency-history.json')),
        cycleLatencyHistoryFileExists: fs.existsSync(path.join(BOT_DIR, 'cycle-latency-history.json')),
        signalDecisionLatencyHistoryFileExists: fs.existsSync(path.join(BOT_DIR, 'signal-decision-latency-history.json')),
        botDir: BOT_DIR,
      };
    }
    return json(res, payload);
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot status server: http://0.0.0.0:${PORT}`);
});
