import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const BTC_FEED = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

const ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
];

async function runDiagnostic() {
  console.log('--- DIAGNOSTIC SÉQUENCE STRIKE (High Frequency) ---');
  console.log(`RPC: ${RPC_URL}`);
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(BTC_FEED, ABI, provider);

  console.log('Attente du créneau 14:35:00...');
  
  const check = setInterval(async () => {
    const now = new Date();
    const m = now.getMinutes();
    const s = now.getSeconds();
    
    // On commence l'échantillonnage à 14:34:55
    if (m === 34 && s >= 55 || m === 35 && s <= 45) {
      try {
        const data = await contract.latestRoundData();
        const price = Number(data.answer) / 1e8;
        const updatedAt = new Date(Number(data.updatedAt) * 1000).toLocaleTimeString('fr-FR');
        
        console.log(`[${now.toLocaleTimeString('fr-FR')}.${now.getMilliseconds().toString().padStart(3, '0')}] Oracle_Price: ${price.toFixed(2)} (Oracle_Update: ${updatedAt})`);
      } catch (e) {
        console.error('Error fetching:', e.message);
      }
    }
    
    if (m === 35 && s > 45) {
      console.log('Diagnostic terminé.');
      clearInterval(check);
      process.exit(0);
    }
  }, 1000);
}

runDiagnostic();
