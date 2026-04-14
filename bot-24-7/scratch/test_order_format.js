
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
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

async function testOrder() {
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const initClient = new ClobClient('https://clob.polymarket.com', 137, signer);
    const creds = await initClient.deriveApiKey();
    const clobClient = new ClobClient('https://clob.polymarket.com', 137, signer, creds);

    const tokenId = '49151918436208595929415591066331671917346354895933141013434640806591705874086';
    
    console.log("--- 🕵️‍♂️ TEST DE VALIDATION DE PRIX (NON-DÉPLOYÉ) ---");
    try {
        const tSize = await clobClient.getTickSize(tokenId);
        console.log(`📐 Tick Size: ${tSize}`);

        // Test with 0.50
        const price = 0.50;
        console.log(`🛒 Testing order with price: ${price}`);
        
        // We use createOrder to see if the SDK validation passes (before posting)
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: price,
            size: 5, // minimum size often 5
            side: Side.BUY
        }, {
            tickSize: tSize
        });
        
        console.log("✅ SDK Validation PASSED. Payload generated.");
        console.log("Price in payload:", order.price);
        
    } catch (err) {
        console.error("❌ SDK Validation FAILED:", err.message);
        if (err.message.includes("range")) {
            console.log("💡 Indice : Le SDK rejette les décimales pour ce tick size.");
        }
    }
}

testOrder();
