import { fetchBitcoin15mResolvedData, resolve15mSimConfig } from './src/lib/bitcoin15mResolvedDataFetch.js';

async function main() {
  const simCfg = resolve15mSimConfig({});
  const res = await fetchBitcoin15mResolvedData(4, simCfg, true);
  const r = res.enrichedFinal.find(x => x.botWouldTake);
  if (r) {
    console.log('Found signal at', new Date(r.botEntryTimestamp * 1000).toISOString(), r.eventSlug);
    console.log(JSON.stringify(r.simDebug, null, 2));
  } else {
    console.log('No signal in last 4 hours');
  }
}
main();
