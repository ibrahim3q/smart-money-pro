const API_KEY = 'yoTGVzu_bIApT5a0NZyAXN81zi3AUwm2';
const BASE    = 'https://api.polygon.io';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { type, tickers, ticker, range } = req.query;

  try {

    // ── ١. أسعار لحظية Snapshot ──────────────────
    if (!type || type === 'snapshot') {
      const url  = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers}&apiKey=${API_KEY}`;
      const r    = await fetch(url);
      const data = await r.json();

      if (data.tickers?.length) {
        return res.status(200).json({ type:'snapshot', tickers: data.tickers });
      }

      // Fallback: إغلاق أمس
      const yesterday  = prevTradingDay();
      const tickerList = (tickers||'').split(',').map(t=>t.trim()).filter(Boolean);
      const prices     = [];

      for (const t of tickerList) {
        try {
          await sleep(120);
          const rr  = await fetch(`${BASE}/v1/open-close/${t}/${yesterday}?adjusted=true&apiKey=${API_KEY}`);
          const dd  = await rr.json();
          if (dd.close) prices.push({
            ticker:t, close:dd.close, open:dd.open,
            high:dd.high, low:dd.low, volume:dd.volume, date:dd.from
          });
        } catch(e) {}
      }
      return res.status(200).json({ type:'prevclose', prices, date:yesterday });
    }

    // ── ٢. بيانات تاريخية للرسم البياني ─────────────────────
    if (type === 'history') {
      const t   = (ticker||'NVDA').toUpperCase();
      const rng = range || '1W';
      const { multiplier, timespan, from } = rangeConfig(rng);
      const to  = todayStr();

      const url  = `${BASE}/v2/aggs/ticker/${t}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=500&apiKey=${API_KEY}`;
      const r    = await fetch(url);
      const data = await r.json();

      if (data.results?.length > 0) {
        return res.status(200).json({
          type:'history', ticker:t, range:rng,
          results: data.results.map(b=>({ t:b.t, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v }))
        });
      }
      return res.status(200).json({ type:'history', ticker:t, range:rng, results:[] });
    }

    // ── ٣. مؤشرات تقنية ──────────────────────────────────────
    if (type === 'indicators') {
      const t = (ticker||'NVDA').toUpperCase();
      const [rsiR, macdR, emaR, smaR] = await Promise.allSettled([
        fetch(`${BASE}/v1/indicators/rsi/${t}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/macd/${t}?timespan=day&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&limit=1&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/ema/${t}?timespan=day&adjusted=true&window=20&series_type=close&limit=2&apiKey=${API_KEY}`).then(r=>r.json()),
        fetch(`${BASE}/v1/indicators/sma/${t}?timespan=day&adjusted=true&window=50&series_type=close&limit=1&apiKey=${API_KEY}`).then(r=>r.json()),
      ]);
      return res.status(200).json({
        type:'indicators', ticker:t,
        rsi:   rsiR.status==='fulfilled'  ? rsiR.value?.results?.values?.[0]?.value  : null,
        macd:  macdR.status==='fulfilled' ? macdR.value?.results?.values?.[0]        : null,
        ema20: emaR.status==='fulfilled'  ? emaR.value?.results?.values?.[0]?.value  : null,
        sma50: smaR.status==='fulfilled'  ? smaR.value?.results?.values?.[0]?.value  : null,
      });
    }

    // ── ٤. بيانات السوق (VIX + Fear&Greed) ──────────────────
    if (type === 'market') {
      let vix = null, fearGreed = null;

      try {
        const vr = await fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=VIXY&apiKey=${API_KEY}`);
        const vd = await vr.json();
        vix = vd?.tickers?.[0]?.day?.c || null;
      } catch(e) {}

      try {
        const fgR = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
          headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}
        });
        if(fgR.ok) {
          const fgD = await fgR.json();
          fearGreed = fgD?.fear_and_greed?.score || fgD?.score || null;
        }
      } catch(e) {}

      if(!fearGreed) {
        try {
          const sr  = await fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=SPY&apiKey=${API_KEY}`);
          const sd  = await sr.json();
          const chg = sd?.tickers?.[0]?.todaysChangePerc || 0;
          fearGreed = Math.min(95, Math.max(5, 50 + chg*10));
        } catch(e) {}
      }

      return res.status(200).json({ type:'market', vix, fearGreed });
    }

    // ── ٥. Options Chain — أسعار العقود الحقيقية ─────────────
    if (type === 'options') {
      const t          = (ticker||'NVDA').toUpperCase();
      const optionType = (req.query.optionType||'call').toLowerCase(); // call | put
      const expiry     = req.query.expiry || '';   // YYYY-MM-DD

      try {
        // جلب Options Chain من Polygon
        let url = `${BASE}/v3/snapshot/options/${t}?contract_type=${optionType}&limit=10&apiKey=${API_KEY}`;
        if (expiry) url += `&expiration_date=${expiry}`;

        const r    = await fetch(url);
        const data = await r.json();

        if (data.results?.length > 0) {
          const contracts = data.results.map(c => ({
            ticker:       c.details?.ticker         || '',
            strike:       c.details?.strike_price   || 0,
            expiry:       c.details?.expiration_date|| '',
            type:         c.details?.contract_type  || '',
            // أسعار حقيقية
            lastPrice:    c.last_quote?.midpoint || c.day?.close || 0,
            bid:          c.last_quote?.bid      || 0,
            ask:          c.last_quote?.ask      || 0,
            midpoint:     c.last_quote?.midpoint || 0,
            // Greeks
            delta:        c.greeks?.delta  || 0,
            gamma:        c.greeks?.gamma  || 0,
            theta:        c.greeks?.theta  || 0,
            vega:         c.greeks?.vega   || 0,
            iv:           c.implied_volatility || 0,
            // حجم التداول
            volume:       c.day?.volume    || 0,
            openInterest: c.open_interest  || 0,
            // السعر الحالي للسهم
            underlyingPrice: c.underlying_asset?.price || 0,
          }));

          return res.status(200).json({
            type: 'options',
            ticker: t,
            optionType,
            expiry,
            contracts,
            count: contracts.length
          });
        }

        return res.status(200).json({ type:'options', ticker:t, contracts:[], count:0 });

      } catch(e) {
        return res.status(200).json({ type:'options', ticker:t, contracts:[], count:0, error:e.message });
      }
    }

    res.status(400).json({ error:'unknown type' });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Helpers ──
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

function todayStr() {
  return new Date().toISOString().slice(0,10);
}

function prevTradingDay() {
  const ny = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  ny.setDate(ny.getDate()-1);
  while(ny.getDay()===0||ny.getDay()===6) ny.setDate(ny.getDate()-1);
  return ny.toISOString().slice(0,10);
}

function rangeConfig(range) {
  const ny  = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const fmt = d => d.toISOString().slice(0,10);
  const sub = (d,n) => { const r=new Date(d); r.setDate(r.getDate()-n); return r; };
  switch(range) {
    case '1D': return { multiplier:5,  timespan:'minute', from:fmt(sub(ny,1))  };
    case '1W': return { multiplier:1,  timespan:'hour',   from:fmt(sub(ny,7))  };
    case '1M': return { multiplier:1,  timespan:'day',    from:fmt(sub(ny,31)) };
    case '3M': return { multiplier:1,  timespan:'day',    from:fmt(sub(ny,92)) };
    default:   return { multiplier:1,  timespan:'day',    from:fmt(sub(ny,31)) };
  }
}
