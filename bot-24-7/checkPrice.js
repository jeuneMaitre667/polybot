import { ethers } from 'ethers';
const url = 'https://polygon-mainnet.g.alchemy.com/v2/qDLYcGckGL323XVWQot_r';
const p = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true });
const abi = ['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'];
async function run() {
  const addrs = { 
    BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f', 
    ETH: '0xF9680D99D99444723d9b912632E2943722415636', 
    SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC' 
  };
  for (let [n, a] of Object.entries(addrs)) {
    try {
      const c = new ethers.Contract(a, abi, p);
      const d = await c.latestRoundData();
      console.log(`${n}: SUCCESS - $${Number(d.answer)/1e8}`);
    } catch (e) {
      console.log(`${n}: FAIL - ${e.message}`);
    }
  }
}
run();
