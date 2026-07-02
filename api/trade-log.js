// api/trade-log.js
// يرجّع سجل قرارات النظام الآلي + الصفقات المفتوحة حالياً + أداء اليوم
// تستخدمه واجهة "سجل التنفيذ الآلي" بالموقع لعرض كل شي لحظياً
import { getRecentDecisions, getOpenPositions, getDailyPnL, isCircuitBreakerTripped, isKillSwitchActive } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [decisions, openPositions, dailyPnL, breakerTripped, killSwitch] = await Promise.all([
      getRecentDecisions(50),
      getOpenPositions(),
      getDailyPnL(),
      isCircuitBreakerTripped(),
      isKillSwitchActive(),
    ]);

    return res.status(200).json({
      decisions,
      openPositions,
      dailyPnL,
      breakerTripped,
      killSwitch,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
