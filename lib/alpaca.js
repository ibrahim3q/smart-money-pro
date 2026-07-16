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

// ── بناء رمز عقد الخيار بصيغة OCC القياسية (متبقٍ للتوافق، غير مستخدم بمسار الأسهم) ──
function buildOptionSymbol(ticker, expiryISO, type, strike) {
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

// ═══════════════════════ أوامر الخيارات (قديمة، غير مستخدمة بمسار الأسهم الحالي) ═══════════════════════
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

async function closeOptionPositionMarket(occSymbol, qty) {
  const body = { symbol: occSymbol, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day' };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

async function placeTakeProfitLimitOrder(occSymbol, qty, limitPrice) {
  const body = { symbol: occSymbol, qty: String(qty), side: 'sell', type: 'limit', time_in_force: 'gtc', limit_price: String(limitPrice) };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ═══════════════════════ أوامر الأسهم (المسار النشط الحالي) ═══════════════════════

// (متبقٍ للتوافق فقط — لم يعد يُستخدم بالتدفق الرئيسي، استُبدل بالتدفق الحدّي أدناه)
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

async function openEquityMarketOrder({ symbol, qty }) {
  const body = { symbol: symbol.toUpperCase(), qty: String(qty), side: 'buy', type: 'market', time_in_force: 'day' };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── أمر دخول حدّي بسقف صارم — لا يمكن يُنفَّذ فوق limitPrice مهما كانت
// سرعة حركة السهم أو التأخير بين الفحص والتنفيذ ──
async function openEquityLimitOrder({ symbol, qty, limitPrice }) {
  const body = { symbol: symbol.toUpperCase(), qty: String(qty), side: 'buy', type: 'limit', time_in_force: 'day', limit_price: String(limitPrice) };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── انتظار تأكيد التنفيذ الفعلي (Polling) ──
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

// ── نفس الانتظار، لكن لو ما امتلأ الأمر الحدّي خلال المهلة، نُلغيه ──
// ⚠️ ملاحظة مهمة: الإلغاء بعد المهلة قد يترك تنفيذاً جزئياً (أسهم مملوكة
// فعلاً) — المستدعي مسؤول عن فحص filled_qty بعد التقاط الخطأ والتعامل
// معها (auto-trade-engine يصفّيها فوراً الآن).
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

// ── ✨ جديد: انتظار سعر التنفيذ الفعلي لأمر (يُستخدم بعد أوامر الإغلاق
// بالسوق) — أمر السوق يرجع فوراً بحالة "new" وبدون filled_avg_price،
// فحساب PnL من السعر اللحظي المجلوب يتجاهل الانزلاق السعري ويحرف
// الإحصائيات تدريجياً. هذه الدالة تنتظر التنفيذ وترجع السعر الحقيقي،
// أو null لو تعذّر (المستدعي يسقط على السعر اللحظي كخطة بديلة). ──
async function pollOrderFillPrice(orderId, maxAttempts = 4, delayMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await getOrder(orderId).catch(() => null);
    if (order?.status === 'filled' && order.filled_avg_price) {
      return parseFloat(order.filled_avg_price);
    }
    if (order && ['canceled', 'rejected', 'expired'].includes(order.status)) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

// ── ربط الحماية (هدف + وقف) بمركز مملوك فعلياً عبر أمر OCO ──
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

// ── إغلاق فوري بالسوق ──
async function closeEquityPositionMarket(symbol, qty) {
  const body = { symbol: symbol.toUpperCase(), qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day' };
  return alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

// ── إلغاء كل الأوامر المعلّقة لرمز معيّن ──
async function cancelAllOrdersForSymbol(symbol) {
  const orders = await alpacaFetch(`/v2/orders?status=open&symbols=${symbol.toUpperCase()}`);
  await Promise.all((orders || []).map((o) => cancelOrder(o.id).catch(() => {})));
}

// ⚠️ الإصلاح الجديد: بدل الاعتماد على حقل legs بالأمر الأب (ثبت أنه غير
// موثوق بمنصة Alpaca لأوامر OCO — موثّق بشكاوى مجتمعية مشابهة: أحياناً
// إحدى الرجلين تبقى بحالة "held" ولا تظهر بمصفوفة legs رغم nested=true)،
// نستعلم مباشرة عن كل الأوامر المرتبطة بالرمز (نفس الطريقة الموثوقة التي
// تعمل أصلاً بـcancelAllOrdersForSymbol)، ونحدد الهدف والوقف من نوعهم
// الصريح (type: 'limit' للهدف، type: 'stop' للوقف) بغض النظر عن حالتهم.
async function fetchRecentSellOrdersForSymbol(symbol, qty) {
  // status=all يضمن ظهور الأوامر حتى لو بحالة "held" أو غيرها من الحالات
  // الوسيطة التي لا تظهر بـstatus=open
  const orders = await alpacaFetch(`/v2/orders?status=all&symbols=${symbol.toUpperCase()}&direction=desc&limit=10`);
  const relevant = (orders || []).filter(
    (o) => o.side === 'sell' && parseFloat(o.qty) === qty && !['canceled', 'rejected', 'expired'].includes(o.status)
  );
  const takeProfitOrderId = relevant.find((o) => o.type === 'limit')?.id || null;
  const stopLossOrderId = relevant.find((o) => o.type === 'stop')?.id || null;
  return { takeProfitOrderId, stopLossOrderId, raw: relevant };
}

// ── إلغاء أمر معلّق ──
async function cancelOrder(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}`, { method: 'DELETE' });
}

// ── حالة أمر معيّن ──
async function getOrder(orderId) {
  return alpacaFetch(`/v2/orders/${orderId}`);
}

// ── نفس الشي لكن يطلب nested=true صراحة (يبقى مفيد كطبقة إضافية، رغم
// إثبات عدم كفايته وحده لكل الحالات) ──
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
  pollOrderFillPrice,
  placeOCOExit,
  closeEquityPositionMarket,
  cancelAllOrdersForSymbol,
  fetchRecentSellOrdersForSymbol,
};
