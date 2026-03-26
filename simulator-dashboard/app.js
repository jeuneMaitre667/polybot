function byId(id) { return document.getElementById(id); }
function n(v) { return Number(v); }
function pct(v) { return `${(v * 100).toFixed(2)}%`; }
function eur(v) { return `${v.toFixed(2)}€`; }

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNormal(rng) {
  const u1 = Math.max(1e-9, rng());
  const u2 = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function baseInputs() {
  const days = Math.max(1, Math.floor(n(byId('days').value) || 1));
  const tradesPerDay = Math.max(1, Math.floor(n(byId('tradesPerDay').value) || 1));
  return {
    startBalance: Math.max(1, n(byId('startBalance').value) || 100),
    maxStake: Math.max(1, n(byId('maxStake').value) || 100),
    days,
    tradesPerDay,
    totalTrades: days * tradesPerDay,
    entryC: Math.min(99, Math.max(1, n(byId('entryCents').value) || 95)),
    feeRate: Math.min(0.1, Math.max(0, (n(byId('feePct').value) || 0) / 100)),
    tpSlipC: Math.max(0, n(byId('tpSlipCents').value) || 0),
    slSlipC: Math.max(0, n(byId('slSlipCents').value) || 0),
    mcRuns: Math.max(100, Math.min(20000, Math.floor(n(byId('mcRuns').value) || 5000))),
    dailyWrVol: Math.max(0, (n(byId('dailyWrVolPctPoints').value) || 0) / 100),
    dailyWrFloor: Math.min(1, Math.max(0, (n(byId('dailyWrFloorPct').value) || 0) / 100)),
    dailyWrCap: Math.min(1, Math.max(0, (n(byId('dailyWrCapPct').value) || 100) / 100)),
    abnormalLossProb: Math.min(1, Math.max(0, (n(byId('abnormalLossProbPct').value) || 0) / 100)),
    abnormalSlExitC: Math.min(99, Math.max(0.1, n(byId('abnormalSlExitCents').value) || 60)),
    dailyTarget: Math.max(0, (n(byId('dailyTargetPct').value) || 0) / 100),
    dailyStop: Math.max(0, (n(byId('dailyStopPct').value) || 0) / 100),
  };
}

function strategyInputs() {
  const base = baseInputs();
  const s1 = {
    ...base,
    name: byId('s1Name').value.trim() || 'Base',
    winRate: Math.min(1, Math.max(0, (n(byId('winRatePct').value) || 0) / 100)),
    tpExitC: Math.min(99.99, Math.max(1, n(byId('tpExitCents').value) || 100)),
    slExitC: Math.min(99, Math.max(0.1, n(byId('slExitCents').value) || 72)),
  };
  const s2 = {
    ...base,
    name: byId('s2Name').value.trim() || 'Stratégie B',
    winRate: Math.min(1, Math.max(0, (n(byId('s2WinRatePct').value) || 0) / 100)),
    tpExitC: Math.min(99.99, Math.max(1, n(byId('s2TpExitCents').value) || 99)),
    slExitC: Math.min(99, Math.max(0.1, n(byId('s2SlExitCents').value) || 75)),
  };
  const s3 = {
    ...base,
    name: byId('s3Name').value.trim() || 'Stratégie C',
    winRate: Math.min(1, Math.max(0, (n(byId('s3WinRatePct').value) || 0) / 100)),
    tpExitC: Math.min(99.99, Math.max(1, n(byId('s3TpExitCents').value) || 100)),
    slExitC: Math.min(99, Math.max(0.1, n(byId('s3SlExitCents').value) || 68)),
  };
  return [s1, s2, s3];
}

function multipliers(cfg) {
  const entry = cfg.entryC / 100;
  const tpExit = Math.max(0.0001, (cfg.tpExitC - cfg.tpSlipC) / 100);
  const slExit = Math.max(0.0001, (cfg.slExitC - cfg.slSlipC) / 100);
  const abnormalExit = Math.max(0.0001, (cfg.abnormalSlExitC - cfg.slSlipC) / 100);
  return {
    winNet: tpExit / entry - 1 - cfg.feeRate,
    lossNet: slExit / entry - 1 - cfg.feeRate,
    abnormalLossNet: abnormalExit / entry - 1 - cfg.feeRate,
  };
}

function runScenario(cfg, rng, keepPath = false) {
  const m = multipliers(cfg);
  let bal = cfg.startBalance;
  let peak = bal;
  let maxDD = 0;
  let wins = 0;
  let losses = 0;
  let abnormalLosses = 0;
  let tradesDone = 0;
  const path = keepPath ? [bal] : null;

  for (let d = 0; d < cfg.days; d += 1) {
    const dayStart = bal;
    let dayWr = cfg.winRate + randomNormal(rng) * cfg.dailyWrVol;
    dayWr = Math.max(cfg.dailyWrFloor, Math.min(cfg.dailyWrCap, dayWr));
    for (let t = 0; t < cfg.tradesPerDay; t += 1) {
      if (cfg.dailyTarget > 0 && bal >= dayStart * (1 + cfg.dailyTarget)) break;
      if (cfg.dailyStop > 0 && bal <= dayStart * (1 - cfg.dailyStop)) break;
      const stake = Math.min(cfg.maxStake, bal);
      if (!(stake > 0)) break;
      const isWin = rng() < dayWr;
      if (isWin) {
        bal += stake * m.winNet;
        wins += 1;
      } else {
        const abnormal = rng() < cfg.abnormalLossProb;
        bal += stake * (abnormal ? m.abnormalLossNet : m.lossNet);
        losses += 1;
        if (abnormal) abnormalLosses += 1;
      }
      tradesDone += 1;
      if (bal > peak) peak = bal;
      const dd = peak > 0 ? (peak - bal) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      if (keepPath) path.push(bal);
    }
  }
  return { finalBalance: bal, wins, losses, abnormalLosses, tradesDone, maxDD, multipliers: m, path };
}

function runMonteCarlo(cfg) {
  const vals = [];
  const dds = [];
  for (let i = 0; i < cfg.mcRuns; i += 1) {
    const r = runScenario(cfg, mulberry32(1000 + i), false);
    vals.push(r.finalBalance);
    dds.push(r.maxDD);
  }
  vals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { vals, mean, p5: q(vals, 0.05), p50: q(vals, 0.5), p95: q(vals, 0.95), min: vals[0], max: vals[vals.length - 1], ddP50: q(dds, 0.5), ddP95: q(dds, 0.95) };
}

function renderStats(container, items) {
  container.innerHTML = items.map((it) => `<div class="stat"><div class="k">${it.k}</div><div class="v">${it.v}</div></div>`).join('');
}

function drawHistogram(vals) {
  const canvas = byId('histogram');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const bins = 30;
  const min = vals[0];
  const max = vals[vals.length - 1];
  const span = Math.max(1e-9, max - min);
  const counts = Array(bins).fill(0);
  for (const v of vals) counts[Math.min(bins - 1, Math.floor(((v - min) / span) * bins))] += 1;
  const maxC = Math.max(...counts, 1);
  const bw = w / bins;
  for (let i = 0; i < bins; i += 1) {
    const barH = (counts[i] / maxC) * (h - 28);
    ctx.fillStyle = '#2f72ff';
    ctx.fillRect(i * bw + 1, h - barH - 18, bw - 2, barH);
  }
  ctx.fillStyle = '#9fb0cf';
  ctx.font = '12px sans-serif';
  ctx.fillText(`min ${min.toFixed(2)}€`, 8, h - 4);
  ctx.fillText(`max ${max.toFixed(2)}€`, w - 100, h - 4);
}

function drawCompareChart(series) {
  const canvas = byId('compareChart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const colors = ['#2f72ff', '#26b46d', '#f59e0b'];
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMax = 0;
  for (const s of series) {
    for (const v of s.path) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    if (s.path.length > xMax) xMax = s.path.length;
  }
  yMin = Math.min(yMin, 0);
  const ySpan = Math.max(1e-9, yMax - yMin);
  const xSpan = Math.max(1, xMax - 1);
  const toX = (i) => 38 + (i / xSpan) * (w - 55);
  const toY = (v) => (h - 28) - ((v - yMin) / ySpan) * (h - 46);

  ctx.strokeStyle = '#334969';
  ctx.beginPath();
  ctx.moveTo(38, 10);
  ctx.lineTo(38, h - 28);
  ctx.lineTo(w - 10, h - 28);
  ctx.stroke();

  series.forEach((s, idx) => {
    ctx.strokeStyle = colors[idx % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.path.forEach((v, i) => {
      const x = toX(i);
      const y = toY(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = colors[idx % colors.length];
    ctx.fillRect(w - 220, 16 + idx * 18, 10, 10);
    ctx.fillStyle = '#c8d7f2';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${s.name} (${s.finalBalance.toFixed(2)}€)`, w - 205, 25 + idx * 18);
  });
}

function runAll() {
  const [s1, s2, s3] = strategyInputs();
  const det1 = runScenario(s1, mulberry32(42), true);
  const mc1 = runMonteCarlo(s1);
  const det2 = runScenario(s2, mulberry32(42), true);
  const det3 = runScenario(s3, mulberry32(42), true);

  renderStats(byId('deterministicStats'), [
    { k: 'Capital final (A)', v: eur(det1.finalBalance) },
    { k: 'Profit net (A)', v: eur(det1.finalBalance - s1.startBalance) },
    { k: 'Wins / Losses (A)', v: `${det1.wins} / ${det1.losses}` },
    { k: 'Pertes SL anormales (A)', v: `${det1.abnormalLosses}` },
    { k: 'Trades exécutés (A)', v: `${det1.tradesDone}/${s1.totalTrades}` },
    { k: 'Max drawdown (A)', v: pct(det1.maxDD) },
    { k: 'Gain net win/trade', v: pct(det1.multipliers.winNet) },
    { k: 'Perte nette loss/trade', v: pct(det1.multipliers.lossNet) },
    { k: 'Perte nette loss anormale', v: pct(det1.multipliers.abnormalLossNet) },
  ]);

  renderStats(byId('mcStats'), [
    { k: 'Moyenne finale (A)', v: eur(mc1.mean) },
    { k: 'P5 (prudent)', v: eur(mc1.p5) },
    { k: 'Médiane (P50)', v: eur(mc1.p50) },
    { k: 'P95 (optimiste)', v: eur(mc1.p95) },
    { k: 'Min / Max', v: `${eur(mc1.min)} / ${eur(mc1.max)}` },
    { k: 'Max DD P50 / P95', v: `${pct(mc1.ddP50)} / ${pct(mc1.ddP95)}` },
  ]);

  drawHistogram(mc1.vals);
  drawCompareChart([
    { name: s1.name, path: det1.path, finalBalance: det1.finalBalance },
    { name: s2.name, path: det2.path, finalBalance: det2.finalBalance },
    { name: s3.name, path: det3.path, finalBalance: det3.finalBalance },
  ]);

  const summary = {
    baseStrategy: s1,
    deterministic: det1,
    monteCarlo: { runs: s1.mcRuns, mean: mc1.mean, p5: mc1.p5, p50: mc1.p50, p95: mc1.p95, min: mc1.min, max: mc1.max, maxDdP50: mc1.ddP50, maxDdP95: mc1.ddP95 },
    comparison: [
      { name: s1.name, final: det1.finalBalance, pnl: det1.finalBalance - s1.startBalance },
      { name: s2.name, final: det2.finalBalance, pnl: det2.finalBalance - s2.startBalance },
      { name: s3.name, final: det3.finalBalance, pnl: det3.finalBalance - s3.startBalance },
    ],
  };
  byId('summary').textContent = JSON.stringify(summary, null, 2);
  window.__SIM_RESULT__ = summary;
}

byId('runBtn').addEventListener('click', runAll);
byId('exportBtn').addEventListener('click', () => {
  const data = window.__SIM_RESULT__ || {};
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'simulation-polymarket.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

runAll();
