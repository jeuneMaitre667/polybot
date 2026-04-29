import { ClobClient } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkMarket() {
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);

    const conditionId = '0x88989f644e59174dfb2bc3465715970c3c3e6a2512615467000c000000000000'; // Example BTC condition
    try {
        const m = await client.getMarket(conditionId);
        console.log(JSON.stringify(m, null, 2));
    } catch (e) {
        console.error(e);
    }
}

checkMarket();
