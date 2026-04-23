import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { sendTelegramAlert } from './telegramAlerts.js';
import * as RiskManager from './risk-manager.js';

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
    const proxyUrl = process.env.PROXY_URL;
    const options = {};
    
    if (proxyUrl) {
        console.log(`[SL Sentinel] 🌐 Using Proxy for WebSocket: ${proxyUrl.split('@')[1] || proxyUrl}`);
        options.agent = new HttpsProxyAgent(proxyUrl);
    }

    console.log(`[SL Sentinel] Connecting to Polymarket WebSocket...`);
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
            // v24.1.4: Visible Heartbeat for user peace of mind
            if (activeSubscription) {
                console.log(`[SL Sentinel] 💓 Heartbeat: Monitoring ${activeSubscription.tokenId} active...`);
            }
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
    let bidSize = topBid ? parseFloat(topBid.size) : 0;
    
    // v17.36.21: Advanced Noise & Slippage Protection
    if (!bestBid) return;

    // 1. Minimum Liquidity Filter: Ignore bids with < 1 contracts (dust)
    if (bidSize < 1) return;

    // v43.0: Depth-Aware Price Calculation (Anti-Ghost Bids)
    // We find the price where we can actually sell $100 worth of tokens.
    const MIN_DEPTH_USD = 100.0;
    let cumulativeValue = 0;
    let depthAwarePrice = 0;

    for (const bid of book.bids) {
        const price = parseFloat(bid.price);
        const size = parseFloat(bid.size);
        cumulativeValue += price * size;
        
        if (cumulativeValue >= MIN_DEPTH_USD) {
            depthAwarePrice = price;
            break;
        }
    }

    // If depth is not reached (e.g. less than $100 of total bids), we ignore the update
    // This protects against fake liquidity gaps and ghost bids.
    if (depthAwarePrice === 0) return;

    if (depthAwarePrice === 0) return;

    const pnlPct = (depthAwarePrice - activeSubscription.buyPrice) / activeSubscription.buyPrice;
    
    // DEBUG LOG: See what the sentinel is actually doing
    if (depthAwarePrice < activeSubscription.buyPrice * 0.90) {
        console.log(`[SL DEBUG] Potential Trigger! DepthPrice: ${depthAwarePrice} | FirstBid: ${book.bids[0].price} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
    }

    const isTriggered = RiskManager.shouldTriggerStopLoss(
        activeSubscription.buyPrice, 
        depthAwarePrice,
        activeSubscription.side,
        activeSubscription.entryAssetPrice,
        global.lastBinanceSpot,
        activeSubscription.strikePrice
    );

    if (isTriggered) {
        console.warn(`[SL Sentinel] 🚨 SWISS GUARD TRIGGERED at DepthPrice: ${depthAwarePrice}! (FirstBid was ${book.bids[0].price})`);
        
        const triggerFn = activeSubscription.onTrigger;
        const info = { ...activeSubscription, currentPrice: bestBid, pnlPct };
        
        // Safety: clear subscription immediately to avoid multiple triggers
        stopMonitoring();
        
        if (triggerFn) triggerFn(info);
    }
}
