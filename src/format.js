import { matchesKeywords } from "./input.js";
import { formatPublishedAt } from './dates.js';
import { normalizeAuthorUrl } from './facebook.js';
import { isAnonymousAuthor } from './direct-messages.js';

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const SHORTENED = "\n… [Nội dung rút gọn — mở link để đọc tiếp]";

function cut(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  let truncated = value.slice(0, Math.max(0, limit - 1));
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}…`;
}

function singleLine(value, limit) {
  return cut(String(value ?? "").replace(/[\r\n\t]+/g, " ").trim(), limit);
}

export function formatGroupTitle(group, post = {}) {
  if (group.sourceType === 'profile') return `${singleLine(group.label || 'Trang cá nhân',160)} · ${group.contentType === 'posts' ? 'bài viết' : group.contentType === 'reels' ? 'reel' : 'bài viết và reel'}`;
  const identifiers = [post.url, group.url].map(value => {
    try { return new URL(value).pathname.match(/^\/groups\/([^/]+)/)?.[1]; }
    catch { return null; }
  }).filter(Boolean);
  const facebookId = identifiers.find(value => /^\d+$/.test(value));
  const label = group.label && !identifiers.some(value => group.label === value || group.label === `Nhóm Facebook ${value}`)
    ? group.label : 'Chưa đọc được tên nhóm';
  return `${singleLine(label,160)} (${facebookId || 'chưa rõ ID nhóm'})`;
}

function postLink(post) {
  const value = String(post.url ?? "");
  if (!value || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error("Bài viết thiếu link hợp lệ.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || url.username || url.password || url.port) {
    throw new Error("Link bài viết phải thuộc Facebook.");
  }
  if (value.length > 1200) throw new Error("Link bài viết quá dài.");
  return value;
}

export function formatRejectedPost(group, post, result) {
  const reason = result.matchedReject.length ? `Khớp Reject: ${singleLine(result.matchedReject.join('; '),220)}` : 'Không khớp từ khóa Accept nào';
  return [`🚫 Bài bị loại theo từ khóa · Nhóm #${group.id} ${formatGroupTitle(group,post)}`, `Lý do: ${reason}`,
    `Người đăng: ${post.author ? singleLine(post.author,100) : 'không rõ'} · Ngày đăng: ${formatPublishedAt(post.publishedAt)}`,
    singleLine(post.text,300), post.url].filter(Boolean).join('\n');
}

/** Plain text only: HTML-like text in posts is displayed literally. */
export function formatPost(group, post, keywords = []) {
  const link = postLink(post);
  const content = String(post.text ?? "").trim() || "[Không đọc được nội dung bài viết]";
  const matched = (keywords ?? []).filter((keyword) => {
    return String(keyword ?? '').trim() && matchesKeywords(content, [keyword]);
  });
  const header = [
    `📌 ${formatGroupTitle(group,post)}`,
    `Nhóm #${group.id}${post.id ? ` · ID bài: ${singleLine(post.id,100)}` : ''}`,
    post.author ? `Người đăng: ${singleLine(post.author, 100)}` : null,
    `Ngày đăng: ${formatPublishedAt(post.publishedAt)}`,
    `Trang cá nhân: ${(!isAnonymousAuthor(post.author) && normalizeAuthorUrl(post.authorUrl)) || 'không rõ'}`,
    matched.length ? `Từ khóa: ${singleLine(matched.join("; "), 220)}` : null,
  ].filter(Boolean).join("\n");
  const footer = [
    post.media?.length ? `Đính kèm: ${post.media.filter(item => item.type === 'photo').length} ảnh, ${post.media.filter(item => item.type === 'video').length} video (tối đa 10 mục).` : null,
    '💬 Bấm Bình luận bên dưới hoặc reply tin này để bình luận lên Facebook.',
    `Link bài viết: ${link}`,
  ].filter(Boolean).join("\n");
  const allowance = TELEGRAM_MESSAGE_LIMIT - header.length - footer.length - 4;
  const body = content.length <= allowance ? content : cut(content, allowance - SHORTENED.length) + SHORTENED;
  return `${header}\n\n${body}\n\n${footer}`;
}

