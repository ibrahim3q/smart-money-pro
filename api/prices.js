export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers required' });

  const API_KEY = 'yoTGVzu_bIApT5a0NZyAXN81zi3AUwm2';
  const tickerList = tickers.split(',');

  try {
    // جلب إغلاق أمس لكل سهم — يعمل مع الخطة المجانية
    const yesterday = getPrevTradingDay();

    const results = await Promise.allSettled(
      tickerList.map(async t => {
        const url = `https://api.polygon.io/v1/open-close/${t.trim()}/${yesterday}?adjusted=true&apiKey=${API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        return { ticker: t.trim(), data };
      })
    );

    const prices = results
      .filter(r => r.status === 'fulfilled' && r.value.data.close)
      .map(r => ({
        ticker:  r.value.ticker,
        close:   r.value.data.close,
        open:    r.value.data.open,
        high:    r.value.data.high,
        low:     r.value.data.low,
        volume:  r.value.data.volume,
        date:    r.value.data.from,
      }));

    res.status(200).json({ prices, source: 'prev_close', date: yesterday });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function getPrevTradingDay() {
  const d = new Date();
  // تحويل لتوقيت نيويورك
  const ny = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  ny.setDate(ny.getDate() - 1);
  // تخطي عطل نهاية الأسبوع
  while (ny.getDay() === 0 || ny.getDay() === 6) {
    ny.setDate(ny.getDate() - 1);
  }
  return ny.toISOString().slice(0, 10);
}
