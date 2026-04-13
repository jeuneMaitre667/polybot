import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot-24-7/.env' });

async function check() {
    try {
        const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
        const address = '0xE951145cEe6C9367E605705643d2A0E4925325B7';
        
        // 1. MATIC Balance
        const maticBal = await provider.getBalance(address);
        
        // 2. USDC.e Balance (0x2791...)
        const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        const usdcE = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', usdcAbi, provider);
        const usdcEBal = await usdcE.balanceOf(address);
        const usdcEDec = await usdcE.decimals();

        // 3. USDC Native (0x3c49...)
        const usdcN = new ethers.Contract('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', usdcAbi, provider);
        const usdcNBal = await (usdcN.balanceOf(address).catch(() => 0n));
        const usdcNDec = await (usdcN.decimals().catch(() => 6));

        console.log(`MATIC: ${ethers.formatEther(maticBal)}`);
        console.log(`USDC.e: ${ethers.formatUnits(usdcEBal, usdcEDec)}`);
        console.log(`USDC_Native: ${ethers.formatUnits(usdcNBal, usdcNDec)}`);
    } catch (err) {
        console.error('Error checking balance:', err.message);
    }
}
check();
