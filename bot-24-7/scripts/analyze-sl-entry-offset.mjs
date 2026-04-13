/**
 * Usage: node analyze-sl-entry-offset.mjs [orders.log path]
 * Pour chaque marché avec SL (stopLossExit:true) depuis minuit Europe/Paris :
 * - retrouve la première entrée (BUY) du même conditionId ;
 * - calcule les minutes écoulées entre le début du créneau 15m et l’entrée
 *   (début créneau = marketEndMs − 15 min, marketEndMs depuis le log SL ou l’entrée).
 * Compare la distribution selon que la résolution Gamma aurait été favorable ou non.
 */
import fs from 'fs';
import https from 'https';

const TZ = 'Europe/Paris';
const ORDERS = process.argv[2] || '/home/ubuntu/bot-24-7/orders.log';
const SLOT_MS = 15 * 60 * 1000;

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

function isBuyEntryLine(o) {
  if (o.stopLossExit === true) return false;
  if (o.event === 'resolution_redeem') return false;
  if (o.stopLossExitAttemptFailed === true) return false;
  const side = o.takeSide;
  if (side !== 'Up' && side !== 'Down') return false;
  if (o.amountUsd == null && o.orderID == null) return false;
  return true;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const startMs = getMidnightTodayMs(TZ);
if (startMs == null) {
  console.error('Impossible de calculer minuit local');
  process.exit(1);
}

const raw = fs.readFileSync(ORDERS, 'utf8');
const lines = raw.split('\n').filter((x) => x.trim());

/** @type {Map<string, { at: string, marketEndMs?: number }>} */
const firstEntryByCid = new Map();
for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const cid = String(o.conditionId || '').trim();
  if (!cid || !isBuyEntryLine(o)) continue;
  const t = o.at ? new Date(o.at).getTime() : NaN;
  if (!Number.isFinite(t)) continue;
  const prev = firstEntryByCid.get(cid);
  if (!prev || t < new Date(prev.at).getTime()) {
    firstEntryByCid.set(cid, {
      at: o.at,
      marketEndMs: typeof o.marketEndMs === 'number' ? o.marketEndMs : undefined,
    });
  }
}

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
    marketEndMs: typeof o.marketEndMs === 'number' ? o.marketEndMs : null,
  });
}

const byCid = new Map();
for (const r of slRows) {
  if (!r.conditionId) continue;
  if (!byCid.has(r.conditionId)) byCid.set(r.conditionId, []);
  byCid.get(r.conditionId).push(r);
}

const rows = [];
for (const [cid, slList] of byCid) {
  const firstSl = slList.sort((a, b) => new Date(a.at) - new Date(b.at))[0];
  const entry = firstEntryByCid.get(cid);
  const endMs = firstSl.marketEndMs ?? entry?.marketEndMs ?? null;
  if (endMs == null || !Number.isFinite(endMs)) {
    rows.push({
      conditionId: cid.slice(0, 14) + '…',
      takeSide: firstSl.takeSide,
      entryOffsetMin: null,
      wouldHaveWonIfHeld: null,
      note: 'pas de marketEndMs',
    });
    continue;
  }
  const slotStartMs = endMs - SLOT_MS;
  let entryOffsetMin = null;
  if (entry?.at) {
    const entryT = new Date(entry.at).getTime();
    entryOffsetMin = (entryT - slotStartMs) / 60_000;
  }

  let winner = null;
  let err = null;
  try {
    const r = await fetchWinner(cid);
    winner = r.winner;
    if (!winner && r.market?.closed === false) err = 'marché non résolu';
  } catch (e) {
    err = e.message;
  }
  const side =
    firstSl.takeSide === 'Up' || firstSl.takeSide === 'Down' ? firstSl.takeSide : null;
  const wouldWin = side && winner ? side === winner : null;

  rows.push({
    conditionId: cid.slice(0, 14) + '…',
    takeSide: side,
    entryOffsetMin,
    slotStartIso: new Date(slotStartMs).toISOString(),
    entryAt: entry?.at ?? null,
    wouldHaveWonIfHeld: wouldWin,
    winnerGamma: winner,
    note: err,
  });
}

console.log('=== Délai d’entrée après début créneau 15m (min) — SL depuis minuit', TZ, '===');
console.log('Minuit local (UTC):', new Date(startMs).toISOString());
console.log('');
console.table(
  rows.map((r) => ({
    cid: r.conditionId,
    side: r.takeSide,
    offsetMin: r.entryOffsetMin != null ? Math.round(r.entryOffsetMin * 10) / 10 : null,
    wouldWin: r.wouldHaveWonIfHeld,
    note: r.note || '',
  }))
);

const regret = rows.filter((r) => r.wouldHaveWonIfHeld === true && r.entryOffsetMin != null).map((r) => r.entryOffsetMin);
const noRegret = rows.filter((r) => r.wouldHaveWonIfHeld === false && r.entryOffsetMin != null).map((r) => r.entryOffsetMin);
const unk = rows.filter((r) => r.wouldHaveWonIfHeld === null);

function summarize(name, arr) {
  if (arr.length === 0) {
    console.log(`  ${name}: (vide)`);
    return;
  }
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log(`  ${name} (n=${arr.length}): moyenne ${mean.toFixed(2)} min | médiane ${percentile(s, 50).toFixed(2)} | P25 ${percentile(s, 25).toFixed(2)} | P75 ${percentile(s, 75).toFixed(2)} | min ${s[0].toFixed(2)} | max ${s[s.length - 1].toFixed(2)}`);
}

console.log('');
console.log('Distribution du délai d’entrée (minutes après début du quart d’heure) :');
summarize('SL puis résolution favorable (bon côté malgré SL)', regret);
summarize('SL puis résolution défavorable', noRegret);

if (regret.length > 0 && noRegret.length > 0) {
  const sr = [...regret].sort((a, b) => a - b);
  const sn = [...noRegret].sort((a, b) => a - b);
  const medR = percentile(sr, 50);
  const medN = percentile(sn, 50);
  console.log('');
  console.log('Lecture indicative (données du jour, corrélation ≠ causalité) :');
  const gapMin = 1.0; // min d’écart médian pour conclure (évite le bruit)
  if (medR + gapMin < medN) {
    console.log(
      `  Médiane délai d’entrée : « regret » ${medR.toFixed(1)} min vs « résolution défavorable » ${medN.toFixed(1)} min — les regrets sont plutôt des entrées plus tôt dans le créneau.`
    );
    console.log(
      `  Piste : allonger l’interdiction de début de créneau (ex. viser ≥ ${Math.ceil(medN)} min après le début) à valider sur backtest / plus d’historique.`
    );
  } else if (medR > medN + gapMin) {
    console.log(
      `  Médiane délai d’entrée : « regret » ${medR.toFixed(1)} min vs « résolution défavorable » ${medN.toFixed(1)} min — pas de signal « entrez plus tard » sur ce slice.`
    );
  } else {
    console.log(
      `  Médianes quasi identiques (regret ~${medR.toFixed(1)} min, défavorable ~${medN.toFixed(1)} min) : le nombre de minutes après le début du quart d’heure ne sépare pas les deux groupes ici.`
    );
    console.log(
      `  Un simple décalage d’entrée (sans autre changement) est peu probable pour « corriger » le problème SL vs résolution ; voir plutôt volatilité intra-15m, seuil SL ou backtest prix.`
    );
  }
} else if (regret.length > 0) {
  const s = [...regret].sort((a, b) => a - b);
  console.log('');
  console.log('Lecture indicative : médiane délai « regret »', percentile(s, 50).toFixed(2), 'min (pas assez de cas « défavorable » pour comparer).');
}
if (unk.length) {
  console.log('');
  console.log('Marchés avec résolution inconnue ou offset manquant:', unk.length);
}
