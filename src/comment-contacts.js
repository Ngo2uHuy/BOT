import { graphQLLines } from './facebook-api.js';
import { schemaError } from './facebook-graphql.js';

// Extract only contact details explicitly present in the comment body.
export function extractContacts(text) {
  const value = String(text ?? '');
  const emails = [...new Set((value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi) || []).map(x => x.toLowerCase()))];
  const phones = new Set();
  for (const match of value.matchAll(/(?<![\w+])(?:\+84|0084|0)[ .()-]*(?:[35789](?:[ .()-]*\d){8}|2(?:[ .()-]*\d){9})(?!\w)/g)) {
    let phone = match[0].replace(/[^\d+]/g, '');
    phone = phone.replace(/^(?:\+84|0084)/, '0');
    if (/^(?:0[35789]\d{8}|02\d{9})$/.test(phone)) phones.add(phone);
  }
  return { phones: [...phones], emails };
}

// Self-contained for Playwright; a comment permalink is required so post text
// and recommended content cannot be mistaken for a comment.
export function visibleComments({ postId }) {
  const result = [];
  for (const node of document.querySelectorAll('[role="article"]')) {
    if (!node.getClientRects().length) continue;
    const own = selector => [...node.querySelectorAll(selector)].filter(el => el.closest('[role="article"]') === node);
    const link = own('a[href]').find(a => {
      const u = new URL(a.href);
      const target = u.searchParams.get('story_fbid') || u.searchParams.get('v') || u.pathname.match(/\/(?:posts|permalink|videos|reel)\/([^/]+)/)?.[1];
      return target === postId && (u.searchParams.has('comment_id') || u.searchParams.has('reply_comment_id'));
    });
    if (!link) continue;
    const url = new URL(link.href);
    const body = own('[data-ad-preview="message"], [data-ad-rendering-role="comment_message"], [dir="auto"]')
      .filter(el => !el.closest('a, [role="button"]') && !el.querySelector('[dir="auto"]'));
    const author = own('a[href]').find(a => a !== link && !/[?&](?:reply_)?comment_id=/.test(a.href));
    result.push({ id: url.searchParams.get('reply_comment_id') || url.searchParams.get('comment_id'),
      author: author?.innerText || '', authorUrl: author?.href || '', url: link.href,
      text: body.map(el => el.innerText).filter(Boolean).join('\n') });
  }
  return result;
}

export async function readCommentContacts(page, post, { passes = 10, canContinue = () => true } = {}) {
  const comments = new Map();
  let complete = false;
  const sort = page.getByRole('button', { name: /^(?:Most relevant|Newest|Phù hợp nhất|Có liên quan nhất|Mới nhất)$/i });
  let filtered = await sort.count() > 0;
  if (filtered) {
    if (!canContinue()) throw new Error('Đã hủy thu thập comment.');
    await sort.first().click();
    const all = page.getByRole('menuitem', { name: /^(?:All comments|Tất cả bình luận)/i });
    if (await all.count()) {
      await all.first().click();
      await page.waitForTimeout(1000);
      filtered = false;
    }
  }
  for (let pass = 0; pass < passes; pass++) {
    if (!canContinue()) throw new Error('Đã hủy thu thập comment.');
    for (const comment of await page.evaluate(visibleComments, { postId: post.id })) {
      comments.set(comment.id, withContacts(comment, post));
    }
    const more = page.getByRole('button', { name: /^(?:(?:View|See)(?: \d+)? (?:more |previous )?(?:comments|repl(?:y|ies))|\d+ repl(?:y|ies)|Xem(?: thêm)?(?: \d+)? (?:bình luận|câu trả lời|phản hồi)|Xem các bình luận trước|\d+ (?:câu trả lời|phản hồi))$/i });
    let next = null;
    for (let i = 0; i < await more.count(); i++) {
      if (await more.nth(i).isVisible()) { next = more.nth(i); break; }
    }
    if (!next) { complete = !filtered; break; }
    if (pass + 1 === passes) break;
    await next.click();
    await page.waitForTimeout(1000);
  }
  if (!comments.size) throw Object.assign(new Error('Không đọc được comment của bài này. Hãy mở phần bình luận, kiểm tra quyền xem và dùng link bài/video gốc.'), { code: 'NO_COMMENTS' });
  return summary(comments, { complete });
}

const withContacts = (comment, post) => ({ ...comment, ...extractContacts(comment.text), postUrl: post.url });
// `comments` keeps every commenter (not only those with contacts) for bulk actions such as blocking.
const summary = (comments, extra = {}) => ({ scanned: comments.size, items: [...comments.values()].filter(c => c.phones.length || c.emails.length), comments: [...comments.values()], ...extra });
const decodeBase64 = value => { try { return Buffer.from(String(value ?? ''), 'base64').toString('utf8'); } catch { return ''; } };

// Comet comment IDs are base64("comment:POST_COMMENT"); legacy_fbid is the ID that comment_id permalinks use.
// The comment connection is the shallowest one whose edges hold Comment nodes; replies nest deeper.
export function commentsFromGraphQL(text, post, { before = false } = {}) {
  const comments = new Map();
  let connection = null, pageInfo = null, edgeCursor = null;
  const connections = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth); return; }
    if (Array.isArray(node.edges) && node.edges.some(edge => edge?.node?.__typename === 'Comment') && (!connection || depth < connection.depth)) connection = { depth, node };
    if (node.page_info) connections.push(node);
    if (node.page_info && typeof node.page_info === 'object' && (!pageInfo || depth < pageInfo.depth)) pageInfo = { depth, value: node.page_info };
    if (typeof node.cursor === 'string' && node.cursor && node.node?.__typename === 'Comment') edgeCursor = node.cursor;
    if (node.__typename === 'Comment') {
      const raw = decodeBase64(node.id).match(/^comment:(\d+)_(\d+)$/);
      const id = String(node.legacy_fbid || raw?.[2] || '');
      if (/^\d+$/.test(id) && (!raw || raw[1] === post.id) && !comments.has(id)) {
        const author = node.author || node.comment_author || {};
        comments.set(id, {
          id, author: String(author.name || ''), authorId: /^\d+$/.test(String(author.id || '')) ? String(author.id) : '', text: String(node.body?.text ?? node.preferred_body?.text ?? ''),
          authorUrl: typeof author.url === 'string' && author.url ? author.url : /^\d+$/.test(String(author.id || '')) ? `https://www.facebook.com/profile.php?id=${author.id}` : '',
          url: typeof node.url === 'string' && /[?&]comment_id=/.test(node.url) ? node.url : `${post.url}${post.url.includes('?') ? '&' : '?'}comment_id=${id}`,
        });
      }
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  for (const value of graphQLLines(text)) walk(value, 0);
  const info = connection?.node.page_info || pageInfo?.value || null;
  const endCursor = (before ? info?.start_cursor : info?.end_cursor) || edgeCursor || null;
  const more = before ? info?.has_previous_page : info?.has_next_page;
  const incompleteReplies = connections.some(node => node !== connection?.node &&
    (node.page_info.has_next_page === true || node.page_info.has_previous_page === true));
  return { comments: [...comments.values()], endCursor, hasNextPage: typeof more === 'boolean' ? more : Boolean(endCursor), incompleteReplies };
}

// Same contract as readCommentContacts (at most `passes` loads), over a captured comments query.
// partial=false: a deferred later page throws instead of returning the pages read so far (bulk actions need all).
// singlePage: the query has no cursor (replaying it returns page one again); more pages yield `complete: false`.
// A deferral after some pages attaches `progress` to the error; passing it back as `resume` reads on from its cursor,
// counting its pages against `passes`. Only the fields a bulk action needs are kept, so resumed comments have no text.
export async function readCommentContactsApi(fetchText, post, { passes = 10, canContinue = () => true, before = false, partial = true, singlePage = false, resume = null, onProgress = null } = {}) {
  const comments = new Map((resume?.comments ?? []).map(comment => [comment.id, withContacts(comment, post)]));
  let cursor = resume?.cursor ?? null;
  let incompleteReplies = Boolean(resume?.incompleteReplies);
  if (resume?.pages >= passes) return summary(comments, { complete: false });
  for (let pass = resume?.pages ?? 0; pass < passes; pass++) {
    if (!canContinue()) throw new Error('Đã hủy thu thập comment.');
    let text;
    try { text = await fetchText(cursor); }
    catch (error) {
      if (error.code === 'SCAN_DEFERRED' && pass && partial) return summary(comments, {complete:false});
      if (error.code === 'SCAN_DEFERRED' && comments.size) error.progress = { cursor, pages: pass, incompleteReplies,
        comments: [...comments.values()].map(({ id, author, authorId, authorUrl }) => ({ id, author, authorId, authorUrl })) };
      throw error;
    }
    const page = commentsFromGraphQL(text, post, { before }), known = comments.size;
    incompleteReplies ||= page.incompleteReplies;
    for (const comment of page.comments) comments.set(comment.id, withContacts(comment, post));
    onProgress?.({ pages: pass + 1, comments: comments.size });
    if (!comments.size) throw Object.assign(schemaError('Trang GraphQL comment đầu tiên không có comment nào.'), { emptyComments: true });
    // A saved cursor always pointed at a further page; nothing new there means it no longer resolves, not the end.
    if (resume && pass === resume.pages && comments.size === known) return summary(comments, { complete: false });
    if (!page.hasNextPage) break;
    if (singlePage || !page.endCursor || page.endCursor === cursor || comments.size === known || pass+1 === passes) return summary(comments, { complete: false });
    cursor = page.endCursor;
  }
  if (!comments.size) throw Object.assign(schemaError('Trang GraphQL comment đầu tiên không có comment nào.'), { emptyComments: true });
  return summary(comments, incompleteReplies ? { complete: false } : {});
}
