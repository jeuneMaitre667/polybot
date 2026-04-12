import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// On remonte d'un niveau si on est dans src/core
const WALLET_FILE = path.join(__dirname, '..', '..', 'virtual-wallet.json');

const INITIAL_CAPITAL = 1000.0;

/**
 * Lit le solde virtuel actuel. Initialise à 1000$ si le fichier n'existe pas.
 */
export function getVirtualBalance() {
    try {
        if (!fs.existsSync(WALLET_FILE)) {
            saveBalance(INITIAL_CAPITAL);
            return INITIAL_CAPITAL;
        }
        const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        return data.balance || INITIAL_CAPITAL;
    } catch (err) {
        console.error('[VirtualWallet] Read error:', err.message);
        return INITIAL_CAPITAL;
    }
}

/**
 * Met à jour le solde (delta positif ou négatif)
 */
export function updateVirtualBalance(deltaUsd) {
    const current = getVirtualBalance();
    const next = Math.max(0, current + deltaUsd);
    saveBalance(next);
    return next;
}

function saveBalance(balance) {
    try {
        const tmpFile = `${WALLET_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify({ balance, lastUpdate: new Date().toISOString() }, null, 2));
        fs.renameSync(tmpFile, WALLET_FILE);
    } catch (err) {
        console.error('[VirtualWallet] Save error:', err.message);
    }
}
