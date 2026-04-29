import WebSocket from 'ws';

/**
 * Binance WebSocket Manager (v1.0.0)
 * Maintains a real-time stream of BTC price to eliminate polling latency.
 */
class BinanceWS {
    constructor() {
        this.ws = null;
        this.currentPrice = 0;
        this.lastUpdate = 0;
        this.reconnectAttempts = 0;
        this.url = 'wss://stream.binance.com:9443/ws/btcusdt@ticker';
    }

    start() {
        console.log('[BinanceWS] 🛡️⚓ Connecting to Binance Stream...');
        this.ws = new WebSocket(this.url);

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                // 'c' is the last price in the ticker stream
                if (msg.c) {
                    this.currentPrice = parseFloat(msg.c);
                    this.lastUpdate = Date.now();
                }
            } catch (e) {
                console.error('[BinanceWS] Parse error:', e.message);
            }
        });

        this.ws.on('open', () => {
            console.log('[BinanceWS] 🛡️⚓ Stream Connected. Receiving live BTC prices.');
            this.reconnectAttempts = 0;
        });

        this.ws.on('error', (err) => {
            console.error('[BinanceWS] Stream Error:', err.message);
        });

        this.ws.on('close', () => {
            console.warn('[BinanceWS] Stream Closed. Attempting reconnect in 5s...');
            setTimeout(() => this.reconnect(), 5000);
        });
    }

    reconnect() {
        this.reconnectAttempts++;
        if (this.reconnectAttempts > 50) {
            console.error('[BinanceWS] 🛡️⚠️ CRITICAL: Too many reconnect attempts.');
            return;
        }
        this.start();
    }

    getPrice() {
        // Fallback safety: if price is older than 10s, return 0 to trigger polling fallback
        if (Date.now() - this.lastUpdate > 10000) return 0;
        return this.currentPrice;
    }

    isReady() {
        return this.currentPrice > 0 && (Date.now() - this.lastUpdate < 10000);
    }
}

export default new BinanceWS();
