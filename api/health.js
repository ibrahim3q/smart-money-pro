// api/health.js
// ── ✨ فحص نبض المحرك (Dead Man's Switch) ──
// يرجّع 200 لو النظام سليم، و503 لو النبض منقطع بساعات السوق — مصمم
// ليُراقَب بخدمة خارجية مجانية (UptimeRobot / cron-job.org) تستدعيه كل
// 5 دقائق وترسل لك تنبيهاً فور تحوّله لـ503: الـcron توقف والمراكز
// المفتوحة بلا مراقبة برمجية.
//
// GET فقط، للقراءة فقط، بدون توثيق (لا يكشف شيئاً حساساً ولا يغيّر حالة).
import { getLastRun, getCachedMarketSession, todayKeyET } from '../lib/redis.js';
import { nowInET } from '../lib/market-session.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

// أقصى انقطاع مقبول بساعات السوق — الـcron يعمل كل دقيقتين، فـ6 دقائق
// تعني ضياع 3 دورات متتالية على الأقل
const MAX_STALE_SECONDS = parseInt(process.env.HEALTH_MAX_STALE_SECONDS || '360', 10);

function timeStrToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// هل السوق مفتوح الآن؟ نقرأ من كاش التقويم الذي يملؤه المحرك؛ لو الكاش
// فارغ (المحرك لم يعمل اليوم بعد — وهذا بحد ذاته مؤشر) نسقط على فحص
// تقريبي ثابت. لا نستدعي Alpaca من هنا حتى يبقى الـendpoint خفيفاً.
async function isMarketOpenApprox(et) {
  try {
    const cached = await getCachedMarketSession(et.dateStr);
    if (cached) {
      if (cached.closed) return false;
      const openMins = timeStrToMinutes(cached.open);
      const closeMins = timeStrToMinutes(cached.close);
      if (openMins != null && closeMins != null) {
        return et.minutes >= openMins && et.minutes < closeMins;
      }
    }
  } catch (e) { /* الكاش معطّل — الفحص التقريبي أدناه */ }
  if (et.day === 0 || et.day === 6) return false;
  return et.minutes >= 570 && et.minutes < 960;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const et = nowInET();
    const [lastRunISO, marketOpen] = await Promise.all([
      getLastRun().catch(() => null),
      isMarketOpenApprox(et),
    ]);

    const secondsSinceLastRun = lastRunISO
      ? Math.round((Date.now() - new Date(lastRunISO).getTime()) / 1000)
      : null;

    // منقطع = السوق مفتوح والنبض غائب أو أقدم من الحد المقبول
    const stale = marketOpen && (secondsSinceLastRun == null || secondsSinceLastRun > MAX_STALE_SECONDS);

    const payload = {
      healthy: !stale,
      marketOpen,
      lastRun: lastRunISO,
      secondsSinceLastRun,
      maxStaleSeconds: MAX_STALE_SECONDS,
      dateET: todayKeyET(),
      ...(stale ? { warning: '🚨 نبض المحرك منقطع بساعات السوق — الـcron متوقف والمراكز المفتوحة بلا مراقبة! افحص Vercel فوراً' } : {}),
    };

    // 503 عند الانقطاع — خدمات المراقبة الخارجية تلتقطها تلقائياً كتعطّل
    return res.status(stale ? 503 : 200).json(payload);
  } catch (err) {
    return res.status(500).json({ healthy: false, error: err.message });
  }
}
