import { getClobClient } from './clob.js';
import { getUnifiedMarketState } from './strategy.js';
import { updateVirtualBalance } from '../../src/core/virtual-wallet.js';
import { sendTelegramAlert } from '../../telegramAlerts.js';
import * as Analytics from '../../analytics-engine.js';
import { CONFIG, STATE } from './config.js';

const slConfirmations = new Map();

export async function turboSentinel() {
    console.log("[Sentinel] 🛡️🛰️⚓ Turbo Sentinel started (200ms resolution).");
    while (true) {
        try {
            const mv = await getUnifiedMarketState('BTC', new Map()).catch(() => null);
            await monitorPositionsFast(mv);
        } catch (e) {
            console.error("[Sentinel] 🛡️⚠️ Turbo Loop Error:", e.message);
        }
        await new Promise(r => setTimeout(r, 200));
    }
}

async function monitorPositionsFast(mv) {
    if (!STATE.activePosition) return;
    const pos = STATE.activePosition;
    const now = Date.now();

    try {
        const clobClient = getClobClient();
        const book = await clobClient.getOrderBook(pos.tokenId).catch(() => null);
        const bids = book?.bids || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
        
        if (bestBid === 0) return;
        const currentPrice = bestBid;

        // SL Logic (14%)
        const pnlPct = (currentPrice - pos.buyPrice) / pos.buyPrice;
        if (pnlPct <= -0.14) {
            const firstSeen = slConfirmations.get(pos.tokenId) || now;
            if (!slConfirmations.has(pos.tokenId)) slConfirmations.set(pos.tokenId, now);
            
            if (now - firstSeen >= 500) {
                console.log(`[Sentinel] 🚨 STOP LOSS CONFIRMED for ${pos.slug} | Bid: $${bestBid} (PnL: ${(pnlPct * 100).toFixed(2)}%)`);
                STATE.activePosition = null; // Exit
                slConfirmations.delete(pos.tokenId);
            }
        } else {
            slConfirmations.delete(pos.tokenId);
        }

        // Instant TP / Expiry
        const timeUntilEnd = pos.slotEnd - now;
        if (currentPrice >= 0.99 || (timeUntilEnd <= 10000 && timeUntilEnd > 0)) {
            console.log(`[Sentinel] 🚀 EARLY EXIT Triggered for ${pos.slug}. Selling at $${currentPrice}...`);
            STATE.activePosition = null; // Exit
        }

    } catch (err) {}
}
