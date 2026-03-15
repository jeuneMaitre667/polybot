#!/usr/bin/env node
/**
 * Backtest PnL théorique à partir de balance-history.json et orders.log.
 * Lit les fichiers dans BOT_DIR (ou répertoire courant) et affiche un résumé.
 * Usage : node backtest-pnl.js [--dir /path/to/bot-24-7]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : __dirname;

const balancePath = path.join(BOT_DIR, 'balance-history.json');
const ordersPath = path.join(BOT_DIR, 'orders.log');

function loadBalanceHistory() {
  try {
    const raw = fs.readFileSync(balancePath, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && p.at != null) : [];
  } catch {
    return [];
  }
}

function loadOrdersLog() {
  try {
    const raw = fs.readFileSync(ordersPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const history = loadBalanceHistory();
const orders = loadOrdersLog();

const first = history[0];
const last = history[history.length - 1];
const firstBalance = first?.balance != null ? Number(first.balance) : null;
const lastBalance = last?.balance != null ? Number(last.balance) : null;
const pnlUsd = firstBalance != null && lastBalance != null ? lastBalance - firstBalance : null;

const ordersWithWon = orders.filter((o) => typeof o.won === 'boolean');
const won = ordersWithWon.filter((o) => o.won).length;
const totalWithResult = ordersWithWon.length;
const winRate = totalWithResult > 0 ? (won / totalWithResult) * 100 : null;

console.log('=== Backtest PnL (données locales) ===');
console.log('Fichiers :', balancePath, ordersPath);
console.log('');
console.log('Balance history :', history.length, 'points');
if (first) console.log('  Premier :', first.at, '→', firstBalance, '$');
if (last) console.log('  Dernier :', last.at, '→', lastBalance, '$');
if (pnlUsd != null) console.log('  PnL (dernier - premier) :', pnlUsd >= 0 ? '+' : '', pnlUsd.toFixed(2), '$');
console.log('');
console.log('Orders log :', orders.length, 'ordres');
if (totalWithResult > 0) console.log('  Avec résultat (won) :', totalWithResult, '→', won, 'gagnés, win rate', winRate != null ? winRate.toFixed(1) : '-', '%');
console.log('');
console.log('Résumé : PnL théorique basé sur l’historique de solde enregistré par le bot.');
