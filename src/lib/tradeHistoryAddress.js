/**
 * Adresse utilisée pour la Data API /trades (souvent le proxy Polymarket = Profil),
 * pas forcément l’EOA renvoyé par MetaMask / Phantom.
 */

export function isHexAddress(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(s.trim());
}

/**
 * @param {{ connectedAddress?: string | null, botFunderCandidates?: (string|null|undefined)[], envRaw?: string }} p
 * @returns {{ address: string | null, source: 'env' | 'bot' | 'wallet' | null }}
 */
export function resolveTradeHistoryAddress({ connectedAddress = null, botFunderCandidates = [], envRaw } = {}) {
  const env = typeof envRaw === 'string' ? envRaw.trim() : String(import.meta.env.VITE_TRADE_HISTORY_ADDRESS || '').trim();
  if (isHexAddress(env)) {
    return { address: env, source: 'env' };
  }
  for (const c of botFunderCandidates) {
    if (isHexAddress(c)) {
      return { address: c.trim(), source: 'bot' };
    }
  }
  if (isHexAddress(connectedAddress)) {
    return { address: connectedAddress.trim(), source: 'wallet' };
  }
  return { address: null, source: null };
}

export function tradeHistorySourceLabel(source) {
  if (source === 'env') return 'Adresse fixe (.env)';
  if (source === 'bot') return 'Compte bot (last-order / funder)';
  if (source === 'wallet') return 'Wallet connecté';
  return null;
}
