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
  const scanMode = env.SCAN_MODE?.trim().toLowerCase() || 'api';
  if (env.FACEBOOK_BROWSERLESS && !['true', 'false'].includes(env.FACEBOOK_BROWSERLESS)) throw new Error('FACEBOOK_BROWSERLESS phải là true hoặc false.');
  const browserless = env.FACEBOOK_BROWSERLESS === 'true';
  if (browserless && scanMode !== 'api') throw new Error('HTTP-only yêu cầu SCAN_MODE=api.');
  if (!['api', 'browser'].includes(scanMode)) throw new Error('SCAN_MODE phải là api hoặc browser.');
  const scanMinIntervalMs = integer(env, 'SCAN_MIN_INTERVAL_SECONDS', 120, 10, 86400) * 1000;
  const scanMaxIntervalMs = integer(env, 'SCAN_MAX_INTERVAL_SECONDS', 1800, 10, 86400) * 1000;
  if (scanMaxIntervalMs < scanMinIntervalMs) throw new Error('SCAN_MAX_INTERVAL_SECONDS phải lớn hơn hoặc bằng SCAN_MIN_INTERVAL_SECONDS.');
  const apiMinDelayMs = integer(env, 'API_MIN_DELAY_MS', 3000, 0, 600000);
  const apiMaxDelayMs = integer(env, 'API_MAX_DELAY_MS', 8000, 0, 600000);
  if (apiMaxDelayMs < apiMinDelayMs) throw new Error('API_MAX_DELAY_MS phải lớn hơn hoặc bằng API_MIN_DELAY_MS.');
  return {
    token,
    shopeeAffiliate: readShopeeConfig(env),
    tiktokAffiliate: readTikTokConfig(env),
    allowedUserIds: rawIds.map(Number),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    headless: env.HEADLESS !== 'false',
    pollIntervalMs: integer(env, 'POLL_INTERVAL_SECONDS', 10, 1, 86400) * 1000,
    historyIntervalMs: integer(env, 'HISTORY_INTERVAL_SECONDS', 600, 30, 86400) * 1000,
    scrollPasses: integer(env, 'SCROLL_PASSES', 3, 1, 10),
    scanWorkers: integer(env, 'SCAN_WORKERS', 4, 1, 16),
    commentWorkers: integer(env, 'COMMENT_WORKERS', 4, 1, 16),
    commentIntervalMs: integer(env, 'COMMENT_INTERVAL_SECONDS', 0, 0, 300) * 1000,
    directMessageWorkers: integer(env, 'DIRECT_MESSAGE_WORKERS', 4, 1, 16),
    directMessageIntervalMs: integer(env, 'DIRECT_MESSAGE_INTERVAL_SECONDS', 0, 0, 300) * 1000,
    blockWorkers: integer(env, 'BLOCK_WORKERS', 3, 1, 8),
    blockIntervalMs: integer(env, 'BLOCK_INTERVAL_SECONDS', 15, 0, 300) * 1000,
    friendWorkers: integer(env, 'FRIEND_WORKERS', 2, 1, 8),
    friendIntervalMs: integer(env, 'FRIEND_INTERVAL_SECONDS', 0, 0, 300) * 1000,
    metricWindowMs: integer(env, 'METRIC_WINDOW_HOURS', 24, 1, 720) * 3600000,
    browserless, scanMode, scanMinIntervalMs, scanMaxIntervalMs, apiMinDelayMs, apiMaxDelayMs,
    apiConcurrency: integer(env, 'API_CONCURRENCY', 1, 1, 4),
    apiMaxRequestsPerHour: integer(env, 'API_MAX_REQUESTS_PER_HOUR', 400, 1, 100000),
    apiTemplateTtlMs: integer(env, 'API_TEMPLATE_TTL_MINUTES', 360, 5, 10080) * 60000,
    // Pause after a Facebook rate limit; also read from .env by the desktop app, not only process.env.
    cooldownMs: integer(env, 'FACEBOOK_COOLDOWN_MS', 0, 0, 86400000),
    // 0 disables the chronological groups-feed fast lane (SCAN_MODE=api only).
    feedPollMs: scanMode === 'api' ? integer(env, 'FEED_POLL_SECONDS', 10, 0, 3600) * 1000 : 0,
    notificationPollMs: scanMode === 'api' ? integer(env, 'NOTIFICATION_POLL_SECONDS', 120, 0, 3600) * 1000 : 0,
  };
}
