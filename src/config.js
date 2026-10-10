import path from 'node:path';
import { readShopeeConfig } from './affiliate.js';
import { readTikTokConfig } from './tiktok-affiliate.js';

function integer(env, key, fallback, min, max) {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} phải là số nguyên từ ${min} đến ${max}.`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Điền TELEGRAM_BOT_TOKEN hợp lệ trong .env trước khi chạy.');
  }
  const rawIds = env.ALLOWED_TELEGRAM_USER_IDS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  if (!rawIds.length || rawIds.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error('ALLOWED_TELEGRAM_USER_IDS phải chứa ít nhất một Telegram user ID dạng số.');
  }
  if (env.HEADLESS && !['true', 'false'].includes(env.HEADLESS)) {
    throw new Error('HEADLESS phải là true hoặc false.');
  }
  return {
    token,
    shopeeAffiliate: readShopeeConfig(env),
    tiktokAffiliate: readTikTokConfig(env),
    allowedUserIds: rawIds.map(Number),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    headless: env.HEADLESS !== 'false',
    pollIntervalMs: integer(env, 'POLL_INTERVAL_SECONDS', 10, 10, 86400) * 1000,
    historyIntervalMs: integer(env, 'HISTORY_INTERVAL_SECONDS', 600, 60, 86400) * 1000,
    scrollPasses: integer(env, 'SCROLL_PASSES', 3, 1, 10),
    scanWorkers: integer(env, 'SCAN_WORKERS', 4, 1, 4),
    metricWindowMs: integer(env, 'METRIC_WINDOW_HOURS', 24, 1, 720) * 3600000,
    metricRefreshMs: integer(env, 'METRIC_REFRESH_SECONDS', 600, 60, 86400) * 1000,
  };
}
