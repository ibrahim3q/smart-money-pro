// ── إعدادات CORS: قيّد الوصول لدومين موقعك فقط ──
const ALLOWED_ORIGIN = 'https://smart-money-pro-vert.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', success: false });

  try {
    const { system, prompt, max_tokens } = req.body || {};

    // ── التحقق من المدخلات ──
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required', success: false });
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
        max_tokens: max_tokens || 1000,
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
