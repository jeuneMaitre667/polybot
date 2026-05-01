import fs from 'fs';
import { Side, OrderType } from '@polymarket/clob-client-v2';
import { getClobClient } from './clob.js';
import { sendTelegramAlert } from '../../telegramAlerts.js';
import * as Analytics from '../../analytics-engine.js';
import * as SLSentinel from '../../sl-sentinel.js';
import { updateVirtualBalance, getVirtualBalance } from '../../src/core/virtual-wallet.js';
import { CONFIG, STATE } from './config.js';

export async function executeTrade(marketState, signalData, tradeAmountUsd) {
    const clobClient = getClobClient();
    const { bSpot, effectiveStrike, bDeltaPct, slotStart } = marketState;
    const side = bDeltaPct > 0 ? 'YES' : 'NO';
    const currentSlotSec = Math.floor(slotStart / 1000);
    const currentSig = signalData.signals.find(s => s.slug && s.slug.endsWith(String(currentSlotSec)));
    
    if (!currentSig) return;
    const tokenId = side === 'YES' ? currentSig.tokenIdYes : currentSig.tokenIdNo;

    let bestAsk = 0;
    try {
        const book = await clobClient.getOrderBook(tokenId).catch(() => null);
        const asks = book?.asks || [];
        if (asks.length > 0) {
            const prices = asks.map(a => parseFloat(a.price)).filter(p => p < 0.999);
            if (prices.length > 0) bestAsk = Math.min(...prices);
        }
    } catch (err) {}

    if (bestAsk === 0) {
        bestAsk = side === 'YES' ? parseFloat(currentSig.priceYes || 0) : parseFloat(currentSig.priceNo || 0);
    }

    if (!bestAsk || bestAsk < CONFIG.SNIPER_PRICE_MIN || bestAsk > CONFIG.SNIPER_PRICE_MAX) {
        return;
    }

    const safePrice = Math.min(0.99, Number(bestAsk) + 0.02);
    const theta = (STATE.globalFeeRate / 0.5) || 0.072;
    const effectivePrice = safePrice * (1 + (theta * (1 - safePrice)));
    const safeQty = Math.floor(tradeAmountUsd / effectivePrice);

    if (safeQty <= 0) return;

    // Execution Simulation
    if (CONFIG.IS_SIMULATION_ENABLED) {
        console.log(`[Engine] 🧪 SIMULATION: Execution Side:${side} | Price:$${bestAsk} | Qty:${safeQty}`);
        STATE.activePosition = {
            tokenId: String(tokenId),
            conditionId: currentSig.conditionId,
            buyPrice: bestAsk,
            strike: currentSig.strike,
            entryAssetPrice: bSpot,
            amount: safeQty,
            slotStart,
            side,
            asset: 'BTC',
            slug: currentSig.slug,
            slotEnd: slotStart + 300000,
            isSimulated: true
        };
        const actualCost = safeQty * bestAsk;
        await updateVirtualBalance(-actualCost);
        
        const msg = `🧪 *SIMULATION ENTRY : BTC ${side}*\n• Price: $${bestAsk}\n• Qty: ${safeQty}`;
        await sendTelegramAlert(msg);
        
        // Start SL Monitoring
        SLSentinel.startMonitoring(
            String(tokenId), bestAsk, side, 0.14, bSpot, currentSig.strike,
            async (info) => console.log('SL Triggered:', info) // Mock for now
        );
        return;
    }

    // Real Execution
    try {
        let tSize = await clobClient.getTickSize(tokenId).catch(() => "0.01");
        if (Number(tSize) >= 1) tSize = "0.01";
        
        const divisor = 1 / parseFloat(tSize);
        const finalPrice = Math.min(parseFloat((Math.round(safePrice * divisor) / divisor).toFixed(4)), 0.99);
        const amount = Math.max(parseFloat((tradeAmountUsd / finalPrice).toFixed(4)), 1.0);

        const orderObj = await clobClient.createOrder(
            { tokenID: tokenId, price: finalPrice, size: amount, side: side === "UP" ? Side.BUY : Side.SELL },
            { tickSize: tSize, negRisk: currentSig.m?.negRisk ?? (tokenId.length > 50) }
        );

        const response = await clobClient.postOrder(orderObj, OrderType.GTC);
        if (response && response.orderID) {
            console.log(`[Engine] ✅ OFFICIAL Order Accepted: ${response.orderID}`);
            
            STATE.activePosition = {
                tokenId: String(tokenId), buyPrice: finalPrice, amount: amount,
                slotStart, side, asset: 'BTC', slug: currentSig.slug,
                slotEnd: slotStart + 300000, isSimulated: false
            };
            await sendTelegramAlert(`🎯 *SNIPER ENTRY : BTC ${side}*\n• Price: $${finalPrice}\n• Qty: ${amount}`);
        }
    } catch (err) {
        console.error(`[Engine] 🛡️⚠️ SDK EXECUTION FAILED:`, err.message);
    }
}
