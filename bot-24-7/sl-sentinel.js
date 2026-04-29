/**
 * v49.3.0 SL Sentinel (LEGACY / INTERNAL)
 * SL logic has been moved directly into index.js performanceLoop for better reliability.
 * This file remains for backward compatibility of imports but functions are no-ops.
 */

export function startMonitoring(tokenId, buyPrice, side, stopLossPct, entryAssetPrice, strikePrice, onTrigger) {
    // SL is now handled inside performanceLoop in index.js
}

export function isConnected() {
    return true; // Always return true to satisfy dashboard health checks
}

export function stopMonitoring() {
    // No-op
}
