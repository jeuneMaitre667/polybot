import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot-24-7/.env' });

async function check() {
    try {
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
        const clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
        
        console.log(`EOA Address: ${wallet.address}`);
        
        // Fetch Gamma Profile (will show proxy)
        const profile = await axios.get(`https://gamma-api.polymarket.com/profiles?address=${wallet.address}`).catch(() => null);
        if (profile && profile.data) {
             console.log('--- Profile Data ---');
             console.log(JSON.stringify(profile.data, null, 2));
        }

    } catch (err) {
        console.error('Error fetching profile:', err.message);
    }
}

import axios from 'axios';
check();
