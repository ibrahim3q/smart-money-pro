// lib/redis.js
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
      tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });
    client.on('error', (err) => console.error('Redis error:', err.message));
  }
  return client;
}

const KEYS = {
  KILL_SWITCH: 'auto_trade:kill_switch',
  OPEN_POSITIONS: 'auto_trade:open_positions',
  DAILY_PNL: (dateStr) => `auto_trade:daily_pnl:${dateStr}`,
  CIRCUIT_BREAKER: (dateStr) => `auto_trade:circuit_breaker:${dateStr}`,
  DAILY_TRADE_COUNT: (dateStr) => `auto_trade:daily_trade_count:${dateStr}`,
  DECISION_LOG: 'auto_trade:decision_log',
};

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

async function isKillSwitchActive() {
  const r = getClient();
  const val = await r.get(KEYS.KILL_SWITCH);
  return val === 'true';
}
async function setKillSwitch(active) {
  const r = getClient();
  await r.set(KEYS.KILL_SWITCH, active ? 'true' : 'false');
}

async function getOpenPositions() {
  return getJSON(KEYS.OPEN_POSITIONS, []);
}
async function setOpenPositions(positions) {
  await setJSON(KEYS.OPEN_POSITIONS, positions);
}

function todayKeyET() {
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

async function getDailyTradeCount() {
  const r = getClient();
  const val = await r.get(KEYS.DAILY_TRADE_COUNT(todayKeyET()));
  return val ? parseInt(val, 10) : 0;
}
async function incrementDailyTradeCount() {
  const r = getClient();
  const key = KEYS.DAILY_TRADE_COUNT(todayKeyET());
  const newCount = await r.incr(key);
  await r.expire(key, 172800);
  return newCount;
}

// ── فترة تهدئة لكل سهم ──
async function setCooldown(ticker, seconds = 600) {
  const r = getClient();
  await r.set(`auto_trade:cooldown:${ticker}`, '1', 'EX', seconds);
}
async function isCoolingDown(ticker) {
  const r = getClient();
  const val = await r.get(`auto_trade:cooldown:${ticker}`);
  return val !== null;
}

// ── تتبّع أداء كل سهم على حدة (نقاط الثقة التاريخية) ──
const TICKER_STATS_SET = 'auto_trade:ticker_stats_set';

async function updateTickerStats(ticker, pnl) {
  const r = getClient();
  const key = `auto_trade:ticker_stats:${ticker}`;
  const raw = await r.get(key);
  const stats = raw ? JSON.parse(raw) : { ticker, wins: 0, losses: 0, totalPnl: 0, tradesCount: 0 };

  stats.tradesCount += 1;
  stats.totalPnl = +(stats.totalPnl + pnl).toFixed(2);
  if (pnl >= 0) stats.wins += 1; else stats.losses += 1;
  stats.winRate = +((stats.wins / stats.tradesCount) * 100).toFixed(1);
  stats.avgPnl = +(stats.totalPnl / stats.tradesCount).toFixed(2);
  stats.lastUpdated = new Date().toISOString();

  await r.set(key, JSON.stringify(stats));
  await r.sadd(TICKER_STATS_SET, ticker);
}

// ── جلب أداء سهم واحد (يُستخدم بفلتر الاستبعاد التلقائي) ──
async function getTickerStats(ticker) {
  const r = getClient();
  const raw = await r.get(`auto_trade:ticker_stats:${ticker}`);
  return raw ? JSON.parse(raw) : null;
}

async function getAllTickerStats() {
  const r = getClient();
  const tickers = await r.smembers(TICKER_STATS_SET);
  if (!tickers.length) return [];
  const results = await Promise.all(tickers.map(async (t) => {
    const raw = await r.get(`auto_trade:ticker_stats:${t}`);
    return raw ? JSON.parse(raw) : null;
  }));
  return results.filter(Boolean).sort((a, b) => b.winRate - a.winRate || b.avgPnl - a.avgPnl);
}

// ── قفل التنفيذ ──
const LOCK_KEY = 'auto_trade:execution_lock';
async function acquireExecutionLock() {
  const r = getClient();
  const result = await r.set(LOCK_KEY, Date.now().toString(), 'EX', 90, 'NX');
  return result === 'OK';
}
async function releaseExecutionLock() {
  const r = getClient();
  await r.del(LOCK_KEY);
}

// ── سجل القرارات ──
async function logDecision(entry) {
  const r = getClient();
  const record = { ...entry, timestamp: new Date().toISOString() };
  await r.lpush(KEYS.DECISION_LOG, JSON.stringify(record));
  await r.ltrim(KEYS.DECISION_LOG, 0, 499);
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
  getDailyTradeCount,
  incrementDailyTradeCount,
  setCooldown,
  isCoolingDown,
  updateTickerStats,
  getTickerStats,
  getAllTickerStats,
  acquireExecutionLock,
  releaseExecutionLock,
  logDecision,
  getRecentDecisions,
  todayKeyET,
};
