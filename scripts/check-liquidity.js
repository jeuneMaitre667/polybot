#!/usr/bin/env node
/**
 * Vérifie les relevés de liquidité des deux bots (horaire + 15m) via les APIs de statut.
 * Utilise les URLs du .env du dashboard (VITE_BOT_STATUS_URL, VITE_BOT_STATUS_URL_15M).
 * Optionnel : BOT_STATUS_SECRET pour ?token= si l'API est protégée.
 *
 * Usage: node scripts/check-liquidity.js
 * Depuis la racine du repo: node scripts/check-liquidity.js
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const t = line.replace(/#.*/, '').trim();
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

async function fetchStatus(url, token, debug = false) {
  const u = new URL('/api/bot-status', url);
  if (token) u.searchParams.set('token', token);
  if (debug) u.searchParams.set('debug', '1');
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const env = loadEnv();
  const url1 = env.VITE_BOT_STATUS_URL;
  const url15m = env.VITE_BOT_STATUS_URL_15M;
  const secret = env.BOT_STATUS_SECRET || process.env.BOT_STATUS_SECRET;

  console.log('--- Relevés de liquidité (3 derniers jours) ---\n');

  const debug = process.argv.includes('--debug');
  if (debug) console.log('(Mode debug: vérification présence fichier liquidity-history.json)\n');

  if (url1) {
    try {
      const data = await fetchStatus(url1, secret, debug);
      const liq = data.liquidityStats || {};
      console.log('Bot Horaire:', url1);
      console.log('  count:', liq.count ?? '—');
      console.log('  lastAt:', liq.lastAt ?? '—');
      console.log('  avg (USD):', liq.avg ?? '—');
      console.log('  min/max (USD):', liq.min ?? '—', '/', liq.max ?? '—');
      if (data._debug) console.log('  _debug:', JSON.stringify(data._debug, null, 2).replace(/\n/g, '\n  '));
      console.log('');
    } catch (e) {
      console.log('Bot Horaire:', url1);
      console.log('  Erreur:', e.message);
      console.log('');
    }
  } else {
    console.log('Bot Horaire: (VITE_BOT_STATUS_URL non défini dans .env)\n');
  }

  if (url15m) {
    try {
      const data = await fetchStatus(url15m, secret, debug);
      const liq = data.liquidityStats || {};
      console.log('Bot 15m:', url15m);
      console.log('  count:', liq.count ?? '—');
      console.log('  lastAt:', liq.lastAt ?? '—');
      console.log('  avg (USD):', liq.avg ?? '—');
      console.log('  min/max (USD):', liq.min ?? '—', '/', liq.max ?? '—');
      if (data._debug) console.log('  _debug:', JSON.stringify(data._debug, null, 2).replace(/\n/g, '\n  '));
      console.log('');
    } catch (e) {
      console.log('Bot 15m:', url15m);
      console.log('  Erreur:', e.message);
      console.log('');
    }
  } else {
    console.log('Bot 15m: (VITE_BOT_STATUS_URL_15M non défini dans .env)\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
