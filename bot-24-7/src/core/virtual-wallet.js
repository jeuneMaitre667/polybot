import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAtomicUpdate, safeReadJson } from './persistence-layer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// On remonte d'un niveau si on est dans src/core
const WALLET_FILE = path.join(__dirname, '..', '..', 'virtual-wallet.json');

const INITIAL_CAPITAL = 1000.0;

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
    const result = await runAtomicUpdate(WALLET_FILE, (data) => {
        const current = data.balance || INITIAL_CAPITAL;
        const next = Math.max(0, current + deltaUsd);
        
        console.log(`[Wallet] 💰 Atomic Update: ${current.toFixed(2)} -> ${next.toFixed(2)} (${deltaUsd > 0 ? '+' : ''}${deltaUsd.toFixed(2)})`);
        
        return {
            balance: next,
            lastUpdate: new Date().toISOString()
        };
    });
    
    return result.balance;
}
