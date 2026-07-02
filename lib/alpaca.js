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

// ── فتح صفقة سهم بأمر Bracket (دخول + هدف + وقف بطلب واحد ذري) ──
// مدعوم رسمياً وموثّق بالكامل للأسهم من Alpaca — بعكس الخيارات، هنا الحماية
// الحقيقية تعيش عند الوسيط نفسه من لحظة التنفيذ، لا تعتمد على استمرار Cron.
async function openEquityBracketPosition({ symbol, qty, takeProfitPrice, stopLossPrice }) {
  const body = {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: 'buy',
    type: 'market',
    time_in_force: 'day', // يوم واحد فقط — يتماشى مع نمط "إغلاق بنفس اليوم"
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
  openEquityBracketPosition,
  closeEquityPositionMarket,
  cancelAllOrdersForSymbol,
};
