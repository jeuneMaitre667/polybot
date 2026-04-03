/**
 * v7.14.0 : Rapport de performance Multi-Asset (BTC, ETH, SOL).
 * Calcule le PnL, le Win Rate et l'exposition actuelle depuis le dernier reset.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR = path.resolve(__dirname, '..');
const ORDERS_LOG = path.join(BOT_DIR, 'orders.log');
const ACTIVE_POSITIONS = path.join(BOT_DIR, 'active-positions.json');

const ASSET_EMOJIS = {
  'BTC': '🟠',
  'ETH': '🔵',
  'SOL': '🟣',
  'DEFAULT': '💎'
};

function getBranding(asset) {
  const up = String(asset || '').toUpperCase();
  return ASSET_EMOJIS[up] || ASSET_EMOJIS['DEFAULT'];
}

async function run() {
  console.log('\n--- 📊 POLYBOT PERFORMANCE REPORT (Multi-Asset) ---');
  
  if (!fs.existsSync(ORDERS_LOG)) {
    console.log('❌ Aucun historique (orders.log) trouvé.');
    return;
  }

  const lines = fs.readFileSync(ORDERS_LOG, 'utf8').split('\n').filter(Boolean);
  const trades = lines.map(l => {
    try { return JSON.parse(l); } catch(e) { return null; }
  }).filter(t => t && t.event === 'stop_loss_exit');

  const stats = {};

  trades.forEach(t => {
    const asset = t.underlying || t.asset || 'Unknown';
    if (!stats[asset]) {
      stats[asset] = { count: 0, pnl: 0, wins: 0, volume: 0 };
    }
    
    // Simplification PnL pour le rapport : estimation basée sur l'exit
    // Note: Dans un vrai système, on comparerait Entry vs Exit exact.
    // Ici on assume que le bot log le PnL ou on le calcule via les USDC.
    const pnl = Number(t.totalFilledUsdc || 0) - Number(t.originalStakeUsd || t.amountUsd || 0);
    
    stats[asset].count++;
    stats[asset].pnl += pnl;
    if (pnl > 0) stats[asset].wins++;
    stats[asset].volume += Number(t.totalFilledUsdc || 0);
  });

  console.log(`📅 Analyse de ${trades.length} trades fermés.\n`);

  let totalPnl = 0;
  for (const [asset, data] of Object.entries(stats)) {
    const emoji = getBranding(asset);
    const winRate = ((data.wins / data.count) * 100).toFixed(1);
    const color = data.pnl >= 0 ? '\x1b[32m' : '\x1b[31m'; // Vert ou Rouge
    const resetColor = '\x1b[0m';
    
    console.log(`${emoji} ${asset.padEnd(5)} | Trades: ${data.count} | WinRate: ${winRate}% | PnL: ${color}${data.pnl.toFixed(2)} USDC${resetColor}`);
    totalPnl += data.pnl;
  }

  // Exposition actuelle
  if (fs.existsSync(ACTIVE_POSITIONS)) {
    const active = JSON.parse(fs.readFileSync(ACTIVE_POSITIONS, 'utf8')).filter(p => !p.resolved);
    if (active.length > 0) {
      console.log('\n📡 EXPOSITION ACTUELLE :');
      active.forEach(p => {
        const emoji = getBranding(p.underlying || p.asset);
        console.log(`${emoji} ${p.underlying || p.asset} | ${p.takeSide} | Stake: ${Number(p.filledUsdc || p.amountUsd || 0).toFixed(2)} USDC`);
      });
    }
  }

  const finalColor = totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n💰 TOTAL PNL : ${finalColor}${totalPnl.toFixed(2)} USDC\x1b[0m`);
  console.log('--------------------------------------------------\n');
}

run().catch(console.error);
