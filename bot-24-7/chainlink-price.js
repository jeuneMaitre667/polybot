/**
 * Module Chainlink Multi-Asset Price Feed - Polygon Mainnet (v6.2.0)
 * 
 * Implement Multi-RPC Fallback (Parallel Race) to ensure lowest latency.
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

let lastWinningRpc = 'Unknown';

/** 
 * Récupère le prix Chainlink pour un actif donné (BTC, ETH, SOL).
 * utilise une course (Race) entre tous les RPC disponibles pour garantir la fraîcheur.
 */
export async function getChainlinkPrice(asset = 'BTC') {
  const cleanAsset = String(asset).toUpperCase();
  const cache = assetCaches[cleanAsset];
  if (!cache) return { price: null, error: 'Asset non supporté' };

  const now = Date.now();
  if (cache.price != null && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return { ...cache, stale: false };
  }

  // Multi-RPC Race (v6.2.0)
  // On lance tous les RPC en parallèle et on prend le premier succès.
  const promises = RPC_ENDPOINTS.map(async (url) => {
    try {
      const provider = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true });
      const contract = new ethers.Contract(DATA_FEEDS[cleanAsset], AGGREGATOR_V3_ABI, provider);
      const data = await contract.latestRoundData();
      const rawPrice = Number(data.answer) / Math.pow(10, CHAINLINK_DECIMALS);
      const updatedAtMs = Number(data.updatedAt) * 1000;
      
      const rpcLabel = url.includes('alchemy') ? 'Alchemy (Private)' : url.split('//')[1]?.split('/')[0] || 'Public';
      
      return {
        price: rawPrice,
        updatedAt: updatedAtMs,
        roundId: data.roundId.toString(),
        fetchedAt: Date.now(),
        source: 'chainlink',
        rpcLabel,
        ageSec: Math.floor((Date.now() - updatedAtMs) / 1000),
      };
    } catch (err) {
      // Pour Promise.any, on jette une erreur pour l'écarter.
      throw err;
    }
  });

  try {
    const result = await Promise.any(promises);
    assetCaches[cleanAsset] = result;
    lastWinningRpc = result.rpcLabel;
    return { ...result, stale: result.ageSec > 120 };
  } catch (err) {
    console.warn(`[Chainlink] [${cleanAsset}] Tous les RPC ont échoué ! tentative de récupération depuis le cache.`);
    if (cache.price != null) return { ...cache, stale: true, source: 'chainlink_stale_cache' };
    return { price: null, updatedAt: null, roundId: null, source: 'chainlink_unavailable', stale: true };
  }
}

/** Legacy support pour index.js */
export async function getChainlinkBtcPrice() {
  return getChainlinkPrice('BTC');
}

export async function captureStrikeAtSlotOpen(asset, slotSlug, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const result = await getChainlinkPrice(asset);
    if (result.price != null && !result.stale) {
      console.log(`[Strike] [${asset}] Capturé via ${result.rpcLabel}: $${result.price.toFixed(2)}`);
      return { price: result.price, slotSlug, asset, capturedAt: new Date().toISOString(), source: 'chainlink_polygon', roundId: result.roundId };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { price: null, slotSlug, asset, capturedAt: new Date().toISOString(), source: 'capture_failed', roundId: null };
}

export function getChainlinkHealthStats(asset = 'BTC') {
  const cache = assetCaches[asset.toUpperCase()];
  return { lastPrice: cache?.price, source: cache?.source, rpc: lastWinningRpc };
}
