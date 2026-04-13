/**
 * Usage: node analyze-sl-vs-resolution.mjs [orders.log path]
 * Analyse les SL (stopLossExit:true) depuis minuit fuseau Europe/Paris,
 * interroge Gamma pour le gagnant du marché et compare au takeSide.
 */
import fs from 'fs';
import https from 'https';

const TZ = 'Europe/Paris';
const ORDERS = process.argv[2] || '/home/ubuntu/bot-24-7/orders.log';

function formatInTz(utcMs, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(utcMs));
}

function getMidnightTodayMs(timeZone) {
  const ymd = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = ymd.split('-').map(Number);
  const lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const hi = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  for (let t = lo; t <= hi; t += 1000) {
    const s = formatInTz(t, timeZone);
    if (s.startsWith(`${ymd} 00:00:00`)) return t;
  }
  return null;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(new Error(String(e)));
          }
        });
      })
      .on('error', reject);
  });
}

/** Déduit Up | Down | null depuis outcomePrices / tokens Gamma. */
function winnerFromMarket(m) {
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
      const prices =
        typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
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

async function fetchWinner(conditionId) {
  const id = encodeURIComponent(conditionId);
  const url = `https://gamma-api.polymarket.com/markets?condition_ids=${id}&limit=1`;
  const data = await httpGetJson(url);
  const m = Array.isArray(data) ? data[0] : data?.[0];
  return { winner: winnerFromMarket(m), market: m };
}

const startMs = getMidnightTodayMs(TZ);
if (startMs == null) {
  console.error('Impossible de calculer minuit local');
  process.exit(1);
}

const raw = fs.readFileSync(ORDERS, 'utf8');
const lines = raw.split('\n').filter((x) => x.trim());

const slRows = [];
for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if (o.stopLossExit !== true) continue;
  const t = o.at ? new Date(o.at).getTime() : NaN;
  if (!Number.isFinite(t) || t < startMs) continue;
  slRows.push({
    at: o.at,
    conditionId: String(o.conditionId || ''),
    takeSide: o.takeSide,
    entryP: o.stopLossEntryPriceP,
    bidP: o.stopLossBestBidP,
    filledUsdc: o.filledUsdc,
  });
}

console.log('=== SL stopLossExit:true depuis minuit', TZ, '===');
console.log('Minuit local (approx UTC):', new Date(startMs).toISOString());
console.log('Nombre de lignes SL:', slRows.length);
console.log('');

const byCid = new Map();
for (const r of slRows) {
  if (!r.conditionId) continue;
  if (!byCid.has(r.conditionId)) byCid.set(r.conditionId, []);
  byCid.get(r.conditionId).push(r);
}

const results = [];
for (const [cid, rows] of byCid) {
  const first = rows.sort((a, b) => new Date(a.at) - new Date(b.at))[0];
  let winner = null;
  let err = null;
  try {
    const r = await fetchWinner(cid);
    winner = r.winner;
    if (!winner && r.market?.closed === false) err = 'marché non résolu / prix ambigus';
  } catch (e) {
    err = e.message;
  }
  const side = first.takeSide === 'Up' || first.takeSide === 'Down' ? first.takeSide : null;
  const wouldWinAtResolution = side && winner ? side === winner : null;
  results.push({
    conditionId: cid.slice(0, 18) + '…',
    takeSide: side,
    firstSlAt: first.at,
    winnerGamma: winner,
    wouldHaveWonIfHeld: wouldWinAtResolution,
    note: err,
  });
}

console.table(results);
const ok = results.filter((r) => r.wouldHaveWonIfHeld === true).length;
const bad = results.filter((r) => r.wouldHaveWonIfHeld === false).length;
const unk = results.filter((r) => r.wouldHaveWonIfHeld === null).length;
console.log('');
console.log('Résumé (marchés distincts avec au moins un SL aujourd’hui):');
console.log('  SL puis résolution favorable (tu avais le bon côté):', ok);
console.log('  SL puis résolution défavorable:', bad);
console.log('  Résolution inconnue / ambiguë:', unk);
