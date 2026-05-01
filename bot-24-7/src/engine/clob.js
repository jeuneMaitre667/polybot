import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client-v2';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CONFIG, STATE } from './config.js';

let clobClient = null;
let proxyAgent = null;

if (process.env.PROXY_URL) {
    proxyAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    proxyAgent.toJSON = () => '[DublinProxy]';
}

export function getProxyAgent() {
    return proxyAgent;
}

export function getClobClient() {
    return clobClient;
}

export async function ensureClobClient() {
    try {
        if (!STATE.wallet || !STATE.wallet.address) {
            const pk = process.env.PRIVATE_KEY;
            if (!pk) throw new Error("PRIVATE_KEY missing for self-healing");
            STATE.wallet = new ethers.Wallet(pk);
        }

        if (!clobClient) {
            const { createWalletClient, http: viemHttp } = await import('viem');
            const { privateKeyToAccount } = await import('viem/accounts');
            const { polygon } = await import('viem/chains');

            const account = privateKeyToAccount(process.env.PRIVATE_KEY);
            const walletClient = createWalletClient({
                account,
                chain: polygon,
                transport: viemHttp()
            });

            console.log(`[ClobClient] 🛡️🛰️⚓ Initializing CLOB V2 Client:`);
            console.log(`[ClobClient] • Signer EOA: ${STATE.wallet.address}`);

            const tempClient = new ClobClient({
                host: CONFIG.CLOB_API_URL,
                chain: 137,
                signer: walletClient,
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent
            });

            let apiCreds;
            try {
                apiCreds = await tempClient.deriveApiKey();
                console.log(`[ClobClient] • API Key derived: ${apiCreds.key.substring(0, 8)}...`);
            } catch (deriveErr) {
                console.warn(`[ClobClient] 🛡️🛰️⚓ deriveApiKey failed. Trying createOrDeriveApiKey...`);
                apiCreds = await tempClient.createOrDeriveApiKey();
                console.log(`[ClobClient] • API Key created: ${apiCreds.key.substring(0, 8)}...`);
            }

            clobClient = new ClobClient({
                host: CONFIG.CLOB_API_URL,
                chain: 137,
                signer: walletClient,
                creds: apiCreds,
                signatureType: parseInt(process.env.CLOB_SIGNATURE_TYPE || '2'),
                funderAddress: process.env.CLOB_FUNDER_ADDRESS,
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent
            });

            console.log(`[ClobClient] 🛡️🛰️⚓ ClobClient V2 initialized (DUBLIN-AXIOM PROTOCOL)`);
        }
        return true;
    } catch (err) {
        console.error(`[ClobClient] 🛡️⚠️ FAILED to restore wallet:`, err.message);
        return false;
    }
}
