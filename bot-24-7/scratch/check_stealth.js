import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkStealth() {
    const proxyUrl = process.env.PROXY_URL;
    const agent = new HttpsProxyAgent(proxyUrl);

    console.log("🕵️‍♂️ Diagnostic de Furtivité...");
    
    try {
        // 1. Vérification de l'IP vue par le monde
        const ipRes = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent });
        console.log(`✅ IP Proxy détectée : ${ipRes.data.ip}`);
        
        if (ipRes.data.ip === "92.113.177.34") {
            console.error("❌ ATTENTION : Vous utilisez toujours l'IP bannie ! Changez vos identifiants Proxy-Cheap.");
        } else {
            console.log("💎 IP VIERGE : Vous avez bien une nouvelle identité réseau.");
        }

        // 2. Test Geoblock Polymarket (Read-only)
        try {
            const polyRes = await axios.get('https://clob.polymarket.com/markets/0x7cdae3ed609f7a755d787a224a0d952e505299ad', { httpsAgent: agent });
            console.log("✅ Accès Polymarket : OK (Pas de Geoblock)");
        } catch (e) {
            console.error(`❌ Erreur Geoblock : ${e.response?.status || e.message}`);
        }

    } catch (err) {
        console.error("❌ Échec de connexion au Proxy : Verifiez PROXY_URL dans le .env");
    }
}

checkStealth();
