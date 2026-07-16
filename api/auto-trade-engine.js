// api/auto-trade-engine.js
// نسخة الأسهم — مضاربة يومية محافظة (Day Trading)

import {
  isKillSwitchActive,
  getOpenPositions,
  setOpenPositions,
  getDailyPnL,
  addToDailyPnL,
  isCircuitBreakerTripped,
  tripCircuitBreaker,
  getDailyTradeCount,
  incrementDailyTradeCount,
  setCooldown,
  isCoolingDown,
  updateTickerStats,
  getTickerStats,
  acquireExecutionLock,
  releaseExecutionLock,
  logDecision,
} from '../lib/redis.js';

import {
  getAccount,
  getPositions,
  openEquityMarketOrder,
  openEquityLimitOrder,
  pollOrderFillOrCancel,
  placeOCOExit,
  closeEquityPositionMarket,
  cancelAllOrdersForSymbol,
  fetchRecentSellOrdersForSymbol,
  getOrder,
} from '../lib/alpaca.js';

import { notifyTradeOpened, notifyTradeClosed, notifyCircuitBreaker } from '../lib/notify.js';

// ── إعدادات المخاطرة ──
const CAPITAL = parseFloat(process.env.AUTO_TRADE_CAPITAL || '1000');
const RISK_PCT = parseFloat(process.env.AUTO_TRADE_RISK_PCT || '2');
const DAILY_LOSS_LIMIT_PCT = parseFloat(process.env.AUTO_TRADE_DAILY_LOSS_PCT || '3');
const MAX_OPEN_POSITIONS = parseInt(process.env.AUTO_TRADE_MAX_POSITIONS || '2', 10);
const MAX_DAILY_TRADES = parseInt(process.env.AUTO_TRADE_MAX_DAILY_TRADES || '5', 10);
const TARGET_PCT = parseFloat(process.env.AUTO_TRADE_STOCK_TARGET_PCT || '1.5') / 100;
const STOP_PCT = parseFloat(process.env.AUTO_TRADE_STOCK_STOP_PCT || '0.75') / 100;
const HARD_MAX_RISK_PCT = 5;

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

const WATCHLIST = ['NVDA', 'QQQ', 'AMD', 'AAPL', 'COIN', 'TSLA', 'META', 'MSFT', 'GOOGL', 'AMZN', 'SMCI', 'PLTR', 'MSTR', 'IBIT', 'ARM', 'MRVL'];
const US_HOLIDAYS_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-25'];

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runLog = { opened: null, closed: [] };

  const lockAcquired = await acquireExecutionLock();
  if (!lockAcquired) {
    return res.status(200).json({ status: 'skipped', reason: 'another_cycle_running' });
  }

  try {
    if (await isKillSwitchActive()) {
      await logDecision({ type: 'skip', reason: 'kill_switch_active' });
      return res.status(200).json({ status: 'halted', reason: 'kill_switch_active' });
    }

    const nowET = nowInET();

    if (!isMarketOpenNow(nowET)) {
      return res.status(200).json({ status: 'skipped', reason: 'market_closed' });
    }

    await syncWithBroker();

    const minsNow = nowET.getHours() * 60 + nowET.getMinutes();
    const isEndOfDaySweep = minsNow >= 955;

    let openPositions = await getOpenPositions();
    const stillOpen = [];

    for (const pos of openPositions) {
      const result = isEndOfDaySweep
        ? await forceCloseEndOfDay(pos)
        : await evaluatePosition(pos);

      if (result.closed) {
        runLog.closed.push(result);
        await logDecision({ type: 'close', position: pos, result });
        await notifyTradeClosed(pos, result).catch(() => {});
        await setCooldown(pos.ticker).catch(() => {});
        await updateTickerStats(pos.ticker, result.pnl ?? 0).catch(() => {});
      } else {
        stillOpen.push(result.updatedPos || pos);
      }
    }
    await setOpenPositions(stillOpen);
    openPositions = stillOpen;

    if (isEndOfDaySweep) {
      return res.status(200).json({ status: 'end_of_day_sweep', closed: runLog.closed });
    }

    const dailyPnL = await getDailyPnL();
    const dailyLossLimit = -(CAPITAL * DAILY_LOSS_LIMIT_PCT / 100);
    if (dailyPnL <= dailyLossLimit && !(await isCircuitBreakerTripped())) {
      await tripCircuitBreaker();
      await notifyCircuitBreaker(dailyPnL).catch(() => {});
    }
    if (await isCircuitBreakerTripped()) {
      await logDecision({ type: 'skip', reason: 'daily_loss_circuit_breaker', dailyPnL });
      return res.status(200).json({ status: 'circuit_breaker_active', dailyPnL, closed: runLog.closed });
    }

    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      await logDecision({ type: 'skip', reason: 'max_positions_reached', count: openPositions.length });
      return res.status(200).json({ status: 'max_positions', closed: runLog.closed });
    }

    const dailyTradeCount = await getDailyTradeCount();
    if (dailyTradeCount >= MAX_DAILY_TRADES) {
      await logDecision({ type: 'skip', reason: 'max_daily_trades_reached', count: dailyTradeCount });
      return res.status(200).json({ status: 'max_daily_trades', dailyTradeCount, closed: runLog.closed });
    }

    if (!isEntryWindowOpen(nowET)) {
      await logDecision({ type: 'skip', reason: 'outside_entry_window' });
      return res.status(200).json({ status: 'outside_entry_window', closed: runLog.closed });
    }

    // ⚠️ فلتر حالة السوق العام: لا نفتح أي صفقة فردية لو السوق ككل (SPY)
    // تحت اتجاهه العام — "لا تسبح عكس التيار" حتى لو إشارة سهم بعينه تبدو
    // ممتازة. معطّل افتراضياً (نفس منهج الفلاتر التجريبية الأخرى). ──
    if (ENABLE_MARKET_REGIME_FILTER) {
      const marketHealthy = await isMarketHealthy();
      if (!marketHealthy) {
        await logDecision({ type: 'skip', reason: 'market_regime_unhealthy' });
        return res.status(200).json({ status: 'market_regime_unhealthy', closed: runLog.closed });
      }
    }

    const sanityCheck = await verifyAccountSanity();
    if (!sanityCheck.ok) {
      await logDecision({ type: 'skip', reason: 'account_sanity_check_failed', details: sanityCheck });
      return res.status(200).json({ status: 'sanity_check_failed', details: sanityCheck, closed: runLog.closed });
    }

    const signal = await findBestSignal(openPositions);
    if (!signal) {
      await logDecision({ type: 'no_signal' });
      return res.status(200).json({ status: 'no_signal', closed: runLog.closed });
    }

    let opened;
    try {
      opened = await executeEntry(signal);
    } catch (execErr) {
      await setCooldown(signal.ticker, 120).catch(() => {});
      await logDecision({ type: 'error', message: execErr.message, ticker: signal.ticker }).catch(() => {});
      return res.status(200).json({ status: 'entry_failed', ticker: signal.ticker, error: execErr.message, closed: runLog.closed });
    }
    await incrementDailyTradeCount();
    runLog.opened = opened;
    await logDecision({ type: 'open', signal, opened });
    await notifyTradeOpened(opened).catch(() => {});

    return res.status(200).json({ status: 'ok', opened, closed: runLog.closed });

  } catch (err) {
    console.error('auto-trade-engine error:', err);
    await logDecision({ type: 'error', message: err.message }).catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    await releaseExecutionLock().catch(() => {});
  }
}

// ═══════════════════════ مزامنة مع الوسيط ═══════════════════════
async function syncWithBroker() {
  try {
    const localPositions = await getOpenPositions();
    if (localPositions.length === 0) return;

    const brokerPositions = await getPositions();
    const brokerSymbols = new Set((brokerPositions || []).map((p) => p.symbol));

    const stillOpen = [];
    for (const pos of localPositions) {
      if (brokerSymbols.has(pos.ticker)) {
        stillOpen.push(pos);
        continue;
      }

      let exitPrice = null;
      let closeReason = 'closed_at_broker_unknown_leg';

      const tp = pos.takeProfitOrderId ? await getOrder(pos.takeProfitOrderId).catch(() => null) : null;
      const sl = pos.stopLossOrderId ? await getOrder(pos.stopLossOrderId).catch(() => null) : null;

      if (tp?.status === 'filled') {
        exitPrice = parseFloat(tp.filled_avg_price);
        closeReason = 'target_filled_synced';
      } else if (sl?.status === 'filled') {
        exitPrice = parseFloat(sl.filled_avg_price);
        closeReason = 'stop_loss_filled_synced';
      }

      if (exitPrice == null) {
        exitPrice = (await fetchStockPrice(pos.ticker)) || pos.entry;
      }

      const pnl = (exitPrice - pos.entry) * pos.qty;
      await addToDailyPnL(pnl);
      await setCooldown(pos.ticker).catch(() => {});
      await updateTickerStats(pos.ticker, pnl).catch(() => {});
      await logDecision({ type: 'close', position: pos, result: { closed: true, reason: closeReason, exitPrice, pnl, via: 'broker_sync' } });
    }

    if (stillOpen.length !== localPositions.length) {
      await setOpenPositions(stillOpen);
    }
  } catch (err) {
    console.error('syncWithBroker error:', err.message);
  }
}

// ═══════════════════════ الوقت والجلسة ═══════════════════════
function nowInET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function isMarketOpenNow(ny) {
  const day = ny.getDay();
  if (day === 0 || day === 6) return false;
  const dateStr = ny.toISOString().slice(0, 10);
  if (US_HOLIDAYS_2026.includes(dateStr)) return false;
  const mins = ny.getHours() * 60 + ny.getMinutes();
  return mins >= 570 && mins < 960;
}

function isEntryWindowOpen(ny) {
  const mins = ny.getHours() * 60 + ny.getMinutes();
  return mins >= 585 && mins < 945;
}

// ═══════════════════════ صمّام أمان ═══════════════════════
async function verifyAccountSanity() {
  try {
    const account = await getAccount();
    const buyingPower = parseFloat(account.buying_power || 0);
    const equity = parseFloat(account.equity || 0);
    if (buyingPower < 50) {
      return { ok: false, reason: 'insufficient_buying_power', buyingPower };
    }
    if (CAPITAL > equity * 3) {
      return { ok: false, reason: 'capital_mismatch', configured: CAPITAL, actualEquity: equity };
    }
    return { ok: true, buyingPower, equity };
  } catch (err) {
    return { ok: false, reason: 'account_fetch_failed', error: err.message };
  }
}

// ═══════════════════════ مراقبة/إغلاق صفقة مفتوحة ═══════════════════════
const TRAILING_LOCK_TRIGGER_PROGRESS = 0.80;
const TRAILING_LOCK_PULLBACK_PCT = 0.25;

async function evaluatePosition(pos) {
  try {
    if (pos.takeProfitOrderId) {
      const tp = await getOrder(pos.takeProfitOrderId).catch(() => null);
      if (tp?.status === 'filled') {
        const pnl = (parseFloat(tp.filled_avg_price) - pos.entry) * pos.qty;
        await addToDailyPnL(pnl);
        return { closed: true, reason: 'target_filled', exitPrice: parseFloat(tp.filled_avg_price), pnl };
      }
    }
    if (pos.stopLossOrderId) {
      const sl = await getOrder(pos.stopLossOrderId).catch(() => null);
      if (sl?.status === 'filled') {
        const pnl = (parseFloat(sl.filled_avg_price) - pos.entry) * pos.qty;
        await addToDailyPnL(pnl);
        return { closed: true, reason: 'stop_loss_filled', exitPrice: parseFloat(sl.filled_avg_price), pnl };
      }
    }

    const price = await fetchStockPrice(pos.ticker);
    if (price == null) return { closed: false, reason: 'no_quote', updatedPos: pos };

    if (price >= pos.target || price <= pos.stopLoss) {
      await cancelAllOrdersForSymbol(pos.ticker).catch(() => {});
      const closeOrder = await closeEquityPositionMarket(pos.ticker, pos.qty);
      const exitPrice = parseFloat(closeOrder.filled_avg_price || price);
      const pnl = (exitPrice - pos.entry) * pos.qty;
      await addToDailyPnL(pnl);
      return {
        closed: true,
        reason: price >= pos.target ? 'target_hit_direct_check' : 'stop_hit_direct_check',
        exitPrice, pnl,
      };
    }

    const distanceToTarget = pos.target - pos.entry;
    const peakPrice = Math.max(pos.peakPrice || pos.entry, price);
    const peakProgress = distanceToTarget > 0 ? (peakPrice - pos.entry) / distanceToTarget : 0;

    if (peakProgress >= TRAILING_LOCK_TRIGGER_PROGRESS) {
      const gainFromEntryToPeak = peakPrice - pos.entry;
      const pullbackFromPeak = peakPrice - price;
      const pullbackRatio = gainFromEntryToPeak > 0 ? pullbackFromPeak / gainFromEntryToPeak : 0;

      if (pullbackRatio >= TRAILING_LOCK_PULLBACK_PCT) {
        await cancelAllOrdersForSymbol(pos.ticker).catch(() => {});
        const closeOrder = await closeEquityPositionMarket(pos.ticker, pos.qty);
        const exitPrice = parseFloat(closeOrder.filled_avg_price || price);
        const pnl = (exitPrice - pos.entry) * pos.qty;
        await addToDailyPnL(pnl);
        return { closed: true, reason: 'profit_lock_trailing', exitPrice, pnl };
      }
    }

    return { closed: false, currentPrice: price, updatedPos: { ...pos, peakPrice } };
  } catch (err) {
    return { closed: false, reason: 'evaluation_error', error: err.message, updatedPos: pos };
  }
}

// ═══════════════════════ إغلاق إجباري بنهاية اليوم ═══════════════════════
async function forceCloseEndOfDay(pos) {
  try {
    await cancelAllOrdersForSymbol(pos.ticker).catch(() => {});
    const price = await fetchStockPrice(pos.ticker);
    const closeOrder = await closeEquityPositionMarket(pos.ticker, pos.qty);
    const exitPrice = parseFloat(closeOrder.filled_avg_price || price || pos.entry);
    const pnl = (exitPrice - pos.entry) * pos.qty;
    await addToDailyPnL(pnl);
    return { closed: true, reason: 'end_of_day_forced_close', exitPrice, pnl };
  } catch (err) {
    return { closed: false, reason: 'force_close_error', error: err.message };
  }
}

// ═══════════════════════ بيانات السوق ═══════════════════════
async function fetchStockPrice(ticker) {
  try {
    const url = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${ticker}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const snap = d?.tickers?.[0];
    return snap?.lastTrade?.p || snap?.day?.c || null;
  } catch (e) {
    return null;
  }
}

async function fetchDaySnapshot(ticker) {
  try {
    const url = `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${ticker}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const snap = d?.tickers?.[0];
    if (!snap) return null;
    return {
      price: snap.lastTrade?.p || snap.day?.c || null,
      vwap: snap.day?.vw || null,
      volume: snap.day?.v || null,
    };
  } catch (e) {
    return null;
  }
}

async function fetchAvgVolume20d(ticker) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const fromD = new Date();
    fromD.setDate(fromD.getDate() - 30);
    const from = fromD.toISOString().slice(0, 10);
    const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=20&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const results = d?.results || [];
    if (results.length === 0) return null;
    return results.reduce((sum, bar) => sum + (bar.v || 0), 0) / results.length;
  } catch (e) {
    return null;
  }
}

// ── متوسط المدى الحقيقي (ATR-14) — مقياس تقلب كل سهم الفعلي بالدولار.
// Polygon لا يوفّر ATR جاهزاً كمؤشر (فقط SMA/EMA/MACD/RSI)، فنحسبه يدوياً
// من شموع يومية بالمعادلة القياسية: TR = max(H-L, |H-prevClose|,
// |L-prevClose|)، وATR = متوسط آخر 14 قيمة TR. ──
async function fetchATR14(ticker) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const fromD = new Date();
    fromD.setDate(fromD.getDate() - 30); // يضمن ~20 يوم تداول فعلي لحساب 14 TR
    const from = fromD.toISOString().slice(0, 10);
    const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=30&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const bars = d?.results || [];
    if (bars.length < 15) return null; // بيانات غير كافية لحساب موثوق

    const trueRanges = [];
    for (let i = 1; i < bars.length; i++) {
      const high = bars[i].h, low = bars[i].l, prevClose = bars[i - 1].c;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }
    const last14 = trueRanges.slice(-14);
    if (last14.length === 0) return null;
    return last14.reduce((sum, v) => sum + v, 0) / last14.length;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════ البحث عن أفضل إشارة ═══════════════════════
const ENABLE_VWAP_FILTER = (process.env.AUTO_TRADE_ENABLE_VWAP_FILTER || 'false') === 'true';
const ENABLE_VOLUME_FILTER = (process.env.AUTO_TRADE_ENABLE_VOLUME_FILTER || 'false') === 'true';

// ⚠️ فلتر الاستبعاد التلقائي بناءً على الأداء التاريخي الفعلي — أول
// استخدام حقيقي لجدول "نقاط الثقة" اللي كنا نبنيه فقط للمراقبة. أي سهم
// جمع 3 صفقات فأكثر ونسبة نجاحه أقل من الحد الأدنى يُستبعد تلقائياً من
// الترشيح، بغض النظر عن قوة الإشارة اللحظية — نفس منطق "لا تشتري ضد
// التيار" لكن مطبّق على الأداء التاريخي للسهم نفسه، مو بس اتجاهه السعري.
const MIN_TRADES_FOR_PERFORMANCE_FILTER = parseInt(process.env.AUTO_TRADE_MIN_TRADES_FOR_FILTER || '3', 10);
const MIN_WIN_RATE_PCT = parseFloat(process.env.AUTO_TRADE_MIN_WIN_RATE_PCT || '40');

// ⚠️ فلتر حالة السوق العام — الفجوة الأصلية المكتشفة من أول يوم تحليل:
// النظام كان يقيّم كل سهم بمعزل تام، بدون ما يسأل "هل السوق ككل صاعد
// أصلاً؟". نتحقق من SPY كمقياس عام: لو السوق تحت اتجاهه العام (EMA50)،
// نوقف كل عمليات الفتح الجديدة بغض النظر عن قوة أي إشارة فردية — مبدأ
// "لا تسبح عكس التيار" مطبّق على مستوى السوق كامل، مو بس السهم الواحد.
const ENABLE_MARKET_FILTER = (process.env.AUTO_TRADE_ENABLE_MARKET_FILTER || 'true') === 'true';

async function isMarketConditionFavorable() {
  if (!ENABLE_MARKET_FILTER) return { ok: true, skipped: true };
  try {
    const snapshot = await fetchDaySnapshot('SPY');
    if (!snapshot?.price) return { ok: true, reason: 'data_unavailable_fail_open' }; // fail-open

    const ema50 = await fetchEMA50('SPY');
    if (ema50 == null) return { ok: true, reason: 'ema_unavailable_fail_open' };

    if (snapshot.price < ema50) {
      return { ok: false, reason: 'spy_below_ema50', spyPrice: snapshot.price, spyEma50: ema50 };
    }
    return { ok: true, spyPrice: snapshot.price, spyEma50: ema50 };
  } catch (e) {
    return { ok: true, reason: 'market_check_error_fail_open' };
  }
}

async function findBestSignal(openPositions) {
  // ── الفحص الأول قبل أي شي: هل السوق ككل بحالة مواتية؟ ──
  const marketCheck = await isMarketConditionFavorable();
  if (!marketCheck.ok) {
    return { blocked: true, reason: 'unfavorable_market_condition', details: marketCheck };
  }

  const openTickers = new Set(openPositions.map((p) => p.ticker));
  const candidatesAfterOpen = WATCHLIST.filter((t) => !openTickers.has(t));

  // ── فلتر الأداء التاريخي: نستبعد الأسهم اللي أثبتت فشلاً متكرراً موثّقاً ──
  const statsChecks = await Promise.all(candidatesAfterOpen.map((t) => getTickerStats(t)));
  const candidatesRaw = candidatesAfterOpen.filter((t, i) => {
    const stats = statsChecks[i];
    if (!stats || stats.tradesCount < MIN_TRADES_FOR_PERFORMANCE_FILTER) return true; // بيانات غير كافية — نسمح له
    return stats.winRate >= MIN_WIN_RATE_PCT;
  });

  const cooldownChecks = await Promise.all(candidatesRaw.map((t) => isCoolingDown(t)));
  const candidates = candidatesRaw.filter((_, i) => !cooldownChecks[i]);

  const scored = [];
  await Promise.allSettled(candidates.map(async (t) => {
    try {
      const [rsiR, macdR] = await Promise.all([
        fetch(`${POLYGON_BASE}/v1/indicators/rsi/${t}?timespan=${INDICATOR_TIMESPAN}&adjusted=true&window=14&series_type=close&limit=1&apiKey=${POLYGON_KEY}`).then((r) => r.json()),
        fetch(`${POLYGON_BASE}/v1/indicators/macd/${t}?timespan=${INDICATOR_TIMESPAN}&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&limit=1&apiKey=${POLYGON_KEY}`).then((r) => r.json()),
      ]);
      const rsi = rsiR?.results?.values?.[0]?.value;
      const macdVal = macdR?.results?.values?.[0];
      if (rsi == null || !macdVal) return;

      const macdHist = (macdVal.value || 0) - (macdVal.signal || 0);
      const bullish = rsi > 45 && rsi < 65 && macdHist > 0;
      if (!bullish) return;

      const score = macdHist * 10 + (65 - Math.abs(rsi - 55));
      scored.push({ ticker: t, rsi, macdHist, score });
    } catch (e) { /* تجاهل وكمل */ }
  }));

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  for (const candidate of scored) {
    const snapshot = await fetchDaySnapshot(candidate.ticker);
    const stockPrice = snapshot?.price;
    if (!stockPrice) continue;

    const ema50 = await fetchEMA50(candidate.ticker);
    if (ema50 != null && stockPrice < ema50) continue;

    if (ENABLE_VWAP_FILTER && snapshot?.vwap != null && stockPrice < snapshot.vwap) continue;

    let relVolume = null;
    if (ENABLE_VOLUME_FILTER && snapshot?.volume) {
      const avgVol = await fetchAvgVolume20d(candidate.ticker);
      if (avgVol) {
        relVolume = snapshot.volume / avgVol;
        if (relVolume < 2) continue;
      }
    }

    return {
      ticker: candidate.ticker,
      entry: stockPrice,
      rsi: candidate.rsi,
      macdHist: candidate.macdHist,
      score: candidate.score,
      ema50,
      vwap: snapshot?.vwap ?? null,
      relVolume: relVolume != null ? +relVolume.toFixed(2) : null,
    };
  }

  return null;
}

async function fetchEMA50(ticker) {
  try {
    const url = `${POLYGON_BASE}/v1/indicators/ema/${ticker}?timespan=day&adjusted=true&window=50&series_type=close&limit=1&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    return d?.results?.values?.[0]?.value ?? null;
  } catch (e) {
    return null;
  }
}

const MAX_ENTRY_GAP_PCT = parseFloat(process.env.AUTO_TRADE_MAX_ENTRY_GAP_PCT || '0.7');

// ⚠️ فلتر حالة السوق العام — معطّل افتراضياً (تجريبي، بنفس منهج الفلاتر
// الأخرى). يفحص SPY كمرجع: لو تحت EMA50 الخاص فيه، السوق ككل بحالة ضعف
// عام، فنمتنع عن فتح صفقات فردية جديدة حتى لو إشارتها ممتازة.
const ENABLE_MARKET_REGIME_FILTER = (process.env.AUTO_TRADE_ENABLE_MARKET_REGIME_FILTER || 'false') === 'true';
const MARKET_REGIME_TICKER = process.env.AUTO_TRADE_MARKET_REGIME_TICKER || 'SPY';

async function isMarketHealthy() {
  try {
    const price = await fetchStockPrice(MARKET_REGIME_TICKER);
    const ema50 = await fetchEMA50(MARKET_REGIME_TICKER);
    if (price == null || ema50 == null) return true; // بيانات ناقصة — fail-open، لا نمنع التداول بسببها
    return price >= ema50;
  } catch (e) {
    return true; // fail-open
  }
}

// ⚠️ مؤشرات بإطار زمني أقصر (تجريبي، معطّل افتراضياً) — يعالج عدم التطابق
// الزمني المعروف: نحسب RSI/MACD حالياً على شموع يومية لكن نتخذ قرار داخل
// اليوم. هذا يبدّل الإطار لساعة واحدة. ⚠️ تنبيه صريح: عتبات RSI (45-65)
// ومعايير MACD الحالية مُعايرة على بيانات يومية — لا نعرف بعد هل نفس
// العتبات تصلح على إطار الساعة، هذا يحتاج معايرة جديدة كاملة بعد جمع
// بيانات حقيقية بالإطار الجديد، مو افتراض جاهز من اليوم الأول.
const ENABLE_HOURLY_INDICATORS = (process.env.AUTO_TRADE_ENABLE_HOURLY_INDICATORS || 'false') === 'true';
const INDICATOR_TIMESPAN = ENABLE_HOURLY_INDICATORS ? 'hour' : 'day';

// ⚠️ الهدف/الوقف المتكيّف بـATR — معطّل افتراضياً (نجرّبه بمعزل قبل
// الالتزام، بنفس منهج VWAP/الحجم). لو فشل جلب ATR لأي سبب، نرجع تلقائياً
// للنسبة الثابتة (fail-safe) بدل ما نمنع الصفقة بالكامل.
const ENABLE_ATR_TARGETS = (process.env.AUTO_TRADE_ENABLE_ATR_TARGETS || 'false') === 'true';
const ATR_STOP_MULTIPLIER = parseFloat(process.env.AUTO_TRADE_ATR_STOP_MULTIPLIER || '1.0');
const ATR_TARGET_MULTIPLIER = parseFloat(process.env.AUTO_TRADE_ATR_TARGET_MULTIPLIER || '2.0'); // يحافظ على R:R = 2:1

// ═══════════════════════ تنفيذ الدخول ═══════════════════════
// ⚠️ تصنيف قوة الإشارة — مبني على دليل حقيقي من بياناتنا، مو تخمين نظري:
// MACD متطرف (>6) كان نمط META الخطر (مطاردة قمة تنعكس بسرعة)، بينما
// فجوة EMA50 كبيرة + MACD معتدل (زي AAPL بثبات) كانت الأكثر موثوقية.
// لهذا لا نستخدم "score" الخام (يكبر مع MACD المتطرف) كمقياس قوة، بل
// نصنّف صراحة بناءً على الدرس المستفاد.
function classifySignalQuality(signal) {
  const emaGapPct = signal.ema50 ? ((signal.entry - signal.ema50) / signal.ema50) * 100 : null;
  const macdHist = signal.macdHist;

  const isWeak = macdHist > 6 || (emaGapPct != null && emaGapPct < 1);
  if (isWeak) return { tier: 'weak', riskMultiplier: 0.5 };

  const isStrong = emaGapPct != null && emaGapPct >= 3 && macdHist >= 1.5 && macdHist <= 4;
  if (isStrong) return { tier: 'strong', riskMultiplier: 1.25 };

  return { tier: 'normal', riskMultiplier: 1.0 };
}

async function executeEntry(signal) {
  const quality = classifySignalQuality(signal);
  const effectiveRiskPct = Math.min(RISK_PCT * quality.riskMultiplier, HARD_MAX_RISK_PCT);
  const riskAmt = CAPITAL * effectiveRiskPct / 100;
  const shares = Math.max(1, Math.floor(riskAmt / (signal.entry * STOP_PCT)));

  const freshPrice = await fetchStockPrice(signal.ticker);
  if (freshPrice) {
    const gapPct = ((freshPrice - signal.entry) / signal.entry) * 100;
    if (Math.abs(gapPct) > MAX_ENTRY_GAP_PCT) {
      const direction = gapPct > 0 ? 'صاعدة (مطاردة قمة)' : 'هابطة (زخم منتهي)';
      throw new Error(`price_gap_too_large: signal=${signal.entry} fresh=${freshPrice} gap=${gapPct.toFixed(2)}% (${direction})`);
    }
  }

  const ceilingPrice = +(signal.entry * (1 + MAX_ENTRY_GAP_PCT / 100)).toFixed(2);
  const entryOrder = await openEquityLimitOrder({ symbol: signal.ticker, qty: shares, limitPrice: ceilingPrice });

  const filledOrder = await pollOrderFillOrCancel(entryOrder.id);
  const realEntryPrice = parseFloat(filledOrder.filled_avg_price);

  // ── حساب الهدف والوقف: من ATR الفعلي لو مفعّل ومتوفر، وإلا نسبة ثابتة ──
  let targetPrice, stopPrice, atrUsed = null;
  if (ENABLE_ATR_TARGETS) {
    const atr = await fetchATR14(signal.ticker);
    if (atr) {
      atrUsed = atr;
      targetPrice = +(realEntryPrice + atr * ATR_TARGET_MULTIPLIER).toFixed(2);
      stopPrice = +(realEntryPrice - atr * ATR_STOP_MULTIPLIER).toFixed(2);
    }
  }
  if (targetPrice == null) {
    // fail-safe: نسبة ثابتة، إما لأن ATR معطّل أو فشل جلبه
    targetPrice = +(realEntryPrice * (1 + TARGET_PCT)).toFixed(2);
    stopPrice = +(realEntryPrice * (1 - STOP_PCT)).toFixed(2);
  }

  // ── ربط الحماية بأمر OCO، ثم تحديد معرّفات الأرجل عبر استعلام مباشر
  // بالرمز (موثوق) بدل الاعتماد على حقل legs بالأمر الأب (ثبت أنه غير
  // موثوق دائماً بمنصة Alpaca لأوامر OCO — موثّق بشكاوى مجتمعية) ──
  let takeProfitOrderId = null;
  let stopLossOrderId = null;
  try {
    await placeOCOExit({
      symbol: signal.ticker,
      qty: shares,
      takeProfitPrice: targetPrice,
      stopLossPrice: stopPrice,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const legsResult = await fetchRecentSellOrdersForSymbol(signal.ticker, shares);
    takeProfitOrderId = legsResult.takeProfitOrderId;
    stopLossOrderId = legsResult.stopLossOrderId;
    if (!takeProfitOrderId || !stopLossOrderId) {
      console.error('OCO legs incomplete after direct query:', JSON.stringify(legsResult.raw));
    }
  } catch (e) {
    console.error('OCO exit placement failed:', e.message);
  }

  const position = {
    id: entryOrder.id,
    ticker: signal.ticker,
    entry: realEntryPrice,
    peakPrice: realEntryPrice,
    qty: shares,
    target: targetPrice,
    stopLoss: stopPrice,
    takeProfitOrderId,
    stopLossOrderId,
    openedAt: new Date().toISOString(),
    reason: `RSI ${signal.rsi?.toFixed(1)} + MACD hist ${signal.macdHist?.toFixed(3)}${signal.ema50 ? ` + فوق EMA50 (${signal.ema50.toFixed(2)})` : ''}${signal.vwap ? ` + فوق VWAP (${signal.vwap.toFixed(2)})` : ''}${signal.relVolume ? ` + حجم نسبي ${signal.relVolume}×` : ''} [${quality.tier === 'strong' ? 'إشارة قوية 🟢' : quality.tier === 'weak' ? 'إشارة ضعيفة 🔴' : 'إشارة عادية 🟡'}]`,
    riskAmt,
    signalQuality: quality.tier,
    riskMultiplierApplied: quality.riskMultiplier,
    atrUsed,
    signalPrice: signal.entry,
  };

  const openPositions = await getOpenPositions();
  openPositions.push(position);
  await setOpenPositions(openPositions);

  return position;
}
