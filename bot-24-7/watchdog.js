import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env for Telegram alerts
dotenv.config({ path: path.resolve(__dirname, '.env') });

import { sendTelegramAlert } from './telegramAlerts.js';
import { timeKeeper } from './src/core/ntp-client.js'; // v17.52.0: Software NTP Sync

const HEARTBEAT_FILE = path.join(__dirname, 'heartbeat.json');
const MAX_SILENCE_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const CPU_THRESHOLD = 40;
const CPU_ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

let lastCpuAlertTime = 0;

console.log(`[Watchdog] 🛡️ Sentinel started. Monitoring heartbeat and CPU Threshold (${CPU_THRESHOLD}%) every ${CHECK_INTERVAL_MS / 1000}s...`);

async function checkResources() {
    exec('pm2 jlist', async (error, stdout) => {
        if (error) return;
        try {
            const list = JSON.parse(stdout);
            const bot = Array.isArray(list) ? list.find(p => p.name === 'poly-engine' || p.name === 'polymarket-bot') : null;
            if (!bot) return;

            const cpu = bot.monit?.cpu || 0;
            const now = Date.now();

            if (cpu > CPU_THRESHOLD && (now - lastCpuAlertTime > CPU_ALERT_COOLDOWN_MS)) {
                lastCpuAlertTime = now;
                await sendTelegramAlert(`⚠️ *CPU RESOURCE ALERT* ⚠️\n\nLe processus *poly-engine* consomme actuellement *${cpu}%* du CPU.\nVérifiez l'état de l'instance Lightsail.\n\n_Threshold: ${CPU_THRESHOLD}% | Cooldown: 10m_`);
                console.log(`[Watchdog] 🚨 CPU Alert sent: ${cpu}%`);
            }
        } catch (e) {
            // Ignore parse errors from pm2
        }
    });
}

async function checkHeartbeat() {
    try {
        // Resource check integrated into heartbeat loop
        checkResources();

        if (!fs.existsSync(HEARTBEAT_FILE)) {
            console.warn('[Watchdog] ⚠️ heartbeat.json not found yet. Main bot might be starting...');
            return;
        }

        const data = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
        const now = timeKeeper.getNow();
        const diff = now - data.timestamp;

        if (diff > MAX_SILENCE_MS) {
            console.error(`[Watchdog] 🚨 SILENCE DETECTED (${Math.floor(diff / 1000)}s). Restarting poly-engine...`);
            
            await sendTelegramAlert(`⚠️ *WATCHDOG ALERT* ⚠️\n\nLe moteur (poly-engine) semble figé depuis ${Math.floor(diff / 60000)} minutes.\nRedémarrage forcé en cours...`);
            
            exec('pm2 restart poly-engine', (error, stdout, stderr) => {
                if (error) {
                    console.error(`[Watchdog] ❌ Restart failed: ${error.message}`);
                    return;
                }
                console.log('[Watchdog] ✅ poly-engine has been successfully restarted.');
            });
        } else {
            // Heartbeat OK
            if (process.env.DEBUG_WATCHDOG === 'true') {
                console.log(`[Watchdog] Pulse OK. Last activity: ${Math.floor(diff / 1000)}s ago.`);
            }
        }
    } catch (err) {
        console.error('[Watchdog] ❌ Monitoring error:', err.message);
    }
}

// Start the loop
timeKeeper.sync().then(() => {
    setInterval(checkHeartbeat, CHECK_INTERVAL_MS);
    checkHeartbeat();
});
