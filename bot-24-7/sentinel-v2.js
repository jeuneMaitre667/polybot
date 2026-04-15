/**
 * Sentinel V2 Watcher (v1.0.0)
 * Monitors Polymarket SDK and Changelog for V2 migration signals.
 * Runs every 12 hours at Noon and Midnight.
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const STATE_FILE = path.join(__dirname, 'sentinel-state.json');
const SDK_PACKAGE = '@polymarket/clob-client';
const CHANGELOG_URL = 'https://docs.polymarket.com/changelog';

const TG_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL;

if (PROXY_URL) {
    console.log(`[Sentinel] 🌐 Using Proxy: ${PROXY_URL.split('@')[1] || PROXY_URL}`);
    const agent = new HttpsProxyAgent(PROXY_URL);
    axios.defaults.httpsAgent = agent;
    axios.defaults.proxy = false;
}

/**
 * v21.3.0: Mandatory Geoblock Verification for Sentinel consistency
 */
async function validateGeoblockStatus() {
    console.log(`[Sentinel] 🔍 Verifying Polymarket access...`);
    try {
        // Simple public endpoint check to see if we are geoblocked
        await axios.get('https://clob.polymarket.com/health', { timeout: 5000 });
        console.log(`[Sentinel] ✅ Access Authorized.`);
        return true;
    } catch (err) {
        if (err.response?.status === 403) {
            console.error(`[Sentinel] ❌ ERROR: Geoblock detected. Monitoring might be limited.`);
            return false;
        }
        return true; // Ignore other network errors for the sentinel
    }
}

async function sendAlert(msg) {
    if (!TG_TOKEN || !TG_CHAT_ID) return console.log('[Sentinel] Missing TG Config, alert skipped:', msg);
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: msg,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error('[Sentinel] TG Alert Failed:', e.message);
    }
}

async function checkUpdates() {
    console.log(`[Sentinel] 🕵️‍♂️ Running scheduled check: ${new Date().toLocaleString('fr-FR')}`);
    
    let state = { lastSdkVersion: '5.8.1', lastChangelogLength: 0 };
    if (fs.existsSync(STATE_FILE)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch (e) { console.error('[Sentinel] State read error'); }
    }

    let alerts = [];

    // 1. Check NPM Version
    try {
        const npmRes = await axios.get(`https://registry.npmjs.org/${SDK_PACKAGE}/latest`, { 
            timeout: 5000,
            httpsAgent: null 
        });
        const latestVersion = npmRes.data.version;
        if (latestVersion !== state.lastSdkVersion) {
            alerts.push(`🚨 *POLYMARKET SDK UPDATE* ⚡\nNouveau SDK détecté : v${latestVersion} (Précédente: v${state.lastSdkVersion}). La migration V2 approche !`);
            state.lastSdkVersion = latestVersion;
        }
    } catch (e) { console.error('[Sentinel] NPM check failed:', e.message); }

    // 2. Check Changelog for Keywords
    try {
        const clRes = await axios.get(CHANGELOG_URL, { 
            timeout: 7000,
            httpsAgent: null
        });
        const content = clRes.data;
        const keywords = ['V2', 'migration', 'Polymarket USD', 'Protocol Upgrade', 'USDC.e'];
        const found = keywords.filter(k => content.includes(k) && ! (state.lastFoundKeywords || []).includes(k));
        
        if (found.length > 0) {
            alerts.push(`📖 *CHANGELOG UPDATE* 🔍\nMots-clés de migration détectés : ${found.join(', ')}. Vérifiez https://docs.polymarket.com/changelog`);
            state.lastFoundKeywords = [...new Set([...(state.lastFoundKeywords || []), ...found])];
        }
        
        if (content.length !== state.lastChangelogLength) {
            state.lastChangelogLength = content.length;
        }
    } catch (e) { console.error('[Sentinel] Changelog check failed:', e.message); }

    // 3. Finalize
    if (alerts.length > 0) {
        for (const a of alerts) { await sendAlert(a); }
    } else {
        console.log('[Sentinel] No changes detected.');
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function scheduleNext() {
    const now = new Date();
    const nextCheck = new Date();
    
    // Target: Noon (12:00) or Midnight (00:00)
    if (now.getHours() < 12) {
        nextCheck.setHours(12, 0, 0, 0);
    } else {
        nextCheck.setHours(24, 0, 0, 0);
    }

    const waitMs = nextCheck.getTime() - now.getTime();
    console.log(`[Sentinel] ⏳ Next audit in ${(waitMs / 3600000).toFixed(2)} hours (at ${nextCheck.toLocaleString('fr-FR')})`);
    
    setTimeout(async () => {
        await checkUpdates();
        scheduleNext();
    }, waitMs);
}

// Start Command
if (process.argv.includes('--test')) {
    console.log('[Sentinel] Manual Test Triggered...');
    checkUpdates();
} else {
    console.log('[Sentinel] Service Started - Dual-Watch Mode Active (Noon/Midnight)');
    validateGeoblockStatus();
    scheduleNext();
}
