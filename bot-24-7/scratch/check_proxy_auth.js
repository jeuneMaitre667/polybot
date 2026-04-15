import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function testProxy() {
    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) {
        console.error('ERROR: PROXY_URL is missing in .env');
        return;
    }
    console.log('[Test] Proxy URL length:', proxyUrl.length);
    console.log('[Test] Proxy Host:', proxyUrl.split('@')[1] || proxyUrl);

    const agent = new HttpsProxyAgent(proxyUrl);
    
    console.log('[Test] Phase 1: ipify via Proxy...');
    try {
        const res = await axios.get('https://api.ipify.org?format=json', { 
            httpsAgent: agent,
            proxy: false // Crucial to disable axios internal proxy logic
        });
        console.log('✅ Success! IP via Proxy:', res.data.ip);
    } catch (err) {
        console.error('❌ Phase 1 Failed:', err.message);
        if (err.response) console.error('Status:', err.response.status);
    }

    console.log('[Test] Phase 2: Telegram (Direct, No Proxy)...');
    try {
        const res = await axios.get('https://api.telegram.org', { timeout: 5000 });
        console.log('✅ Success! Telegram is reachable directly.');
    } catch (err) {
        console.error('❌ Phase 2 Failed:', err.message);
    }
}

testProxy();
