/**
 * v45.0 Stable SL Sentinel (PASSIVE)
 * The WebSocket is now disabled for SL to avoid ghost bids.
 * SL logic is handled by the main loop polling in index.js.
 */

export function startMonitoring(tokenId, buyPrice, side, stopLossPct, entryAssetPrice, strikePrice, onTrigger) {
    console.log(`[SL Sentinel] 🛡️ Stable Mode: SL is handled by main loop. WebSocket monitoring disabled.`);
}

export function isConnected() {
    return false;
}

export function stopMonitoring() {
    // No-op
}
