const HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com']);
const RESERVED = /^(groups|reel|reels|watch|videos|photos|photo|photo.php|story.php|permalink.php|login|share|search|events|home.php|marketplace|gaming|friends|notifications|settings|messages)$/i;

function facebookUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) throw new Error('Link Facebook không hợp lệ.');
  const full = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const authority = full.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (!authority || !HOSTS.has(authority.toLowerCase())) throw new Error('Chỉ nhận link Facebook không có tài khoản hoặc cổng.');
  const rawPath = full.slice(full.indexOf(authority) + authority.length).split(/[?#]/)[0];
  if (/%|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) throw new Error('Đường dẫn Facebook không hợp lệ.');
  return new URL(full);
}

export function normalizeProfileUrl(value) {
  const url = facebookUrl(value);
  if (['story_fbid','post_id','comment_id','reply_comment_id'].some(key => url.searchParams.has(key))) throw new Error('Hãy gửi link trang cá nhân, không gửi link bài viết.');
  if (url.pathname === '/profile.php' && /^\d+$/.test(url.searchParams.get('id') || '')) return `https://www.facebook.com/profile.php?id=${url.searchParams.get('id')}`;
  const match = url.pathname.match(/^\/([A-Za-z0-9.]+)(?:\/reels)?\/?$/);
  if (!match || RESERVED.test(match[1]) || match[1].includes('.php')) throw new Error('Link trang cá nhân không hợp lệ.');
  return `https://www.facebook.com/${match[1]}`;
}

export function profileReelsUrl(value) {
  const url = new URL(normalizeProfileUrl(value));
  if (url.pathname === '/profile.php') url.searchParams.set('sk', 'reels');
  else url.pathname += '/reels/';
  return url.href;
}

export function parseProfileInput(value) {
  const tokens = String(value ?? '').trim().split(/[\s,;]+/u).filter(Boolean);
  const modes = ['all','posts','reels'];
  const mode = modes.includes(tokens.at(-1)?.toLowerCase()) ? tokens.pop().toLowerCase() : 'all';
  if (!tokens.length) throw new Error('Cú pháp: /profile LINK_1 LINK_2 ... [all|posts|reels]. Có thể xuống dòng giữa các link.');
  // Validate the whole batch before changing any existing source configuration.
  const urls = new Set();
  for (const [index, token] of tokens.entries()) {
    try { urls.add(normalizeProfileUrl(token)); }
    catch { throw new Error(`Link trang cá nhân thứ ${index+1} không hợp lệ. Chưa lưu danh sách; hãy sửa link rồi gửi lại. Đặt all, posts hoặc reels ở cuối lệnh.`); }
  }
  return {urls:[...urls],mode,duplicates:tokens.length-urls.size};
}

export function normalizeProfilePostUrl(value) {
  try {
    const url = facebookUrl(value);
    if (url.protocol !== 'https:' || ['comment_id','reply_comment_id'].some(key => url.searchParams.has(key))) return null;
    const reel = url.pathname.match(/^\/reel\/(\d+)\/?$/);
    if (reel) return { id: reel[1], kind: 'reel', groupUrl: null, url: `https://www.facebook.com/reel/${reel[1]}` };
    const post = url.pathname.match(/^\/([A-Za-z0-9.]+)\/(posts|videos)\/([A-Za-z0-9_-]+)\/?$/);
    if (post && !RESERVED.test(post[1])) return { id: post[3], kind: 'post', groupUrl: normalizeProfileUrl(`https://www.facebook.com/${post[1]}`), url: `https://www.facebook.com/${post[1]}/${post[2]}/${post[3]}` };
    if (/^\/(permalink|story)\.php$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('id') || '') && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('story_fbid') || '')) {
      const id = url.searchParams.get('story_fbid'), owner = url.searchParams.get('id');
      return { id, kind: 'post', groupUrl: `https://www.facebook.com/profile.php?id=${owner}`, url: `https://www.facebook.com/permalink.php?story_fbid=${id}&id=${owner}` };
    }
  } catch { /* Invalid or unrelated link. */ }
  return null;
}

// Read only links inside the profile's main content; never follow recommendations
// outside it. Ownership is checked again against profile aliases by the collector.
export function extractProfileSnapshots() {
  const root = document.querySelector('[role="main"], main');
  if (!root) return [];
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const result = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    if (!visible(anchor)) continue;
    const url = new URL(anchor.href);
    if (!/^\/(?:reel\/\d+|[A-Za-z0-9.]+\/(?:posts|videos)\/[A-Za-z0-9_-]+)\/?$/.test(url.pathname) && !/^\/(?:permalink|story)\.php$/.test(url.pathname)) continue;
    if (url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) continue;
    const article = anchor.closest('[role="article"], [data-pagelet^="FeedUnit_"]');
    if (article?.parentElement?.closest('[role="article"]')) continue;
    if (anchor.closest('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) continue;
    const author = article?.querySelector('[data-ad-rendering-role="profile_name"] a, h2 a, h3 a, strong a');
    const time = article?.querySelector('time[datetime], abbr[data-utime]');
    const messages = article ? [...article.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]')].filter(node => !node.closest('[role="article"]') || node.closest('[role="article"]') === article) : [];
    result.push({url:anchor.href, authorUrl:author?.href || null, author:author?.innerText || null,
      text:messages.map(node => node.innerText).join('\n'),
      publishedAt:time?.getAttribute('datetime') || time?.getAttribute('data-utime'),
      dateLabels:[anchor.getAttribute('data-post-date'),anchor.getAttribute('aria-label'),anchor.getAttribute('title')],
      // A reel grid belongs to the selected profile; feed reels need author proof.
      grid:!article && /\/reel\//.test(url.pathname)});
  }
  return result;
}
