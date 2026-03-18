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
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
    const list = JSON.parse(out);
    const bot = Array.isArray(list) ? list.find((p) => p.name === 'polymarket-bot') : null;
    return {
      status: bot?.pm2_env?.status === 'online' ? 'online' : 'offline',
      uptime: bot?.pm2_env?.pm_uptime ?? null,
      pid: bot?.pid ?? null,
    };
  } catch (e) {
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

/** Compte les ordres dans orders.log sur les 24 dernières heures. Win rate = null (non calculé côté serveur pour l’instant). */
function getStats24h() {
  const ordersPath = path.join(BOT_DIR, 'orders.log');
  let ordersLast24h = 0;
  let won = 0;
  let totalWithResult = 0;
  try {
    const raw = fs.readFileSync(ordersPath, 'utf8');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        const at = o.at ? new Date(o.at).getTime() : 0;
        if (at >= cutoff) ordersLast24h++;
        if (typeof o.won === 'boolean') {
          totalWithResult++;
          if (o.won) won++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  const winRate = totalWithResult > 0 ? Math.round((won / totalWithResult) * 1000) / 1000 : null;
  return { ordersLast24h, winRate };
}

/** Lit health.json (écrit par le bot : WS, dernier ordre, geoblock, kill switch). */
function getHealth() {
  const o = readJsonFile(path.join(BOT_DIR, 'health.json'));
  if (!o || typeof o !== 'object') return null;
  return {
    wsConnected: !!o.wsConnected,
    lastOrderAt: o.lastOrderAt ?? null,
    lastOrderSource: o.lastOrderSource ?? null,
    geoblockOk: o.geoblockOk,
    killSwitchActive: !!o.killSwitchActive,
    at: o.at ?? null,
  };
}

/** Lit liquidity-history.json (relevés du bot) et retourne { avg, min, max, count, lastAt } sur les 3 derniers jours. lastAt = date ISO du dernier relevé (pour vérifier si le bot a récupéré des données en 1 h). */
function getLiquidityStats() {
  try {
    const raw = fs.readFileSync(path.join(BOT_DIR, 'liquidity-history.json'), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return { avg: null, min: null, max: null, count: 0, lastAt: null };
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const values = filtered
      .map((e) => Number(e.liquidityUsd))
      .filter((n) => Number.isFinite(n) && n > 0);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    if (values.length === 0) return { avg: null, min: null, max: null, count: 0, lastAt };
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      avg: Math.round((sum / values.length) * 100) / 100,
      min: Math.round(Math.min(...values) * 100) / 100,
      max: Math.round(Math.max(...values) * 100) / 100,
      count: values.length,
      lastAt,
    };
  } catch {
    return { avg: null, min: null, max: null, count: 0, lastAt: null };
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
      return { all: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, ws: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null } };
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = arr.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const lastAt = filtered.length > 0
      ? filtered.reduce((latest, e) => (e.at > latest ? e.at : latest), filtered[0].at)
      : null;
    const all = [];
    const ws = [];
    const poll = [];
    for (const e of filtered) {
      const n = Number(e?.latencyMs);
      if (!Number.isFinite(n) || n <= 0) continue;
      all.push(n);
      const src = String(e?.source || '').toLowerCase();
      if (src === 'ws') ws.push(n);
      if (src === 'poll') poll.push(n);
    }
    return {
      all: summarizeLatency(all, lastAt),
      ws: summarizeLatency(ws, lastAt),
      poll: summarizeLatency(poll, lastAt),
    };
  } catch {
    return { all: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, ws: { avgMs: null, p95Ms: null, count: 0, lastAt: null }, poll: { avgMs: null, p95Ms: null, count: 0, lastAt: null } };
  }
}

/** Lit .env du bot et retourne { useMarketOrder, pollIntervalSec }. */
function getBotConfig() {
  const envPath = path.join(BOT_DIR, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    let useMarketOrder = true;
    let pollIntervalSec = 1;
    for (const line of raw.split('\n')) {
      const t = line.replace(/#.*/, '').trim();
      if (t.startsWith('USE_MARKET_ORDER=')) {
        useMarketOrder = t.slice('USE_MARKET_ORDER='.length).trim().toLowerCase() !== 'false';
      }
      if (t.startsWith('POLL_INTERVAL_SEC=')) {
        const n = parseInt(t.slice('POLL_INTERVAL_SEC='.length).trim(), 10);
        if (Number.isFinite(n)) pollIntervalSec = n;
      }
    }
    return { useMarketOrder, pollIntervalSec };
  } catch {
    return { useMarketOrder: true, pollIntervalSec: 1 };
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
    const liquidityStats = getLiquidityStats();
    const tradeLatencyStats = getTradeLatencyStats24h();
    const payload = {
      status: pm2.status,
      uptime: pm2.uptime,
      pid: pm2.pid,
      balanceUsd,
      lastOrder,
      balanceHistory,
      useMarketOrder: config.useMarketOrder,
      pollIntervalSec: config.pollIntervalSec,
      ordersLast24h: stats.ordersLast24h,
      winRate: stats.winRate,
      liquidityStats,
      tradeLatencyStats,
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
