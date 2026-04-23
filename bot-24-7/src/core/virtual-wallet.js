import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAtomicUpdate, safeReadJson } from './persistence-layer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// v17.9.0: Forced Absolute Path for multi-context reliability
const WALLET_FILE = '/home/ubuntu/polybot/bot-24-7/virtual-wallet.json';

const INITIAL_CAPITAL = 915.0;

/**
 * Lit le solde virtuel actuel. 
 */
export function getVirtualBalance() {
    const data = safeReadJson(WALLET_FILE, { balance: null });
    if (data.balance === null) {
        console.error(`[Wallet] 🛡️⚠️ CRITICAL: virtual-wallet.json could not be read or balance is missing at ${WALLET_FILE}. Falling back to ${INITIAL_CAPITAL}.`);
        return INITIAL_CAPITAL;
    }
    return data.balance;
}

/**
 * Met à jour le solde (delta positif ou négatif) de manière ATOMIQUE.
 * v17.46.5: Sequential sequencing fix.
 */
export async function updateVirtualBalance(deltaUsd) {
    try {
        const result = await runAtomicUpdate(WALLET_FILE, (data) => {
            const current = data.balance ?? INITIAL_CAPITAL;
            const next = Math.max(0, parseFloat((current + deltaUsd).toFixed(2)));
            
            console.log(`[Wallet] 💰 Atomic Update: ${current.toFixed(2)} -> ${next.toFixed(2)} (${deltaUsd > 0 ? '+' : ''}${deltaUsd.toFixed(2)})`);
            
            return {
                balance: next,
                lastUpdate: new Date().toISOString()
            };
        });
        
        // v17.55.0: Enhanced safety - return balance property or fallback to disk read
        if (result && typeof result.balance === 'number') {
            return result.balance;
        }
    } catch (e) {
        console.error("[Wallet] Critical failure in update. Falling back to recovery read:", e.message);
    }
    
    return getVirtualBalance();
}
