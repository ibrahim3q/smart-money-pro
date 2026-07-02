// api/kill-switch.js
// GET  → يرجّع حالة الإيقاف الطارئ الحالية
// POST → يفعّل/يعطّل الإيقاف الطارئ (body: { active: true|false })
import { isKillSwitchActive, setKillSwitch, logDecision } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── تفعيل/تعطيل سريع من المتصفح مباشرة (بدون واجهة) — لحالات الطوارئ ──
    // مثال: /api/kill-switch?set=true&token=YOUR_CRON_SECRET
    if (req.method === 'GET' && req.query.set !== undefined) {
      if (!process.env.CRON_SECRET || req.query.token !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized — invalid token' });
      }
      const active = req.query.set === 'true';
      await setKillSwitch(active);
      await logDecision({ type: 'kill_switch_toggle', active, via: 'quick_url' });
      return res.status(200).json({ active, success: true, message: active ? '🛑 تم إيقاف التداول الآلي' : '✅ تم تفعيل التداول الآلي' });
    }

    if (req.method === 'GET') {
      const active = await isKillSwitchActive();
      return res.status(200).json({ active });
    }

    if (req.method === 'POST') {
      const { active } = req.body || {};
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active (boolean) is required' });
      }
      await setKillSwitch(active);
      await logDecision({ type: 'kill_switch_toggle', active });
      return res.status(200).json({ active, success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
