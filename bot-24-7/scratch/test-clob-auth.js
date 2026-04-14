import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fileURLToPath } from 'url';
import path from 'path';
import { ClobClient } from '@polymarket/clob-client';
import { createL2Headers } from '@polymarket/clob-client/dist/headers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

// Notre version manuelle
function createClobHeadersManual(method, path, body, creds, userAddress) {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = timestamp + method + path + body;
    const sig = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64'))
        .update(message)
        .digest('base64');
    const sigUrlSafe = sig.replace(/\+/g, '-').replace(/\//g, '_');
    return {
        'POLY_ADDRESS': userAddress,
        'POLY_API_KEY': creds.key,
        'POLY_PASSPHRASE': creds.passphrase,
        'POLY_TIMESTAMP': String(timestamp),
        'POLY_SIGNATURE': sigUrlSafe,
        'Content-Type': 'application/json'
    };
}

async function testAuth() {
    console.log("--- CLOB AUTH COMPARISON TEST ---");
    
    const privateKey = process.env.PRIVATE_KEY;
    const wallet = new ethers.Wallet(privateKey);
    const host = 'https://clob.polymarket.com';
    const chainId = 137;
    const tempClient = new ClobClient(host, chainId, wallet, undefined, 0, undefined, undefined, proxyAgent);
    const creds = await tempClient.deriveApiKey();

    const method = 'GET';
    const targetPath = '/orders-sampling?market=0x...'; // Un endpoint public mais testons l'auth dessus
    const bodyStr = '';

    console.log("🛠️ Generating SDK Headers...");
    const sdkHeaders = await createL2Headers(wallet, creds, {
        method,
        requestPath: targetPath,
        body: bodyStr
    });

    console.log("🛠️ Generating manual Headers...");
    const manualHeaders = createClobHeadersManual(method, targetPath, bodyStr, creds, wallet.address);

    console.log("\n--- COMPARISON ---");
    console.log("SDK Headers:", JSON.stringify(sdkHeaders, null, 2));
    console.log("Manual Headers:", JSON.stringify(manualHeaders, null, 2));

    // On teste avec les SDK Headers d'abord pour être sûr de l'endpoint
    console.log("\n🛰️ Testing with SDK Headers...");
    try {
        // Testons un endpoint qui accepte forcément le GET : /markets (si authentifié)
        // Ou mieux : /orders mais avec des params
        const testPath = '/orders?market=0x2791bca1f2de4661ed88a30c99a7a9449aa84174'; // Juste pour tester le 405
        
        const response = await axios.get(`${host}${testPath}`, {
            headers: await createL2Headers(wallet, creds, { method: 'GET', requestPath: testPath, body: '' }),
            httpsAgent: proxyAgent
        });
        console.log("✅ SDK Headers Success! Status:", response.status);
    } catch (err) {
        console.error("❌ SDK Headers Result:", err.response ? err.response.status : err.message);
        if (err.response && err.response.data) console.log("Detail:", err.response.data);
    }
}

testAuth();
