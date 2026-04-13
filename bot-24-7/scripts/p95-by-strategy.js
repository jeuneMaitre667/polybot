#!/usr/bin/env node
/**
 * Affiche le p95 de decisionMs par fetchSignalsStrategy sur les 24 dernières heures.
 * À lancer sur le serveur après déploiement pour vérifier l'amélioration latence 5m.
 * Usage (sur le serveur) : node ~/bot-24-7/scripts/p95-by-strategy.js
 * Ou depuis bot-24-7 : node scripts/p95-by-strategy.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = process.env.BOT_DIR || path.resolve(__dirname, '..');
const HISTORY_FILE = path.join(BOT_DIR, 'signal-decision-latency-history.json');

function summarize(values) {
  if (!values?.length) return { avgMs: null, p95Ms: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95 = sorted[Math.max(0, Math.floor(0.95 * (sorted.length - 1)))];
  return { avgMs: Math.round(sum / sorted.length), p95Ms: Math.round(p95), count: sorted.length };
}

try {
  const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) {
    console.log('Aucune entrée dans signal-decision-latency-history.json');
    process.exit(0);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = arr.filter((e) => e?.at && new Date(e.at).getTime() >= cutoff);
  const byStrategy = {};
  for (const e of filtered) {
    const n = Number(e?.decisionMs);
    if (!Number.isFinite(n) || n <= 0) continue;
    const strategy = String(e?.fetchSignalsStrategy ?? '').trim() || 'unknown';
    if (!byStrategy[strategy]) byStrategy[strategy] = [];
    byStrategy[strategy].push(n);
  }
  console.log('--- P95 decisionMs par fetchSignalsStrategy (24 h) ---');
  for (const [strategy, values] of Object.entries(byStrategy).sort((a, b) => (b[1].length - a[1].length))) {
    const s = summarize(values);
    console.log(`  ${strategy}: p95=${s.p95Ms} ms  avg=${s.avgMs} ms  count=${s.count}`);
  }
  if (Object.keys(byStrategy).length === 0) console.log('  (aucune entrée avec decisionMs sur 24 h)');
} catch (err) {
  console.error('Erreur:', err.message);
  process.exit(1);
}
