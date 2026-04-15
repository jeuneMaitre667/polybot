import { sendTelegramAlert } from './telegramAlerts.js';

async function test() {
    console.log('[Test] Sending Telegram alert...');
    await sendTelegramAlert('🛡️🛰️⚓ TEST RECOVERY SUCCESSFUL\n\nBot: Ghost-Shield Elite v34.2\nStatus: Operational\nBalance: $134.46\nAddress: 54.247.10.200');
    console.log('[Test] Done.');
}

test();
