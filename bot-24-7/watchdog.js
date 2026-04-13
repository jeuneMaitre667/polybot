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

const HEARTBEAT_FILE = path.join(__dirname, 'heartbeat.json');
const MAX_SILENCE_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

console.log(`[Watchdog] 🛡️ Sentinel started. Monitoring heartbeat every ${CHECK_INTERVAL_MS / 1000}s...`);

async function checkHeartbeat() {
    try {
        if (!fs.existsSync(HEARTBEAT_FILE)) {
            console.warn('[Watchdog] ⚠️ heartbeat.json not found yet. Main bot might be starting...');
            return;
        }

        const data = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
        const now = Date.now();
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
setInterval(checkHeartbeat, CHECK_INTERVAL_MS);
checkHeartbeat();
