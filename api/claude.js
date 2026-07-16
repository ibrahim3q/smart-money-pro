// api/claude.js
// ── إعدادات CORS: قيّد الوصول لدومين موقعك فقط ──
// ⚠️ تذكير: CORS يحمي من المتصفحات فقط — أي طلب مباشر (curl مثلاً)
// يتجاوزه بالكامل. لذلك أُضيف أدناه حد استخدام لكل IP عبر Redis يحمي
// رصيد Anthropic من الاستنزاف، مع fail-open لو Redis غير متاح حتى لا
// تتعطل الواجهة بسببه.
import { getClient } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

// حد الطلبات لكل IP بالساعة — عدّله من متغيرات البيئة حسب استخدامك الفعلي
const RATE_LIMIT_PER_HOUR = parseInt(process.env.CLAUDE_RATE_LIMIT_PER_HOUR || '30', 10);
// سقف صارم لحجم الرد المطلوب — يمنع طلبات ضخمة مفتعلة تحرق الرصيد
const MAX_TOKENS_CEILING = 2000;
// سقف طول الـprompt (بالأحرف) لنفس السبب
const MAX_PROMPT_CHARS = 20000;

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function checkRateLimit(ip) {
  try {
    const r = getClient();
    const key = `claude_api:ratelimit:${ip}`;
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, 3600);
    return count <= RATE_LIMIT_PER_HOUR;
  } catch (e) {
    // fail-open: لو Redis واجه مشكلة، لا نعطّل الميزة كلها بسببه
    console.error('Rate limit check failed:', e.message);
    return true;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', success: false });

  try {
    // ── حد الاستخدام لكل IP ──
    const allowed = await checkRateLimit(clientIP(req));
    if (!allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded — try again later', success: false });
    }

    const { system, prompt, max_tokens } = req.body || {};

    // ── التحقق من المدخلات ──
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required', success: false });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: `prompt too long (max ${MAX_PROMPT_CHARS} chars)`, success: false });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(max_tokens || 1000, MAX_TOKENS_CEILING),
        system: system || 'أنت مساعد مالي متخصص. أجب بالعربية.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    // ── فحص أخطاء Anthropic API ──
    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json({
        error: data?.error?.message || 'Anthropic API error',
        success: false
      });
    }

    const text = data.content?.map(b => b.text || '').join('') || '';

    if (!text) {
      return res.status(502).json({ error: 'Empty response from Claude', success: false });
    }

    res.status(200).json({ text, success: true });

  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message, success: false });
  }
}
