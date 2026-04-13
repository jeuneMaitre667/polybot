/**
 * STEALTH CONFIGURATION MODULE (v22.0.0 "Ghost Protocol")
 * Simplified for native got-scraping browser emulation
 */

/**
 * Returns basic stealth settings. 
 * got-scraping handles headers and TLS fingerprints automatically when used.
 */
export function getStealthProfile() {
    return {
        // We let got-scraping use its internal best-practices for Chrome mimicry
        http2: true,
        responseType: 'json',
        timeout: { request: 5000 }
    };
}

/**
 * Calculates a random jitter delay to break bot rhythmic patterns
 */
export function getJitter(baseMs = 1000, variance = 300) {
    const randomShift = Math.floor(Math.random() * variance * 2) - variance;
    return Math.max(200, baseMs + randomShift);
}

/**
 * Logs a stealth audit message
 */
export function logStealthMode(asset) {
    // Audit log restricted to avoid log flooding
}
