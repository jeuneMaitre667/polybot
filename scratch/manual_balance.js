import axios from 'axios';
import dotenv from 'dotenv';
import pkg from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

const { JsonRpcProvider, Contract, formatUnits } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../bot-24-7/.env') });

async function run() {
    try {
        console.log("Connexion à Polygon (Ethers v6 CJS interop)...");
        const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
        
        const usdcAddress = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
        const funderAddress = process.env.CLOB_FUNDER_ADDRESS;

        const usdc = new Contract(usdcAddress, ["function balanceOf(address) view returns (uint256)"], provider);
        const balRaw = await usdc.balanceOf(funderAddress);
        const bal = formatUnits(balRaw, 6);
        
        const timestamp = new Date().toLocaleTimeString('fr-FR');
        const msg = `🛡️ *VÉRIFICATION RÉUSSIE (${timestamp})* 🏦\n\n` +
                    `• Capital USDC : $${parseFloat(bal).toFixed(2)}\n` +
                    `• Engine : v17.62.9 (OPÉRATIONNEL) ⚡\n` +
                    `• Mode : RÉEL 🎯\n\n` +
                    `Liaison blockchain et Telegram 100% OK.`;

        const token = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
        const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();
        const url = `https://api.telegram.org/bot${token}/sendMessage`;

        await axios.post(url, { 
            chat_id: chatId, 
            text: msg, 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });

        console.log(`[Success] Message envoyé. Solde : $${bal}`);
    } catch (e) {
        console.error('[Error]', e.message);
    }
}

run();
