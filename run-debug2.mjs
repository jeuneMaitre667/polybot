import { writeFileSync } from 'fs';
import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from './src/lib/bitcoin15mResolvedDataFetch.js';

async function main() {
  const simCfg = resolve15mSimConfig({});
  const res = await fetchBitcoin15mResolvedData(4, simCfg, true);
  const r = res.enrichedFinal.find(x => x.botWouldTake);
  if (r) {
    writeFileSync('clean-debug.json', JSON.stringify({ slug: r.eventSlug, ts: r.botEntryTimestamp, dbg: r.simDebug }, null, 2));
    console.log('Wrote clean-debug.json');
  } else {
    console.log('No signal in last 4 hours');
  }
}
main();
