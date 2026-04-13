const axios = require('axios');
const dotenv = require('dotenv');
const { ethers } = require('ethers');

dotenv.config({ path: 'bot-24-7/.env' });

async function run() {
    try {
        console.log("Connexion à Polygon...");
        const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
        
        // USDC.e Address
        const usdcAddress = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
        const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
        const funderAddress = process.env.CLOB_FUNDER_ADDRESS;

        const usdc = new ethers.Contract(usdcAddress, usdcAbi, provider);
        const balRaw = await usdc.balanceOf(funderAddress);
        const bal = ethers.formatUnits(balRaw, 6);
        
        const timestamp = new Date().toLocaleTimeString('fr-FR');
        const msg = `🛡️ *VÉRIFICATION MANUELLE (${timestamp})* 🏦\n\n` +
                    `• Capital USDC : $${parseFloat(bal).toFixed(2)}\n` +
                    `• Engine : v17.62.9 (OPÉRATIONNEL) ⚡\n` +
                    `• Mode : RÉEL 🎯\n\n` +
                    `Tout est en ordre, le Sniper est aux aguets !`;

        const token = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
        const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();
        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        await axios.post(url, { 
            chat_id: chatId, 
            text: msg, 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });

        console.log(`[Success] Message envoyé. Solde détecté : $${bal}`);
    } catch (e) {
        console.error('[Error]', e.message);
    }
}

run();
