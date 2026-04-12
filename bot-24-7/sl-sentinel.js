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
 * Returns true if WebSocket is alive.
 */
export function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
}

// v17.24.0: Passive connection disabled. 
// Connection is now triggered only when startMonitoring is called.

/**
 * Stop monitoring.
 */
export function stopMonitoring() {
    if (activeSubscription) {
        console.log(`[SL Sentinel] 🛡️ Monitoring cleared for ${activeSubscription.tokenId}`);
        activeSubscription = null;
        
        // v17.24.0: Close WS when not in use to avoid reconnection spam
        if (ws) {
            console.log(`[SL Sentinel] ⚡ Closing WebSocket (No active position).`);
            ws.removeAllListeners();
            ws.close();
            ws = null;
        }
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
        if (activeSubscription) {
            console.warn(`[SL Sentinel] ⚠️ WebSocket Closed. Reconnecting in 5s...`);
            setTimeout(initWebSocket, 5000);
        } else {
            console.log(`[SL Sentinel] WebSocket closed (Normal).`);
        }
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
    const topBid = book.bids && book.bids.length > 0 ? book.bids[0] : null;
    let bestBid = topBid ? parseFloat(topBid.price) : null;
    
    // v17.36.19: Noise Protection
    // Ignore extreme outliers (dust bids) often received during initial pipe sync.
    // If a market starts around 0.50, a bid of 0.005 is noise, not a real crash.
    if (!bestBid || bestBid < 0.01) return;

    const pnlPct = (bestBid - activeSubscription.buyPrice) / activeSubscription.buyPrice;
    
    // Debug log status (5% of messages)
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
