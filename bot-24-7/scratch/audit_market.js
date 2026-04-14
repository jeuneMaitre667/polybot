
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Load inner bot env
const envContent = fs.readFileSync('C:/Users/cedpa/polymarket-dashboard/bot-24-7/.env', 'utf8');
const lines = envContent.split(/\r?\n/);
for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('=');
    if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        process.env[key] = value.replace(/^["']|["']$/g, '');
    }
}

async function audit() {
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    // Auth derivation
    const initClient = new ClobClient('https://clob.polymarket.com', 137, signer);
    const creds = await initClient.deriveApiKey();
    const clobClient = new ClobClient('https://clob.polymarket.com', 137, signer, creds);

    console.log("--- 🕵️‍♂️ AUDIT MÉTADONNÉES MARCHÉ ---");
    try {
        const tokenId = '49151918436208595929415591066331671917346354895933141013434640806591705874086';
        const market = await clobClient.getMarket(tokenId);
        console.log(JSON.stringify(market, null, 2));
        
        const tick = await clobClient.getTickSize(tokenId);
        console.log("\n📐 SDK TICK SIZE:", tick);
        
    } catch (err) {
        console.error("❌ Erreur Audit :", err.message);
    }
}

audit();
