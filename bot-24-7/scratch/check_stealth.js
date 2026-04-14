import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkStealth() {
    const proxyUrl = process.env.PROXY_URL;
    const agent = new HttpsProxyAgent(proxyUrl);

    console.log("🕵️‍♂️ Diagnostic de Furtivité v27.3...");
    
    try {
        // 1. Vérification de l'IP vue par le monde
        const ipRes = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent });
        console.log(`✅ IP Proxy détectée : ${ipRes.data.ip}`);
        
        if (ipRes.data.ip === "92.113.177.34") {
            console.warn("⚠️ ATTENTION : Vous utilisez toujours l'IP 92.113.177.34. C'est risqué si elle est déjà blacklistée.");
        } else {
            console.log("💎 IP VIERGE : Identité réseau confirmée.");
        }

        // 2. Test Geoblock Polymarket (Read-only stable endpoint)
        try {
            const polyRes = await axios.get('https://clob.polymarket.com/time', { httpsAgent: agent });
            console.log(`✅ Accès Polymarket : OK (Serveur Time: ${polyRes.data})`);
        } catch (e) {
            console.error(`❌ Erreur Geoblock : ${e.response?.status || e.message}`);
        }

        // 3. Test de dérivation des clés (Auto-Derive)
        try {
            console.log("🔐 Tentative de dérivation des clés API...");
            const wallet = new Wallet(process.env.PRIVATE_KEY);
            const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet, undefined, 1, process.env.CLOB_FUNDER_ADDRESS, undefined, agent);
            const creds = await tempClient.deriveApiKey();
            console.log(`✅ Authentification Auto : OK (Key: ${creds.key.substring(0, 8)}...)`);
        } catch (authErr) {
            console.error(`❌ Échec Authentification : ${authErr.message}`);
            console.log("💡 Note: Si deriveApiKey échoue, le bot tentera createOrDeriveApiKey au lancement.");
        }

    } catch (err) {
        console.error("❌ Échec de connexion au Proxy : Verifiez PROXY_URL et le Whitelisting.");
    }
}

checkStealth();
