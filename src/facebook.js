import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseDay } from './dates.js';
import { normalizeMedia } from './media.js';
import { commentText, submitComment } from './comments.js';
import { BrowserQueue } from './browser-queue.js';
import { inspectScanPage, emptyScanError } from './scan-diagnostics.js';
import { FacebookCooldown, rateLimitError } from './facebook-cooldown.js';
import { readJoinedGroups } from './joined-groups.js';
import { normalizeProfileUrl, normalizeProfilePostUrl, profileReelsUrl, extractProfileSnapshots } from './profile.js';

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
      authorUrl: normalizeAuthorUrl(snapshot.authorUrl),
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
export async function revealPostDate(page, link, timeout = 1500) {
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
  await page.waitForTimeout(100);
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
    await page.waitForTimeout(100);
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
  #commentQueue = new BrowserQueue(1);
  #backgroundQueue = new BrowserQueue(1);
  #profiles = new Map();
  #closed = false;
  #contexts = new Set();

  constructor({ dataDir, headless = true, scrollPasses = 3, scanWorkers = 4, log = console.warn }) {
    if (!dataDir) throw new Error('Cần cấu hình dataDir.');
    if (!Number.isInteger(scrollPasses) || scrollPasses < 1 || scrollPasses > 10) throw new Error('scrollPasses phải nằm trong khoảng 1–10.');
    this.#queue = new BrowserQueue(scanWorkers);
    this.dataDir = path.resolve(dataDir);
    this.cooldown = new FacebookCooldown(this.dataDir, { log });
    this.headless = headless;
    this.scrollPasses = scrollPasses;
  }

  collect(ownerId, groupUrl, dateRange = null, options = {}) {
    const guardedOptions = canContinue => ({ ...options, shouldContinue: () => canContinue() && (!options.shouldContinue || options.shouldContinue()) });
    if (!new URL(groupUrl).pathname.startsWith('/groups/')) {
      const profile = normalizeProfileUrl(groupUrl);
      return this.#enqueue(ownerId, canContinue => this.#collectProfile(ownerId, profile, dateRange, guardedOptions(canContinue)), false, options.background, !options.background);
    }
    const normalized = normalizeFacebookGroupUrl(groupUrl);
    return this.#enqueue(ownerId, canContinue => this.#read(ownerId, `${normalized}?sorting_setting=CHRONOLOGICAL`, normalized, null, dateRange, null, guardedOptions(canContinue)), false, options.background, !options.background);
  }

  joinedGroups(ownerId) {
    return this.#enqueue(ownerId, ()=>this.#read(ownerId,'https://www.facebook.com/groups/joins/',null,null,null,readJoinedGroups));
  }

  collectPost(ownerId, postUrl) {
    const normalized = normalizePostUrl(postUrl);
    if (!normalized) return Promise.reject(new Error('Link bài Facebook không hợp lệ.'));
    return this.#enqueue(ownerId, async () => {
      if (normalized.kind) return this.#readProfilePost(ownerId, normalized);
      const posts = await this.#read(ownerId, normalized.url, normalized.groupUrl, normalized.id);
      const post = posts.find(item => item.id === normalized.id);
      if (!post) throw new Error('Không tìm thấy bài cần cập nhật. Bài có thể bị xóa, mất quyền truy cập hoặc giao diện Facebook đã thay đổi.');
      return post;
    }, false, true);
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
      author:snapshot.author || null,authorUrl:normalizeAuthorUrl(snapshot.authorUrl),media:normalizeMedia(snapshot.media),
      publishedAt:[snapshot.publishedAt,...(snapshot.dateLabels || [])].map(parsePublishedAt).find(Boolean) || null};
  }

  async #collectProfile(ownerId, profile, dateRange, options) {
    const posts = new Map();
    const mode = options.contentType || 'all';
    const targets = mode === 'posts' ? [profile] : mode === 'reels' ? [profileReelsUrl(profile)] : [profile,profileReelsUrl(profile)];
    for (const target of targets) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      await this.#read(ownerId,target,null,null,null,async page => {
        const aliases = new Set([profile, normalizeProfileUrl(page.url())]);
        const canonical = await page.locator('head link[rel="canonical"], head meta[property="og:url"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href') || node.getAttribute('content')));
        for (const value of canonical) { try { aliases.add(normalizeProfileUrl(value)); } catch {} }
        const belongs = value => { try { return aliases.has(normalizeProfileUrl(value)); } catch { return false; } };
        const name = await page.locator('h1').first().innerText().catch(() => '');
        const passes = options.latest ? 1 : dateRange ? 300 : this.scrollPasses;
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
          if (pass+1<passes) {
            await page.evaluate(() => window.scrollBy(0,Math.max(window.innerHeight*.9,600)));
            await page.waitForTimeout(1200);
          }
        }
      });
    }
    if (!posts.size) throw new Error('Không đọc được bài/reel thuộc trang cá nhân này. Kiểm tra quyền xem hoặc giao diện Facebook.');
    return [...posts.values()];
  }

  comment(ownerId, postUrl, text, canSubmit) {
    const post = normalizePostUrl(postUrl);
    if (!post) return Promise.reject(new Error('Link bài Facebook không hợp lệ.'));
    const body = commentText(text);
    return this.#enqueue(ownerId, canContinue => this.#read(ownerId,post.url,post.groupUrl,post.id,null,
      async page => {
        const actual = normalizePostUrl(page.url());
        if (!actual || actual.url !== post.url) throw new Error('Facebook chuyển sang bài khác; không đăng bình luận.');
        await revealPermalinks(page);
        return submitComment(page,post,body,() => canContinue() && (!canSubmit || canSubmit()));
      }),true);
  }

  canScan(ownerId, probe = true) {
    return this.cooldown.canRun(ownerId, probe);
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
    const profile = profileDirectory(this.dataDir, ownerId);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: this.headless, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1280, height: 1000 },
        serviceWorkers: 'block', acceptDownloads: false,
        timeout: 30000,
      });
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
    const context = await this.#context(ownerId);
    const page = await context.newPage();
    page.on('popup', popup => popup.close().catch(() => {}));
    let stage = 'mở trang Facebook';
    try {
      page.setDefaultTimeout(8000);
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response?.status() === 429) throw rateLimitError();
      stage = 'kiểm tra phiên đăng nhập và quyền đọc';
      await assertReadable(page, context);
      if (action === readJoinedGroups) return await action(page);
      await page.locator('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/reel/"], [role="main"]').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      if (action) return await action(page);
      const groupName = !postId ? await page.locator('h1').first().innerText().catch(() => '') : '';
      const collected = new Map();
      const passes = postId || options.latest ? 1 : dateRange ? 300 : this.scrollPasses;
      const emitted = new Map();
      let stagnant = 0;
      let completedPasses = 0, snapshotCount = 0;
      stage = 'trích xuất bài viết';
      for (let pass = 0; pass < passes; pass++) {
        if (options.shouldContinue && !options.shouldContinue()) break;
        completedPasses++;
        await assertReadable(page, context);
        // Expand only message-local buttons. Never click a generic page button,
        // which could post, join a group, or perform another account action.
        const expand = page.locator('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]').getByRole('button', { name: /^(?:See more|Xem thêm)$/i });
        const expandCount = Math.min(await expand.count(), 20);
        for (let index = expandCount - 1; index >= 0; index--) {
          const button = expand.nth(index);
          if (await button.isVisible().catch(() => false)) await button.click({ timeout: 1000 }).catch(() => {});
        }
        const currentUrl = new URL(page.url());
        const currentGroup = currentUrl.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)/)?.[1];
        if (!currentGroup) throw new Error('Facebook không còn mở trang nhóm/bài mục tiêu. Kiểm tra phiên đăng nhập và quyền truy cập bằng trình duyệt.');
        const actualGroupUrl = `https://www.facebook.com/groups/${currentGroup}`;
        // A named group may publish numeric permalinks. Only trust aliases from
        // Facebook's own redirect/canonical metadata; never infer from shared links.
        const groupAliases = new Set([groupUrl, actualGroupUrl]);
        const canonicalUrls = await page.locator('head link[rel="canonical"], head meta[property="og:url"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href') || node.getAttribute('content')));
        for (const url of canonicalUrls) {
          try { groupAliases.add(normalizeFacebookGroupUrl(url)); }
          catch { const post = normalizePostUrl(url); if (post) groupAliases.add(post.groupUrl); }
        }
        const previousSize = collected.size;
        const capture = async () => {
          const snapshots = await page.evaluate(extractVisiblePostSnapshots);
          snapshotCount += snapshots.length;
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
        stagnant = collected.size === previousSize ? stagnant + 1 : 0;
        if (dateRange && stagnant >= 5) break;
        if (pass + 1 < passes) {
          await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600)));
          await page.waitForTimeout(1200);
        }
      }
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
      await page.close().catch(() => {});
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
