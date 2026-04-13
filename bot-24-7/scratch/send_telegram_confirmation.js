
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const token = "8772477965:AAHTDB01KMkIvznvXYm5lE83Zre_X-JHfBE";
const chatId = "531945454";
const msg = "🚀 *Sniper Bot v21.2.0 - Confirmation*\n\nLe bot est synchronisé, les clés API CLOB sont dérivées et le système est prêt pour le prochain trade réel. 🎯";

async function send() {
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: msg,
            parse_mode: "Markdown"
        });
        console.log("Message sent successfully");
    } catch (err) {
        console.error("Error sending message:", err.response?.data || err.message);
    }
}

send();
