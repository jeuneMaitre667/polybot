import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { ethers } from 'ethers';

const BRIDGE_BASE_URL = 'https://bridge.polymarket.com';
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'.toLowerCase();
const TRANSFER_TOPIC0 = '0xddf252ad00000000000000000000000000000000000000000000000000000000';

function toKey(chainId, tokenAddress) {
  return `${String(chainId || '').trim()}:${String(tokenAddress || '').trim().toLowerCase()}`;
}

function baseUnitToFloat(baseUnit, decimals) {
  const raw = String(baseUnit ?? '').trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 30) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const out = n / 10 ** d;
  return Number.isFinite(out) ? out : null;
}

function toTopicAddress(address) {
  const a = String(address || '').toLowerCase().replace(/^0x/, '');
  if (!/^[a-f0-9]{40}$/.test(a)) return null;
  return `0x${'0'.repeat(24)}${a}`;
}

function parseHexBigInt(hexValue) {
  const h = String(hexValue || '').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(h)) return null;
  try {
    return BigInt(h);
  } catch {
    return null;
  }
}

function formatUsdcFromUnits(unitsBigInt) {
  if (unitsBigInt == null) return null;
  const out = Number(unitsBigInt) / 1_000_000;
  return Number.isFinite(out) ? out : null;
}

function extractUsdcTransferIn(receipt, toAddress) {
  const toTopic = toTopicAddress(toAddress);
  if (!toTopic) return null;
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  let totalUnits = 0n;
  for (const log of logs) {
    const token = String(log?.address || '').toLowerCase();
    if (token !== USDC_E_POLYGON) continue;
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (String(topics?.[0] || '').toLowerCase() !== TRANSFER_TOPIC0) continue;
    if (String(topics?.[2] || '').toLowerCase() !== toTopic) continue;
    const v = parseHexBigInt(log?.data);
    if (v != null) totalUnits += v;
  }
  if (totalUnits <= 0n) return null;
  return formatUsdcFromUnits(totalUnits);
}

async function fetchReceiptViaEtherscan(txHash, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  try {
    const { data } = await axios.get('https://api.etherscan.io/v2/api', {
      params: {
        chainid: 137,
        module: 'proxy',
        action: 'eth_getTransactionReceipt',
        txhash: txHash,
        apikey: key,
      },
      timeout: 12000,
    });
    return data?.result || null;
  } catch {
    return null;
  }
}

async function fetchReceiptViaRpc(txHash, rpcUrls) {
  for (const url of rpcUrls) {
    const u = String(url || '').trim();
    if (!u) continue;
    try {
      const provider = new ethers.providers.JsonRpcProvider(u);
      const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
      if (receipt) return receipt;
    } catch {
      // ignore current RPC and try next one
    }
  }
  return null;
}

/**
 * Dépôts bridge détectés automatiquement (approx USDC selon les décimales du token source).
 * @param {string | null} userAddress
 */
export function useBridgeDeposits(userAddress) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [depositAddress, setDepositAddress] = useState(null);
  const [items, setItems] = useState([]);
  const [unsupportedItems, setUnsupportedItems] = useState([]);
  const [inferredTopupItems, setInferredTopupItems] = useState([]);
  const [totalApproxUsdc, setTotalApproxUsdc] = useState(0);

  const fetchDeposits = useCallback(async () => {
    const addr = String(userAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      setLoading(false);
      setError(null);
      setDepositAddress(null);
      setItems([]);
      setInferredTopupItems([]);
      setTotalApproxUsdc(0);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [{ data: assetsData }, { data: depositData }] = await Promise.all([
        axios.get(`${BRIDGE_BASE_URL}/supported-assets`, { timeout: 15000 }),
        axios.post(
          `${BRIDGE_BASE_URL}/deposit`,
          { address: addr },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
          },
        ),
      ]);

      const evmDepositAddress = depositData?.address?.evm || null;
      setDepositAddress(evmDepositAddress);
      if (!evmDepositAddress) {
        setItems([]);
        setUnsupportedItems([]);
        setInferredTopupItems([]);
        setTotalApproxUsdc(0);
        return;
      }

      const tokenMeta = new Map();
      const supportedAssets = Array.isArray(assetsData?.supportedAssets) ? assetsData.supportedAssets : [];
      for (const a of supportedAssets) {
        tokenMeta.set(toKey(a?.chainId, a?.token?.address), {
          decimals: a?.token?.decimals,
          symbol: a?.token?.symbol || null,
        });
      }

      const { data: statusData } = await axios.get(`${BRIDGE_BASE_URL}/status/${evmDepositAddress}`, { timeout: 15000 });
      const txs = Array.isArray(statusData?.transactions) ? statusData.transactions : [];
      const completed = txs
        .filter((t) => String(t?.status || '').toUpperCase() === 'COMPLETED')
        .filter((t) => String(t?.toChainId || '') === '137')
        .filter((t) => String(t?.toTokenAddress || '').toLowerCase() === USDC_E_POLYGON)
        .map((t) => {
          const meta = tokenMeta.get(toKey(t?.fromChainId, t?.fromTokenAddress));
          const amountApprox = baseUnitToFloat(t?.fromAmountBaseUnit, meta?.decimals);
          return {
            txHash: t?.txHash || null,
            createdTimeMs: Number(t?.createdTimeMs) || null,
            fromChainId: t?.fromChainId || null,
            fromTokenAddress: t?.fromTokenAddress || null,
            fromSymbol: meta?.symbol || null,
            amountApprox,
          };
        })
        .sort((a, b) => (b.createdTimeMs || 0) - (a.createdTimeMs || 0));

      const etherscanApiKey = String(import.meta.env.VITE_ETHERSCAN_API_KEY || '').trim();
      const rpcUrls = [
        import.meta.env.VITE_POLYGON_RPC_URL,
        'https://polygon-bor-rpc.publicnode.com',
        'https://polygon-rpc.com',
      ].filter(Boolean);

      const withResolvedAmount = await Promise.all(
        completed.map(async (x) => {
          let onchainUsdc = null;
          if (/^0x[a-fA-F0-9]{64}$/.test(String(x.txHash || ''))) {
            const receiptFromEtherscan = await fetchReceiptViaEtherscan(x.txHash, etherscanApiKey);
            const receipt = receiptFromEtherscan || (await fetchReceiptViaRpc(x.txHash, rpcUrls));
            onchainUsdc = extractUsdcTransferIn(receipt, userAddress);
          }
          return {
            ...x,
            amountUsdc: Number.isFinite(Number(onchainUsdc)) ? Number(onchainUsdc) : x.amountApprox,
            valuationSource: Number.isFinite(Number(onchainUsdc))
              ? 'onchain'
              : Number.isFinite(Number(x.amountApprox))
                ? 'approx_source'
                : 'unknown',
          };
        }),
      );

      const isStableUsdcLike = (s) => {
        const x = String(s || '').toUpperCase();
        return x === 'USDC' || x === 'USDC.E';
      };
      const supported = withResolvedAmount.filter(
        (x) => Number.isFinite(Number(x.amountUsdc)) && (x.valuationSource === 'onchain' || isStableUsdcLike(x.fromSymbol)),
      );
      const unsupported = withResolvedAmount.filter((x) => !supported.includes(x));

      // Fallback utile pour les apports en POL convertis en USDC :
      // on détecte les transferts USDC entrants du proxy, puis on exclut les tx connues TRADE/REDEEM.
      const excludedTxHashes = new Set();
      try {
        const { data: activityData } = await axios.get('https://data-api.polymarket.com/activity', {
          params: { user: addr, limit: 5000, offset: 0 },
          timeout: 15000,
        });
        const rows = Array.isArray(activityData) ? activityData : activityData?.value;
        const arr = Array.isArray(rows) ? rows : [];
        for (const a of arr) {
          const typ = String(a?.type || '').toUpperCase();
          if (typ === 'TRADE' || typ === 'REDEEM') {
            const h = String(a?.transactionHash || '').toLowerCase();
            if (/^0x[a-f0-9]{64}$/.test(h)) excludedTxHashes.add(h);
          }
        }
      } catch {
        // activity endpoint is best-effort for exclusions
      }

      const includedHashes = new Set(
        supported
          .map((x) => String(x.txHash || '').toLowerCase())
          .filter((h) => /^0x[a-f0-9]{64}$/.test(h)),
      );
      const toTopic = toTopicAddress(addr);
      const inferred = [];
      if (toTopic) {
        const provider = new ethers.providers.JsonRpcProvider(rpcUrls[0] || 'https://polygon-bor-rpc.publicnode.com');
        try {
          const latest = await provider.getBlockNumber();
          const lookbackBlocks = 800_000; // ~18 jours sur Polygon
          const start = Math.max(0, latest - lookbackBlocks);
          const step = 50_000;
          for (let from = start; from <= latest; from += step) {
            const to = Math.min(latest, from + step - 1);
            const logs = await provider.getLogs({
              address: USDC_E_POLYGON,
              fromBlock: from,
              toBlock: to,
              topics: [TRANSFER_TOPIC0, null, toTopic],
            });
            for (const log of logs) {
              const txHash = String(log?.transactionHash || '').toLowerCase();
              if (!/^0x[a-f0-9]{64}$/.test(txHash)) continue;
              if (includedHashes.has(txHash)) continue;
              if (excludedTxHashes.has(txHash)) continue;
              const units = parseHexBigInt(log?.data);
              const amountUsdc = formatUsdcFromUnits(units);
              if (!Number.isFinite(Number(amountUsdc)) || Number(amountUsdc) <= 0) continue;
              inferred.push({
                txHash,
                createdTimeMs: null,
                fromChainId: '137',
                fromTokenAddress: USDC_E_POLYGON,
                fromSymbol: 'USDC.e',
                amountUsdc: Number(amountUsdc),
                valuationSource: 'inferred_transfer_in',
              });
            }
          }
        } catch {
          // fallback inference is optional
        }
      }

      setItems(supported);
      setUnsupportedItems(unsupported);
      setInferredTopupItems(inferred);
      const totalKnown = supported.reduce((acc, x) => acc + (Number(x.amountUsdc) || 0), 0);
      const totalInferred = inferred.reduce((acc, x) => acc + (Number(x.amountUsdc) || 0), 0);
      const total = totalKnown + totalInferred;
      setTotalApproxUsdc(Number.isFinite(total) ? total : 0);
    } catch (e) {
      setError(e?.message || 'Erreur chargement dépôts bridge');
      setItems([]);
      setUnsupportedItems([]);
      setInferredTopupItems([]);
      setTotalApproxUsdc(0);
    } finally {
      setLoading(false);
    }
  }, [userAddress]);

  useEffect(() => {
    fetchDeposits();
  }, [fetchDeposits]);

  return {
    loading,
    error,
    depositAddress,
    items,
    unsupportedItems,
    inferredTopupItems,
    totalApproxUsdc,
    refresh: fetchDeposits,
  };
}

