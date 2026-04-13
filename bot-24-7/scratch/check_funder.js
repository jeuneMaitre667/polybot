import { ethers } from 'ethers';

async function check() {
    try {
        const provider = new ethers.JsonRpcProvider('https://polygon.llamarpc.com');
        const address = '0x3a7560F5571432d6b364D1db1C2683a0C08D9b72';
        
        console.log(`Checking Funder: ${address}`);

        const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        const usdcE = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', usdcAbi, provider);
        const usdcEBal = await usdcE.balanceOf(address);
        const usdcEDec = await usdcE.decimals();

        const maticBal = await provider.getBalance(address);

        console.log(`FUNDER_MATIC: ${ethers.formatEther(maticBal)}`);
        console.log(`FUNDER_USDC.e: ${ethers.formatUnits(usdcEBal, usdcEDec)}`);
    } catch (err) {
        console.error('Error:', err.message);
    }
}
check();
