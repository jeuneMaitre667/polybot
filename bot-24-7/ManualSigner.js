/**
 * v24.0.0: ManualSigner.js (Zero-SDK Prototype)
 * Protocole EIP-712 chirurgical pour Polymarket CLOB.
 * Évite tout appel réseau masqué du SDK.
 */
import { ethers } from 'ethers';

const POLYMARKET_EXCHANGE_CONTRACT = "0x4bFb30164a3501E8505e6097e17De830114fE643";
const POLYGON_CHAIN_ID = 137;

// Domaine EIP-712 Polymarket
const domain = {
    name: "Polymarket",
    version: "1",
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: POLYMARKET_EXCHANGE_CONTRACT
};

// Types EIP-712 Polymarket Order
const types = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" }, // 0=BUY, 1=SELL
        { name: "signatureType", type: "uint8" } // 1=POLY_PROXY
    ]
};

/**
 * Signe un ordre manuellement via EIP-712 (vethers v5 support)
 */
export async function signOrderManual(wallet, orderData) {
    // Note: Use _signTypedData for ethers v5 compatibility
    const signature = await wallet._signTypedData(domain, types, orderData);
    return signature;
}
