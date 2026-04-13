import WebSocket from 'ws';

async function run() {
  console.log('--- Diagnostic de Lag Lancé (120s) ---');
  
  // 1. Déterminer le marché actif
  let tokenIds = [];
  try {
    const r = await fetch('http://localhost:3001/api/bot-status');
    const j = await r.json();
    const lastTid = j.lastOrder?.tokenId;
    if (lastTid) tokenIds.push(lastTid);
    if (j.activeSignals) {
      j.activeSignals.forEach(s => { if (s.tokenIdToBuy) tokenIds.push(s.tokenIdToBuy); });
    }
    tokenIds = [...new Set(tokenIds)].filter(id => id && id.length > 5);
  } catch (e) {
    console.error('Erreur status:', e.message);
  }
  
  if (tokenIds.length === 0) {
     console.error('Aucun tokenId actif trouvé. Tentative de récupération via Gamma...');
     // Backup: fetch current 15m slot from Gamma
     try {
       const nowSec = Math.floor(Date.now() / 1000);
       const slotStart = Math.floor(nowSec / 900) * 900;
       const slug = `btc-up-down-15m-${slotStart}`;
       const r = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
       const j = await r.json();
       if (j.markets) {
         j.markets.forEach(m => {
           if (m.clobTokenIds) {
             const tids = JSON.parse(m.clobTokenIds);
             tokenIds.push(...tids);
           }
         });
       }
     } catch (e) { console.error('Fallback Gamma échoué:', e.message); }
  }

  tokenIds = [...new Set(tokenIds)];
  if (tokenIds.length === 0) {
     console.error('Aucun token identifiable. Abandon.');
     process.exit(1);
  }
  
  console.log('Tokens surveillés:', tokenIds.join(', '));

  let binancePrice = null;
  let lastBinanceUpdate = 0;
  const logs = [];

  // 2. Binance WS
  const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  binanceWs.on('message', (data) => {
    const msg = JSON.parse(data);
    binancePrice = parseFloat(msg.c);
    lastBinanceUpdate = Date.now();
  });

  // 3. Polymarket (Polling Fallback)
  // Comme le WebSocket CLOB 404 souvent sur les petits marchés, on va utiliser le polling ultra-rapide (500ms)
  // pour être sûr d'avoir des données à comparer.
  console.log('Mode: Polling HTTP (500ms) pour Polymarket (plus fiable pour ce test)');
  
  const pollInterval = setInterval(async () => {
    if (!binancePrice) return;
    
    for (const tid of tokenIds) {
      try {
        const r = await fetch(`https://clob.polymarket.com/price?token_id=${tid}&side=BUY`);
        if (!r.ok) continue;
        const j = await r.json();
        const price = parseFloat(j.price);
        if (price) {
          const now = Date.now();
          logs.push({
            ts: now,
            binance: binancePrice,
            binanceAge: now - lastBinanceUpdate,
            polyPrice: price,
            tid: tid
          });
        }
      } catch (e) {}
    }
  }, 500);

  // 4. Fin
  setTimeout(() => {
    clearInterval(pollInterval);
    console.log('\n--- Fin du Diagnostic ---');
    console.log('Total points capturés:', logs.length);
    
    if (logs.length > 10) {
       // On cherche les moments où Binance a bougé et Poly a suivi
       const sorted = logs.sort((a,b) => a.ts - b.ts);
       const ages = sorted.map(l => l.binanceAge);
       const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
       
       console.log(`Décalage moyen (Binance Tick -> Poly Poll): ${Math.round(avgAge)}ms`);
       console.log('\nÉchantillon de réactivité :');
       sorted.slice(-10).forEach(l => {
         console.log(`- [${new Date(l.ts).toISOString().slice(11,19)}] Binance: ${l.binance.toFixed(2)} | Poly: ${l.polyPrice.toFixed(3)} (Age Binance: ${l.binanceAge}ms)`);
       });
    } else {
       console.log('Pas assez de données pour conclure.');
    }

    binanceWs.terminate();
    process.exit(0);
  }, 120000);
}

run().catch(console.error);
