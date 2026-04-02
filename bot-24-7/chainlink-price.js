/**
 * Module Chainlink BTC/USD Price Feed - Polygon Mainnet
 * 
 * Lit le prix BTC/USD depuis le smart contract Chainlink sur Polygon.
 * C'est la source de résolution la plus proche de Polymarket (Polygon).
 * 
 * Contract: 0xc907E116054Ad103354f2D350FD2514433D57F6f (BTC/USD, 8 decimals)
 * Méthode: latestRoundData() → { roundId, answer, startedAt, updatedAt, answeredInRound }
 */
import { ethers } from 'ethers';

// --- Configuration ---
const CHAINLINK_BTC_USD_ADDRESS = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const CHAINLINK_DECIMALS = 8;

// RPC Polygon : Alchemy / QuickNode en priorité (30-80ms), publics en fallback (300-800ms).
// Utilisation de la clé fournie par l'utilisateur pour l'optimisation.
const ALCHEMY_KEY = 'qDLYcGckGL323XVWQot_r';
const PRIMARY_RPC = `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const FALLBACK_RPCS = [
  'https://polygon-rpc.com',
  'https://rpc-mainnet.maticvigil.com',
];

const RPC_ENDPOINTS = [PRIMARY_RPC, ...FALLBACK_RPCS];

// ABI minimal pour latestRoundData()
const AGGREGATOR_V3_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
];

// --- Cache ---
const CACHE_TTL_MS = 2000; // 2s de cache (Audit Compliance v5.2.0)
let cachedPrice = { price: null, updatedAt: null, roundId: null, fetchedAt: 0, source: 'chainlink' };
let currentProviderIndex = 0;
let providerInstance = null;
let contractInstance = null;

function getContract() {
  if (contractInstance && providerInstance) return contractInstance;
  const url = RPC_ENDPOINTS[currentProviderIndex % RPC_ENDPOINTS.length];
  providerInstance = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true });
  contractInstance = new ethers.Contract(CHAINLINK_BTC_USD_ADDRESS, AGGREGATOR_V3_ABI, providerInstance);
  return contractInstance;
}

function rotateProvider() {
  currentProviderIndex = (currentProviderIndex + 1) % RPC_ENDPOINTS.length;
  providerInstance = null;
  contractInstance = null;
}

export async function getChainlinkBtcPrice() {
  const now = Date.now();
  if (cachedPrice.price != null && (now - cachedPrice.fetchedAt) < CACHE_TTL_MS) {
    return { ...cachedPrice, stale: false };
  }

  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    try {
      const contract = getContract();
      const data = await contract.latestRoundData();
      const rawPrice = Number(data.answer) / Math.pow(10, CHAINLINK_DECIMALS);
      const updatedAtMs = Number(data.updatedAt) * 1000;

      cachedPrice = {
        price: rawPrice,
        updatedAt: updatedAtMs,
        roundId: data.roundId.toString(),
        fetchedAt: now,
        source: 'chainlink',
        ageSec: Math.floor((now - updatedAtMs) / 1000),
      };
      return { ...cachedPrice, stale: cachedPrice.ageSec > 120 };
    } catch (err) {
      console.warn(`[Chainlink] Erreur RPC Polygon (${RPC_ENDPOINTS[currentProviderIndex % RPC_ENDPOINTS.length]}): ${err.message}`);
      rotateProvider();
    }
  }

  if (cachedPrice.price != null) return { ...cachedPrice, stale: true, source: 'chainlink_stale_cache' };
  return { price: null, updatedAt: null, roundId: null, source: 'chainlink_unavailable', stale: true };
}

export async function captureStrikeAtSlotOpen(slotSlug, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const result = await getChainlinkBtcPrice();
    if (result.price != null && !result.stale) {
      console.log(`[Strike] Capturé via Alchemy (Polygon) pour ${slotSlug}: $${result.price.toFixed(2)}`);
      return { price: result.price, slotSlug, capturedAt: new Date().toISOString(), source: 'chainlink_polygon', roundId: result.roundId };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { price: null, slotSlug, capturedAt: new Date().toISOString(), source: 'capture_failed', roundId: null };
}

export function getChainlinkHealthStats() {
  return { lastPrice: cachedPrice.price, source: cachedPrice.source, rpc: 'Alchemy Polygon' };
}
