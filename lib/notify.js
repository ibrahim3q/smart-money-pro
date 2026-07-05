// lib/notify.js
// إشعارات Telegram — اختيارية بالكامل: لو المتغيرات غير موجودة، الدوال تتجاهل
// بصمت ولا تؤثر على عمل النظام إطلاقاً.
//
// للتفعيل أضف بـVercel:
//   TELEGRAM_BOT_TOKEN  — من @BotFather بعد إنشاء بوت جديد
//   TELEGRAM_CHAT_ID    — معرّف محادثتك مع البوت

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return; // غير مفعّل — تجاهل بصمت
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Telegram notify failed:', e.message);
  }
}

export async function notifyTradeOpened(pos) {
  await sendTelegram(
    `🟢 <b>صفقة جديدة</b>\n` +
    `${pos.ticker} — ${pos.qty} سهم @ $${pos.entry}\n` +
    `🎯 الهدف: $${pos.target} | 🛑 الوقف: $${pos.stopLoss}\n` +
    `📊 ${pos.reason}`
  );
}

export async function notifyTradeClosed(pos, result) {
  const emoji = result.pnl >= 0 ? '✅' : '🔴';
  await sendTelegram(
    `${emoji} <b>إغلاق صفقة</b>\n` +
    `${pos.ticker} — خروج @ $${result.exitPrice?.toFixed(2)}\n` +
    `💰 النتيجة: ${result.pnl >= 0 ? '+' : ''}$${result.pnl?.toFixed(2)}\n` +
    `السبب: ${result.reason}`
  );
}

export async function notifyCircuitBreaker(dailyPnL) {
  await sendTelegram(
    `⛔ <b>قاطع الدائرة تفعّل</b>\n` +
    `الخسارة اليومية وصلت: $${dailyPnL.toFixed(2)}\n` +
    `توقف فتح صفقات جديدة لبقية اليوم.`
  );
}

export async function notifyError(message) {
  await sendTelegram(`⚠️ <b>خطأ بالنظام</b>\n${message}`);
}
