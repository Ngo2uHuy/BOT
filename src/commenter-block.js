import { normalizeAuthorUrl } from './facebook.js';
import { isAnonymousAuthor } from './direct-messages.js';
import { hhmm } from './post-buttons.js';

// Pace sequential requests and respect the shared API limiter.
export const COMMENTER_BLOCK_PAUSE_MIN_MS = 15000;
export const COMMENTER_BLOCK_PAUSE_MAX_MS = 30000;
// Random pause in [intervalMs, 2*intervalMs].
export const commenterBlockPauseMs = (random = Math.random, intervalMs = COMMENTER_BLOCK_PAUSE_MIN_MS) => intervalMs + Math.round(random() * intervalMs);
// Jobs run right after the press; the query is a cheap indexed lookup.
export const COMMENTER_BLOCK_POLL_MS = 3000;
// Re-pressing resumes these; 'done' is final (single pass) and 'pending'/'running' are in progress.
export const COMMENTER_BLOCK_RETRY_STATES = ['failed', 'stopped'];

// Legacy auto-job marker duration; no repeat scheduling.
export const COMMENTER_AUTO_WINDOW_MS = 24 * 3600 * 1000;

// The block job reads every comment page; this only bounds a pagination loop that never ends.
export const COMMENTER_SCAN_PASSES = 500;
export const COMMENTER_NO_COMMENTS_TRIES = 6;
export const COMMENTER_NO_COMMENTS_RETRY_MS = 1800000;
// A comment read deferred by the hourly cap resumes from its saved cursor; an older cursor may no longer resolve.
export const COMMENTER_PROGRESS_TTL_MS = 3 * 3600 * 1000;

export const numericProfile = id => /^\d+$/.test(String(id ?? '')) ? `https://www.facebook.com/profile.php?id=${id}` : null;
export const isNumericProfile = url => /[?&]id=\d+$/.test(url || '');
// This ID is only an exclusion key, never a block target. Anonymous posts may
// expose a scoped actor ID: retaining it lets us exclude that actor too.
export const postAuthorProfile = post => normalizeAuthorUrl(post.authorUrl);

// Numeric profiles first-class; vanity-only ones are kept for lazy ID resolution right before blocking.
// The post author (by URL, or by name when only a vanity URL is known), anonymous members and the bot's own
// account are never targets; the caller repeats the author/self checks once a vanity resolves.
export function commenterProfiles(comments, { post = {}, accountId = null } = {}) {
  const author = postAuthorProfile(post), authorNumeric = isNumericProfile(author);
  const self = numericProfile(accountId);
  const profiles = new Set();
  const unknown = new Set();
  for (const comment of comments) {
    if (comment.author && isAnonymousAuthor(comment.author)) { unknown.add(comment.author); continue; }
    const url = normalizeAuthorUrl(comment.authorUrl), profile = numericProfile(comment.authorId) || url;
    if ((author && (url === author || profile === author)) || (author && !authorNumeric && post.author && comment.author === post.author) || (self && profile === self)) continue;
    if (profile) profiles.add(profile); else unknown.add(comment.author || comment.id);
  }
  return { profiles: [...profiles], unknown: unknown.size };
}

// Why a pending/interrupted job has not started, in the order that actually gates it. `until` only when it is knowable;
// 'busy' deliberately carries no time because it depends on how long the running jobs take.
export function commenterBlockWaitText({reason, until, position, total, running}) {
  const place = position ? `Đứng thứ ${position}/${total} trong hàng đợi` : '';
  const at = until ? ` đến ${hhmm(until)}` : '';
  return {
    stopped: 'Hệ thống đang dừng — khởi động để chạy',
    paused: 'Nguồn đang tạm dừng — tiếp tục nguồn để chạy',
    retry: `Hẹn thử lại lúc ${until ? hhmm(until) : '—'}`,
    hold: `Tài khoản đang tạm hoãn${at}`,
    cooldown: `Tài khoản đang nghỉ do Facebook giới hạn${at}`,
    budget: `${place ? `${place} · ` : ''}Hết lượt request nền${until ? `, thử lại lúc ${hhmm(until)}` : ''}`,
    busy: `${place} · ${running} luồng đang bận`,
    accountBusy: `${place} · Đang xử lý người comment của bài trước`,
    turn: `${place} · sắp đến lượt`,
  }[reason];
}

// Position uses the exact ORDER BY of nextCommenterBlockJob (global: the workers are shared) but exposes only numbers, never other owners' jobs.
// `blocked(owner,now)` -> {reason:'hold'|'cooldown',until} | null and `budgetUntil(owner,now)` come from the monitor; without them only store-side reasons apply.
export function commenterBlockWaits(store, ownerId, {now = Date.now(), limit = 20, postUrl = null, workers = 3, stopped = false, jobs = null, ownerIds, blocked = () => null, budgetUntil = () => null} = {}) {
  const queue = store.commenterBlockQueue(now, ownerIds), running = store.countRunningCommenterBlocks();
  const accountRunning = store.countRunningCommenterBlocks(ownerId);
  // `jobs`: an already paged list of this owner's jobs to annotate instead of the most recent `limit`.
  return (jobs ?? store.listCommenterBlocks(ownerId, limit, postUrl)).map(job => {
    if (job.state !== 'pending' && job.state !== 'interrupted') return job;
    const index = queue.findIndex(item => item.id === job.id), wait = {position: index >= 0 ? index + 1 : null, total: queue.length, running, workers, until: null};
    const hold = blocked(job.ownerId, now), budget = budgetUntil(job.ownerId, now);
    if (stopped) wait.reason = 'stopped';
    else if (job.sourcePaused) wait.reason = 'paused';
    else if (job.state === 'pending' && job.runAt > now) Object.assign(wait, {reason: 'retry', until: job.runAt});
    else if (hold) Object.assign(wait, hold);
    else if (budget > now) Object.assign(wait, {reason: 'budget', until: budget});
    else wait.reason = accountRunning ? 'accountBusy' : running >= workers ? 'busy' : 'turn';
    return {...job, wait: {...wait, text: commenterBlockWaitText(wait)}};
  });
}
