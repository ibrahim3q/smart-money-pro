// api/auto-trade-engine.js
// يُستدعى من Vercel Cron كل دقيقتين أثناء ساعات التداول (راجع vercel.json)
// هذا الملف هو "العقل" الكامل للنظام الآلي: يراقب الصفقات المفتوحة، يطبّق
// قاطع الدائرة اليومي، ويقرر فتح صفقات جديدة بناءً على إشارات حقيقية.

import {
  isKillSwitchActive,
  getOpenPositions,
  setOpenPositions,
  getDailyPnL,
  addToDailyPnL,
  isCircuitBreakerTripped,
  tripCircuitBreaker,
  logDecision,
} from '../lib/redis.js';

import {
  openOptionPosition,
  openOptionPositionWithTakeProfit,
  closeOptionPositionMarket,
  placeTakeProfitLimitOrder,
  cancelOrder,
  getOrder,
} from '../lib/alpaca.js';

// ── إعدادات المخاطرة (من Environment Variables، بقيم افتراضية آمنة) ──
const CAPITAL = parseFloat(process.env.AUTO_TRADE_CAPITAL || '1000');
const RISK_PCT = parseFloat(process.env.AUTO_TRADE_RISK_PCT || '2');       // 2% لكل صفقة
const DAILY_LOSS_LIMIT_PCT = parseFloat(process.env.AUTO_TRADE_DAILY_LOSS_PCT || '3'); // 3% حد يومي
const MAX_OPEN_POSITIONS = parseInt(process.env.AUTO_TRADE_MAX_POSITIONS || '2', 10);
const TARGET_PCT = 0.05;   // +5%
const STOP_PCT = 0.025;    // -2.5%

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

// قائمة الأسهم المراقبة (نفس قائمة الموقع الرئيسي)
const WATCHLIST = ['NVDA', 'QQQ', 'AMD', 'AAPL', 'COIN', 'TSLA', 'META', 'MSFT', 'GOOGL', 'SPY', 'AMZN', 'SMCI', 'PLTR', 'MSTR', 'IBIT', 'ARM', 'MRVL'];

const US_HOLIDAYS_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-25'];

export default async function handler(req, res) {
  // ── تحقق أمني: فقط Vercel Cron أو طلب يحمل السر الصحيح يقدر يشغّل هذا ──
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runLog = { checked: [], opened: null, closed: [], skipped_reason: null };

  try {
    // ── 1. فحص Kill Switch أولاً — لو مفعّل نوقف كل شي فوراً ──
    if (await isKillSwitchActive()) {
      await logDecision({ type: 'skip', reason: 'kill_switch_active' });
      return res.status(200).json({ status: 'halted', reason: 'kill_switch_active' });
    }

    // ── 2. فحص ساعات التداول (لا نفعل شي خارج الجلسة الرئيسية) ──
    if (!isMarketOpenNow()) {
      return res.status(200).json({ status: 'skipped', reason: 'market_closed' });
    }

    // ── 3. مراقبة الصفقات المفتوحة أولاً (إغلاق قبل فتح) ──
    let openPositions = await getOpenPositions();
    const stillOpen = [];
    for (const pos of openPositions) {
      const result = await evaluatePosition(pos);
      if (result.closed) {
        runLog.closed.push(result);
        await logDecision({ type: 'close', position: pos, result });
      } else {
        stillOpen.push(pos);
      }
    }
    await setOpenPositions(stillOpen);
    openPositions = stillOpen;

    // ── 4. فحص قاطع الدائرة اليومي (3% خسارة) ──
    const dailyPnL = await getDailyPnL();
    const dailyLossLimit = -(CAPITAL * DAILY_LOSS_LIMIT_PCT / 100);
    if (dailyPnL <= dailyLossLimit) {
      await tripCircuitBreaker();
    }
    const breakerTripped = await isCircuitBreakerTripped();

    if (breakerTripped) {
      await logDecision({ type: 'skip', reason: 'daily_loss_circuit_breaker', dailyPnL });
      return res.status(200).json({ status: 'circuit_breaker_active', dailyPnL, closed: runLog.closed });
    }

    // ── 5. فحص أقصى عدد صفقات مفتوحة ──
    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      await logDecision({ type: 'skip', reason: 'max_positions_reached', count: openPositions.length });
      return res.status(200).json({ status: 'max_positions', openPositions: openPositions.length, closed: runLog.closed });
    }

    // ── 6. البحث عن إشارة دخول جديدة ──
    const signal = await findBestSignal(openPositions);
    if (!signal) {
      await logDecision({ type: 'no_signal' });
      return res.status(200).json({ status: 'no_signal', closed: runLog.closed });
    }

    // ── 7. تنفيذ الدخول ──
    const opened = await executeEntry(signal);
    runLog.opened = opened;
    await logDecision({ type: 'open', signal, opened });

    return res.status(200).json({ status: 'ok', opened, closed: runLog.closed });

  } catch (err) {
    console.error('auto-trade-engine error:', err);
    await logDecision({ type: 'error', message: err.message }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════ ساعات التداول ═══════════════════════
function isMarketOpenNow() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = ny.getDay();
  if (day === 0 || day === 6) return false;
  const dateStr = ny.toISOString().slice(0, 10);
  if (US_HOLIDAYS_2026.includes(dateStr)) return false;
  const mins = ny.getHours() * 60 + ny.getMinutes();
  // الجلسة الرئيسية فقط: 9:30 - 16:00 (نتجنب pre/after-market لتقلب السيولة العالي)
  return mins >= 570 && mins < 960;
}

// ═══════════════════════ مراقبة/إغلاق صفقة مفتوحة ═══════════════════════
async function evaluatePosition(pos) {
  try {
    const quote = await fetchOptionQuote(pos.ticker, pos.expiry, pos.type, pos.strike);
    if (!quote || quote.price <= 0) {
      return { closed: false, reason: 'no_quote' };
    }

    const currentPrice = quote.price;

    // ── الأولوية: هل الأمر GTC عند الوسيط اتنفذ فعلاً؟ (أسرع وأدق مصدر) ──
    if (pos.takeProfitOrderId) {
      const order = await getOrder(pos.takeProfitOrderId).catch(() => null);
      if (order && order.status === 'filled') {
        const pnl = (parseFloat(order.filled_avg_price) - pos.entry) * pos.contracts * 100;
        await addToDailyPnL(pnl);
        return { closed: true, reason: 'target_filled', exitPrice: parseFloat(order.filled_avg_price), pnl };
      }
    }

    // ── شبكة أمان مباشرة: نفحص السعر اللحظي مقابل الهدف بغض النظر عن حالة
    // أمر الوسيط — هذا يحمي الصفقة حتى لو فشل وضع أمر GTC (مثلاً بسبب
    // race condition بين أمر الدخول وأمر الهدف)، أو لو الأمر لسا ما امتلأ
    // رغم أن السعر فعلياً وصل الهدف. ──
    if (currentPrice >= pos.target) {
      if (pos.takeProfitOrderId) {
        await cancelOrder(pos.takeProfitOrderId).catch(() => {});
      }
      const closeOrder = await closeOptionPositionMarket(pos.occ_symbol, pos.contracts);
      const exitPrice = parseFloat(closeOrder.filled_avg_price || currentPrice);
      const pnl = (exitPrice - pos.entry) * pos.contracts * 100;
      await addToDailyPnL(pnl);
      return { closed: true, reason: 'target_hit_direct_check', exitPrice, pnl };
    }

    // هل ضرب الوقف؟ (-2.5%) — نراقبه إحنا لأن ما فيه ضمان bracket لعقود الخيارات
    const stopPrice = pos.entry * (1 - STOP_PCT);
    if (currentPrice <= stopPrice) {
      // ألغِ أمر الهدف المعلّق أولاً
      if (pos.takeProfitOrderId) {
        await cancelOrder(pos.takeProfitOrderId).catch(() => {});
      }
      const closeOrder = await closeOptionPositionMarket(pos.occ_symbol, pos.contracts);
      const exitPrice = parseFloat(closeOrder.filled_avg_price || currentPrice);
      const pnl = (exitPrice - pos.entry) * pos.contracts * 100;
      await addToDailyPnL(pnl);
      return { closed: true, reason: 'stop_loss_triggered', exitPrice, pnl };
    }

    return { closed: false, currentPrice };
  } catch (err) {
    return { closed: false, reason: 'evaluation_error', error: err.message };
  }
}

// ═══════════════════════ جلب سعر عقد لحظي من Polygon ═══════════════════════
async function fetchOptionQuote(ticker, expiry, type, strike) {
  try {
    const url = `${POLYGON_BASE}/v3/snapshot/options/${ticker}?contract_type=${type.toLowerCase()}&strike_price=${strike}&expiration_date=${expiry}&limit=1&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const c = d.results?.[0];
    if (!c) return null;
    const bid = c.last_quote?.bid || 0;
    const ask = c.last_quote?.ask || 0;
    const mid = c.last_quote?.midpoint || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
    const price = mid > 0 ? mid : (c.last_trade?.price || c.day?.close || 0);
    return { price, bid, ask };
  } catch (e) {
    return null;
  }
}

// ═══════════════════════ البحث عن أفضل إشارة دخول ═══════════════════════
async function findBestSignal(openPositions) {
  const openTickers = new Set(openPositions.map((p) => p.ticker));
  const candidates = WATCHLIST.filter((t) => !openTickers.has(t)); // لا تفتح صفقتين بنفس السهم

  const nextFriISO = nextTradingFriday();

  // نجيب مؤشرات حقيقية لكل سهم (RSI/MACD) لتحديد الاتجاه
  const scored = [];
  await Promise.allSettled(candidates.map(async (t) => {
    try {
      const [rsiR, macdR] = await Promise.all([
        fetch(`${POLYGON_BASE}/v1/indicators/rsi/${t}?timespan=day&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLYGON_KEY}`).then((r) => r.json()),
        fetch(`${POLYGON_BASE}/v1/indicators/macd/${t}?timespan=day&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&limit=1&apiKey=${POLYGON_KEY}`).then((r) => r.json()),
      ]);
      const rsi = rsiR?.results?.values?.[0]?.value;
      const macdVal = macdR?.results?.values?.[0];
      if (rsi == null || !macdVal) return;

      const macdHist = (macdVal.value || 0) - (macdVal.signal || 0);
      // إشارة صاعدة بسيطة وصارمة: RSI بمنطقة صحية (مو تشبع شراء/بيع) + MACD histogram موجب وقوي نسبياً
      const bullish = rsi > 45 && rsi < 65 && macdHist > 0;
      if (!bullish) return;

      const score = macdHist * 10 + (65 - Math.abs(rsi - 55));
      scored.push({ ticker: t, rsi, macdHist, score });
    } catch (e) { /* تجاهل وكمل */ }
  }));

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // نجيب السعر الحالي للسهم
  const snapUrl = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${best.ticker}&apiKey=${POLYGON_KEY}`;
  const snapR = await fetch(snapUrl);
  const snapD = await snapR.json();
  const stockPrice = snapD?.tickers?.[0]?.lastTrade?.p || snapD?.tickers?.[0]?.day?.c;
  if (!stockPrice) return null;

  // نجلب Options Chain الحقيقي ونطبّق نفس فلتر السيولة الصارم المستخدم بالموقع
  const optUrl = `${POLYGON_BASE}/v3/snapshot/options/${best.ticker}?contract_type=call&limit=100&expiration_date=${nextFriISO}&apiKey=${POLYGON_KEY}`;
  const optR = await fetch(optUrl);
  const optD = await optR.json();
  if (!optD.results?.length) return null;

  const targetLow = stockPrice * 1.01;
  const targetHigh = stockPrice * 1.03;

  const liquidContracts = optD.results
    .map((c) => ({
      strike: c.details?.strike_price || 0,
      bid: c.last_quote?.bid || 0,
      ask: c.last_quote?.ask || 0,
      midpoint: c.last_quote?.midpoint || 0,
      lastPrice: c.last_trade?.price || c.day?.close || 0,
      volume: c.day?.volume || 0,
      openInterest: c.open_interest || 0,
    }))
    .filter((c) => {
      if (!(c.strike > 0)) return false;
      const price = c.midpoint > 0 ? c.midpoint : c.lastPrice;
      if (price < 0.05) return false;
      if (!(c.bid > 0) || !(c.ask > 0)) return false;
      const spread = ((c.ask - c.bid) / price) * 100;
      if (spread > 15) return false;
      if (!(c.volume >= 10 || c.openInterest >= 50)) return false;
      return true;
    });

  if (liquidContracts.length === 0) return null; // ما فيه عقد سائل — تجاهل السهم كامل

  const otmIdeal = liquidContracts
    .filter((c) => c.strike >= targetLow && c.strike <= targetHigh)
    .sort((a, b) => (b.volume + b.openInterest) - (a.volume + a.openInterest));
  const otmFallback = liquidContracts
    .filter((c) => c.strike > stockPrice)
    .sort((a, b) => Math.abs(a.strike - stockPrice) - Math.abs(b.strike - stockPrice));

  const chosen = otmIdeal[0] || otmFallback[0];
  if (!chosen) return null;

  const entry = chosen.midpoint > 0 ? chosen.midpoint : chosen.lastPrice;

  return {
    ticker: best.ticker,
    type: 'CALL',
    strike: chosen.strike,
    expiry: nextFriISO,
    entry,
    stockPrice,
    rsi: best.rsi,
    macdHist: best.macdHist,
    score: best.score,
  };
}

// ═══════════════════════ تنفيذ الدخول فعلياً عبر Alpaca ═══════════════════════
async function executeEntry(signal) {
  const riskAmt = CAPITAL * RISK_PCT / 100;
  const contracts = Math.max(1, Math.floor(riskAmt / (signal.entry * 100 * STOP_PCT)));

  const targetPrice = +(signal.entry * (1 + TARGET_PCT)).toFixed(2);
  const stopPrice = +(signal.entry * (1 - STOP_PCT)).toFixed(2);

  let order;
  let takeProfitOrderId = null;
  try {
    // المحاولة الأولى: أمر OTO (دخول + هدف بطلب واحد) — يتجنب مشكلة السباق
    order = await openOptionPositionWithTakeProfit({
      ticker: signal.ticker,
      expiryISO: signal.expiry,
      type: signal.type,
      strike: signal.strike,
      qty: contracts,
      takeProfitLimitPrice: targetPrice,
    });
    // بأمر OTO، الساق الثانية (take_profit) تُنشأ تلقائياً عند الوسيط ونحصل
    // معرّفها من legs[] إن وُجد
    takeProfitOrderId = order.legs?.[0]?.id || null;
  } catch (e) {
    console.error('OTO order failed, falling back to plain entry:', e.message);
    // Fallback: دخول عادي بدون هدف مدمج — evaluatePosition() بيحمي الصفقة
    // بالفحص المباشر للسعر بأي الأحوال، فما فيه خطر حتى لو فشل هذا كمان
    order = await openOptionPosition({
      ticker: signal.ticker,
      expiryISO: signal.expiry,
      type: signal.type,
      strike: signal.strike,
      qty: contracts,
      limitPrice: null,
    });
  }

  const position = {
    id: order.id,
    occ_symbol: order.occ_symbol,
    ticker: signal.ticker,
    type: signal.type,
    strike: signal.strike,
    expiry: signal.expiry,
    entry: signal.entry,
    contracts,
    target: targetPrice,
    stopLoss: stopPrice,
    takeProfitOrderId,
    openedAt: new Date().toISOString(),
    reason: `RSI ${signal.rsi?.toFixed(1)} + MACD hist ${signal.macdHist?.toFixed(3)}`,
  };

  const openPositions = await getOpenPositions();
  openPositions.push(position);
  await setOpenPositions(openPositions);

  return position;
}

// ═══════════════════════ الجمعة القادمة (متجاوزة العطل) ═══════════════════════
function nextTradingFriday() {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  while (US_HOLIDAYS_2026.includes(d.toISOString().slice(0, 10))) {
    d.setDate(d.getDate() + 7);
  }
  return d.toISOString().slice(0, 10);
}
