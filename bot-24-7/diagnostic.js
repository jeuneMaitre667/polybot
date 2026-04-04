import { ethers } from 'ethers';
import WebSocket from 'ws';

const DATA_FEEDS = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
  SOL: '0x10C8264C0935B3B9870013E057F330FF3E9C56DC',
};

async function testChainlink() {
  console.log('--- TESTING CHAINLINK (POLYGON) ---');
  const provider = new ethers.JsonRpcProvider('https://1rpc.io/matic', 137, { staticNetwork: true });
  for (const [asset, address] of Object.entries(DATA_FEEDS)) {
    const contract = new ethers.Contract(address, [
      'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
    ], provider);
    const data = await contract.latestRoundData();
    const price = Number(data.answer) / 1e8;
    const date = new Date(Number(data.updatedAt) * 1000).toISOString();
    console.log(`[${asset}] Price: ${price.toFixed(2)} | UpdatedAt: ${date}`);
  }
}

async function testBinance() {
  console.log('--- TESTING BINANCE WS ---');
  const ws = new WebSocket('wss://fstream.binance.com/ws/ethusdt@aggTrade');
  ws.on('message', (raw) => {
    const data = JSON.parse(raw.toString());
    console.log(`[Binance ETH] Price: ${data.p} | Server Time: ${new Date(data.E).toISOString()}`);
    ws.close();
  });
}

testChainlink().then(() => testBinance());
