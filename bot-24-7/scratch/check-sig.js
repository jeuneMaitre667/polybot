import { ethers } from 'ethers';
import { signOrderManual } from '../ManualSigner.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

async function check() {
    console.log("--- Zero-SDK : Sanity Check ---");
    if (!process.env.PRIVATE_KEY) {
        console.error("💀 ERROR: PRIVATE_KEY not found in .env");
        return;
    }
    
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
    console.log(`Wallet Address: ${wallet.address}`);

    const dummyOrder = {
        salt: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        maker: process.env.CLOB_FUNDER_ADDRESS, // v24.2.7: Ensure funder is set
        signer: wallet.address,
        taker: ethers.constants.AddressZero,
        tokenId: "1234567890123456789012345678901234567890",
        makerAmount: "1000000",
        takerAmount: "900000",
        expiration: String(Math.floor(Date.now()/1000) + 3600),
        nonce: "0",
        feeRateBps: "1000",
        side: 0,
        signatureType: 1
    };

    try {
        const sig = await signOrderManual(wallet, dummyOrder);
        console.log(`✅ Signature Generated: ${sig.substring(0, 20)}... (${sig.length} bytes)`);
        console.log("🚀 PILOT READY: EIP-712 Signature confirmed.");
    } catch (e) {
        console.error("💀 FATAL: Signature failed!", e.message);
    }
}

check();
