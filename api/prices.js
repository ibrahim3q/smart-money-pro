const API_KEY = 'yoTGVzu_bIApT5a0NZyAXN81zi3AUwm2';
const BASE    = 'https://api.polygon.io';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { type, tickers, ticker } = req.query;

  try {
    // ── ١. أسعار لحظية Snapshot ──────────────────────────────
    if (!type || type === 'snapshot') {
      const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers}&apiKey=${API_KEY}`;
      const r   = await fetch(url);
      const d   = await r.json();
      if (d.tickers?.length) return res.json({ type:'snapshot', tickers: d.tickers });

      // Fallback: إغلاق أمس
      const yesterday  = prevTradingDay();
      const tickerList = (tickers||'').split(',').map(t=>t.trim()).filter(Boolean);
      const prices     = [];
      for (const t of tickerList) {
        try {
          await sleep(120);
          const rr = await fetch(`${BASE}/v1/open-close/${t}/${yesterday}?adjusted=true&apiKey=${API_KEY}`);
          const dd = await rr.json();
          if (dd.close) prices.push({ ticker:t, close:dd.close, open:dd.open, high:dd.high, low:dd.low, volume:dd.volume, date:dd.from });
        } catch(e) {}
      }
      return res.json({ type:'prevclose', prices, date:yesterday });
    }

    // ── ٢. بيانات تاريخية للرسم البياني ─────────────────────
    if (type === 'history') {
      const t    = ticker || 'NVDA';
      const range= req.query.range || '1W';
      const { multiplier, timespan, from } = rangeConfig(range);
      const url  = `${BASE}/v2/aggs/ticker/${t}/range/${multiplier}/${timespan}/${from}/${today()}?adjusted=true&sort=asc&limit=500&apiKey=${API_KEY}`;
      const r    = await fetch(url);
      const d    = await r.json();
      return res.json({ type:'history', ticker:t, range, results: d.results || [] });
    }

    // ── ٣. مؤشرات تقنية (RSI, MACD, EMA) ────────────────────
    if (type === 'indicators') {
      const t = ticker || 'NVDA';
      const [rsiR, macdR, emaR, smaR] = await Promise.allSettled([
        fetch(`${BASE}/v1/indicators/rsi/${t}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/macd/${t}?timespan=day&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&limit=1&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/ema/${t}?timespan=day&adjusted=true&window=20&series_type=close&limit=2&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/sma/${t}?timespan=day&adjusted=true&window=50&series_type=close&limit=2&apiKey=${API_KEY}`).then(r=>r.json()),
      ]);

      const rsi  = rsiR.status==='fulfilled'  ? rsiR.value?.results?.values?.[0]?.value  : null;
      const macd = macdR.status==='fulfilled' ? macdR.value?.results?.values?.[0]        : null;
      const ema20= emaR.status==='fulfilled'  ? emaR.value?.results?.values?.[0]?.value  : null;
      const ema20prev= emaR.status==='fulfilled'?emaR.value?.results?.values?.[1]?.value : null;
      const sma50= smaR.status==='fulfilled'  ? smaR.value?.results?.values?.[0]?.value  : null;

      return res.json({ type:'indicators', ticker:t, rsi, macd, ema20, ema20prev, sma50 });
    }

    // ── ٤. Fear & Greed + VIX + Put/Call ────────────────────
    if (type === 'market') {
      const [vixR, pcR, fgR] = await Promise.allSettled([
        // VIX من Polygon
        fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=VIXY&apiKey=${API_KEY}`).then(r=>r.json()),
        // Put/Call Ratio (نسبة تقريبية من حجم SPY options)
        fetch(`${BASE}/v3/reference/options/SPY?limit=10&apiKey=${API_KEY}`).then(r=>r.json()),
        // Fear & Greed من CNN
        fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata'),
      ]);

      // VIX
      const vix = vixR.status==='fulfilled' ? vixR.value?.tickers?.[0]?.day?.c : null;

      // Fear & Greed
      let fg = null;
      if (fgR.status==='fulfilled') {
        try {
          const fgData = await fgR.value.json();
          fg = fgData?.fear_and_greed?.score || fgData?.score || null;
        } catch(e) {}
      }

      return res.json({ type:'market', vix, fearGreed: fg });
    }

    res.status(400).json({ error: 'unknown type' });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

function today() {
  return new Date().toISOString().slice(0,10);
}

function prevTradingDay() {
  const ny = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  ny.setDate(ny.getDate()-1);
  while(ny.getDay()===0||ny.getDay()===6) ny.setDate(ny.getDate()-1);
  return ny.toISOString().slice(0,10);
}

function rangeConfig(range) {
  const ny = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const fmt = d => d.toISOString().slice(0,10);
  const sub = (d,n) => { const r=new Date(d); r.setDate(r.getDate()-n); return r; };
  switch(range) {
    case '1D': return { multiplier:5,  timespan:'minute', from: fmt(sub(ny,1))  };
    case '1W': return { multiplier:1,  timespan:'hour',   from: fmt(sub(ny,7))  };
    case '1M': return { multiplier:1,  timespan:'day',    from: fmt(sub(ny,30)) };
    case '3M': return { multiplier:1,  timespan:'day',    from: fmt(sub(ny,90)) };
    default:   return { multiplier:1,  timespan:'day',    from: fmt(sub(ny,30)) };
  }
}
