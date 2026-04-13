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
const FALLBACK_RPCS = (process.env.POLYGON_RPC_FALLBACK || 'https://polygon-rpc.com,https://1rpc.io/matic,https://rpc.ankr.com/polygon,https://polygon.llamarpc.com,https://rpc-mainnet.maticvigil.com').split(',').map(u => u.trim()).filter(Boolean);

const RPC_ENDPOINTS = ALCHEMY_RPC ? [ALCHEMY_RPC, ...FALLBACK_RPCS] : FALLBACK_RPCS;

// --- Sanity Guard Thresholds (v7.16.38) ---
// If price is below these, it's likely stale data from a non-syncing node (e.g. ETH at $2049 from 2023).
const SANITY_MIN_PRICE = {
  BTC: 40000,
  ETH: 1500,
  SOL: 40,
};

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
      const provider = new ethers.providers.JsonRpcProvider(url, 137);
      const contract = new ethers.Contract(DATA_FEEDS[cleanAsset], AGGREGATOR_V3_ABI, provider);
      const data = await contract.latestRoundData();
      const rawPrice = Number(data.answer) / Math.pow(10, CHAINLINK_DECIMALS);
      const updatedAtMs = Number(data.updatedAt) * 1000;

      // --- Sanity Guard (v7.16.38) ---
      const minPrice = SANITY_MIN_PRICE[cleanAsset] || 0;
      if (rawPrice < minPrice) {
          throw new Error(`Sanity Guard: ${cleanAsset} price ${rawPrice} is below threshold ${minPrice}. Likely stale node.`);
      }

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
    // v7.16.57 : Seuil de fraîcheur réduit à 60s (Demande utilisateur pour éviter strike décalé)
    return { ...result, stale: result.ageSec > 60 };
  } catch (err) {
    if (err.errors) {
      console.warn(`[Chainlink] [${cleanAsset}] RPC Errors detail:`, err.errors.map(e => e.message));
    }
    console.warn(`[Chainlink] [${cleanAsset}] Tous les RPC ont échoué ou prix invalide ! tentative de récupération depuis le cache.`);
    if (cache.price != null) return { ...cache, stale: true, source: 'chainlink_stale_cache' };
    return { price: null, updatedAt: null, roundId: null, source: 'chainlink_unavailable', stale: true };
  }
}


/** Legacy support pour index.js */
export async function getChainlinkBtcPrice() {
  return getChainlinkPrice('BTC');
}

/**
 * captureStrikeAtSlotOpen(asset, slotSlug, targetTimestampMs, maxRetries)
 * v7.0.0 : Chasse le prix Chainlink officiel.
 * On attend que l'oracle publie un prix dont l'updatedAt est >= au début théorique du slot.
 */
export async function captureStrikeAtSlotOpen(asset, slotSlug, targetTimestampMs = 0, maxRetries = 20) {
  console.log(`[Strike] Lancement capture pour ${asset} (Cible: ${new Date(targetTimestampMs).toISOString()})`);
  
  // Attente de sécurité d'un cycle block (ex: 2.5s) au lieu de 10s, 
  // pour être juste sur la ligne de départ et capter le prix actif à la seconde exacte.
  await new Promise(r => setTimeout(r, 5000));
  
  for (let i = 0; i < maxRetries; i++) {
    const result = await getChainlinkPrice(asset);
    
    // Condition de succès : un prix existe et n'est pas périmé > 2h (protection contre nodes désync)
    const ageMs = targetTimestampMs - result.updatedAt;
    if (result.price != null && ageMs < 7200000) {
      console.log(`[Strike] [${asset}] ✅ ANCRÉ via ${result.rpcLabel}: $${result.price.toFixed(2)} (Différence update/début slot: ${-ageMs}ms)`);
      return { 
        price: result.price, 
        slotSlug, 
        asset, 
        capturedAt: new Date().toISOString(), 
        source: 'chainlink_polygon', 
        updatedAt: result.updatedAt,
        roundId: result.roundId 
      };
    }
    
    // Log de progression tous les 3 essais
    if (i % 3 === 0) {
      console.log(`[Strike] [${asset}] Attente oracle... (attempt ${i+1}/${maxRetries})`);
    }
    
    await new Promise(r => setTimeout(r, 1500)); // Polling toutes les 1.5s
  }
  
  // Backup: Si on n'a vraiment rien après 30s, on prend la dernière valeur connue
  console.warn(`[Strike] [${asset}] ⚠️TIMEOUT: Impossible de trouver un prix post-ouverture. Utilisation du fallback.`);
  const fallback = await getChainlinkPrice(asset);
  return { 
    price: fallback.price, 
    slotSlug, 
    asset, 
    capturedAt: new Date().toISOString(), 
    source: 'chainlink_fallback', 
    updatedAt: fallback.updatedAt,
    roundId: fallback.roundId 
  };
}

export function getChainlinkHealthStats(asset = 'BTC') {
  const cache = assetCaches[asset.toUpperCase()];
  return { lastPrice: cache?.price, source: cache?.source, rpc: lastWinningRpc };
}

/** 
 * Accès synchrone au dernier prix en cache (v6.3.4 Fix)
 */
export function getChainlinkPriceCached(asset = 'BTC') {
  const cleanAsset = String(asset).toUpperCase();
  return assetCaches[cleanAsset]?.price || null;
}
