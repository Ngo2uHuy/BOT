import { normalizeAuthorUrl, normalizePostUrl } from './facebook.js';
import { isAnonymousAuthor } from './direct-messages.js';
import { zaloPhones } from './zalo.js';

export const hhmm =time => new Date(time).toLocaleTimeString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hour12:false});

export const commenterBlockLabel = job => !job ? '🚫 Chặn người comment'
  : job.state === 'pending' && job.runAt > Date.now() ? `⏳ Chặn người comment lúc ${hhmm(job.runAt)}`
  : job.state === 'pending' || job.state === 'running' ? '⏳ Đang chặn người comment'
  : job.state === 'done' ? `✅ Đã chặn ${job.result?.blocked ?? 0} người comment`
  : job.result?.noComments ? '💬 Chưa có comment để chặn' : '⚠️ Chặn người comment chưa xong';

// Commenter blocking is offered on accepted posts only.
export function rejectedPostButtons(post, {authorBlocked = false} = {}) {
  return {inline_keyboard:[
    [authorBlocked ? {text:'✅ Đã chặn người đăng',callback_data:'rejected:blocked'} : {text:'🚫 Chặn người đăng',callback_data:'rejected:block'}],
  ]};
}

export function postButtons(post, {commenters = null} = {}) {
  const link = normalizePostUrl(post.url);
  if (!link) throw new Error('Link bài viết không hợp lệ.');
  const isAnon = post.author ? isAnonymousAuthor(post.author) : false;
  const profile = !isAnon ? normalizeAuthorUrl(post.authorUrl) : null;
  return { inline_keyboard: [
    [{ text: '💬 Bình luận', callback_data: 'post:comment' },
      { text: '↗️ Chia sẻ', url: `https://t.me/share/url?url=${encodeURIComponent(link.url)}` }],
    [{ text: '🔗 Đi tới bài viết', url: link.url }],
    [profile ? { text: '👤 Trang cá nhân', url: profile }
      : { text: '👤 Trang cá nhân', callback_data: 'post:no-profile' }],
    [profile ? { text: '📩 Nhắn tin riêng', callback_data: 'post:inbox' }
      : { text: '📩 Nhắn tin riêng', callback_data: 'post:no-profile-inbox' }],
    [profile ? { text: '🤝 Kết bạn', callback_data: 'post:friend' }
      : { text: '🤝 Kết bạn', callback_data: 'post:no-profile-friend' }],
    [{text:'📝 Danh sách bình luận',callback_data:'post:commentlist'}],
    [{text:'🛍 Bình luận top Shopee',callback_data:'post:affiliatetop'}],
    [{text:'🎵 Bình luận top TikTok',callback_data:'post:tiktoktop'}],
    ...(zaloPhones(post).length ? [[{text:'📱 Liên hệ Zalo',callback_data:'post:zalo'}]] : []),
    [{text:commenterBlockLabel(commenters),callback_data:'post:block-commenters'}],
    [{text:'🏠 Menu',callback_data:'nav:home'}],
  ] };
}

const commenterJob = (store, ownerId, post) => post.url ? store.commenterBlockJob?.(ownerId, post.url) : null;

export function postMarkup(store, ownerId, post) {
  return postButtons(post, {commenters: commenterJob(store, ownerId, post)});
}

// Keyboard of the notification a job was pressed on: rejected and accepted posts carry different buttons.
export function notificationMarkup(store, ownerId, post, replyMode) {
  return replyMode === 'rejected' ? rejectedMarkup(store, ownerId, post) : postMarkup(store, ownerId, post);
}

export function rejectedMarkup(store, ownerId, post) {
  const author = (!post.author || !isAnonymousAuthor(post.author)) && normalizeAuthorUrl(post.authorUrl);
  return rejectedPostButtons(post, {authorBlocked: Boolean(author) && store.authorBlockState(ownerId, author) === 'blocked'});
}
