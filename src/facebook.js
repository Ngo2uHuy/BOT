import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openHttpContext, loadHttpSession, browserUnavailable, submitHttpAction } from './facebook-http.js';
import { parseDay } from './dates.js';
import { normalizeMedia } from './media.js';
import { commentText, submitComment } from './comments.js';
import { readCommentContacts, readCommentContactsApi } from './comment-contacts.js';
import { directMessageText, sendDirectMessage, isAnonymousAuthor, profileIdFromHtml } from './direct-messages.js';
import { sendFriendRequest } from './friends.js';
import { BrowserQueue } from './browser-queue.js';
import { notificationHints } from './notifications.js';
import { inspectScanPage, emptyScanError } from './scan-diagnostics.js';
import { FacebookCooldown, FACEBOOK_COOLDOWN_MS, rateLimitError } from './facebook-cooldown.js';
import { readJoinedGroups, readJoinedGroupsApi } from './joined-groups.js';
import { normalizeProfileUrl, normalizeProfilePostUrl, profileReelsUrl, extractProfileSnapshots } from './profile.js';
import { parseGraphQLStream, extractPostsFromPageScripts, extractPageInfo } from './facebook-api.js';
import { BUILTIN_QUERIES, GraphQLFeedClient, RequestLimiter, captureFeedTemplate, captureQueryTemplate, captureSession, describeGraphQLRequest, extractProfileGraphQLPosts, extractSessionFromHtml, groupIdFromUrl, paginateFeed, schemaError } from './facebook-graphql.js';

export function normalizeAuthorUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !FACEBOOK_HOSTS.has(url.hostname) || url.username || url.password || url.port || String(value).length > 500) return null;
    const groupUser = url.pathname.match(/^\/groups\/[^/]+\/user\/(\d+)\/?$/);
    if (groupUser) return `https://www.facebook.com/profile.php?id=${groupUser[1]}`;
    if (url.pathname === '/profile.php' && /^\d+$/.test(url.searchParams.get('id') || '')) return `https://www.facebook.com/profile.php?id=${url.searchParams.get('id')}`;
    if (/^\/[A-Za-z0-9.]+\/?$/.test(url.pathname) && !/^\/(groups|watch|reel|reels|photo|photos|permalink.php|story.php|login|share|search|events)\/?$/i.test(url.pathname)) return `https://www.facebook.com${url.pathname}`;
  } catch { /* Missing or unrecognized profile. */ }
  return null;
}

export function parsePublishedAt(value) {
  const text = String(value ?? '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim();
  if (/^\d{10}(?:\.\d+)?$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  const match = text.match(/(?:ngày\s*)?(\d{1,2})\s+tháng\s+(\d{1,2}),?\s+(?:năm\s+)?(\d{4})(?:\s+(?:lúc|vào)\s+(\d{1,2}):(\d{2}))?/iu)
    || text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[, ]+(?:(?:lúc|vào)\s+)?(\d{1,2}):(\d{2}))?/iu);
  if (match) {
    try {
      const hours = Number(match[4] || 0), minutes = Number(match[5] || 0);
      if (hours > 23 || minutes > 59) return null;
      return new Date(parseDay(`${match[1]}/${match[2]}/${match[3]}`) + (hours * 60 + minutes) * 60000).toISOString();
    } catch { return null; }
  }
  const english = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})(?: at (\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?/i);
  if (english) {
    const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(english[1].toLowerCase())+1;
    let hour = Number(english[4] || 0);
    if (english[6]) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12 + (english[6].toLowerCase() === 'pm' ? 12 : 0);
    }
    return parsePublishedAt(`${english[2]} tháng ${month} ${english[3]} lúc ${hour}:${english[5] || '00'}`);
  }
  return null;
}

const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com']);
const POST_PATH = /^\/groups\/([A-Za-z0-9._-]+)\/(?:posts|permalink)\/([A-Za-z0-9_-]+)\/?$/;

export function profileDirectory(dataDir, ownerId) {
  const id = String(ownerId);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('Telegram user ID phải là số nguyên dương.');
  return path.resolve(dataDir, 'profiles', id);
}

export function normalizeFacebookGroupUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Link nhóm Facebook không hợp lệ.'); }
  const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
  if (url.protocol !== 'https:' || !FACEBOOK_HOSTS.has(url.hostname) || url.port || url.username || url.password || !match) {
    throw new Error('Chỉ hỗ trợ link https://www.facebook.com/groups/ID-hoặc-tên-nhóm.');
  }
  return `https://www.facebook.com/groups/${match[1]}`;
}

export function normalizePostUrl(value, expectedGroupUrl) {
  const personal = normalizeProfilePostUrl(value);
  if (personal) return expectedGroupUrl ? null : personal;
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const match = url.pathname.match(POST_PATH);
  if (url.protocol !== 'https:' || !FACEBOOK_HOSTS.has(url.hostname) || url.port || url.username || url.password || !match) return null;
  // A comment permalink is not a new post, even though its path contains a post ID.
  if (url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return null;
  if (expectedGroupUrl && match[1].toLowerCase() !== new URL(normalizeFacebookGroupUrl(expectedGroupUrl)).pathname.split('/')[2].toLowerCase()) return null;
  return { id: match[2], groupUrl: `https://www.facebook.com/groups/${match[1]}`, url: `https://www.facebook.com/groups/${match[1]}/posts/${match[2]}` };
}

export function normalizeCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().replace(/[\u00a0\u202f]/g, ' ').match(/^(\d+(?:[., ]\d+)*)(?:\s*(k|m|b|nghìn|ngàn|triệu|tỷ))?$/iu);
  if (!match) return null;
  const suffix = match[2]?.toLowerCase();
  let numeric = match[1];
  if (suffix) {
    numeric = numeric.replace(/ /g, '').replace(',', '.');
    if (!/^\d+(?:\.\d+)?$/.test(numeric)) return null;
  } else {
    if (/[., ]/.test(numeric) && !/^\d{1,3}(?:[., ]\d{3})+$/.test(numeric)) return null;
    numeric = numeric.replace(/[., ]/g, '');
  }
  const multiplier = { k: 1e3, nghìn: 1e3, ngàn: 1e3, m: 1e6, triệu: 1e6, b: 1e9, tỷ: 1e9 }[suffix] ?? 1;
  const count = Math.round(Number(numeric) * multiplier);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function engagementFromLabels(labels = []) {
  const result = { reactions: null, comments: null, shares: null };
  for (const raw of labels) {
    const label = String(raw).trim();
    if (label.length > 120) continue;
    const field = /(?:all reactions|reactions?|tất cả cảm xúc|lượt bày tỏ cảm xúc|cảm xúc)/iu.test(label) ? 'reactions'
      : /(?:comments?|bình luận)/iu.test(label) ? 'comments'
        : /(?:shares?|lượt chia sẻ)/iu.test(label) ? 'shares' : null;
    if (!field) continue;
    const numeric = label.match(/\d+(?:[.,\u00a0\u202f ]\d+)*(?:\s*(?:nghìn|ngàn|triệu|tỷ|k|m|b)(?=\s|$))?/iu)?.[0];
    const value = normalizeCount(numeric);
    if (value !== null) result[field] = Math.max(result[field] ?? 0, value);
  }
  return result;
}

// This function is intentionally self-contained so Playwright can evaluate it in
// the page and fixture tests can exercise the exact same DOM extraction. Facebook
// has no stable DOM contract: selectors may need maintenance after layout changes.
export function extractVisiblePostSnapshots(root = document) {
  const messageSelector = '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"], [data-testid="post_message"]';
  const articleSelector = '[role="article"]';
  const visible = node => Boolean(node.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const postLink = node => {
    try {
      const url = new URL(node.href);
      return url.protocol === 'https:' && ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com'].includes(url.hostname)
        && /^\/groups\/[A-Za-z0-9._-]+\/(?:posts|permalink)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
        && !url.searchParams.has('comment_id') && !url.searchParams.has('reply_comment_id');
    } catch { return false; }
  };
  const containers = new Set();
  for (const anchor of root.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')) {
    if (!visible(anchor) || !postLink(anchor)) continue;
    let container = anchor.closest(articleSelector);
    if (container?.parentElement?.closest(articleSelector)) continue; // Nested articles are comments/shared posts.
    container ??= anchor.closest('[data-pagelet^="FeedUnit_"]');
    if (!container) {
      const feed = anchor.closest('[role="feed"]');
      if (feed) {
        container = anchor;
        while (container.parentElement && container.parentElement !== feed) container = container.parentElement;
      }
    }
    if (container && visible(container)) containers.add(container);
  }
  const snapshots = [];
  for (const container of containers) {
    const owned = node => {
      const nested = node.closest(articleSelector);
      return !nested || nested === container || !container.contains(nested);
    };
    const anchors = [...container.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')].filter(node => visible(node) && owned(node) && !node.closest(messageSelector));
    const anchor = anchors.find(node => postLink(node) && (node.hasAttribute('data-post-date') || node.querySelector('time, abbr')))
      || anchors.find(postLink);
    if (!anchor) continue;
    const messageNodes = [...container.querySelectorAll(messageSelector)].filter(node => visible(node) && owned(node));
    const text = messageNodes.filter(node => !messageNodes.some(other => other !== node && other.contains(node))).map(node => node.innerText.trim()).join('\n').slice(0, 30000);
    const author = [...container.querySelectorAll('[data-ad-rendering-role="profile_name"], h2 a, h3 a, strong a')].find(node => visible(node) && owned(node) && !node.closest(messageSelector));
    const time = [...container.querySelectorAll('time[datetime], abbr[data-utime]')].find(node => owned(node) && !node.closest(messageSelector));
    const authorLink = author?.closest('a[href]') || author?.querySelector('a[href]');
    const media = [];
    for (const node of container.querySelectorAll('video, img')) {
      if (!owned(node) || !visible(node) || node.closest('h2, h3, [data-ad-rendering-role="profile_name"]')) continue;
      if (node.tagName === 'VIDEO') {
        media.push({ type: 'video', url: node.currentSrc || node.src || node.querySelector('source')?.src, preview: node.poster });
      } else {
        const box = node.getBoundingClientRect();
        const photoLink = node.closest('a[href*="/photo"], a[href*="photo.php"]');
        if (photoLink || (box.width >= 150 && box.height >= 100)) media.push({ type: 'photo', url: node.currentSrc || node.src });
      }
    }
    snapshots.push({ url: anchor.href, text, author: author?.innerText?.trim() || null,
      media,
      authorUrl: authorLink?.href || null,
      publishedAt: time?.getAttribute('datetime') || time?.getAttribute('data-utime') || null,
      dateLabels: anchors.filter(node => postLink(node) && new URL(node.href).pathname.replace('/permalink/','/posts/').replace(/\/$/,'') === new URL(anchor.href).pathname.replace('/permalink/','/posts/').replace(/\/$/,'')).flatMap(node =>
        [node.getAttribute('data-post-date'), node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText,
          ...[...node.querySelectorAll('[title], [aria-label], [data-utime], [datetime]')].flatMap(child => ['title','aria-label','data-utime','datetime'].map(key => child.getAttribute(key)))]),
    });
  }
  return snapshots;
}

export function normalizeSnapshots(snapshots, groupUrl) {
  const posts = new Map();
  const groups = Array.isArray(groupUrl) ? groupUrl : [groupUrl];
  for (const snapshot of snapshots) {
    const link = groups.map(group => normalizePostUrl(snapshot.url, group)).find(Boolean);
    if (!link) continue;
    const post = {
      id: link.id, url: link.url, text: String(snapshot.text ?? '').trim().slice(0, 30000),
      author: typeof snapshot.author === 'string' ? snapshot.author.trim().slice(0, 300) || null : null,
      authorUrl: isAnonymousAuthor(snapshot.author) ? null : normalizeAuthorUrl(snapshot.authorUrl),
      publishedAt: [snapshot.publishedAt, ...(snapshot.dateLabels || [])].map(parsePublishedAt).find(Boolean) || null,
      media: normalizeMedia(snapshot.media),
    };
    const previous = posts.get(post.id);
    if (!previous || post.text.length >= previous.text.length) posts.set(post.id, {...post,publishedAt:post.publishedAt || previous?.publishedAt || null});
    else if (!previous.publishedAt && post.publishedAt) previous.publishedAt = post.publishedAt;
  }
  return [...posts.values()];
}

function allowedNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'));
  } catch { return false; }
}

// Facebook renders the post timestamp link with a placeholder href ("?__cft__...#?fkg"
// or "#") and only fills in the real /groups/ID/posts/ID permalink on hover/focus.
// Hovering is a pointer move only; nothing is ever clicked here.
export async function revealPostDate(page, link, timeout = 800) {
  if (parsePublishedAt(await link.getAttribute('data-post-date'))) return;
  const metadata=await link.evaluate(node=>({href:node.href,labels:[node.getAttribute('aria-label'),node.getAttribute('title')]}));
  // Placeholder links still need hover to resolve their permalink.
  const direct = normalizePostUrl(metadata.href) && metadata.labels.map(parsePublishedAt).find(Boolean);
  if(direct) {
    await link.evaluate((node,value)=>node.setAttribute('data-post-date',value),direct);
    return;
  }
  // Clear the previous hover first. Facebook may render a portal tooltip without
  // aria-describedby; never attribute a tooltip already visible to another post.
  await page.mouse.move(0,0);
  await page.waitForTimeout(50);
  const before = await page.locator('[role="tooltip"]:visible').allTextContents();
  if (!await link.hover({timeout:500}).then(()=>true,()=>false)) return;
  const until = Date.now()+timeout;
  do {
    const labels = await link.evaluate(node => [node.getAttribute('aria-label'),node.getAttribute('title'),
      ...(node.getAttribute('aria-describedby') || '').split(/\s+/).map(id=>document.getElementById(id)?.innerText)]);
    const visible = await page.locator('[role="tooltip"]:visible').allTextContents();
    const fresh = visible.filter(text=>!before.includes(text));
    const date = [...labels,...(fresh.length === 1 ? fresh : [])].map(parsePublishedAt).find(Boolean);
    if (date) {
      await link.evaluate((node,value)=>node.setAttribute('data-post-date',value),date);
      return;
    }
    await page.waitForTimeout(50);
  } while (Date.now()<until);
}

export async function revealPermalinks(page, limit = 30, onReveal = null) {
  const placeholders = page.locator('[role="feed"] a[href^="?"], [role="feed"] a[href="#"], [role="feed"] a[href*="#?fkg"]');
  const nodes = await placeholders.elementHandles();
  const count = nodes.length;
  let hovered = 0;
  for (let index = 0; index < count; index++) {
    const box = await nodes[index].boundingBox().catch(() => null);
    if (!box || box.y < 0 || box.y + box.height > (page.viewportSize()?.height || 1000)) continue;
    await revealPostDate(page,nodes[index]);
    await onReveal?.();
    if (++hovered >= limit) break;
  }
  if (count) await page.mouse.move(0, 0).catch(() => {});
  await Promise.all(nodes.map(node=>node.dispose()));
}

async function assertReadable(page, context) {
  if (!allowedNavigation(page.url())) throw new Error('Facebook chuyển hướng ra ngoài miền cho phép; đã dừng thu thập.');
  if ((await page.evaluate(inspectScanPage)).notice === 'RATE_LIMITED') throw rateLimitError();
  const pathname = new URL(page.url()).pathname;
  if (/\/(?:checkpoint|challenge|two_step_verification|recover|login|login\.php)(?:\/|$)/i.test(pathname)) {
    throw new Error('Facebook yêu cầu đăng nhập/xác minh. Dừng bot, chạy npm run login -- --user-id ID và xử lý thủ công.');
  }
  const cookies = await context.cookies('https://www.facebook.com');
  if (!cookies.some(cookie => cookie.name === 'c_user' && cookie.value)) throw new Error('Phiên Facebook đã hết hạn. Dừng bot và đăng nhập lại bằng npm run login -- --user-id ID.');
  if (await page.locator('input[name="email"], input[name="pass"]').count()) throw new Error('Facebook đang hiện trang đăng nhập. Cần đăng nhập lại thủ công.');
  const hasPostLinks = await page.locator('a[href*="/posts/"], a[href*="/permalink/"]').count();
  const text = hasPostLinks ? '' : (await page.locator('body').innerText({ timeout: 8000 })).slice(0, 20000);
  if (!hasPostLinks && /this content isn't available right now|this content is not available|nội dung này hiện không (?:hiển thị|khả dụng)|you must (?:join|be a member)|join this group to (?:see|view)|tham gia nhóm này để xem|chỉ thành viên (?:mới )?(?:có thể )?xem/iu.test(text)) {
    throw emptyScanError(await page.evaluate(inspectScanPage));
  }
}

export class FacebookCollector {
  #queue;
  #commentQueue;
  #backgroundQueue;
  #profiles = new Map();
  #closed = false;
  #contexts = new Set();
  #readCounts = new Map();
  #fallbackLogs = new Map();
  #captureMisses = new Map();
  #sessionMisses = new Map();
  #sessionErrors = new Map();
  #sessionLoads = new Map();
  #unmatchedLogs = new Map();

  constructor({
    dataDir, headless = true, scrollPasses = 3, scanWorkers = 4,
    commentWorkers = 4, backgroundWorkers = 2,
    log = console.warn, cooldownMs = FACEBOOK_COOLDOWN_MS,
    scanMode = 'browser', apiConcurrency = 1, apiMinDelayMs = 3000, apiMaxDelayMs = 8000,
    apiMaxRequestsPerHour = 400, apiTemplateTtlMs = 6 * 3600000, graphql = null, apiBootstrap = true, browserless = false, apiLog = true,
  }) {
    if (!dataDir) throw new Error('Cần cấu hình dataDir.');
    if (!Number.isInteger(scrollPasses) || scrollPasses < 1 || scrollPasses > 10) throw new Error('scrollPasses phải nằm trong khoảng 1–10.');
    this.#queue = new BrowserQueue(scanWorkers);
    this.#commentQueue = new BrowserQueue(Math.max(4, commentWorkers));
    this.#backgroundQueue = new BrowserQueue(Math.max(2, backgroundWorkers));
    this.dataDir = path.resolve(dataDir);
    this.cooldown = new FacebookCooldown(this.dataDir, { log, cooldownMs });
    this.headless = headless;
    this.scrollPasses = scrollPasses;
    this.log = log;
    this.scanMode = scanMode;
    this.browserless = browserless;
    this.apiLog = apiLog;
    if (browserless && scanMode !== 'api') throw new Error('HTTP-only yêu cầu SCAN_MODE=api.');
    this.apiBootstrap = apiBootstrap;
    this.graphql = graphql || new GraphQLFeedClient({ ttlMs: apiTemplateTtlMs, builtins: apiBootstrap ? BUILTIN_QUERIES : {},
      limiter: new RequestLimiter({ concurrency: apiConcurrency, minDelayMs: apiMinDelayMs, maxDelayMs: apiMaxDelayMs, maxPerHour: apiMaxRequestsPerHour,
        onSlowdown: (ownerId, slow, reason) => log(`[TỐC ĐỘ | Tài khoản ${ownerId}] ${reason}: khoảng cách request x${slow.toFixed(1)} (${Math.round(apiMinDelayMs * slow)} ms).`) }) });
  }

  // One plain HTML GET yields the session tokens, so built-in queries run before any render-and-scroll
  // capture visit. Misses are retried at most every 30 minutes; rate limits still reach the cooldown.
  async #ensureSession(ownerId) {
    if (this.#sessionLoads.has(ownerId)) return this.#sessionLoads.get(ownerId);
    const loading = this.#loadSession(ownerId);
    this.#sessionLoads.set(ownerId, loading);
    try { return await loading; }
    finally { this.#sessionLoads.delete(ownerId); }
  }

  async #loadSession(ownerId) {
    if (!this.apiBootstrap || this.graphql.session(ownerId)) return;
    if (Date.now() - (this.#sessionMisses.get(ownerId) || 0) < 1800000) {
      // HTTP-only has no browser fallback: keep reporting the real cause instead of a missing template.
      if (this.browserless && this.#sessionErrors.has(ownerId)) throw this.#sessionErrors.get(ownerId);
      return;
    }
    this.#sessionMisses.set(ownerId, Date.now());
    let html = '';
    try {
      const context = await this.#context(ownerId);
      html = await this.graphql.limiter.run(ownerId, async () => {
        const response = await context.request.get('https://www.facebook.com/', { maxRedirects: 0, timeout: 30000, failOnStatusCode: false });
        if (response.status() === 429 || /checkpoint/i.test(response.headers().location || '')) throw rateLimitError();
        return response.status() === 200 ? response.text() : '';
      });
    } catch (error) {
      if (this.browserless || error.code === 'RATE_LIMITED' || error.code === 'SCAN_DEFERRED') throw error;
      return;
    }
    if (this.#rememberSession(ownerId, extractSessionFromHtml(html), 'HTML')) {
      this.#sessionMisses.delete(ownerId);
      this.#sessionErrors.delete(ownerId);
      return;
    }
    if (!this.browserless) return;
    const loggedOut = /"USER_ID":"0"|name="pass"/.test(html);
    const error = new Error(loggedOut
      ? `Phiên Facebook HTTP đã bị đăng xuất (Facebook trả trang đăng nhập). Dừng bot, chạy npm run login -- --user-id ${ownerId} rồi khởi động lại.`
      : 'Không đọc được token phiên từ trang chủ Facebook; kiểm tra cookie hoặc checkpoint.');
    error.code = 'FACEBOOK_SESSION';
    this.#sessionErrors.set(ownerId, error);
    throw error;
  }

  #rememberSession(ownerId, session, source) {
    if (!session) return false;
    if (this.graphql.rememberSession(ownerId, session)) this.log(`[QUÉT API | Tài khoản ${ownerId}] Đã lấy phiên GraphQL từ ${source}; gọi API trực tiếp, không cần cuộn trang.`);
    return true;
  }

  collect(ownerId, groupUrl, dateRange = null, options = {}) {
    const guardedOptions = canContinue => ({ ...options, shouldContinue: () => canContinue() && (!options.shouldContinue || options.shouldContinue()) });
    if (!new URL(groupUrl).pathname.startsWith('/groups/')) {
      const profile = normalizeProfileUrl(groupUrl);
      return this.#enqueue(ownerId, canContinue => this.#collectProfile(ownerId, profile, dateRange, guardedOptions(canContinue)), false, options.background, !options.background);
    }
    const normalized = normalizeFacebookGroupUrl(groupUrl);
    return this.#enqueue(ownerId, canContinue => this.#collectGroup(ownerId, normalized, dateRange, guardedOptions(canContinue)), false, options.background, !options.background);
  }

  async #collectGroup(ownerId, groupUrl, dateRange, options) {
    if (this.scanMode !== 'api') return this.#readGroup(ownerId, groupUrl, dateRange, options);
    // A logged-out HTTP session must surface as such, not as an unreadable group ID.
    if (this.browserless && !this.graphql.template(ownerId)) await this.#ensureSession(ownerId);
    const groupId = options.numericId || groupIdFromUrl(groupUrl) || (this.browserless ? await this.#resolveGroupId(ownerId, groupUrl, options) : null);
    if (groupId && !this.graphql.template(ownerId)) await this.#ensureSession(ownerId);
    if (groupId && this.graphql.template(ownerId)) {
      try { return await this.#collectApi(ownerId, groupUrl, groupId, dateRange, options); }
      catch (error) {
        if (this.browserless) throw error;
        if (error.code !== 'GRAPHQL_SCHEMA') throw error;
        this.graphql.invalidate(ownerId);
        this.#apiFallback(ownerId, ownerId, error);
      }
    }
    // A missed capture is retried at most every 30 minutes so scans do not keep paying extra scrolls.
    const captureTemplate = Date.now() - (this.#captureMisses.get(ownerId) || 0) >= 1800000;
    return this.#readGroup(ownerId, groupUrl, dateRange, { ...options, captureTemplate });
  }

  // HTTP-only has no capture visit to learn a slug group's numeric ID; the group page HTML carries it
  // as "groupID". Only a single distinct value is trusted, since pages can embed other groups.
  async #resolveGroupId(ownerId, groupUrl, options) {
    const context = await this.#context(ownerId);
    const html = await this.graphql.limiter.run(ownerId, async () => {
      const response = await context.request.get(groupUrl.replace(/\/?$/, '/'), { timeout: 30000, failOnStatusCode: false });
      if (response.status() === 429 || /checkpoint/i.test(response.headers().location || '')) throw rateLimitError();
      return response.status() === 200 ? response.text() : '';
    });
    const ids = new Set([...html.matchAll(/"groupID":"(\d{5,25})"/g)].map(match => match[1]));
    if (ids.size !== 1) throw new Error('HTTP-only: không đọc được ID số của nhóm từ trang nhóm. Dùng /joined refresh hoặc thêm nhóm bằng link ID số.');
    const [groupId] = ids;
    try { options.onGroupId?.(groupId); } catch { /* Persisting the alias is best effort. */ }
    return groupId;
  }

  #readGroup(ownerId, groupUrl, dateRange, options) {
    return this.#read(ownerId, `${groupUrl}?sorting_setting=CHRONOLOGICAL`, groupUrl, null, dateRange, null, options);
  }

  #pageOptions(dateRange, options) {
    const latest = Boolean(options.latest) && !dateRange;
    const watermark = Number.isFinite(options.watermark) ? options.watermark : null;
    // Only a requested backfill pages back to the range start; other range passes stop at the watermark.
    const cutoff = dateRange ? Math.max(dateRange.start - 1, options.backfill ? -Infinity : watermark ?? -Infinity) : watermark;
    const maxPages = dateRange ? (options.backfill ? 300 : Math.min(3, this.scrollPasses)) : latest ? (cutoff === null ? 1 : 5) : this.scrollPasses;
    return {
      cutoff, maxPages, latest, stopAfterOld: 3, shouldContinue: options.shouldContinue,
      onPage: async page => {
        // Same rule as the browser lane: undated posts are never persisted early.
        const ready = page.filter(post => post.publishedAt);
        if (ready.length && options.onPosts) await options.onPosts(ready);
      },
    };
  }

  async #collectApi(ownerId, groupUrl, groupId, dateRange, options) {
    const context = await this.#context(ownerId);
    const pageOptions = this.#pageOptions(dateRange, options);
    // A routine "anything new?" check needs only the newest few posts; later pages use full pages.
    const firstCount = pageOptions.latest && pageOptions.cutoff !== null ? 3 : 10;
    const { posts } = await paginateFeed((cursor, page) => this.graphql.fetchPage(context.request, ownerId, { groupId, groupUrl, cursor, count: page ? 10 : firstCount }), pageOptions);
    // One empty, private or left group says nothing about the account-wide template, so it is not invalidated.
    if (!posts.length) throw Object.assign(new Error('[EMPTY_FEED] Trang GraphQL đầu tiên của nhóm không có bài nào; nhóm có thể trống, riêng tư hoặc tài khoản đã rời nhóm.'), { code: 'EMPTY_FEED' });
    return posts;
  }

  // Newest posts across every joined group from the chronological "Most recent" groups feed. Pages
  // stop at the first post at or before `watermark`; without one only the first page is read.
  recentGroupPosts(ownerId, { watermark = null, maxPages = 4 } = {}) {
    if (this.scanMode !== 'api') return Promise.resolve([]);
    return this.#enqueue(ownerId, async () => {
      if (!this.graphql.template(ownerId, 'recentFeed')) await this.#ensureSession(ownerId);
      const context = await this.#context(ownerId);
      const referer = 'https://www.facebook.com/?filter=groups&sk=h_chr';
      const { posts } = await paginateFeed(async cursor => {
        const text = await this.graphql.fetchQuery(context.request, ownerId, 'recentFeed', { cursor, count: 10, referer });
        return { posts: parseGraphQLStream(text), ...extractPageInfo(text) };
      }, { cutoff: watermark, maxPages: watermark === null ? 1 : maxPages, latest: true, stopAfterOld: 1 });
      return posts.filter(post => post.publishedAt && /\/groups\/[^/]+\/posts\//.test(post.url));
    });
  }

  notificationGroups(ownerId, { maxPages = 1, isKnown = () => false } = {}) {
    if (this.scanMode !== 'api') return Promise.resolve([]);
    return this.#enqueue(ownerId, async () => {
      if (!this.graphql.template(ownerId, 'notifications')) await this.#ensureSession(ownerId);
      const context = await this.#context(ownerId);
      const hints = [];
      let cursor = null;
      for (let page = 0; page < maxPages; page++) {
        const text = await this.graphql.fetchQuery(context.request, ownerId, 'notifications',
          {cursor,count:15,referer:'https://www.facebook.com/notifications/'});
        const list = notificationHints(text);
        hints.push(...list);
        const { endCursor, hasNextPage } = extractPageInfo(text);
        // Notifications are newest-first: reaching an already seen one means the rest were read last poll.
        if (!hasNextPage || list.some(isKnown)) break;
        cursor = endCursor;
      }
      return hints;
    }, false, true);
  }

  // Logged at most every 10 minutes per account and query kind.
  #apiFallback(key, ownerId, error) {
    if (this.browserless) throw error;
    if (Date.now() - (this.#fallbackLogs.get(key) || 0) < 600000) return;
    this.#fallbackLogs.set(key, Date.now());
    this.log(`[QUÉT API | Tài khoản ${ownerId}] ${error.message} Dùng trình duyệt cho lượt này và lấy lại template.`);
  }

  #rememberTemplate(ownerId, template, scope) {
    if (this.graphql.remember(ownerId, template, scope)) this.log(`[QUÉT API | Tài khoản ${ownerId}] Đã lấy template GraphQL ${template.friendlyName}.`);
  }

  // Names the paginated GraphQL queries a capture visit saw without matching, so patterns can follow Facebook renames.
  #logUnmatched(ownerId, kind, seen) {
    const key = `${ownerId}\n${kind}`;
    if (Date.now() - (this.#unmatchedLogs.get(key) || 0) < 1800000) return;
    this.#unmatchedLogs.set(key, Date.now());
    this.log(`[QUÉT API | Tài khoản ${ownerId}] Chưa nhận ra truy vấn GraphQL "${kind}"; đã thấy: ${[...seen].map(([name, keys]) => `${name} {${keys.join(',')}}`).join('; ')}`);
  }

  joinedGroups(ownerId, options = {}) {
    if (options.force) {
      this.cooldown.save(ownerId, null);
    }
    const target = 'https://www.facebook.com/groups/joins/';
    return this.#enqueue(ownerId, async () => {
      if (this.scanMode === 'api' && !this.graphql.template(ownerId, 'joinedGroups')) await this.#ensureSession(ownerId);
      const template = this.scanMode === 'api' && this.graphql.template(ownerId, 'joinedGroups');
      if (template) {
        try {
          const context = await this.#context(ownerId);
          const result = await readJoinedGroupsApi(cursor => this.graphql.fetchQuery(context.request, ownerId, 'joinedGroups', { cursor, referer: target }), { baseline: template.baseline });
          template.baseline = result.groups.length;
          return result;
        } catch (error) {
          if (error.code !== 'GRAPHQL_SCHEMA') throw error;
          this.graphql.invalidate(ownerId, 'joinedGroups');
          this.#apiFallback(`${ownerId}\njoinedGroups`, ownerId, error);
        }
      }
      let captured = null;
      const result = await this.#read(ownerId,target,null,null,null,readJoinedGroups,
        this.scanMode === 'api' ? { captureTemplate: 'joinedGroups', onTemplate: value => { captured = value; } } : {});
      if (captured) this.#rememberTemplate(ownerId, { ...captured, baseline: result.groups.length }, 'joinedGroups');
      return result;
    });
  }

  clearCooldown(ownerId) {
    this.cooldown.save(ownerId, null);
  }

  #readProfilePost(ownerId, post) {
    return this.#read(ownerId, post.url, null, post.id, null, async page => {
      const actual = normalizeProfilePostUrl(page.url());
      if (!actual || actual.url !== post.url) throw new Error('Facebook chuyển sang bài khác.');
      const snapshots = await page.evaluate(extractProfileSnapshots);
      let snapshot = snapshots.find(item => normalizeProfilePostUrl(item.url)?.url === post.url);
      if (!snapshot && post.kind === 'reel') {
        snapshot = await page.evaluate(() => {
          const main = document.querySelector('[role="main"], main');
          if (!main) return null;
          const author = main.querySelector('[data-ad-rendering-role="profile_name"] a, h2 a, h3 a');
          const time = main.querySelector('time[datetime], abbr[data-utime]');
          return {url:location.href,author:author?.innerText,authorUrl:author?.href,
            text:main.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]')?.innerText || '',
            publishedAt:time?.getAttribute('datetime') || time?.getAttribute('data-utime')};
        });
      }
      if (!snapshot) throw new Error('Không đọc được nội dung bài/reel mục tiêu.');
      return this.#profileSnapshot(snapshot, post);
    });
  }

  #profileSnapshot(snapshot, link) {
    return {id:link.id,url:link.url,kind:link.kind,text:String(snapshot.text || '').trim().slice(0,30000),
      author:snapshot.author || null,authorUrl:isAnonymousAuthor(snapshot.author) ? null : normalizeAuthorUrl(snapshot.authorUrl),media:normalizeMedia(snapshot.media),
      publishedAt:[snapshot.publishedAt,...(snapshot.dateLabels || [])].map(parsePublishedAt).find(Boolean) || null};
  }

  async #collectProfile(ownerId, profile, dateRange, options) {
    const posts = new Map();
    const mode = options.contentType || 'all';
    const targets = mode === 'posts' ? [profile] : mode === 'reels' ? [profileReelsUrl(profile)] : [profile,profileReelsUrl(profile)];
    for (const target of targets) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const kind = target === profile ? 'profile' : 'reels', scope = `${kind}:${profile}`;
      if (this.scanMode === 'api' && await this.#collectProfileApi(ownerId, profile, target, kind, dateRange, options, posts)) continue;
      // As with groups, a missed capture is retried at most every 30 minutes so scans do not keep paying extra scrolls.
      const capture = this.scanMode === 'api' && Date.now() - (this.#captureMisses.get(`${ownerId}\n${scope}`) || 0) >= 1800000;
      let template = null, seenAliases = [], profileName = '';
      await this.#read(ownerId,target,null,null,null,async (page, captured) => {
        const aliases = new Set([profile, normalizeProfileUrl(page.url())]);
        const canonical = await page.locator('head link[rel="canonical"], head meta[property="og:url"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href') || node.getAttribute('content')));
        for (const value of canonical) { try { aliases.add(normalizeProfileUrl(value)); } catch {} }
        const belongs = value => { try { return aliases.has(normalizeProfileUrl(value)); } catch { return false; } };
        const name = await page.locator('h1').first().innerText().catch(() => '');
        seenAliases = [...aliases];
        profileName = name.trim().slice(0,300);
        const basePasses = options.latest ? 1 : (dateRange && options.backfill ? 300 : this.scrollPasses);
        // The pagination query is only sent after scrolling; allow a few extra passes to capture it.
        const passes = capture ? Math.max(basePasses, 4) : basePasses;
        let stagnant = 0;
        for (let pass=0; pass<passes; pass++) {
          if (options.shouldContinue && !options.shouldContinue()) break;
          await assertReadable(page,await this.#context(ownerId));
          await revealPermalinks(page);
          const before = posts.size;
          const links = page.locator('a[href*="/posts/"], a[href*="story_fbid="], a[href*="/reel/"]');
          for (let i=0; i<await links.count(); i++) {
            const link = links.nth(i), box = await link.boundingBox().catch(() => null);
            if (box && box.y >= 0 && box.y+box.height <= 1000) await revealPostDate(page,link,500);
          }
          for (const snapshot of await page.evaluate(extractProfileSnapshots)) {
            const link = normalizeProfilePostUrl(snapshot.url);
            if (!link || (mode === 'posts' && link.kind !== 'post') || (mode === 'reels' && link.kind !== 'reel')) continue;
            if (link.kind === 'post' && !belongs(link.groupUrl)) continue;
            if (snapshot.authorUrl && !belongs(snapshot.authorUrl)) continue;
            let post = this.#profileSnapshot(snapshot,link);
            if (link.kind === 'reel') {
              if (posts.has(link.id)) continue;
              // Reel permalinks do not encode their owner. Require author proof.
              if (!belongs(post.authorUrl)) {
                const detail = await this.#readProfilePost(ownerId,link);
                if (!belongs(detail.authorUrl)) continue;
                post = {...detail,publishedAt:detail.publishedAt || post.publishedAt};
              }
            }
            post.groupName = name.trim().slice(0,300);
            posts.set(post.id,post);
          }
          stagnant = posts.size === before ? stagnant+1 : 0;
          if (options.onPosts) await options.onPosts([...posts.values()].filter(post => post.publishedAt));
          if (stagnant >= 5) break;
          if (pass+1 >= basePasses && (!capture || captured())) break;
          if (pass+1<passes) {
            await page.evaluate(() => window.scrollBy(0,Math.max(window.innerHeight*.9,600)));
            await page.waitForTimeout(1200);
          }
        }
      }, capture ? { captureTemplate: kind, onTemplate: value => { template = value; } } : {});
      if (template) {
        // The numeric ID sent by the profile query is the alias API authors are reported under.
        const aliases = [...seenAliases, ...(template.targetId ? [`https://www.facebook.com/profile.php?id=${template.targetId}`] : [])];
        this.#rememberTemplate(ownerId, { ...template, aliases, name: profileName }, scope);
      } else if (capture) this.#captureMisses.set(`${ownerId}\n${scope}`, Date.now());
    }
    if (!posts.size) throw new Error('Không đọc được bài/reel thuộc trang cá nhân này. Kiểm tra quyền xem hoặc giao diện Facebook.');
    return [...posts.values()];
  }

  // Profile posts/reels through a captured timeline or reels query; false means use the browser this run.
  async #collectProfileApi(ownerId, profile, target, kind, dateRange, options, posts) {
    const scope = `${kind}:${profile}`, template = this.graphql.template(ownerId, scope);
    if (!template) return false;
    const aliases = new Set([profile, ...['profile', 'reels'].flatMap(item => this.graphql.template(ownerId, `${item}:${profile}`)?.aliases || [])]);
    const belongs = value => { try { return aliases.has(normalizeProfileUrl(value)); } catch { return false; } };
    try {
      const context = await this.#context(ownerId);
      const { posts: found } = await paginateFeed(async (cursor, pages) => {
        const text = await this.graphql.fetchQuery(context.request, ownerId, scope, { cursor, referer: target });
        const page = extractProfileGraphQLPosts(text, kind, belongs).map(post => ({ ...post, groupName: template.name || '' }));
        if (!pages && !page.length) throw schemaError('Trang GraphQL đầu tiên không có bài/reel nào thuộc trang cá nhân.');
        return { posts: page, ...extractPageInfo(text) };
      }, this.#pageOptions(dateRange, options));
      for (const post of found) posts.set(post.id, post);
      return true;
    } catch (error) {
      if (error.code !== 'GRAPHQL_SCHEMA') throw error;
      this.graphql.invalidate(ownerId, scope);
      this.#apiFallback(`${ownerId}\n${scope}`, ownerId, error);
      return false;
    }
  }

  // Defaults read at most 10 pages; bulk blocking passes a higher cap and partial=false.
  collectCommentContacts(ownerId, postUrl, { passes = 10, partial = true, low = false, canContinue: keepReading = () => true, resume = null, onProgress = null } = {}) {
    const post = normalizePostUrl(postUrl);
    if (!post) return Promise.reject(new Error('Cần link bài viết gốc hoặc video Facebook dạng /TEN/videos/ID; quảng cáo dùng link bài viết gốc.'));
    return this.#enqueue(ownerId, async queueContinue => {
      const canContinue = () => queueContinue() && keepReading();
      // The comments query is keyed by feedback ID = base64("feedback:" + numeric post ID).
      const numeric = this.scanMode === 'api' && /^\d+$/.test(post.id);
      if (numeric && this.browserless && !this.graphql.template(ownerId, 'comments')) await this.#ensureSession(ownerId);
      const template = numeric && this.graphql.template(ownerId, 'comments');
      if (template) {
        try {
          const context = await this.#context(ownerId);
          const result = await readCommentContactsApi(cursor => this.graphql.fetchQuery(context.request, ownerId, 'comments', { cursor, targetId: post.id, referer: post.url, low }),
            post, { canContinue, passes, partial, before: /before/i.test(template.cursorKey), singlePage: !template.cursorKey, resume: template.cursorKey ? resume : null, onProgress });
          // Bulk scans also expand unread replies in the browser when the API result is incomplete.
          if (result.complete !== false || this.browserless || (partial && template.cursorKey)) return result;
        } catch (error) {
          if (error.code !== 'GRAPHQL_SCHEMA') throw error;
          // HTTP-only cannot tell a post without readable comments from a stale query, and parking the
          // built-in would fail every post of the account for parkMs with no browser to recapture it.
          if (this.browserless && error.emptyComments) throw Object.assign(new Error('Không đọc được comment của bài này. Hãy mở phần bình luận, kiểm tra quyền xem và dùng link bài/video gốc.'), { code: 'NO_COMMENTS' });
          this.graphql.invalidate(ownerId, 'comments');
          this.#apiFallback(`${ownerId}\ncomments`, ownerId, error);
        }
      }
      let captured = null;
      const result = await this.#read(ownerId, post.url, post.groupUrl, post.id, null, async page => {
        if (normalizePostUrl(page.url())?.url !== post.url) throw new Error('Facebook chuyển sang bài khác; dừng thu thập comment.');
        await page.locator('[role="article"] a[href*="comment_id="]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        return readCommentContacts(page, post, { canContinue, passes });
      }, this.scanMode === 'api' ? { captureTemplate: 'comments', onTemplate: value => { captured = value; } } : {});
      if (captured) this.#rememberTemplate(ownerId, captured, 'comments');
      return result;
    }, false, low);
  }

  comment(ownerId, postUrl, text, canSubmit) {
    const post = normalizePostUrl(postUrl);
    if (!post) return Promise.reject(new Error('Link bài Facebook không hợp lệ.'));
    const body = commentText(text);
    if (this.browserless) return this.#httpAction(ownerId, 'comment', post.id, body, canSubmit);
    return this.#action(started => this.#enqueue(ownerId, canContinue => this.#read(ownerId,post.url,post.groupUrl,post.id,null,
      async page => {
        const actual = normalizePostUrl(page.url());
        if (!actual || actual.url !== post.url) throw new Error('Facebook chuyển sang bài khác; không đăng bình luận.');
        started();
        return submitComment(page,post,body,() => canContinue() && (!canSubmit || canSubmit()));
      }),true));
  }

  directMessage(ownerId, authorUrl, text, canSubmit, options = { callAfter: true }) {
    const norm = normalizeAuthorUrl(authorUrl);
    if (!norm) return Promise.reject(new Error('Link trang cá nhân của tác giả không hợp lệ hoặc bài viết ẩn danh.'));
    const body = directMessageText(text);
    if (this.browserless) return this.#httpAction(ownerId, 'message', this.#recipientId(norm), body, canSubmit);
    return this.#action(started => this.#enqueue(ownerId, canContinue => this.#read(ownerId,norm,null,null,null,
      async page => {
        started();
        return sendDirectMessage(page,norm,body,() => canContinue() && (!canSubmit || canSubmit()), options);
      }, options),true));
  }

  // `low` (bulk jobs): background queue and low limiter priority so scanning is never held up.
  blockUser(ownerId, authorUrl, canSubmit, { low = false } = {}) {
    const norm = normalizeAuthorUrl(authorUrl);
    if (!norm) return Promise.reject(new Error('Không xác định được trang cá nhân người đăng.'));
    return this.#httpAction(ownerId, 'block', this.#recipientId(norm), null, canSubmit, low);
  }

  // Numeric ID of the logged-in Facebook account (null when no session is known), so bulk actions skip it.
  accountId(ownerId, { low = false } = {}) {
    return this.#enqueue(ownerId, async () => { await this.#ensureSession(ownerId); return this.graphql.session(ownerId)?.form.__user || null; }, !low, low);
  }

  // Vanity-only profiles need their numeric ID for the block mutation: one plain GET (no browser render),
  // accepting only IDs bound to that vanity. 429/checkpoint stop the caller like any rate limit.
  resolveProfileId(ownerId, authorUrl, { low = false } = {}) {
    const norm = normalizeAuthorUrl(authorUrl), known = norm?.match(/[?&]id=(\d+)$/)?.[1];
    if (!norm || known) return Promise.resolve(known || null);
    return this.#enqueue(ownerId, async () => {
      const context = await this.#context(ownerId);
      const page = await this.graphql.limiter.run(ownerId, async () => {
        const response = await context.request.get(norm, { maxRedirects: 0, timeout: 30000, failOnStatusCode: false });
        const location = response.headers().location || '';
        if (response.status() === 429 || /checkpoint/i.test(location)) throw rateLimitError();
        return { location, html: response.status() === 200 ? await response.text() : '' };
      }, low ? { low } : undefined);
      return profileIdFromHtml({ ...page, vanity: new URL(norm).pathname.replace(/\//g, ''), ownId: this.graphql.session(ownerId)?.form.__user });
    }, !low, low);
  }

  friendRequest(ownerId, authorUrl, canSubmit) {
    const norm = normalizeAuthorUrl(authorUrl);
    if (!norm) return Promise.reject(new Error('Link trang cá nhân của tác giả không hợp lệ hoặc bài viết ẩn danh.'));
    if (this.browserless) return this.#httpAction(ownerId, 'friend', this.#recipientId(norm), null, canSubmit);
    return this.#action(started => this.#enqueue(ownerId, canContinue => this.#read(ownerId,norm,null,null,null,
      async page => {
        started();
        return sendFriendRequest(page,norm,() => canContinue() && (!canSubmit || canSubmit()));
      }),true));
  }

  // Navigation, login and queue errors happen before the send helper runs, so nothing can have been sent;
  // the helpers themselves tag their own errors (commentSubmitted true/false).
  async #action(work) {
    let started = false;
    try { return await work(() => { started = true; }); }
    catch (error) {
      if (!started && error && typeof error === 'object') error.commentSubmitted ??= false;
      throw error;
    }
  }

  #recipientId(url) {
    const parsed = new URL(url);
    return parsed.searchParams.get('id') || parsed.pathname.match(/^\/(\d+)\/?$/)?.[1] || null;
  }

  #httpAction(ownerId, kind, target, text, canSubmit, low = false) {
    return this.#action(started => this.#enqueue(ownerId, async canContinue => {
      if (!target) throw new Error('HTTP-only cần link profile.php?id=ID_SO của người nhận.');
      await this.#ensureSession(ownerId);
      const context = await this.#context(ownerId);
      return this.graphql.limiter.run(ownerId, () => { started(); return submitHttpAction({ request: context.request,
        session: this.graphql.session(ownerId), kind, target, text,
        canSubmit: () => canContinue() && (!canSubmit || canSubmit()) }); }, low ? { low } : { priority: true });
    }, !low, low));
  }

  async validateSessions(ownerIds) {
    if (this.browserless) await Promise.all(ownerIds.map(ownerId => loadHttpSession(this.dataDir, ownerId)));
  }

  canScan(ownerId, probe = true) {
    return this.cooldown.canRun(ownerId, probe);
  }

  async recycle(ownerId = null) {
    if (this.#closed) return;
    const ids = ownerId ? [ownerId] : [...this.#profiles.keys()];
    for (const id of ids) {
      this.#readCounts.delete(id);
      const opening = this.#profiles.get(id);
      if (opening) {
        try {
          const context = await opening;
          if (typeof context.pages === 'function' && context.pages().length === 0) {
            this.#profiles.delete(id);
            this.#contexts.delete(context);
            await context.close().catch(() => {});
          }
        } catch {
          this.#profiles.delete(id);
        }
      }
    }
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch {}
    }
  }

  #enqueue(ownerId, work, priority = false, background = false, probe = false) {
    if (this.#closed) return Promise.reject(new Error('Facebook collector đã đóng.'));
    const queue = priority ? this.#commentQueue : background ? this.#backgroundQueue : this.#queue;
    return queue.enqueue(() => {
      if (this.#closed) throw new Error('Facebook collector đã đóng.');
      return this.cooldown.run(ownerId, probe, work);
    },priority);
  }

  async #context(ownerId) {
    if (!this.#profiles.has(ownerId)) {
      const opening = this.#openContext(ownerId);
      this.#profiles.set(ownerId,opening);
      opening.catch(() => { if (this.#profiles.get(ownerId) === opening) this.#profiles.delete(ownerId); });
    }
    return this.#profiles.get(ownerId);
  }

  async #openContext(ownerId) {
    if (this.browserless) {
      const context = await openHttpContext(this.dataDir, ownerId, { log: this.apiLog ? this.log : null });
      if (this.#closed) { await context.close(); throw new Error('Facebook collector đã đóng.'); }
      this.#contexts.add(context);
      return context;
    }
    const profile = profileDirectory(this.dataDir, ownerId);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: this.headless, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1280, height: 1000 },
        serviceWorkers: 'block', acceptDownloads: false,
        timeout: 30000,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--disk-cache-size=33554432',
          '--media-cache-size=1',
        ],
      });
      await context.grantPermissions(['microphone'], { origin: 'https://www.facebook.com' }).catch(() => {});
    } catch {
      throw new Error('Không mở được Chromium/profile Facebook. Chạy npx playwright install chromium; đóng cửa sổ login và mọi bot đang dùng cùng profile rồi thử lại.');
    }
    this.#contexts.add(context);
    try {
      if (this.#closed) throw new Error('Facebook collector closed');
      const cookies = await context.cookies('https://www.facebook.com');
      if (!cookies.some(cookie => cookie.name === 'c_user' && cookie.value)) throw new Error(`Chưa đăng nhập Facebook cho Telegram ID ${ownerId}. Dừng bot, chạy npm run login -- --user-id ${ownerId}, đăng nhập thủ công rồi khởi động lại bot.`);
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && !allowedNavigation(request.url())) return route.abort();
        if (['image', 'media', 'font'].includes(request.resourceType())) return route.abort();
        return route.continue();
      });
      for (const page of context.pages()) await page.close();
      context.on('close', () => {
        this.#contexts.delete(context);
        this.#profiles.delete(ownerId);
      });
      return context;
    } catch (error) {
      this.#contexts.delete(context);
      await context.close().catch(() => {});
      throw error;
    }
  }

  async #read(ownerId, target, groupUrl, postId = null, dateRange = null, action = null, options = {}) {
    if (this.browserless) throw browserUnavailable();
    const context = await this.#context(ownerId);
    const page = await context.newPage();
    page.on('popup', async popup => {
      if (options?.callAfter) {
        // missedCall closes the call window itself; this only catches strays without cutting the ring short.
        await new Promise(r => setTimeout(r, 15000));
        await popup.close().catch(() => {});
      } else {
        popup.close().catch(() => {});
      }
    });

    const apiPosts = new Map();
    let pageClosed = false;
    let captured = null;
    const captureKind = options.captureTemplate === true ? 'feed' : options.captureTemplate || null;
    const unmatched = new Map();
    // Any GraphQL call the page makes on its own carries the session tokens; keep them for the API lane.
    if (this.scanMode === 'api' && this.apiBootstrap && !this.graphql.session(ownerId)) {
      page.on('request', request => {
        if (pageClosed || this.graphql.session(ownerId)) return;
        this.#rememberSession(ownerId, captureSession({ method: request.method(), url: request.url(), postData: request.postData(), headers: request.headers() }), 'trình duyệt');
      });
    }
    if (captureKind) {
      page.on('request', request => {
        if (pageClosed || (captured && captureKind === 'feed')) return;
        const raw = { method: request.method(), url: request.url(), postData: request.postData(), headers: request.headers() };
        const template = captureKind === 'feed' ? captureFeedTemplate(raw) : captureQueryTemplate(captureKind, raw);
        if (!template) {
          const seen = !captured && unmatched.size < 30 && describeGraphQLRequest(raw);
          if (seen && seen.keys.some(key => /cursor|after|before|count|first|last/i.test(key))) unmatched.set(`${seen.friendlyName}#${seen.docId}`, seen.keys);
          return;
        }
        // Non-feed kinds keep the best-ranked query of the visit; the feed keeps the first match.
        if (captured && !(template.priority < captured.priority)) return;
        captured = template;
        if (captureKind !== 'feed') {
          options.onTemplate?.(template);
          return;
        }
        this.#captureMisses.delete(ownerId);
        if (this.graphql.remember(ownerId, template)) this.log(`[QUÉT API | Tài khoản ${ownerId}] Đã lấy template GraphQL ${template.friendlyName}.`);
        try { options.onGroupId?.(template.groupId); } catch { /* Persisting the alias is best effort. */ }
      });
    }
    page.on('response', async res => {
      if (pageClosed) return;
      const u = res.url();
      if (u.includes('/api/graphql/')) {
        try {
          const text = await res.text();
          if (pageClosed) return;
          for (const post of parseGraphQLStream(text, groupUrl)) {
            apiPosts.set(post.id, post);
          }
        } catch {}
      }
    });

    let stage = 'mở trang Facebook';
    try {
      page.setDefaultTimeout(8000);
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response?.status() === 429) throw rateLimitError();
      stage = 'kiểm tra phiên đăng nhập và quyền đọc';
      await assertReadable(page, context);
      if (action === readJoinedGroups) return await action(page);
      if (!apiPosts.size && !action) {
        await page.locator('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/reel/"], [role="main"]').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
      }
      if (action) return await action(page, () => captured);
      const groupName = !postId ? await page.locator('h1').first().innerText().catch(() => '') : '';
      const collected = new Map();
      const basePasses = postId || options.latest ? 1 : (dateRange && options.backfill ? 300 : this.scrollPasses);
      // Facebook only sends the feed pagination query after scrolling; allow a few extra passes to capture it.
      const passes = options.captureTemplate ? Math.max(basePasses, 4) : basePasses;
      const emitted = new Map();
      let stagnant = 0;
      let completedPasses = 0, snapshotCount = 0;
      stage = 'trích xuất bài viết';
      for (let pass = 0; pass < passes; pass++) {
        if (options.shouldContinue && !options.shouldContinue()) break;
        completedPasses++;
        await assertReadable(page, context);

        const currentUrl = new URL(page.url());
        const currentGroup = currentUrl.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)/)?.[1];
        if (!currentGroup) throw new Error('Facebook không còn mở trang nhóm/bài mục tiêu. Kiểm tra phiên đăng nhập và quyền truy cập bằng trình duyệt.');
        const actualGroupUrl = `https://www.facebook.com/groups/${currentGroup}`;
        // A named group may publish numeric permalinks. Only trust aliases from
        // Facebook's own redirect/canonical metadata; never infer from shared links.
        const groupAliases = new Set([groupUrl, actualGroupUrl]);
        for (const id of [options.numericId, captured?.groupId]) if (/^\d{5,25}$/.test(String(id || ''))) groupAliases.add(`https://www.facebook.com/groups/${id}`);
        const canonicalUrls = await page.locator('head link[rel="canonical"], head meta[property="og:url"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href') || node.getAttribute('content')));
        for (const url of canonicalUrls) {
          try { groupAliases.add(normalizeFacebookGroupUrl(url)); }
          catch { const post = normalizePostUrl(url); if (post) groupAliases.add(post.groupUrl); }
        }
        const previousSize = collected.size;
        const capture = async () => {
          // 1. Trích xuất trực tiếp từ các script JSON và GraphQL stream của Facebook
          const scripts = await page.evaluate(() => {
            return [...document.querySelectorAll('script')]
              .map(s => s.textContent || '')
              .filter(t => t.length > 0 && t.length < 200000 && (t.includes('creation_time') || t.includes('post_id') || t.includes('legacy_fbid')))
              .slice(0, 5);
          }).catch(() => []);
          for (const post of extractPostsFromPageScripts(scripts, groupUrl)) {
            apiPosts.set(post.id, post);
          }
          for (const [id, post] of apiPosts) {
            if (groupName.trim()) post.groupName = groupName.trim().slice(0, 300);
            const previous = collected.get(id);
            if (!previous || post.text.length >= previous.text.length) {
              collected.set(id, { ...post, publishedAt: post.publishedAt || previous?.publishedAt || null });
            } else if (!previous.publishedAt && post.publishedAt) {
              previous.publishedAt = post.publishedAt;
            }
          }

          // 2. Dự phòng qua DOM snapshot khi không có API payload (ví dụ trong mock test)
          const snapshots = await page.evaluate(extractVisiblePostSnapshots);
          snapshotCount += snapshots.length + apiPosts.size;
          for (const post of normalizeSnapshots(snapshots, [...groupAliases])) {
            if (groupName.trim()) post.groupName = groupName.trim().slice(0,300);
            const previous = collected.get(post.id);
            if (!previous || post.text.length >= previous.text.length) collected.set(post.id, {...post,publishedAt:post.publishedAt || previous?.publishedAt || null});
            else if (!previous.publishedAt && post.publishedAt) previous.publishedAt = post.publishedAt;
          }
          // Unknown dates must not be persisted early: resolving the date later
          // would otherwise make a newly discovered post look like an old post.
          const ready = [...collected.values()].filter(post => post.publishedAt && emitted.get(post.id) !== JSON.stringify(post));
          if (ready.length && options.onPosts) {
            await options.onPosts(ready);
            for (const post of ready) emitted.set(post.id,JSON.stringify(post));
          }
        };
        await capture();
        if (!apiPosts.size) {
          // Expand message-local buttons only on DOM fallback
          const expand = page.locator('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]').getByRole('button', { name: /^(?:See more|Xem thêm)$/i });
          const expandCount = Math.min(await expand.count(), 10);
          for (let index = expandCount - 1; index >= 0; index--) {
            const button = expand.nth(index);
            if (await button.isVisible().catch(() => false)) await button.click({ timeout: 500 }).catch(() => {});
          }
          await revealPermalinks(page,30,capture);
          const timestampLinks = page.locator('a[href*="/posts/"], a[href*="/permalink/"]');
          for (let index = 0, count = await timestampLinks.count(); index < count; index++) {
            if (options.shouldContinue && !options.shouldContinue()) break;
            const link = timestampLinks.nth(index);
            if (await link.getAttribute('data-post-date')) continue;
            const box = await link.boundingBox().catch(() => null);
            if (!box || box.y < 0 || box.y + box.height > 1000) continue;
            await revealPostDate(page,link);
            await capture();
          }
        }
        stagnant = collected.size === previousSize ? stagnant + 1 : 0;
        if (dateRange && stagnant >= 5) break;
        if (pass + 1 >= basePasses && (captured || !options.captureTemplate)) break;
        if (pass + 1 < passes) {
          await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600)));
          await page.waitForTimeout(400);
        }
      }
      if (options.captureTemplate && !captured) this.#captureMisses.set(ownerId, Date.now());
      await assertReadable(page, context);
      if (!collected.size) throw emptyScanError(await page.evaluate(inspectScanPage), { passes: completedPasses, snapshots: snapshotCount });
      return [...collected.values()];
    } catch (error) {
      if (/Timeout|net::|Navigation/i.test(error.message)) {
        const detail = error.message.match(/net::[A-Z_]+/)?.[0] || error.message.split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180);
        throw new Error(`[${/net::/.test(error.message) ? 'NETWORK_ERROR' : 'PAGE_TIMEOUT'}] ${detail}\n  Bước: ${stage}\n  Xử lý: mở nhóm bằng tài khoản của bot, kiểm tra mạng và thử lại.`);
      }
      throw error;
    } finally {
      pageClosed = true;
      if (captureKind && !captured && unmatched.size) this.#logUnmatched(ownerId, captureKind, unmatched);
      await page.close().catch(() => {});
      const count = (this.#readCounts.get(ownerId) || 0) + 1;
      this.#readCounts.set(ownerId, count);
      if (count >= 100) {
        this.recycle(ownerId).catch(() => {});
      }
    }
  }

  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#contexts].map(context => context.close()));
    await Promise.all([this.#queue.close(),this.#commentQueue.close(),this.#backgroundQueue.close()]);
    await Promise.allSettled([...this.#contexts].map(context => context.close()));
    this.#profiles.clear();
  }
}
