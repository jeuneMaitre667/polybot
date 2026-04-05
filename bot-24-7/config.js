/**
 * Shared Configuration & Constants (v5.4.0)
 * Centralizing these values to support modular architecture.
 */

// Asset Slugs (v9.5.2)
export const BITCOIN_UP_OR_DOWN_1H_PREFIX = 'bitcoin-up-or-down';
export const ETHEREUM_UP_OR_DOWN_1H_PREFIX = 'ethereum-up-or-down';
export const SOLANA_UP_OR_DOWN_1H_PREFIX = 'solana-up-or-down';

export const BITCOIN_UPDOWN_15M_PREFIX = 'btc-updown-15m';
export const ETHEREUM_UPDOWN_15M_PREFIX = 'eth-updown-15m';
export const SOLANA_UPDOWN_15M_PREFIX = 'sol-updown-15m';

// Market & Trading
export const MARKET_MODE = process.env.MARKET_MODE || '15m';
export const SUPPORTED_ASSETS = ['BTC', 'ETH', 'SOL'];

// API URLs
export const GAMMA_EVENT_BY_SLUG_URL = 'https://gamma-api.polymarket.com/events/slug';

// Cache & Timings
export const FETCH_SIGNALS_CACHE_MS = Number(process.env.FETCH_SIGNALS_CACHE_MS) || 200;
export const MAX_CHAINLINK_AGE_SEC = 8;
export const SIGNAL_MIN_DWELL_MS = Number(process.env.SIGNAL_MIN_DWELL_MS) || 500;

// Math & Strategy
export const SKEW_ADJUSTMENT = Number(process.env.SKEW_ADJUSTMENT) || -0.03;
export const ARBITRAGE_GAP_THRESHOLD = Number(process.env.ARBITRAGE_GAP_THRESHOLD) || 0.005; // v9.3.6: 0.5% Maker Gap
export const ORDER_EXECUTION_TYPE = process.env.ORDER_EXECUTION_TYPE || 'LIMIT';
export const LIMIT_ORDER_TTL_MS = Number(process.env.LIMIT_ORDER_TTL_MS) || 30000;

// v7.3.0 Inventory Skewing
export const INVENTORY_CAP = Number(process.env.INVENTORY_CAP) || 1000; // tokens max par actif
export const SKEW_REDUCTION_OFFSET = Number(process.env.SKEW_REDUCTION_OFFSET) || 0.005; // -0.5% si surexposé
export const BTC_ANNUALIZED_VOLATILITY = Number(process.env.BTC_ANNUALIZED_VOLATILITY) || 0.20;
export const POLYMARKET_FEE_RATE = 0; // v9.3.6: Maker Strategy (Zero Fee)
export const POLYMARKET_TAKER_FEE = 0.0002; // 0.02% (v12.1)
export const EXPECTED_SLIPPAGE = 0.0005;   // 0.05% buffer
export const FEE_SAFETY_BUFFER = 1.05;

// v10.6 : Momentum CDF Strategy Window
export const ENTRY_WINDOW = {
  minSecondsRemaining: 15,
  maxSecondsRemaining: 180, // Fenêtre élargie à 3 min (v12.2)
  minDeltaPct: 0.0003,      // 0.03 %
};

// --- v11 : Ultra-Resilience Backup Config ---
export const STATE_BACKUP_CONFIG = {
    intervalMs: 300000, // 5 min
    dir: './backups',
    files: [
        'health.json',
        'active-positions.json',
        'open-orders.json',
        'stop-loss-metrics.json',
        'daily-stats.json',
        'bot.log'
    ]
};

// --- v13 : High-Priority Risk Mitigation ---
export const MAX_DAILY_DRAWDOWN_PCT = 0.10; // 10% max daily drawdown (Kelly weighting)
export const RPC_PING_INTERVAL_MS = 30000;  // 30s RPC Sentinel

