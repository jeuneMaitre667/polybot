/**
 * Alertes Telegram (sendMessage). Variables : ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID.
 * Options : ALERT_TELEGRAM_TRADE, ALERT_TELEGRAM_REDEEM, ALERT_TELEGRAM_BALANCE_EVERY_MS.
 */
import axios from 'axios';

const MAX_CHUNK = 3900;

export function telegramAlertsConfigured() {
  const t = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
  const c = process.env.ALERT_TELEGRAM_CHAT_ID?.trim();
  return !!(t && c);
}

/** Trade + solde dans les messages trade/redeem ; digest périodique si ALERT_TELEGRAM_BALANCE_EVERY_MS > 0 */
export function telegramTradeAlertsEnabled() {
  return telegramAlertsConfigured() && process.env.ALERT_TELEGRAM_TRADE !== 'false';
}

export function telegramRedeemAlertsEnabled() {
  return telegramAlertsConfigured() && process.env.ALERT_TELEGRAM_REDEEM !== 'false';
}

export function telegramBalanceDigestMs() {
  const n = Number(process.env.ALERT_TELEGRAM_BALANCE_EVERY_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Résumés performance Telegram (demi-journées + journée). Désactivable : ALERT_TELEGRAM_MIDDAY_DIGEST=false */
export function telegramMiddayDigestEnabled() {
  return telegramAlertsConfigured() && process.env.ALERT_TELEGRAM_MIDDAY_DIGEST === 'true';
}

function chunkText(text) {
  const s = String(text || '');
  if (s.length <= MAX_CHUNK) return [s];
  const parts = [];
  for (let i = 0; i < s.length; i += MAX_CHUNK) {
    parts.push(s.slice(i, i + MAX_CHUNK));
  }
  return parts;
}

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendTelegramAlert(text) {
  if (!telegramAlertsConfigured() || !text) return;
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN.trim();
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID.trim();
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const part of chunkText(text)) {
    try {
      await axios.post(
        url,
        { chat_id: chatId, text: part, disable_web_page_preview: true },
        { timeout: 12_000, headers: { 'Content-Type': 'application/json' } },
      );
    } catch (e) {
      const msg = e?.response?.data?.description || e?.message || String(e);
      console.warn('[Telegram] sendMessage échoué:', msg);
    }
  }
}
