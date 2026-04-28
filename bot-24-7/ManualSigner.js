/**
 * v47.0.0: ManualSigner.js (CLOB V2 — EIP-712 v2)
 * Protocole EIP-712 chirurgical pour Polymarket CLOB V2.
 * Changes: domain version "2", new exchange contract, nonce/feeRateBps/taker removed,
 *          timestamp/metadata/builder added.
 */
import { ethers } from 'ethers';

const POLYMARKET_EXCHANGE_CONTRACT_V2 = ethers.utils.getAddress("0xE111180000d2663C0091e4f400237545B87B996B".toLowerCase());
const POLYGON_CHAIN_ID = 137;

// Domaine EIP-712 Polymarket V2
const domain = {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: POLYMARKET_EXCHANGE_CONTRACT_V2
};

// Types EIP-712 Polymarket Order V2
const types = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" }, // 0=BUY, 1=SELL
        { name: "signatureType", type: "uint8" }, // 1=POLY_PROXY
        { name: "timestamp", type: "uint256" }, // V2: replaces nonce (ms since epoch)
        { name: "metadata", type: "bytes32" },  // V2: new field
        { name: "builder", type: "bytes32" }     // V2: new field
    ]
};

/**
 * Signe un ordre manuellement via EIP-712 V2 (ethers v5 support)
 */
export async function signOrderManual(wallet, orderData) {
    // Note: Use _signTypedData for ethers v5 compatibility
    const signature = await wallet._signTypedData(domain, types, orderData);
    return signature;
}
