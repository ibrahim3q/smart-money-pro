// lib/redis.js
// اتصال Redis واحد يُعاد استخدامه بين استدعاءات serverless (بدل فتح اتصال جديد كل مرة)
import Redis from 'ioredis';

let client = null;

function getClient() {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL not configured on server');
  }
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      // Upstash/الاتصال عبر TLS غالباً محتاج هذا:
      tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });
    client.on('error', (err) => console.error('Redis error:', err.message));
  }
  return client;
}

// ── مفاتيح Redis المستخدمة بالنظام ──
const KEYS = {
  KILL_SWITCH: 'auto_trade:kill_switch',           // 'true' | 'false'
  OPEN_POSITIONS: 'auto_trade:open_positions',       // JSON array
  DAILY_PNL: (dateStr) => `auto_trade:daily_pnl:${dateStr}`,       // number (string)
  CIRCUIT_BREAKER: (dateStr) => `auto_trade:circuit_breaker:${dateStr}`, // 'true' | 'false'
  DECISION_LOG: 'auto_trade:decision_log',           // Redis List (JSON strings), أحدث أول
};

// ── قراءة/كتابة JSON بأمان ──
async function getJSON(key, fallback) {
  const r = getClient();
  const val = await r.get(key);
  if (val === null) return fallback;
  try { return JSON.parse(val); } catch (e) { return fallback; }
}
async function setJSON(key, value) {
  const r = getClient();
  await r.set(key, JSON.stringify(value));
}

// ── Kill Switch ──
async function isKillSwitchActive() {
  const r = getClient();
  const val = await r.get(KEYS.KILL_SWITCH);
  return val === 'true';
}
async function setKillSwitch(active) {
  const r = getClient();
  await r.set(KEYS.KILL_SWITCH, active ? 'true' : 'false');
}

// ── الصفقات المفتوحة ──
async function getOpenPositions() {
  return getJSON(KEYS.OPEN_POSITIONS, []);
}
async function setOpenPositions(positions) {
  await setJSON(KEYS.OPEN_POSITIONS, positions);
}

// ── خسارة اليوم + قاطع الدائرة (Circuit Breaker) ──
function todayKeyET() {
  // مفتاح اليوم بتوقيت نيويورك (سوق أمريكي) عشان يتصفّر كل يوم تداول جديد صح
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return ny.toISOString().slice(0, 10);
}
async function getDailyPnL() {
  const r = getClient();
  const val = await r.get(KEYS.DAILY_PNL(todayKeyET()));
  return val ? parseFloat(val) : 0;
}
async function addToDailyPnL(amount) {
  const r = getClient();
  const key = KEYS.DAILY_PNL(todayKeyET());
  const current = await getDailyPnL();
  const updated = current + amount;
  // ينتهي صلاحية المفتاح تلقائياً بعد يومين (تنظيف ذاتي، ما نحتاج نمسحه يدوياً)
  await r.set(key, updated.toString(), 'EX', 172800);
  return updated;
}
async function isCircuitBreakerTripped() {
  const r = getClient();
  const val = await r.get(KEYS.CIRCUIT_BREAKER(todayKeyET()));
  return val === 'true';
}
async function tripCircuitBreaker() {
  const r = getClient();
  await r.set(KEYS.CIRCUIT_BREAKER(todayKeyET()), 'true', 'EX', 172800);
}

// ── سجل القرارات (لعرضها بالواجهة) ──
async function logDecision(entry) {
  const r = getClient();
  const record = { ...entry, timestamp: new Date().toISOString() };
  await r.lpush(KEYS.DECISION_LOG, JSON.stringify(record));
  await r.ltrim(KEYS.DECISION_LOG, 0, 199); // احتفظ بآخر 200 قرار بس
}
async function getRecentDecisions(limit = 50) {
  const r = getClient();
  const raw = await r.lrange(KEYS.DECISION_LOG, 0, limit - 1);
  return raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

export {
  getClient,
  isKillSwitchActive,
  setKillSwitch,
  getOpenPositions,
  setOpenPositions,
  getDailyPnL,
  addToDailyPnL,
  isCircuitBreakerTripped,
  tripCircuitBreaker,
  logDecision,
  getRecentDecisions,
  todayKeyET,
};
