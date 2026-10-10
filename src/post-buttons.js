import { normalizeAuthorUrl, normalizePostUrl } from './facebook.js';

export function postButtons(post) {
  const link = normalizePostUrl(post.url);
  if (!link) throw new Error('Link bài viết không hợp lệ.');
  const profile = normalizeAuthorUrl(post.authorUrl);
  return { inline_keyboard: [
    [{ text: '💬 Bình luận', callback_data: 'post:comment' },
      { text: '↗️ Chia sẻ', url: `https://t.me/share/url?url=${encodeURIComponent(link.url)}` }],
    [{ text: '🔗 Đi tới bài viết', url: link.url }],
    [profile ? { text: '👤 Trang cá nhân', url: profile }
      : { text: '👤 Trang cá nhân', callback_data: 'post:no-profile' }],
    [{text:'📝 Danh sách bình luận',callback_data:'post:commentlist'}],
    [{text:'🛍 Bình luận top Shopee',callback_data:'post:affiliatetop'}],
    [{text:'🎵 Bình luận top TikTok',callback_data:'post:tiktoktop'}],
    [{text:'🏠 Menu',callback_data:'nav:home'}],
  ] };
}
