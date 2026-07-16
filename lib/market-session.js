// lib/market-session.js
// ── جلسة السوق الديناميكية: أوقات الفتح/الإغلاق الحقيقية من تقويم Alpaca ──
//
// يحل مشكلتين بالقائمة الثابتة القديمة US_HOLIDAYS_2026:
//   ١. كانت ستتعطل بصمت في 2027 (لا تعرف عطل السنة الجديدة)
//   ٢. الأخطر: لم تكن تغطي أيام الإغلاق المبكر (مثل 24 ديسمبر — السوق
//      يغلق 1:00 ظهراً). بيوم نصفي، الـsweep المجدول 15:55 لن يصل أبداً
//      والمراكز تبقى مفتوحة لليوم التالي — كسر كامل لمبدأ الإغلاق اليومي.
//
// الآلية: نجلب /v2/calendar من Alpaca مرة يومياً ونخزّنه بـRedis (48 ساعة).
// لو فشل الجلب لأي سبب، نسقط على المنطق الثابت القديم (fail-safe) حتى
// لا يتوقف النظام بسبب عطل بتقويم Alpaca نفسه.

import { fetchMarketCalendar } from './alpaca.js';
import { getCachedMarketSession, setCachedMarketSession } from './redis.js';

// ── قائمة احتياطية فقط — تُستخدم حصراً لو فشل تقويم Alpaca والكاش معاً ──
const FALLBACK_HOLIDAYS_2026 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-26', '2026-11-27', '2026-12-25'];

// ── توقيت نيويورك الموثوق (يعمل بأي بيئة، لا يعتمد على توقيت الخادم) ──
export function nowInET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = parseInt(get('hour'), 10) % 24; // بعض البيئات ترجع '24' لمنتصف الليل
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + parseInt(get('minute'), 10),
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName),
  };
}

// "09:30" → 570 دقيقة
function timeStrToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function staticFallbackSession(et) {
  if (et.day === 0 || et.day === 6) return null;
  if (FALLBACK_HOLIDAYS_2026.includes(et.dateStr)) return null;
  return { openMins: 570, closeMins: 960, isEarlyClose: false, source: 'static_fallback' };
}

// ── الدالة الرئيسية: جلسة اليوم — { openMins, closeMins, isEarlyClose }
// أو null لو السوق مغلق كلياً (عطلة/نهاية أسبوع) ──
export async function getTodaySession(et) {
  // ١) الكاش أولاً
  try {
    const cached = await getCachedMarketSession(et.dateStr);
    if (cached) {
      if (cached.closed) return null;
      const openMins = timeStrToMinutes(cached.open);
      const closeMins = timeStrToMinutes(cached.close);
      if (openMins != null && closeMins != null) {
        return { openMins, closeMins, isEarlyClose: closeMins < 960, source: 'cache' };
      }
    }
  } catch (e) { /* كاش معطّل — نكمل للجلب المباشر */ }

  // ٢) جلب مباشر من تقويم Alpaca ثم تخزين
  try {
    const days = await fetchMarketCalendar(et.dateStr, et.dateStr);
    const today = (days || []).find((d) => d.date === et.dateStr);

    if (!today) {
      // التقويم لا يحتوي اليوم = السوق مغلق (عطلة أو نهاية أسبوع)
      await setCachedMarketSession(et.dateStr, { closed: true }).catch(() => {});
      return null;
    }

    await setCachedMarketSession(et.dateStr, { open: today.open, close: today.close }).catch(() => {});
    const openMins = timeStrToMinutes(today.open);
    const closeMins = timeStrToMinutes(today.close);
    if (openMins == null || closeMins == null) return staticFallbackSession(et);
    return { openMins, closeMins, isEarlyClose: closeMins < 960, source: 'alpaca_calendar' };
  } catch (e) {
    console.error('Market calendar fetch failed, using static fallback:', e.message);
    // ٣) fail-safe: المنطق الثابت القديم
    return staticFallbackSession(et);
  }
}
