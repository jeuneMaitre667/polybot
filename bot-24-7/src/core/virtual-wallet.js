import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAtomicUpdate, safeReadJson } from './persistence-layer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// On remonte d'un niveau si on est dans src/core
const WALLET_FILE = path.join(__dirname, '..', '..', 'virtual-wallet.json');

const INITIAL_CAPITAL = 222.21;

/**
 * Lit le solde virtuel actuel. 
 */
export function getVirtualBalance() {
    const data = safeReadJson(WALLET_FILE, { balance: INITIAL_CAPITAL });
    return data.balance || INITIAL_CAPITAL;
}

/**
 * Met à jour le solde (delta positif ou négatif) de manière ATOMIQUE.
 * v17.46.5: Sequential sequencing fix.
 */
export async function updateVirtualBalance(deltaUsd) {
    try {
        const result = await runAtomicUpdate(WALLET_FILE, (data) => {
            // v34.4: Force 2 decimal precision for zero-drift ROI accounting
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
