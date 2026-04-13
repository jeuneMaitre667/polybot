/**
 * Sentinel de Santé Polymarket-Bot (v13.1)
 * Utilisé par Docker HEALTHCHECK ou PM2 Monitor.
 */
const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, 'health.json');
const MAX_AGE_MS = 60000; // 60 secondes

try {
    if (!fs.existsSync(HEALTH_FILE)) {
        console.error('❌ Health check failed: health.json missing.');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    const lastUpdate = new Date(data.performance?.updatedAt || data.updatedAt || 0).getTime();
    const age = Date.now() - lastUpdate;

    if (age > MAX_AGE_MS) {
        console.error(`❌ Health check failed: Heartbeat is stale (${Math.round(age/1000)}s old).`);
        process.exit(1);
    }

    // console.log(`✅ Health check passed: Heartbeat active (${Math.round(age/1000)}s old).`);
    process.exit(0);
} catch (err) {
    console.error('❌ Health check error:', err.message);
    process.exit(1);
}
