// api/trade-archive.js
// ── ✨ الأرشيف الدائم للصفقات المغلقة — قلب قسم "تشخيص" بالواجهة ──
// GET يرجّع الصفقات المؤرشفة (الأحدث أولاً) مع فلترة اختيارية وإحصائيات:
//   ?ticker=AAPL          فلترة بسهم معيّن
//   ?reason=stop          فلترة بسبب الإغلاق (مطابقة جزئية — "stop" تلتقط كل أنواع الوقف)
//   ?from=2026-07-20      من تاريخ (شامل، بتوقيت نيويورك)
//   ?to=2026-07-24        إلى تاريخ (شامل)
//   ?limit=500            حد النتائج (افتراضي 1000، أقصى 5000)
//   ?format=csv           تنزيل CSV جاهز للإكسل بدل JSON
import { getArchivedTrades } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

const CSV_COLUMNS = [
  ['date', 'التاريخ'],
  ['ticker', 'السهم'],
  ['qty', 'الكمية'],
  ['entry', 'سعر الدخول'],
  ['exitPrice', 'سعر الخروج'],
  ['pnl', 'النتيجة $'],
  ['slippage', 'الانزلاق/سهم'],
  ['reason', 'سبب الإغلاق'],
  ['signalQuality', 'جودة الإشارة'],
  ['target', 'الهدف'],
  ['stopLoss', 'الوقف'],
  ['openedAt', 'وقت الفتح'],
  ['recordedAt', 'وقت الإغلاق'],
  ['signalReason', 'تفاصيل الإشارة'],
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ticker, reason, from, to, format } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '1000', 10) || 1000, 5000);

    let trades = await getArchivedTrades(5000); // نقرأ الكل ثم نفلتر (5000 سقف الأرشيف نفسه)

    if (ticker) trades = trades.filter((t) => t.ticker === String(ticker).toUpperCase());
    if (reason) trades = trades.filter((t) => (t.reason || '').includes(String(reason)));
    if (from) trades = trades.filter((t) => t.date >= from);
    if (to) trades = trades.filter((t) => t.date <= to);

    trades = trades.slice(0, limit);

    // ── إحصائيات المجموعة المفلترة ──
    const wins = trades.filter((t) => (t.pnl ?? 0) >= 0).length;
    const totalPnl = +trades.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(2);
    const withSlip = trades.filter((t) => t.slippage != null);
    const avgSlippage = withSlip.length
      ? +(withSlip.reduce((s, t) => s + t.slippage, 0) / withSlip.length).toFixed(4)
      : null;
    const stats = {
      count: trades.length,
      wins,
      losses: trades.length - wins,
      winRatePct: trades.length ? +((wins / trades.length) * 100).toFixed(1) : null,
      totalPnl,
      avgSlippage,
    };

    // ── تصدير CSV ──
    if (format === 'csv') {
      const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
      const rows = trades.map((t) => CSV_COLUMNS.map(([key]) => csvEscape(t[key])).join(','));
      // BOM ضروري ليعرض الإكسل العربية بشكل صحيح
      const csv = '\uFEFF' + [header, ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trades_${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send(csv);
    }

    // قائمة القيم المتاحة للفلاتر بالواجهة
    const allTickers = [...new Set(trades.map((t) => t.ticker))].sort();
    const allReasons = [...new Set(trades.map((t) => t.reason).filter(Boolean))].sort();

    return res.status(200).json({ trades, stats, allTickers, allReasons });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
