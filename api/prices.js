export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers required' });

  const API_KEY = 'yoTGVzu_bIApT5a0NZyAXN81zi3AUwm2';
  const tickerList = tickers.split(',').map(t => t.trim());
  const yesterday = getPrevTradingDay();

  // جلب بالتسلسل لتجنب حد الطلبات
  const prices = [];
  for (const t of tickerList) {
    try {
      await sleep(300); // انتظار 300ms بين كل طلب
      const url = `https://api.polygon.io/v1/open-close/${t}/${yesterday}?adjusted=true&apiKey=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.close) {
        prices.push({
          ticker: t,
          close:  data.close,
          open:   data.open,
          high:   data.high,
          low:    data.low,
          volume: data.volume,
          date:   data.from,
        });
      }
    } catch(e) { /* تجاهل وتابع */ }
  }

  res.status(200).json({ prices, source: 'prev_close', date: yesterday });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPrevTradingDay() {
  const d = new Date();
  const ny = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setDate(ny.getDate() - 1);
  while (ny.getDay() === 0 || ny.getDay() === 6) ny.setDate(ny.getDate() - 1);
  return ny.toISOString().slice(0, 10);
}
