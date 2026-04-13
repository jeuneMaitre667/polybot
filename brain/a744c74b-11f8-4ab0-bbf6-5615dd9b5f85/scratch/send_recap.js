
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Correct path to .env
dotenv.config({ path: 'C:/Users/cedpa/polymarket-dashboard/bot-24-7/.env' });

// Using correct variable names from .env
const token = process.env.ALERT_TELEGRAM_BOT_TOKEN;
const chatId = process.env.ALERT_TELEGRAM_CHAT_ID;

if (!token || !chatId) {
    console.error('❌ Identifiants manquants (Vérifiez ALERT_TELEGRAM_BOT_TOKEN et ALERT_TELEGRAM_CHAT_ID) !');
    process.exit(1);
}

const message = `📊 *RECAPITULATIF DES 3 DERNIERS TRADES* 📊\n\n` +
                `1️⃣ *Trade 15h14* : BTC DOWN (NO)\n` +
                `• Prix d'entrée : $0.95\n` +
                `• Taille : $10.00\n\n` +
                `2️⃣ *Trade 15h29* : BTC DOWN (NO)\n` +
                `• Prix d'entrée : $0.94\n` +
                `• Taille : $10.00\n\n` +
                `3️⃣ *Trade 15h33* : BTC DOWN (NO)\n` +
                `• Prix d'entrée : $0.97\n` +
                `• Taille : $10.00\n\n` +
                `💰 *Capital Actuel Simulation* : $70.00\n` +
                `⏳ *Statut* : En attente de résolution par Polymarket.`;

async function send() {
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('✅ Recapitulatif envoyé avec succès avec les bons identifiants !');
    } catch (err) {
        if (err.response) {
            console.error(`❌ Erreur Telegram (${err.response.status}):`, err.response.data);
        } else {
            console.error('❌ Erreur Telegram:', err.message);
        }
    }
}

send();
