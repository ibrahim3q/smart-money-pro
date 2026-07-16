// api/trade-log.js
// يرجّع سجل قرارات النظام الآلي + الصفقات المفتوحة حالياً + أداء اليوم
// تستخدمه واجهة "سجل التنفيذ الآلي" بالموقع لعرض كل شي لحظياً
// ✨ جديد: يرجّع أيضاً نبض المحرك (lastRun) وصفقات اليوم المغلقة مع
// الانزلاق السعري — الواجهة تقدر تعرض تحذير انقطاع النبض وجدول جودة التنفيذ
import { getRecentDecisions, getOpenPositions, getDailyPnL, isCircuitBreakerTripped, isKillSwitchActive, getAllTickerStats, getLastRun, getDailyTrades } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

// أنواع القرارات "الصامتة" المتكررة — تُضغط لعبارة ملخّصة بدل تكرارها فرادى
const NOISY_TYPES = new Set(['skip', 'no_signal']);

// ── ضغط القرارات المتكررة المتتالية (نفس type+reason) لعبارة واحدة ملخّصة ──
// يحافظ على كل حدث open/close/error/kill_switch_toggle كامل التفاصيل بدون
// أي تلخيص أو حذف — الضغط يطبّق فقط على الرسائل الصامتة المتكررة.
function collapseNoisyDecisions(decisions) {
  const result = [];
  let i = 0;
  while (i < decisions.length) {
    const d = decisions[i];
    const isNoisy = NOISY_TYPES.has(d.type);

    if (!isNoisy) {
      result.push(d);
      i++;
      continue;
    }

    // اجمع كل القرارات الصامتة المتتالية بنفس type+reason
    const key = `${d.type}:${d.reason || ''}`;
    let j = i;
    while (j < decisions.length && NOISY_TYPES.has(decisions[j].type) && `${decisions[j].type}:${decisions[j].reason || ''}` === key) {
      j++;
    }
    const group = decisions.slice(i, j);
    if (group.length === 1) {
      result.push(group[0]); // حدث وحيد — لا داعي للتلخيص
    } else {
      result.push({
        type: 'skip_summary',
        reason: d.reason,
        count: group.length,
        from: group[group.length - 1].timestamp, // الأقدم (القائمة أحدث أول)
        to: group[0].timestamp, // الأحدث
        timestamp: group[0].timestamp,
      });
    }
    i = j;
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const wantRaw = req.query.raw === 'true'; // ?raw=true يرجّع كل القرارات بدون ضغط، للتشخيص التقني
    const [decisionsRaw, openPositions, dailyPnL, breakerTripped, killSwitch, tickerStats, lastRun, dailyTrades] = await Promise.all([
      getRecentDecisions(300), // مجموعة أكبر — الضغط يفسح مجال لعرض أحداث فعلية أكثر
      getOpenPositions(),
      getDailyPnL(),
      isCircuitBreakerTripped(),
      isKillSwitchActive(),
      getAllTickerStats(),
      getLastRun().catch(() => null),
      getDailyTrades().catch(() => []),
    ]);

    const decisions = wantRaw ? decisionsRaw : collapseNoisyDecisions(decisionsRaw);

    // ✨ نبض المحرك — الواجهة تعرض تحذيراً لو تجاوز 360 ثانية بساعات السوق
    const secondsSinceLastRun = lastRun
      ? Math.round((Date.now() - new Date(lastRun).getTime()) / 1000)
      : null;

    return res.status(200).json({
      decisions,
      openPositions,
      dailyPnL,
      breakerTripped,
      killSwitch,
      tickerStats,
      lastRun,
      secondsSinceLastRun,
      dailyTrades,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
