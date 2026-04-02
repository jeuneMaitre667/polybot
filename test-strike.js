import axios from 'axios';

async function run() {
  console.log('--- Recherche des Strike Prices (BTC 15m) ---');
  try {
    const { data } = await axios.get('https://gamma-api.polymarket.com/events?active=true&limit=100');
    data.forEach(ev => {
      const slug = ev.slug || '';
      if (slug.includes('btc') || slug.includes('bitcoin')) {
        ev.markets.forEach(m => {
          if (m.question && m.question.includes('Bitcoin')) {
            console.log(`Slug: ${slug}`);
            console.log(`Question: ${m.question}`);
            
            // Tentative Regex : "above $68,150.00"
            const match = m.question.match(/\$([0-9,. ]+)/);
            if (match) {
              const cleaned = match[1].replace(/,/g, '').trim();
              console.log(`Strike détecté: ${cleaned}`);
            }
            console.log('-------------------');
          }
        });
      }
    });
  } catch (e) {
    console.error('Erreur Gamma:', e.message);
  }
}

run();
