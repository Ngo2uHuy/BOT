import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const FACEBOOK_COOLDOWN_MS = Number(process.env.FACEBOOK_COOLDOWN_MS ?? 0);

export function rateLimitError() {
  const error = new Error('[RATE_LIMITED] Facebook đang giới hạn truy cập. Sẽ tự động gọi lại liên tục.');
  error.code = 'RATE_LIMITED';
  error.commentSubmitted = false;
  return error;
}

// Shared by every browser lane. A single read-only scan may probe recovery;
// an older in-flight success must never clear a newer restriction.
export class FacebookCooldown {
  constructor(dataDir, { now = Date.now, log = console.warn, cooldownMs = FACEBOOK_COOLDOWN_MS } = {}) {
    this.directory = path.join(dataDir, 'facebook-cooldowns');
    this.states = new Map();
    this.now = now;
    this.log = log;
    this.cooldownMs = cooldownMs;
  }

  filename(ownerId) {
    if (!/^[1-9]\d{0,19}$/.test(String(ownerId))) throw new Error('Telegram user ID không hợp lệ.');
    return path.join(this.directory, `${ownerId}.json`);
  }

  state(ownerId) {
    if (this.cooldownMs <= 0) return null;
    const key = String(ownerId);
    if (!this.states.has(key)) {
      let state = null;
      try {
        const saved = JSON.parse(readFileSync(this.filename(ownerId), 'utf8'));
        if (!Number.isFinite(saved.retryAt)) throw new Error('Mốc thử lại không hợp lệ.');
        state = { retryAt: saved.retryAt, probing: false };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.states.set(key, state);
    } else {
      const state = this.states.get(key);
      if (state && !existsSync(this.filename(ownerId))) {
        this.states.set(key, null);
      }
    }
    return this.states.get(key);
  }

  clear(ownerId) {
    this.save(ownerId, null);
  }

  canRun(ownerId, probe = false) {
    if (this.cooldownMs <= 0) return true;
    const state = this.state(ownerId);
    return !state || (probe && !state.probing && this.now() >= state.retryAt);
  }

  save(ownerId, state) {
    const filename = this.filename(ownerId);
    this.states.set(String(ownerId), state);
    if (state && this.cooldownMs > 0) {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(`${filename}.tmp`, JSON.stringify({ retryAt: state.retryAt }), { mode: 0o600 });
      renameSync(`${filename}.tmp`, filename);
    } else {
      try { unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  pause(ownerId) {
    if (this.cooldownMs > 0) {
      const state = { retryAt: this.now() + this.cooldownMs, probing: false };
      this.save(ownerId, state);
      this.log(`[FACEBOOK RATE LIMIT | Tài khoản ${ownerId}] Chờ thử lại lúc ${new Date(state.retryAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (giờ Việt Nam).`);
    } else {
      this.clear(ownerId);
      this.log(`[FACEBOOK RATE LIMIT | Tài khoản ${ownerId}] Giới hạn tần suất từ Facebook; sẽ tự động gọi lại liên tục đến khi thành công.`);
    }
  }

  blockedError(ownerId) {
    const error = new Error(`[FACEBOOK_COOLDOWN] Tài khoản ${ownerId} đang nghỉ do rate limit hoặc đang thử khôi phục. Mốc thử lại: ${new Date(this.state(ownerId)?.retryAt || this.now()).toISOString()}.`);
    error.code = 'FACEBOOK_COOLDOWN';
    error.commentSubmitted = false;
    return error;
  }

  async run(ownerId, probe, work) {
    if (this.cooldownMs <= 0) {
      try {
        return await work(() => true);
      } catch (error) {
        if (error.code === 'RATE_LIMITED' || /^\[RATE_LIMITED\]/.test(error.message || '')) {
          this.pause(ownerId);
        }
        throw error;
      }
    }
    if (!this.canRun(ownerId, probe)) throw this.blockedError(ownerId);
    const initial = this.state(ownerId);
    if (initial) {
      initial.probing = true;
      // Reserve the next attempt on disk too, in case the process stops mid-probe.
      initial.retryAt = this.now() + this.cooldownMs;
      this.save(ownerId, initial);
      this.log(`[FACEBOOK THỬ LẠI | Tài khoản ${ownerId}] Đang chạy một lượt quét kiểm tra sau thời gian nghỉ.`);
    }
    const canContinue = () => this.state(ownerId) === initial;
    try {
      const result = await work(canContinue);
      if (initial && canContinue()) {
        this.save(ownerId, null);
        this.log(`[FACEBOOK KHÔI PHỤC | Tài khoản ${ownerId}] Quét thành công; trở lại lịch quét bình thường.`);
      }
      return result;
    } catch (error) {
      if (error.code === 'RATE_LIMITED' || /^\[RATE_LIMITED\]/.test(error.message || '')) this.pause(ownerId);
      else if (initial && canContinue()) {
        this.pause(ownerId);
        this.log(`[FACEBOOK | Tài khoản ${ownerId}] Lượt thử chưa thành công; tiếp tục thử lại.`);
      }
      throw error;
    } finally {
      if (initial) initial.probing = false;
    }
  }
}
