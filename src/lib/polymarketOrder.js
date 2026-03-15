/**
 * Place un ordre sur le CLOB Polymarket (Bitcoin Up or Down - Hourly).
 * Par défaut : ordre au marché (exécution immédiate au meilleur prix disponible).
 * Option : ordre limite (prix fixe 95–96 %) pour garantir un rendement minium.
 */
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

/**
 * Ordre au marché : exécution immédiate, meilleur prix disponible (slippage possible).
 * @param {import('ethers').Signer} signer
 * @param {{ tokenIdToBuy: string, sizeUsd: number }} params - sizeUsd en USDC
 * @returns {Promise<{ orderID?: string, error?: string }>}
 */
export async function placePolymarketMarketOrder(signer, params) {
  const { tokenIdToBuy, sizeUsd } = params;
  if (!tokenIdToBuy || sizeUsd <= 0) {
    return { error: 'Paramètres invalides (tokenId, size).' };
  }
  try {
    const clientWithoutCreds = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    const creds = await clientWithoutCreds.createOrDeriveApiKey();
    const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);

    const userMarketOrder = {
      tokenID: tokenIdToBuy,
      amount: Number(sizeUsd),
      side: Side.BUY,
    };
    const options = { tickSize: '0.01', negRisk: false };
    const result = await client.createAndPostMarketOrder(userMarketOrder, options, OrderType.FOK);
    return { orderID: result?.orderID ?? result?.id ?? 'ok' };
  } catch (err) {
    return { error: err.message || 'Erreur lors du placement de l\'ordre au marché.' };
  }
}

/**
 * Ordre limite : prix fixe (ex. 95–96 %), exécution seulement si le carnet le permet.
 * @param {import('ethers').Signer} signer
 * @param {{ tokenIdToBuy: string, price: number, sizeUsd: number }} params
 * @returns {Promise<{ orderID?: string, error?: string }>}
 */
export async function placePolymarketLimitOrder(signer, params) {
  const { tokenIdToBuy, price, sizeUsd } = params;
  if (!tokenIdToBuy || price == null || sizeUsd <= 0) {
    return { error: 'Paramètres invalides (tokenId, price, size).' };
  }
  try {
    const clientWithoutCreds = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    const creds = await clientWithoutCreds.createOrDeriveApiKey();
    const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);

    const userOrder = {
      tokenID: tokenIdToBuy,
      price: Number(price),
      size: Number(sizeUsd),
      side: Side.BUY,
    };
    const options = { tickSize: '0.01', negRisk: false };
    const result = await client.createAndPostOrder(userOrder, options, OrderType.GTC);
    return { orderID: result?.orderID ?? result?.id ?? 'ok' };
  } catch (err) {
    return { error: err.message || 'Erreur lors du placement de l\'ordre limite.' };
  }
}

/**
 * Place un ordre : au marché par défaut (useMarketOrder: true), ou limite si useMarketOrder: false.
 * @param {import('ethers').Signer} signer
 * @param {{ tokenIdToBuy: string, price?: number, sizeUsd: number, useMarketOrder?: boolean }} params
 */
export async function placePolymarketOrder(signer, params) {
  const useMarketOrder = params.useMarketOrder !== false;
  if (useMarketOrder) {
    return placePolymarketMarketOrder(signer, { tokenIdToBuy: params.tokenIdToBuy, sizeUsd: params.sizeUsd });
  }
  return placePolymarketLimitOrder(signer, {
    tokenIdToBuy: params.tokenIdToBuy,
    price: params.price ?? 0.95,
    sizeUsd: params.sizeUsd,
  });
}
