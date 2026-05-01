import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// Configuration statique du Bot
export const CONFIG = {
    // Fichiers d'état
    POSITION_LOG: path.join(ROOT_DIR, 'active-positions.json'),
    HEARTBEAT_FILE: path.join(ROOT_DIR, 'heartbeat.json'),
    LAST_TRADE_FILE: path.join(ROOT_DIR, 'last-trade.json'),
    STREAK_FILE: path.join(ROOT_DIR, 'streak-state.json'),

    // Paramètres de Sniper
    SNIPER_DELTA_THRESHOLD_PCT: parseFloat(process.env.SNIPER_DELTA_THRESHOLD_PCT || "0.07"),
    SNIPER_WINDOW_START: parseInt(process.env.SNIPER_WINDOW_START_S || "90"),
    SNIPER_WINDOW_END: parseInt(process.env.SNIPER_WINDOW_END_S || "30"),
    SNIPER_PRICE_MIN: parseFloat(process.env.SNIPER_PRICE_MIN || "0.88"),
    SNIPER_PRICE_MAX: parseFloat(process.env.SNIPER_PRICE_MAX || "0.95"),
    
    // Serveurs & RPC
    PRIMARY_RPC: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    FAILOVER_RPC: process.env.POLYGON_RPC_URL_FAILOVER || 'https://polygon-rpc.com',
    CLOB_API_URL: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    
    // Contrats V2 (Polymarket)
    CTF_CONTRACT_ADDRESS: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
    PUSD_ADDRESS: '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb',
    USDC_E_ADDRESS: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // Legacy
    
    // Modes de fonctionnement
    IS_SIMULATION_ENABLED: (process.env.SIMULATION_TRADE_ENABLED || '').trim() === 'true',
    BALANCE_REFRESH_MS: parseInt(process.env.BALANCE_REFRESH_MS || "45000"),
    FEE_REFRESH_INTERVAL_MS: 3600000,
    
    // Taux par défaut
    DEFAULT_GLOBAL_FEE_RATE: 0.036
};

// Singleton d'état global
export const STATE = {
    lastExecutedSlot: 0,
    lastAlertedSlot: 0,
    activePosition: null,
    globalFeeRate: CONFIG.DEFAULT_GLOBAL_FEE_RATE,
    userBalance: null,
    maticBalance: null,
    wallet: null,
    isResolving: false,
    isReporting: false,
    isMainLoopRunning: false,
    lastHeartbeatSlot: 0,
    lastPulseTime: Date.now()
};
