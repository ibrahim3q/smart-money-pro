// lib/alpaca.js
// ⚠️ Paper Trading فقط — base URL محدد صراحة، لا يتغير تلقائياً أبداً لحساب حقيقي
const ALPACA_BASE = 'https://paper-api.alpaca.markets';

function headers() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    throw new Error('ALPACA_API_KEY / ALPACA_SECRET_KEY not configured on server');
  }
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

// ── بناء رمز عقد الخيار بصيغة OCC القياسية ──
// مثال: NVDA + 2026-07-10 + CALL + 205  →  NVDA260710C00205000
function buildOptionSymbol(ticker, expiryISO, type, strike) {
  const root = ticker.toUpperCase().padEnd(6, ' ').slice(0, 6).trim().padEnd(ticker.length <= 5 ? ticker.length : 6, '');
  const rootPadded = ticker.toUpperCase(); // Alpaca تقبل الرمز بدون padding زائد فعلياً بمعظم الحالات، نستخدم الجذر مباشرة
  const [y, m, d] = expiryISO.split('-');
  const yy = y.slice(2);
  const cp = type.toUpperCase().startsWith('C') ? 'C' : 'P';
  const strikeInt = Math.round(strike * 1000).toString().padStart(8, '0');
  return `${ticker.toUpperCase()}${yy}${m}${d}${cp}${strikeInt}`;
}

async function alpacaFetch(path, options = {}) {
  const res = await fetch(`${ALPACA_BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `Alpaca API error (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── الحساب ──
async function getAccount() {
  return alpacaFetch('/v2/account');
}

// ── المراكز المفتوحة الحقيقية بحساب Alpaca (مصدر الحقيقة النهائي) ──
async function getPositions() {
  return alpacaFetch('/v2/positions');
}

// ── فتح صفقة مع أمر هدف مدمج بنفس الطلب (OTO) — يحل مشكلة race condition
// اللي كانت تصير لو أرسلنا أمر الشراء وأمر البيع كطلبين منفصلين متتاليين:
// Alpaca كان يرفض أمر البيع لأن الشراء لسا "معلّق" مو "منفّذ" وقت الإرسال ──
async function openOptionPositionWithTakeProfit({ ticker, expiryISO, type, strike, qty, takeProfitLimitPrice }) {
  const symbol = buildOptionSymbol(ticker, expiryISO, type, strike);
  const body = {
    symbol,
    qty: String(qty),
    side: 'buy',
    type: 'market',
    time_in_force: 'gtc',
    order_class: 'oto',
    take_profit: { limit_price: String(takeProfitLimitPrice) },
  };
  const order = await alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
  return { ...order, occ_symbol: symbol };
}

// ── فتح صفقة سهم — أمر سوق بسيط بدون أرجل حماية مربوطة فوراً ──
// السبب: أرجل Bracket تُقفل بأسعار ثابتة وقت الإرسال، لكن سعر التنفيذ
// الفعلي لأمر السوق قد يختلف عن سعر الإشارة بثوانٍ (خصوصاً بأسهم نشطة
// الحركة) — هذا كان يُنتج هدف/وقف منحرفين عن التصميم الأصلي (شفنا هذا
// بمركز META: R:R انقلب من 2:1 المخطط إلى 0.33:1 فعلياً). الحل: ندخل أول،
// نتأكد من السعر الحقيقي، وبعدها نحسب ونربط الحماية.
async function openEquityMarketOrder({ symbol, qty }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── أمر دخول حدّي بسقف صارم — بعكس أمر السوق، هذا الأمر رياضياً لا يمكن
// يُنفَّذ بسعر أعلى من limitPrice مهما كانت سرعة حركة السهم أو التأخير
// بين الفحص والتنفيذ. اكتُشفت الحاجة له بعد صفقة META (MACD=11.95) حيث
// أمر السوق نفّذ بفجوة 1.37% رغم فحص مسبق سليم — لأن السعر تحرك بين
// لحظة الفحص ولحظة التنفيذ الفعلي، وأمر السوق لا يحمي هذي الفجوة إطلاقاً. ──
async function openEquityLimitOrder({ symbol, qty, limitPrice }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'buy',
    type: 'limit',
    time_in_force: 'day',
    limit_price: String(limitPrice),
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── انتظار تأكيد التنفيذ الفعلي (Polling) — أسهم نشطة بساعات التداول
// العادية تمتلئ عادة خلال 1-3 ثوانٍ، نمنحها مهلة معقولة قبل الاستسلام ──
async function pollOrderFill(orderId, maxAttempts = 6, delayMs = 1500) {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await getOrder(orderId);
    if (order.status === 'filled') return order;
    if (['canceled', 'rejected', 'expired'].includes(order.status)) {
      throw new Error(`Entry order ${order.status}: ${orderId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Entry order fill timeout after ${maxAttempts} attempts: ${orderId}`);
}

// ── نفس الانتظار، لكن لو ما امتلأ الأمر الحدّي خلال المهلة (يعني السعر
// تجاوز سقفنا ولن ينفّذ أصلاً)، نُلغيه بدل ما نتركه معلّقاً — نفوّت
// الصفقة عن قصد بدل ما نطاردها بأي ثمن ──
async function pollOrderFillOrCancel(orderId, maxAttempts = 6, delayMs = 1500) {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await getOrder(orderId);
    if (order.status === 'filled') return order;
    if (['canceled', 'rejected', 'expired'].includes(order.status)) {
      throw new Error(`Entry order ${order.status}: ${orderId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await cancelOrder(orderId).catch(() => {});
  throw new Error(`price_ceiling_not_reached: entry limit order canceled after timeout (${orderId})`);
}

// ── ربط الحماية (هدف + وقف) بمركز مملوك فعلياً، بأسعار محسوبة من سعر
// التنفيذ الحقيقي — أمر OCO: أول رجل تُنفَّذ تُلغي الثانية تلقائياً ──
async function placeOCOExit({ symbol, qty, takeProfitPrice, stopLossPrice }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'sell',
    type: 'limit',
    time_in_force: 'day',
    order_class: 'oco',
    take_profit: { limit_price: String(takeProfitPrice) },
    stop_loss: { stop_price: String(stopLossPrice) },
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// (يبقى للتوافق فقط — لم يعد يُستخدم بالتدفق الرئيسي)
async function openEquityBracketPosition({ symbol, qty, takeProfitPrice, stopLossPrice }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
    order_class: 'bracket',
    take_profit: { limit_price: String(takeProfitPrice) },
    stop_loss: { stop_price: String(stopLossPrice) },
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── إغلاق فوري بالسوق (يُستخدم بكنسة نهاية اليوم لإجبار إغلاق أي مركز متبقي) ──
async function closeEquityPositionMarket(symbol, qty) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── إلغاء كل الأوامر المعلّقة لرمز معيّن (يُستخدم قبل إغلاق قسري بكنسة نهاية اليوم) ──
async function cancelAllOrdersForSymbol(symbol) {
  const orders = await alpacaFetch(`/v2/orders?status=open&symbols=${symbol.toUpperCase()}`);
  await Promise.all((orders || []).map((o) => cancelOrder(o.id).catch(() => {})));
}

// ── فتح صفقة (شراء لفتح Buy to Open) — بدون أمر هدف، يُستخدم كـfallback
// لو رفض الوسيط طلب OTO لأي سبب (مثلاً قيود على نوع الحساب) ──
async function openOptionPosition({ ticker, expiryISO, type, strike, qty, limitPrice }) {
  const symbol = buildOptionSymbol(ticker, expiryISO, type, strike);
  const body = {
    symbol,
    qty: String(qty),
    side: 'buy',
    type: limitPrice ? 'limit' : 'market',
    time_in_force: 'day',
    ...(limitPrice ? { limit_price: String(limitPrice) } : {}),
  };
  const order = await alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
  return { ...order, occ_symbol: symbol };
}

// ── إغلاق صفقة (بيع لإغلاق Sell to Close) بأمر سوق فوري (يُستخدم عند ضرب الوقف) ──
async function closeOptionPositionMarket(occSymbol, qty) {
  const body = {
    symbol: occSymbol,
    qty: String(qty),
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── أمر بيع GTC عند الهدف (يبقى فعّال بمستوى الوسيط حتى لو توقف محرك القرار) ──
async function placeTakeProfitLimitOrder(occSymbol, qty, limitPrice) {
  const body = {
    symbol: occSymbol,
    qty: String(qty),
    side: 'sell',
    type: 'limit',
    time_in_force: 'gtc',
    limit_price: String(limitPrice),
  };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── إلغاء أمر معلّق (يُستخدم لإلغاء أمر الهدف GTC عند تفعيل الوقف بدلاً منه) ──
async function cancelOrder(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}`, { method: 'DELETE' });
}

// ── حالة أمر معيّن ──
async function getOrder(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}`);
}

// ── نفس الشي، لكن يطلب nested=true صراحة — ضروري لأوامر OCO/Bracket
// عشان نضمن ظهور مصفوفة legs بالرد (تحتوي معرّفات أرجل الهدف والوقف
// الفعلية). بدون هذا، الرد الافتراضي لا يضمن تضمين legs، وهذا بالضبط
// سبب فشل تسجيل takeProfitOrderId بثبات بينما stopLossOrderId ينجح أحياناً. ──
async function getOrderNested(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}?nested=true`);
}

export {
  ALPACA_BASE,
  buildOptionSymbol,
  getAccount,
  getPositions,
  openOptionPosition,
  openOptionPositionWithTakeProfit,
  closeOptionPositionMarket,
  placeTakeProfitLimitOrder,
  cancelOrder,
  getOrder,
  getOrderNested,
  openEquityBracketPosition,
  openEquityMarketOrder,
  openEquityLimitOrder,
  pollOrderFill,
  pollOrderFillOrCancel,
  placeOCOExit,
  closeEquityPositionMarket,
  cancelAllOrdersForSymbol,
};
