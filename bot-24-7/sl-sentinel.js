import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { sendTelegramAlert } from './telegramAlerts.js';
import * as RiskManager from './risk-manager.js';

/**
 * v44.0 Pure Price Sentinel
 * Immediate reaction on raw market price.
 */

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
let ws = null;
let activeSubscription = null;

export function startMonitoring(tokenId, buyPrice, side, stopLossPct, entryAssetPrice, strikePrice, onTrigger) {
    activeSubscription = {
        tokenId,
        buyPrice,
        side,
        entryAssetPrice,
        strikePrice,
        onTrigger
    };

    console.log(`[SL Sentinel] ⚡ Monitoring started for ${tokenId} (Target SL: -${(stopLossPct * 100).toFixed(1)}% Net PnL)`);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        initWebSocket();
    } else {
        subscribe();
    }
}

export function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
}

export function stopMonitoring() {
    if (activeSubscription) {
        console.log(`[SL Sentinel] 🛡️ Monitoring cleared for ${activeSubscription.tokenId}`);
        activeSubscription = null;
        if (ws) {
            console.log(`[SL Sentinel] ⚡ Closing WebSocket (No active position).`);
            ws.removeAllListeners();
            ws.close();
            ws = null;
        }
    }
}

function initWebSocket() {
    const proxyUrl = process.env.PROXY_URL;
    const options = {};
    if (proxyUrl) {
        options.agent = new HttpsProxyAgent(proxyUrl);
    }
    ws = new WebSocket(WS_URL, options);

    ws.on('open', () => {
        console.log(`[SL Sentinel] ✅ WebSocket Connected.`);
        if (activeSubscription) subscribe();
    });

    ws.on('message', (data) => {
        try {
            if (data === "PONG") return;
            const message = JSON.parse(data);
            if (message.event_type === 'book' && activeSubscription) {
                if (message.asset_id === activeSubscription.tokenId) {
                    processOrderBook(message);
                }
            }
        } catch (e) {}
    });

    ws.on('error', (err) => {
        console.error(`[SL Sentinel] ❌ WebSocket Error:`, err.message);
    });

    ws.on('close', () => {
        if (activeSubscription) setTimeout(initWebSocket, 5000);
    });

    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 20000);
}

function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSubscription) return;
    const msg = {
        type: "market",
        assets_ids: [activeSubscription.tokenId],
        initial_dump: true
    };
    ws.send(JSON.stringify(msg));
    console.log(`[SL Sentinel] 📡 Subscribed to market feed for ${activeSubscription.tokenId}`);
}

function processOrderBook(book) {
    if (!activeSubscription) return;

    // v44.0: PURE BEST BID (No Volume/Depth Filter)
    const topBid = book.bids && book.bids.length > 0 ? book.bids[0] : null;
    if (!topBid) return;

    const currentPrice = parseFloat(topBid.price);
    const pnlPct = (currentPrice - activeSubscription.buyPrice) / activeSubscription.buyPrice;

    const isTriggered = RiskManager.shouldTriggerStopLoss(
        activeSubscription.buyPrice, 
        currentPrice,
        activeSubscription.side,
        activeSubscription.entryAssetPrice,
        global.lastBinanceSpot,
        activeSubscription.strikePrice
    );

    if (isTriggered) {
        console.warn(`[SL Sentinel] 🚨 TRIGGERED at ${currentPrice}! (PnL: ${(pnlPct * 100).toFixed(2)}%)`);
        const triggerFn = activeSubscription.onTrigger;
        const info = { ...activeSubscription, currentPrice, pnlPct };
        stopMonitoring();
        if (triggerFn) triggerFn(info);
    }
}
