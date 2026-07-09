// api/auto-trade-engine.js
// نسخة الأسهم — مضاربة يومية محافظة (Day Trading): هدف صغير، وقف أصغر،
// إغلاق إجباري بنفس اليوم بدون استثناء. يُستدعى من Vercel Cron كل دقيقتين.
//
// الفرق الجوهري عن نسخة الخيارات السابقة:
// 1. Bracket Orders مدعومة رسمياً للأسهم — الحماية تعيش عند الوسيط من لحظة
//    التنفيذ، مو معتمدة على استمرار عمل الـCron.
// 2. سيولة الأسهم الكبيرة عميقة جداً — ما نحتاج فلتر سبريد معقد زي الخيارات.
// 3. صمّام أمان جديد: مقارنة رأس المال المُعلن بالحساب الحقيقي عند Alpaca،
//    وسقف صارم لأقصى مخاطرة مسموحة لكل صفقة (يمنع تكرار خطأ RISK_PCT اليوم).

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
  acquireExecutionLock,
  releaseExecutionLock,
  logDecision,
} from '../lib/redis.js';

import {
  getAccount,
  getPositions,
  openEquityMarketOrder,
  pollOrderFill,
  placeOCOExit,
  closeEquityPositionMarket,
  cancelAllOrdersForSymbol,
  getOrder,
} from '../lib/alpaca.js';

import { notifyTradeOpened, notifyTradeClosed, notifyCircuitBreaker } from '../lib/notify.js';

// ── إعدادات المخاطرة (Environment Variables، بقيم افتراضية آمنة لمضاربة يومية) ──
const CAPITAL = parseFloat(process.env.AUTO_TRADE_CAPITAL || '1000');
const RISK_PCT = parseFloat(process.env.AUTO_TRADE_RISK_PCT || '2');
const DAILY_LOSS_LIMIT_PCT = parseFloat(process.env.AUTO_TRADE_DAILY_LOSS_PCT || '3');
const MAX_OPEN_POSITIONS = parseInt(process.env.AUTO_TRADE_MAX_POSITIONS || '2', 10);
const MAX_DAILY_TRADES = parseInt(process.env.AUTO_TRADE_MAX_DAILY_TRADES || '5', 10);
const TARGET_PCT = parseFloat(process.env.AUTO_TRADE_STOCK_TARGET_PCT || '1.5') / 100; // افتراضي 1.5%
const STOP_PCT = parseFloat(process.env.AUTO_TRADE_STOCK_STOP_PCT || '0.75') / 100;    // افتراضي 0.75% (R:R = 2:1)

// ⚠️ سقف صارم: مهما كانت قيمة RISK_PCT، أقصى مخاطرة لصفقة واحدة لا تتجاوز
// هذه النسبة من رأس المال إطلاقاً. هذا بالضبط الحاجز اللي كان ناقص اليوم
// ومنع تحديد خطأ كتابي (RISK_PCT=20 بدل 2) من التسبب بخسارة 142% من رأس المال.
const HARD_MAX_RISK_PCT = 5;

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

const WATCHLIST = ['NVDA', 'QQQ', 'AMD', 'AAPL', 'COIN', 'TSLA', 'META', 'MSFT', 'GOOGL', 'SPY', 'AMZN', 'SMCI', 'PLTR', 'MSTR', 'IBIT', 'ARM', 'MRVL', 'GLD', 'IAU'];
const US_HOLIDAYS_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-25'];

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runLog = { opened: null, closed: [] };

  // ── قفل التنفيذ: لو فيه دورة ثانية شغالة حالياً، ننسحب فوراً بدل ما نتداخل معها ──
  const lockAcquired = await acquireExecutionLock();
  if (!lockAcquired) {
    return res.status(200).json({ status: 'skipped', reason: 'another_cycle_running' });
  }

  try {
    // ── 1. Kill Switch أولاً ──
    if (await isKillSwitchActive()) {
      await logDecision({ type: 'skip', reason: 'kill_switch_active' });
      return res.status(200).json({ status: 'halted', reason: 'kill_switch_active' });
    }

    const nowET = nowInET();

    // ── 2. خارج ساعات التداول؟ ──
    if (!isMarketOpenNow(nowET)) {
      return res.status(200).json({ status: 'skipped', reason: 'market_closed' });
    }

    // ── 2.5 مزامنة مع Alpaca: الوسيط هو مصدر الحقيقة النهائي للمراكز ──
    // لو bracket order أغلق صفقة (هدف/وقف) بين دورتين، سجلنا الداخلي ما يدري.
    // هنا نصحح السجل ونحسب الـPnL الفائت قبل أي قرار جديد.
    await syncWithBroker();

    // ── 3. كنسة نهاية اليوم — إغلاق إجباري لأي مركز مفتوح قبل الإغلاق ──
    // (مضاربة يومية = صفر ترحيل لليوم التالي، بدون أي استثناء)
    const minsNow = nowET.getHours() * 60 + nowET.getMinutes();
    const isEndOfDaySweep = minsNow >= 955; // 15:55 ET — قبل الإغلاق بـ5 دقائق

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
      } else {
        stillOpen.push(pos);
      }
    }
    await setOpenPositions(stillOpen);
    openPositions = stillOpen;

    if (isEndOfDaySweep) {
      // بعد كنسة نهاية اليوم، لا نفتح صفقات جديدة إطلاقاً
      return res.status(200).json({ status: 'end_of_day_sweep', closed: runLog.closed });
    }

    // ── 4. قاطع الدائرة اليومي ──
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

    // ── 5. حد الصفقات المفتوحة ──
    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      await logDecision({ type: 'skip', reason: 'max_positions_reached', count: openPositions.length });
      return res.status(200).json({ status: 'max_positions', closed: runLog.closed });
    }

    // ── 5.5 حد عدد الصفقات اليومي (منفصل عن حد الصفقات المفتوحة بنفس الوقت) ──
    const dailyTradeCount = await getDailyTradeCount();
    if (dailyTradeCount >= MAX_DAILY_TRADES) {
      await logDecision({ type: 'skip', reason: 'max_daily_trades_reached', count: dailyTradeCount });
      return res.status(200).json({ status: 'max_daily_trades', dailyTradeCount, closed: runLog.closed });
    }

    // ── 5.7 نافذة الدخول: لا صفقات جديدة بأول 15 دقيقة من الجلسة ──
    if (!isEntryWindowOpen(nowET)) {
      await logDecision({ type: 'skip', reason: 'outside_entry_window' });
      return res.status(200).json({ status: 'outside_entry_window', closed: runLog.closed });
    }

    // ── 6. صمّام أمان: تحقق من الحساب الحقيقي عند Alpaca قبل أي حساب حجم صفقة ──
    const sanityCheck = await verifyAccountSanity();
    if (!sanityCheck.ok) {
      await logDecision({ type: 'skip', reason: 'account_sanity_check_failed', details: sanityCheck });
      return res.status(200).json({ status: 'sanity_check_failed', details: sanityCheck, closed: runLog.closed });
    }

    // ── 7. البحث عن إشارة ──
    const signal = await findBestSignal(openPositions);
    if (!signal) {
      await logDecision({ type: 'no_signal' });
      return res.status(200).json({ status: 'no_signal', closed: runLog.closed });
    }

    // ── 8. التنفيذ ──
    let opened;
    try {
      opened = await executeEntry(signal);
    } catch (execErr) {
      // فشل التنفيذ (زي: السعر تحرك بين القرار والإرسال) — نسجّل، نعطي
      // السهم تهدئة قصيرة (دقيقتين، أقصر من تهدئة الإغلاق العادي)، ونكمل
      // بهدوء بدل ما نفشل الدورة كاملة بخطأ 500
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
    // تحرير القفل دائماً — حتى لو صار خطأ، الدورة القادمة تشتغل طبيعي
    await releaseExecutionLock().catch(() => {});
  }
}

// ═══════════════════════ مزامنة مع الوسيط (مصدر الحقيقة النهائي) ═══════════════════════
// يقارن سجلنا الداخلي بالمراكز الفعلية عند Alpaca. لو صفقة اختفت من الوسيط
// (أغلقها bracket order بين دورتين)، نتحقق من أرجل الأمر لمعرفة سعر الخروج
// الفعلي، نحسب الـPnL الصحيح، ونحدّث قاطع الدائرة — بدل ما تضيع الخسارة/الربح.
async function syncWithBroker() {
  try {
    const localPositions = await getOpenPositions();
    if (localPositions.length === 0) return;

    const brokerPositions = await getPositions();
    const brokerSymbols = new Set((brokerPositions || []).map((p) => p.symbol));

    const stillOpen = [];
    for (const pos of localPositions) {
      if (brokerSymbols.has(pos.ticker)) {
        stillOpen.push(pos); // لسا مفتوحة فعلاً عند الوسيط
        continue;
      }

      // المركز اختفى من الوسيط — أغلقه bracket order غالباً. نجيب سعر الخروج الفعلي.
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

      // لو ما قدرنا نحدد الرجل المنفذة، نستخدم آخر سعر معروف كتقدير متحفظ
      if (exitPrice == null) {
        exitPrice = (await fetchStockPrice(pos.ticker)) || pos.entry;
      }

      const pnl = (exitPrice - pos.entry) * pos.qty;
      await addToDailyPnL(pnl);
      await setCooldown(pos.ticker).catch(() => {});
      await logDecision({ type: 'close', position: pos, result: { closed: true, reason: closeReason, exitPrice, pnl, via: 'broker_sync' } });
    }

    if (stillOpen.length !== localPositions.length) {
      await setOpenPositions(stillOpen);
    }
  } catch (err) {
    // فشل المزامنة لا يوقف الدورة — الفحص المباشر بevaluatePosition يغطي كطبقة ثانية
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
  return mins >= 570 && mins < 960; // 9:30 - 16:00 ET فقط
}

// ── نافذة الدخول: من 9:45 فقط (مو 9:30) ──
// أول 15 دقيقة من الجلسة هي الأكثر تقلباً وتضليلاً: فجوات افتتاح، أوامر
// متراكمة من الليل، وحركات وهمية تنعكس سريعاً. المراقبة والإغلاق يبقيان
// نشطين من 9:30، لكن فتح صفقات جديدة يبدأ بعد استقرار الافتتاح.
function isEntryWindowOpen(ny) {
  const mins = ny.getHours() * 60 + ny.getMinutes();
  return mins >= 585 && mins < 955; // 9:45 حتى 15:55 ET
}

// ═══════════════════════ صمّام أمان: تحقق من الحساب الحقيقي ═══════════════════════
async function verifyAccountSanity() {
  try {
    const account = await getAccount();
    const buyingPower = parseFloat(account.buying_power || 0);
    const equity = parseFloat(account.equity || 0);

    // لو الحساب الحقيقي (paper) ما فيه سيولة كافية لأقل صفقة منطقية، أوقف
    if (buyingPower < 50) {
      return { ok: false, reason: 'insufficient_buying_power', buyingPower };
    }
    // لو رأس المال المُعلن بالإعدادات (CAPITAL) أعلى بكثير من الحساب الفعلي،
    // هذا مؤشر خطأ إعداد — أوقف بدل ما نخاطر بحجم صفقة غير واقعي
    if (CAPITAL > equity * 3) {
      return { ok: false, reason: 'capital_mismatch', configured: CAPITAL, actualEquity: equity };
    }
    return { ok: true, buyingPower, equity };
  } catch (err) {
    return { ok: false, reason: 'account_fetch_failed', error: err.message };
  }
}

// ═══════════════════════ مراقبة/إغلاق صفقة مفتوحة (أثناء اليوم) ═══════════════════════
async function evaluatePosition(pos) {
  try {
    // نتحقق أولاً هل أحد أرجل الـ Bracket اتنفذ فعلاً عند الوسيط (المصدر الأدق والأسرع)
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

    // شبكة أمان مباشرة إضافية: نفحص السعر اللحظي الحقيقي من Polygon كتأكيد ثانٍ
    const price = await fetchStockPrice(pos.ticker);
    if (price == null) return { closed: false, reason: 'no_quote' };

    if (price >= pos.target || price <= pos.stopLoss) {
      // الحماية عند الوسيط لازم تكون تكفلت فيها أصلاً (bracket)، لكن لو لأي
      // سبب لسا مفتوحة، نغلق يدوياً كطبقة أمان أخيرة
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

    return { closed: false, currentPrice: price };
  } catch (err) {
    return { closed: false, reason: 'evaluation_error', error: err.message };
  }
}

// ═══════════════════════ إغلاق إجباري بنهاية اليوم (بدون شروط) ═══════════════════════
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

// ═══════════════════════ سعر السهم اللحظي ═══════════════════════
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

// ═══════════════════════ البحث عن أفضل إشارة (نفس منطق RSI/MACD، أسهم مباشرة) ═══════════════════════
async function findBestSignal(openPositions) {
  const openTickers = new Set(openPositions.map((p) => p.ticker));
  const candidatesRaw = WATCHLIST.filter((t) => !openTickers.has(t));

  // استبعد أي سهم بفترة تهدئة (أُغلق أو فشلت محاولة فتحه مؤخراً)
  const cooldownChecks = await Promise.all(candidatesRaw.map((t) => isCoolingDown(t)));
  const candidates = candidatesRaw.filter((_, i) => !cooldownChecks[i]);

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
      const bullish = rsi > 45 && rsi < 65 && macdHist > 0;
      if (!bullish) return;

      const score = macdHist * 10 + (65 - Math.abs(rsi - 55));
      scored.push({ ticker: t, rsi, macdHist, score });
    } catch (e) { /* تجاهل وكمل */ }
  }));

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  // ── فلتر الاتجاه العام: نتحقق من كل مرشّح بترتيب القوة، ونقبل أول واحد
  // فعلاً فوق EMA50 (اتجاه صاعد مؤكد) — نتخطى أي مرشّح تحت اتجاهه العام
  // حتى لو زخمه اللحظي (MACD) يبدو قوياً. هذا يمنع الشراء ضد التيار. ──
  for (const candidate of scored) {
    const stockPrice = await fetchStockPrice(candidate.ticker);
    if (!stockPrice) continue;

    const ema50 = await fetchEMA50(candidate.ticker);
    if (ema50 != null && stockPrice < ema50) {
      continue; // السهم تحت اتجاهه العام — تخطَّه جرّب التالي
    }

    return {
      ticker: candidate.ticker,
      entry: stockPrice,
      rsi: candidate.rsi,
      macdHist: candidate.macdHist,
      score: candidate.score,
      ema50,
    };
  }

  return null; // ولا مرشّح واحد اجتاز فلتر الاتجاه العام
}

// ═══════════════════════ EMA50 يومي — لتأكيد الاتجاه العام ═══════════════════════
async function fetchEMA50(ticker) {
  try {
    const url = `${POLYGON_BASE}/v1/indicators/ema/${ticker}?timespan=day&adjusted=true&window=50&series_type=close&limit=1&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    return d?.results?.values?.[0]?.value ?? null;
  } catch (e) {
    return null; // فشل الجلب — لا نمنع الصفقة بسبب هذا وحده، نتركه يمر (fail-open على هذا الفلتر تحديداً)
  }
}

// ⚠️ أقصى فجوة مسموحة بين سعر الإشارة ولحظة التنفيذ (بالنسبة المئوية).
// اكتُشف هذا الفلتر بعد تحليل 3 أيام بيانات: كل صفقة كانت فجوتها >1% (يعني
// السعر قفز صعوداً كثير بين الإشارة والتنفيذ) خسرت خلال دقائق — نمط "شراء
// قمة مؤقتة" كلاسيكي. القيمة الافتراضية محافظة بناءً على هذا الدليل.
const MAX_ENTRY_GAP_PCT = parseFloat(process.env.AUTO_TRADE_MAX_ENTRY_GAP_PCT || '0.7');

// ═══════════════════════ تنفيذ الدخول (Bracket Order — حماية حقيقية عند الوسيط) ═══════════════════════
async function executeEntry(signal) {
  // ── حساب حجم الصفقة (تقديري، مبني على سعر الإشارة — الكمية نفسها لا
  // تتأثر بفروقات الأسعار الصغيرة بقدر ما يتأثر بها الهدف/الوقف) ──
  const effectiveRiskPct = Math.min(RISK_PCT, HARD_MAX_RISK_PCT);
  const riskAmt = CAPITAL * effectiveRiskPct / 100;
  const shares = Math.max(1, Math.floor(riskAmt / (signal.entry * STOP_PCT)));

  // ── فحص فجوة التنفيذ: سعر طازج مباشرة قبل إرسال الأمر — لو قفز صعوداً
  // أكثر من الحد المسموح منذ لحظة اكتشاف الإشارة، نلغي الصفقة بالكامل بدل
  // ما نشتري بقمة مؤقتة محتملة ──
  const freshPrice = await fetchStockPrice(signal.ticker);
  if (freshPrice) {
    const gapPct = ((freshPrice - signal.entry) / signal.entry) * 100;
    if (gapPct > MAX_ENTRY_GAP_PCT) {
      throw new Error(`price_gap_too_large: signal=${signal.entry} fresh=${freshPrice} gap=${gapPct.toFixed(2)}%`);
    }
  }

  // ── 1) الدخول: أمر سوق بسيط بدون أرجل حماية مربوطة بعد ──
  const entryOrder = await openEquityMarketOrder({ symbol: signal.ticker, qty: shares });

  // ── 2) ننتظر تأكيد التنفيذ الفعلي ونجيب السعر الحقيقي ──
  const filledOrder = await pollOrderFill(entryOrder.id);
  const realEntryPrice = parseFloat(filledOrder.filled_avg_price);

  // ── 3) نحسب الهدف والوقف من السعر الحقيقي (مو سعر الإشارة القديم) ──
  const targetPrice = +(realEntryPrice * (1 + TARGET_PCT)).toFixed(2);
  const stopPrice = +(realEntryPrice * (1 - STOP_PCT)).toFixed(2);

  // ── 4) نربط الحماية الآن بالسعر الصحيح عبر أمر OCO ──
  let takeProfitOrderId = null;
  let stopLossOrderId = null;
  try {
    const ocoOrder = await placeOCOExit({
      symbol: signal.ticker,
      qty: shares,
      takeProfitPrice: targetPrice,
      stopLossPrice: stopPrice,
    });
    const legs = ocoOrder.legs || [ocoOrder];
    takeProfitOrderId = legs.find((l) => l.type === 'limit')?.id || null;
    stopLossOrderId = legs.find((l) => l.type === 'stop')?.id || null;
  } catch (e) {
    console.error('OCO exit placement failed:', e.message);
    // الصفقة مفتوحة بدون حماية عند الوسيط — evaluatePosition() بالفحص
    // المباشر للسعر يبقى شبكة الأمان الأخيرة حتى لو فشل هذا الأمر
  }

  const position = {
    id: entryOrder.id,
    ticker: signal.ticker,
    entry: realEntryPrice, // السعر الحقيقي، مو سعر الإشارة
    qty: shares,
    target: targetPrice,
    stopLoss: stopPrice,
    takeProfitOrderId,
    stopLossOrderId,
    openedAt: new Date().toISOString(),
    reason: `RSI ${signal.rsi?.toFixed(1)} + MACD hist ${signal.macdHist?.toFixed(3)}${signal.ema50 ? ` + فوق EMA50 (${signal.ema50.toFixed(2)})` : ''}`,
    riskAmt,
    signalPrice: signal.entry, // نحتفظ بسعر الإشارة الأصلي للمقارنة والتحليل لاحقاً
  };

  const openPositions = await getOpenPositions();
  openPositions.push(position);
  await setOpenPositions(openPositions);

  return position;
}
