import { WebSocket } from 'ws';
import { sendTelegramAlert } from './telegramAlerts.js';

/**
 * v17.1.0 Ultra-Fast SL Sentinel (WebSocket)
 * Sub-1s Monitoring for Polymarket Positions.
 */

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
let ws = null;
let activeSubscription = null; // { tokenId, buyPrice, side, stopLossThreshold, onTrigger }

/**
 * Starts real-time monitoring for a position.
 */
export function startMonitoring(tokenId, buyPrice, side, stopLossPct, onTrigger) {
    activeSubscription = {
        tokenId,
        buyPrice,
        side,
        stopLossThreshold: buyPrice * (1 - stopLossPct),
        onTrigger
    };

    console.log(`[SL Sentinel] ⚡ Monitoring started for ${tokenId} (Target SL: ${activeSubscription.stopLossThreshold.toFixed(3)})`);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        initWebSocket();
    } else {
        subscribe();
    }
}

/**
 * Stop monitoring.
 */
export function stopMonitoring() {
    if (activeSubscription) {
        console.log(`[SL Sentinel] 🛡️ Monitoring cleared for ${activeSubscription.tokenId}`);
        activeSubscription = null;
        // We keep the WS open for future trades but unsubscribe if needed (optional for 5m)
    }
}

function initWebSocket() {
    console.log(`[SL Sentinel] Connecting to Polymarket WebSocket...`);
    ws = new WebSocket(WS_URL);

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
        } catch (e) {
            // Silently ignore malformed JSON or pings
        }
    });

    ws.on('error', (err) => {
        console.error(`[SL Sentinel] ❌ WebSocket Error:`, err.message);
    });

    ws.on('close', () => {
        console.warn(`[SL Sentinel] ⚠️ WebSocket Closed. Reconnecting in 5s...`);
        setTimeout(initWebSocket, 5000);
    });

    // Heartbeat
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("PING");
        }
    }, 20000);
}

function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSubscription) return;

    const msg = {
        type: "market",
        assets_ids: [activeSubscription.tokenId],
        markets: [],
        initial_dump: true
    };
    ws.send(JSON.stringify(msg));
    console.log(`[SL Sentinel] 📡 Subscribed to market feed for ${activeSubscription.tokenId}`);
}

function processOrderBook(book) {
    if (!activeSubscription) return;

    // We hold a BUY position, so we need to sell. 
    // To sell, we look at the BEST BID (what buyers are offering right now).
    const bestBid = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
    
    if (!bestBid) return;

    const pnlPct = (bestBid - activeSubscription.buyPrice) / activeSubscription.buyPrice;
    
    // Debug log every few updates to avoid overwhelming console
    if (Math.random() < 0.05) {
        // console.log(`[SL Sentinel] Spot: ${bestBid} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
    }

    if (bestBid <= activeSubscription.stopLossThreshold) {
        console.warn(`[SL Sentinel] 🚨 STOP LOSS TRIGGERED at ${bestBid}! (Threshold: ${activeSubscription.stopLossThreshold})`);
        
        const triggerFn = activeSubscription.onTrigger;
        const info = { ...activeSubscription, currentPrice: bestBid, pnlPct };
        
        // Safety: clear subscription immediately to avoid multiple triggers
        stopMonitoring();
        
        if (triggerFn) triggerFn(info);
    }
}
