export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers required' });

  const API_KEY = 'yoTGVzu_bIApT5a0NZyAXN81zi3AUwm2';

  try {
    // Snapshot API — يجلب جميع الأسهم دفعة واحدة (خطة مدفوعة)
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers}&apiKey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.tickers && data.tickers.length > 0) {
      return res.status(200).json(data);
    }

    // Fallback — إغلاق أمس
    const yesterday = getPrevTradingDay();
    const tickerList = tickers.split(',').map(t => t.trim());
    const prices = [];

    for (const t of tickerList) {
      try {
        await new Promise(r => setTimeout(r, 120));
        const r = await fetch(`https://api.polygon.io/v1/open-close/${t}/${yesterday}?adjusted=true&apiKey=${API_KEY}`);
        const d = await r.json();
        if (d.close) prices.push({ ticker:t, close:d.close, open:d.open, high:d.high, low:d.low, volume:d.volume, date:d.from });
      } catch(e) {}
    }

    res.status(200).json({ prices, source:'prev_close', date:yesterday });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

function getPrevTradingDay() {
  const ny = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  ny.setDate(ny.getDate()-1);
  while(ny.getDay()===0||ny.getDay()===6) ny.setDate(ny.getDate()-1);
  return ny.toISOString().slice(0,10);
}
