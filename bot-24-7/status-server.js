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

/** Lit .env du bot et retourne { useMarketOrder, pollIntervalSec }. */
function getBotConfig() {
  const envPath = path.join(BOT_DIR, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    let useMarketOrder = true;
    let pollIntervalSec = 3;
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
    return { useMarketOrder: true, pollIntervalSec: 3 };
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
      at: new Date().toISOString(),
    };
    if (debugRequested) {
      const balancePath = path.join(BOT_DIR, 'balance.json');
      const lastOrderPath = path.join(BOT_DIR, 'last-order.json');
      payload._debug = { balanceFileExists: fs.existsSync(balancePath), lastOrderFileExists: fs.existsSync(lastOrderPath), botDir: BOT_DIR };
    }
    return json(res, payload);
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot status server: http://0.0.0.0:${PORT}`);
});
