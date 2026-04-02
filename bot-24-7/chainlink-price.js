/**
 * Module Chainlink Multi-Asset Price Feed - Polygon Mainnet (v5.4.1)
 * 
 * Lit les prix BTC/USD, ETH/USD et SOL/USD depuis les smart contracts Chainlink sur Polygon.
 * 
 * Contracts:
 * - BTC/USD: 0xc907E116054Ad103354f2D350FD2514433D57F6f
 * - ETH/USD: 0xF9680D99D99444723d9b912632E2943722415636
 * - SOL/USD: 0x1073039600E251f5C953683105CC1E4C7d99528e
 */
import { ethers } from 'ethers';

// --- Configuration ---
const DATA_FEEDS = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
  SOL: '0x10C8264C0935B3B9870013E057F330FF3E9C56DC',
};
const CHAINLINK_DECIMALS = 8;

const ALCHEMY_RPC = process.env.POLYGON_RPC_URL;
const FALLBACK_RPCS = (process.env.POLYGON_RPC_FALLBACK || 'https://1rpc.io/matic,https://rpc.ankr.com/polygon,https://polygon.llamarpc.com').split(',').map(u => u.trim()).filter(Boolean);

const RPC_ENDPOINTS = ALCHEMY_RPC ? [ALCHEMY_RPC, ...FALLBACK_RPCS] : FALLBACK_RPCS;

const AGGREGATOR_V3_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
];

// --- Cache par Asset ---
const CACHE_TTL_MS = 2000;
const assetCaches = {
  BTC: { price: null, updatedAt: null, roundId: null, fetchedAt: 0, source: 'chainlink' },
  ETH: { price: null, updatedAt: null, roundId: null, fetchedAt: 0, source: 'chainlink' },
  SOL: { price: null, updatedAt: null, roundId: null, fetchedAt: 0, source: 'chainlink' },
};

let currentProviderIndex = 0;
let providerInstance = null;
const contractInstances = new Map(); // address -> contract

function getProvider() {
  if (providerInstance) return providerInstance;
  const url = RPC_ENDPOINTS[currentProviderIndex % RPC_ENDPOINTS.length];
  providerInstance = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true });
  return providerInstance;
}

function getContract(asset) {
  const rawAddress = DATA_FEEDS[asset];
  if (!rawAddress) return null;
  const address = ethers.getAddress(rawAddress.toLowerCase()); // Fix checksum v5.4.1
  if (contractInstances.has(address)) return contractInstances.get(address);
  
  const provider = getProvider();
  const contract = new ethers.Contract(address, AGGREGATOR_V3_ABI, provider);
  contractInstances.set(address, contract);
  return contract;
}

function rotateProvider() {
  currentProviderIndex = (currentProviderIndex + 1) % RPC_ENDPOINTS.length;
  providerInstance = null;
  contractInstances.clear();
}

/** Legacy support pour index.js v4/v5 */
export async function getChainlinkBtcPrice() {
  return getChainlinkPrice('BTC');
}

/** 
 * Récupère le prix Chainlink pour un actif donné (BTC, ETH, SOL).
 */
export async function getChainlinkPrice(asset = 'BTC') {
  const cleanAsset = String(asset).toUpperCase();
  const cache = assetCaches[cleanAsset];
  if (!cache) return { price: null, error: 'Asset non supporté' };

  const now = Date.now();
  if (cache.price != null && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return { ...cache, stale: false };
  }

  // v5.6.4: On repart TOUJOURS de l'index 0 (Alchemy) pour ne pas rester bloqué sur un fallback
  currentProviderIndex = 0; 
  providerInstance = null;
  contractInstances.clear();

  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    try {
      const contract = getContract(cleanAsset);
      if (!contract) break;
      
      const data = await contract.latestRoundData();
      const rawPrice = Number(data.answer) / Math.pow(10, CHAINLINK_DECIMALS);
      const updatedAtMs = Number(data.updatedAt) * 1000;

      const result = {
        price: rawPrice,
        updatedAt: updatedAtMs,
        roundId: data.roundId.toString(),
        fetchedAt: now,
        source: 'chainlink',
        ageSec: Math.floor((now - updatedAtMs) / 1000),
      };
      assetCaches[cleanAsset] = result;
      return { ...result, stale: result.ageSec > 120 };
    } catch (err) {
      console.warn(`[Chainlink] [${cleanAsset}] Erreur RPC Polygon [${attempt}]: ${err.message}`);
      rotateProvider(); // Passe au suivant
    }
  }

  if (cache.price != null) return { ...cache, stale: true, source: 'chainlink_stale_cache' };
  return { price: null, updatedAt: null, roundId: null, source: 'chainlink_unavailable', stale: true };
}

export async function captureStrikeAtSlotOpen(asset, slotSlug, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const result = await getChainlinkPrice(asset);
    if (result.price != null && !result.stale) {
      console.log(`[Strike] [${asset}] Capturé pour ${slotSlug}: $${result.price.toFixed(2)}`);
      return { price: result.price, slotSlug, asset, capturedAt: new Date().toISOString(), source: 'chainlink_polygon', roundId: result.roundId };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { price: null, slotSlug, asset, capturedAt: new Date().toISOString(), source: 'capture_failed', roundId: null };
}

export function getChainlinkHealthStats(asset = 'BTC') {
  const cache = assetCaches[asset.toUpperCase()];
  const currentRpc = RPC_ENDPOINTS[currentProviderIndex % RPC_ENDPOINTS.length] || 'Unknown';
  const rpcLabel = currentRpc.includes('alchemy') ? 'Alchemy (Private)' : 'Public Fallback';
  return { lastPrice: cache?.price, source: cache?.source, rpc: rpcLabel };
}
