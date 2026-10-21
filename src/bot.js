import { Bot } from "grammy";
import { parseGroupInput, parseKeywords, normalizeGroupUrl, testKeywords } from "./input.js";
import { parseDateRange, formatDateRange, formatPublishedAt } from './dates.js';
import { commentText, parseCommentList } from './comments.js';
import { directMessageText, isAnonymousAuthor } from './direct-messages.js';
import { zaloPhones, ZALO_WEB_URL } from './zalo.js';
import { normalizeAuthorUrl } from './facebook.js';
import { safeError } from './monitor.js';
import { commenterBlockWaits } from './commenter-block.js';
import { formatGroupTitle } from './format.js';
import { parseProfileInput } from './profile.js';
import { installNavigation } from './navigation.js';
import { installAffiliateCommands } from './affiliate.js';
import { installTikTokCommands } from './tiktok-commands.js';
import { rejectedMarkup, notificationMarkup } from './post-buttons.js';
import { listPager, parseListArgs, listUsage, pageItems, hotItems, REMOVABLE, REMOVE_TYPES, REMOVE_NOTES, removalKey, removalText } from './listing.js';

export const BOT_COMMANDS = [
  ['menu','Menu chính: nguồn, bộ lọc, bài viết và bình luận'],
  ['config','Xem cấu hình hiện tại: từ khóa accept, reject, bộ lọc...'],
  ['sources','Chọn nguồn bằng nút: /sources [trang] [type:] [status:] [auto:] [tìm]'],
  ['search','Tìm nhóm và xem thứ hạng: /search tên, link hoặc ID nhóm'],
  ['testfilter','Thử Accept/Reject: /testfilter [ID|default] | nội dung'],
  ['rejected','Nhận tin bài bị loại theo từ khóa: /rejected on|off'],
  ['settings','Cài đặt nguồn: /settings ID'],
  ['profile','Quét nhiều trang: /profile LINK1 LINK2 [all|posts|reels]'],
  ['joined','Nhóm đã tham gia: /joined [trang|refresh] [status:new|added] [tìm]'], ['select','Chọn nhóm: /select 1,2 hoặc all'],
  ['help','Hướng dẫn và ví dụ lệnh'], ['add','Thêm nhóm: /add LINK'], ['list','Nguồn: /list [trang] [type:] [status:] [auto:] [sort:] [tìm]'], ['hot','Thứ hạng nhóm: /hot LINK hoặc /hot [số_lượng] [page:N] [sort:] [tìm]'],
  ['posts','Bài đã lưu: /posts ID|all [trang] [kind:post|reel] [sort:] [tìm]'], ['daterange','Lọc ngày: /daterange ID ngày_đầu [ngày_cuối]'],
  ['comment','Bình luận mọi nhóm: /comment all | nội dung'],
  ['contacts','Lấy SĐT/email từ comment: /contacts LINK_BÀI_HOẶC_VIDEO'],
  ['commentlist','Nhiều bình luận: /commentlist ID ID_bài | mỗi dòng một nội dung'],
  ['affiliate','Chuyển link Shopee: /affiliate shopee LINK1 LINK2'],
  ['affiliatetop','Xem top hoa hồng: /affiliatetop 5 [rate|amount]'],
  ['affiliatetopcomment','Lấy top và bình luận: /affiliatetopcomment ID ID_bài 5'],
  ['affiliatelinks','Link affiliate đã tạo: /affiliatelinks [trang] [sort:] [tìm]'],
  ['affiliatecomment','Bình luận link đã tạo: /affiliatecomment ID ID_bài | ID_link'],
  ['tiktok','TikTok: trạng thái, kiểm tra hoặc chuyển link sản phẩm'],
  ['tiktoktop','Top hoa hồng TikTok: /tiktoktop 5 [rate|amount]'],
  ['tiktoktopcomment','Lấy top TikTok và bình luận: ID_nguồn ID_bài SỐ_LINK'],
  ['tiktoklinks','Link TikTok đã lưu: /tiktoklinks [trang] [sort:] [tìm]'],
  ['tiktokcomment','Bình luận link TikTok: ID_nguồn ID_bài | ID_link'],
  ['tiktokauto','Tự bình luận TikTok theo nguồn: ID SỐ_LINK hoặc ID off'],
  ['autoreply','Tự bình luận: /autoreply ID hoặc all nội dung/off'],
  ['comments','Bình luận: /comments [trang] [state:] [source:ID] [mode:] [sort:] [tìm]'], ['cancelcomments','Hủy bình luận đang chờ: /cancelcomments [ID]'],
  ['autoinbox','Tự nhắn tin riêng: /autoinbox ID hoặc all nội dung/off'],
  ['inbox','Gửi tin nhắn riêng: /inbox ID ID_bài | nội dung'],
  ['inboxes','Tin nhắn riêng: /inboxes [trang] [state:] [source:ID] [sort:] [tìm]'],
  ['cancelinbox','Hủy tin nhắn riêng đang chờ: /cancelinbox [ID]'],
  ['autofriend','Tự kết bạn: /autofriend ID hoặc all on/off'],
  ['autoblock','Tự chặn người comment: /autoblock ID hoặc all on/off'],
  ['blocks','Lượt chặn người comment, vị trí hàng đợi: /blocks [trang] [state:] [mode:] [tìm]'],
  ['cancelblocks','Hủy lượt chặn người comment: /cancelblocks ID_nguồn hoặc all'],
  ['friend','Kết bạn với người đăng: /friend ID ID_bài'],
  ['friends','Lời mời kết bạn: /friends [trang] [state:] [source:ID] [sort:] [tìm]'],
  ['cancelfriend','Hủy lời mời kết bạn đang chờ: /cancelfriend [ID]'],
  ['keywords','Lọc từ khóa nhận (Accept) mặc định'], ['accept','Lọc từ khóa nhận (Accept) mặc định'],
  ['reject','Lọc từ khóa loại trừ (Reject) mặc định'],
  ['groupkeywords','Lọc từ khóa nhận (Accept) cho nhóm'], ['groupaccept','Lọc từ khóa nhận (Accept) cho nhóm'],
  ['groupreject','Lọc từ khóa loại trừ (Reject) cho nhóm'],
  ['pause','Tạm dừng: /pause [ID]'], ['resume','Tiếp tục: /resume [ID]'], ['remove','Xóa nhóm: /remove ID'],
  ['delete','Xóa 1 mục: /delete comment|inbox|friend|block|link|source ID, /delete post|rejected ID_nguồn ID_bài'],
  ['unhide','Bỏ ẩn bài: /unhide post|rejected ID_nguồn ID_bài'],
  ['status','Trạng thái bot'], ['whoami','Xem ID Telegram'],
  ['cancel','Hủy phiên nhập cài đặt'],
].map(([command,description]) => ({command,description}));

export async function registerCommands(api) {
  await api.setMyCommands(BOT_COMMANDS,{scope:{type:'all_private_chats'}});
  await api.setChatMenuButton({menu_button:{type:'commands'}});
}

// Shared by the CLI and desktop: validate the token, refuse webhook mode, publish the command menu.
export async function prepareBot(bot) {
  await bot.init();
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url) throw new Error('Bot đang dùng webhook. Hãy dùng token bot riêng hoặc chủ động gỡ webhook trước khi chạy polling.');
  await registerCommands(bot.api);
}

function idFrom(value) {
  const input = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(input)) return null;
  const id = Number(input);
  return Number.isSafeInteger(id) ? id : null;
}

function truncate(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  let part = text.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
  return `${part}…`;
}

function short(value, limit = 200) {
  return truncate(String(value ?? "").replace(/[\r\n]+/g, " "), limit);
}

function scanTime(value) {
  if (!value) return "chưa quét";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "không rõ" : date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + " (giờ Việt Nam)";
}

async function replyLines(ctx, lines) {
  let message = "";
  for (const line of lines) {
    const value = truncate(line, 3500);
    if (message && message.length + value.length + 1 > 3900) {
      await ctx.reply(message, { link_preview_options: { is_disabled: true } });
      message = "";
    }
    message += `${message ? "\n" : ""}${value}`;
  }
  if (message) await ctx.reply(message, { link_preview_options: { is_disabled: true } });
}

/** Streaming download is bounded even if Telegram omits file_size. */
async function downloadText(file, token, maxBytes) {
  if (!file.file_path || !/^[a-z\d_/-]+\.[a-z\d]+$/i.test(file.file_path) || file.file_path.includes("..")) {
    throw new Error("Không tải được file. Hãy gửi lại file .txt hoặc .csv.");
  }
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("Không tải được file từ Telegram.");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body.cancel();
    throw new Error("File vượt quá dung lượng cho phép.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("File vượt quá dung lượng cho phép.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary file");
    return text;
  } catch {
    throw new Error("File cần được lưu dưới dạng văn bản UTF-8.");
  }
}

export function createBot({ token, allowedUserIds, store, collector, affiliate, tiktokAffiliate, maxFileBytes = 1_048_576, log = console.warn, blockWaits = (ownerId, options) => commenterBlockWaits(store, ownerId, options), blockProgress = () => null }) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error("maxFileBytes không hợp lệ.");
  const allowed = new Set([...allowedUserIds ?? []].map(String));
  const bot = new Bot(token, { client: { timeoutSeconds: 60 } });

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from || ctx.from.is_bot) return;
    // Error text from Telegram/fetch can contain the bot token. Do not echo or log it.
    try { await next(); } catch {
      try { await ctx.reply("Không thực hiện được yêu cầu. Vui lòng thử lại; quản trị viên kiểm tra cấu hình nếu lỗi tiếp diễn."); } catch { /* User may have blocked the bot. */ }
    }
  });
  bot.command("whoami", (ctx) => ctx.reply(`ID Telegram của bạn: ${ctx.from.id}\nQuản trị viên thêm ID này vào ALLOWED_TELEGRAM_USER_IDS để cấp quyền.`));
  bot.use(async (ctx, next) => {
    if (!allowed.has(String(ctx.from.id))) {
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({text:'Bạn chưa được cấp quyền sử dụng bot.',show_alert:true});
      await ctx.reply("Bạn chưa được cấp quyền sử dụng bot. Gửi /whoami và cung cấp ID cho quản trị viên.");
      return;
    }
    store.ensureUser(ctx.from.id, ctx.chat.id);
    await next();
  });
  const pager = listPager(bot);

  installNavigation(bot,store);
  bot.command('testfilter', async ctx => {
    const raw = String(ctx.match ?? '').trim();
    const separator = raw.indexOf('|');
    const scope = (separator >= 0 ? raw.slice(0,separator) : raw).trim();
    const text = separator >= 0 ? raw.slice(separator+1).trim()
      : String(ctx.msg.reply_to_message?.text ?? ctx.msg.reply_to_message?.caption ?? '').trim();
    const usage = 'Cú pháp: /testfilter default | nội dung bài\nTheo nguồn: /testfilter ID | nội dung bài\nHoặc trả lời một tin nhắn bằng /testfilter (mặc định) hay /testfilter ID.';
    if (!text || (scope && scope.toLowerCase() !== 'default' && !/^[1-9]\d*$/.test(scope))) return ctx.reply(usage);
    let group;
    if (scope && scope.toLowerCase() !== 'default') {
      group = store.listGroups(ctx.from.id).find(g => g.id === Number(scope));
      if (!group) return ctx.reply('Không tìm thấy nguồn của bạn. Dùng /sources để xem ID.');
    }
    const accept = group ? store.effectiveKeywords(group) : store.getKeywords(ctx.from.id);
    const reject = group ? store.effectiveRejectKeywords(group) : (store.getRejectKeywords?.(ctx.from.id) ?? []);
    const result = testKeywords(text, accept, reject);
    const terms = values => values.length ? short(values.join('; '),900) : 'không có';
    const reason = result.matchedReject.length ? 'Khớp Reject nên bị loại, kể cả khi cũng khớp Accept.'
      : result.accepted ? result.acceptEmpty ? 'Accept trống và không khớp Reject.' : 'Khớp Accept và không khớp Reject.'
      : 'Không khớp từ khóa Accept nào.';
    return ctx.reply(`${result.accepted ? '✅ NHẬN' : '❌ LOẠI'} theo bộ lọc từ khóa\nBộ lọc: ${group ? `nguồn #${group.id} (gồm mặc định kế thừa nếu có)` : 'mặc định tài khoản'}\nAccept khớp: ${terms(result.matchedAccept)}\nReject khớp: ${terms(result.matchedReject)}\nLý do: ${reason}\n\nPhân biệt dấu, không phân biệt hoa/thường, khớp cụm nằm trong nội dung. Chỉ thử từ khóa, chưa xét ngày đăng hay trạng thái nguồn; không lưu bài hoặc gửi bình luận.`, {link_preview_options:{is_disabled:true}});
  });
  bot.command('rejected', async ctx => {
    const arg = String(ctx.match ?? '').trim().toLowerCase();
    if (arg === 'on') {
      store.setRejectedNotify(ctx.from.id,Date.now());
      return ctx.reply('Đã bật gửi bài bị loại theo từ khóa (chỉ bài trong khoảng ngày, thấy từ bây giờ). Tắt: /rejected off');
    }
    if (arg === 'off') {
      store.setRejectedNotify(ctx.from.id,null);
      return ctx.reply('Đã tắt gửi bài bị loại theo từ khóa và xóa các thông báo chưa gửi. Bật lại: /rejected on');
    }
    if (arg) return ctx.reply('Cú pháp: /rejected on | /rejected off');
    const since = store.getRejectedNotify(ctx.from.id);
    return ctx.reply(since === null ? 'Gửi bài bị loại theo từ khóa: TẮT. Bật: /rejected on' : `Gửi bài bị loại theo từ khóa: BẬT (từ ${formatPublishedAt(new Date(since).toISOString())}). Tắt: /rejected off`);
  });
  installAffiliateCommands(bot,store,affiliate);
  installTikTokCommands(bot,store,tiktokAffiliate);

  bot.callbackQuery(['rejected:block','rejected:blocked'], async ctx => {
    const target = store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if (!target || target.replyMode !== 'rejected') {
      return ctx.answerCallbackQuery({text:'Bài bị loại không còn trong dữ liệu của bạn.',show_alert:true});
    }
    const profile = (!target.post.author || !isAnonymousAuthor(target.post.author)) && normalizeAuthorUrl(target.post.authorUrl);
    if (!profile) return ctx.answerCallbackQuery({text:'Không xác định được trang cá nhân người đăng (bài ẩn danh hoặc thiếu link).',show_alert:true});
    if (!collector?.blockUser) return ctx.answerCallbackQuery({text:'Bộ đọc Facebook chưa hỗ trợ chặn. Cần khởi động lại bot sau cập nhật.',show_alert:true});
    if (!store.claimAuthorBlock(ctx.from.id,profile)) {
      const state = store.authorBlockState(ctx.from.id,profile);
      return ctx.answerCallbackQuery({text:state === 'blocked' ? 'Đã chặn người đăng này.' : state === 'sending'
        ? 'Đang xử lý chặn người đăng này.' : 'Lần chặn trước chưa xác nhận kết quả. Kiểm tra Facebook trước khi thao tác lại.',show_alert:true});
    }
    try { await ctx.answerCallbackQuery({text:'Đang chặn người đăng…'}); }
    catch (error) { store.setAuthorBlockState(ctx.from.id,profile,'failed'); throw error; }
    try {
      const result = await collector.blockUser(ctx.from.id,profile,() => {
        const current = store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
        return current?.replyMode === 'rejected' && (!current.post.author || !isAnonymousAuthor(current.post.author))
          && normalizeAuthorUrl(current.post.authorUrl) === profile;
      });
      if (result?.success !== true || result.state !== 'blocked') throw new Error('API chưa xác nhận chặn người đăng.');
      store.setAuthorBlockState(ctx.from.id,profile,'blocked');
    } catch (error) {
      store.setAuthorBlockState(ctx.from.id,profile,error.commentSubmitted === false ? 'failed' : 'uncertain');
      return ctx.reply(`Không xác nhận được thao tác chặn: ${safeError(error)}`);
    }
    try {
      await ctx.editMessageReplyMarkup({reply_markup:rejectedMarkup(store,ctx.from.id,target.post)});
    } catch { await ctx.reply('✅ Đã chặn người đăng. Không cập nhật được nút của tin nhắn này.'); }
  });

  // Only schedules: the monitor runs due jobs, so a restart or a slow block run never holds this callback.
  // Rejected and accepted notifications of one post share its single job (unique per owner + post URL);
  // every non-rejected reply mode maps a message to exactly one post.
  // Rejected notifications sent before this change still carry the old button.
  bot.callbackQuery('rejected:block-commenters', ctx => ctx.answerCallbackQuery({text:'Chặn người comment chỉ áp dụng cho bài đạt (accept).',show_alert:true}));
  bot.callbackQuery('post:block-commenters', async ctx => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const target = store.replyTarget(ctx.from.id,ctx.chat.id,messageId);
    if (!target || target.replyMode === 'rejected') return ctx.answerCallbackQuery({text:'Bài viết không còn trong dữ liệu của bạn.',show_alert:true});
    if (!target.post.url) return ctx.answerCallbackQuery({text:'Bài thiếu link nên không đọc được người comment.',show_alert:true});
    if (!collector?.blockUser) return ctx.answerCallbackQuery({text:'Bộ đọc Facebook chưa hỗ trợ chặn. Cần khởi động lại bot sau cập nhật.',show_alert:true});
    const {scheduled,job} = store.scheduleCommenterBlock(ctx.from.id,ctx.chat.id,messageId,target.groupId,target.postId,target.post.url,Date.now());
    if (!job) return ctx.answerCallbackQuery({text:'Bài viết không còn trong dữ liệu của bạn.',show_alert:true});
    await ctx.answerCallbackQuery({show_alert:true,text:!scheduled ? job.state === 'done'
      ? `Đã chặn ${job.result?.blocked ?? 0} người comment của bài này (mỗi bài chạy một lần).` : 'Đang chặn người comment của bài này.'
      : 'Bắt đầu quét và chặn người comment (trừ người đăng) ngay bây giờ.'});
    // Also refreshes a stale label when the shared job was started from the post's other notification.
    try { await ctx.editMessageReplyMarkup({reply_markup:notificationMarkup(store,ctx.from.id,target.post,target.replyMode)}); }
    catch { /* The job is already persisted; the label is cosmetic. */ }
  });

  bot.callbackQuery(['post:comment','post:commentlist','post:no-profile','post:inbox','post:no-profile-inbox','post:friend','post:no-profile-friend','post:zalo'], async ctx => {
    const target = store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if (!target) return ctx.answerCallbackQuery({text:'Bài viết không còn trong dữ liệu của bạn.',show_alert:true});
    if (ctx.callbackQuery.data === 'post:zalo') {
      const phones = zaloPhones(target.post);
      if (!phones.length) return ctx.answerCallbackQuery({text:'Bài viết không có SĐT di động hợp lệ.',show_alert:true});
      await ctx.answerCallbackQuery();
      for (let i = 0; i < phones.length; i += 20) {
        const batch = phones.slice(i, i + 20);
        await ctx.reply(`SĐT trong bài #${target.postId}:\n${batch.join('\n')}\nSao chép số rồi dán vào tìm kiếm Zalo để nhắn tin hoặc kết bạn. Chưa xác minh số có tài khoản Zalo; hãy kiểm tra đúng người.`, {
          reply_markup: {inline_keyboard: [...batch.map(phone => [{text:`Sao chép ${phone}`,copy_text:{text:phone}}]), [{text:'Mở Zalo',url:ZALO_WEB_URL}]]},
          link_preview_options: {is_disabled:true},
        });
      }
      return;
    }
    if (ctx.callbackQuery.data === 'post:no-profile' || ctx.callbackQuery.data === 'post:no-profile-inbox' || ctx.callbackQuery.data === 'post:no-profile-friend') {
      return ctx.answerCallbackQuery({text:'Bài ẩn danh hoặc chưa đọc được link trang cá nhân người đăng.',show_alert:true});
    }
    if (ctx.callbackQuery.data === 'post:friend') {
      if (!target.post?.authorUrl || isAnonymousAuthor(target.post?.author)) {
        return ctx.answerCallbackQuery({text:'Bài viết không có link trang cá nhân của người đăng hoặc bài ẩn danh.',show_alert:true});
      }
      try {
        const result = store.queueFriendRequest(ctx.from.id,target.groupId,target.postId,'manual');
        await ctx.answerCallbackQuery({text:`Đã xếp lời mời kết bạn với ${result.recipientName || 'người đăng'}.`});
        return ctx.reply(`🤝 Bài #${target.postId}: đã xếp lời mời kết bạn tới ${result.recipientName || 'người đăng'}.\nTrang cá nhân: ${result.recipientUrl}\nXem trạng thái bằng /friends.`);
      } catch (err) {
        return ctx.answerCallbackQuery({text:err.message,show_alert:true});
      }
    }
    if (ctx.callbackQuery.data === 'post:inbox') {
      if (!target.post?.authorUrl) {
        return ctx.answerCallbackQuery({text:'Bài viết không có link trang cá nhân của người đăng.',show_alert:true});
      }
      await ctx.answerCallbackQuery();
      const recipient = target.post.author ? `${target.post.author}` : 'người đăng';
      const prompt = await ctx.reply(`📩 Nhắn tin riêng cho ${recipient} (bài #${target.postId})\nTrả lời tin này với nội dung bạn muốn gửi qua Messenger.\n⚠️ Lưu ý: Giãn cách an toàn tối thiểu 5-10 phút/tin, tối đa 15 tin/ngày để bảo vệ tài khoản Facebook. Đóng ô reply nếu không muốn gửi.`,{
        reply_markup:{force_reply:true,input_field_placeholder:'Nhập nội dung tin nhắn gửi qua Messenger'},
        link_preview_options:{is_disabled:true},
      });
      store.mapMessage(ctx.from.id,ctx.chat.id,prompt.message_id,target.groupId,target.postId,'inbox');
      return;
    }
    await ctx.answerCallbackQuery();
    const list = ctx.callbackQuery.data === 'post:commentlist';
    const prompt = await ctx.reply(`💬 ${list?'Danh sách bình luận':'Bình luận'} bài ${target.postId}\n${list?'Trả lời tin này: mỗi dòng một nội dung/link sẽ gửi thành một bình luận riêng, cách nhau ít nhất 30 giây.':'Nhập nội dung trả lời tin này để đăng lên Facebook.'} Đóng ô reply nếu không muốn gửi.\n${target.post.url}`,{
      reply_markup:{force_reply:true,input_field_placeholder:'Nhập bình luận đăng lên Facebook'},
      link_preview_options:{is_disabled:true},
    });
    store.mapMessage(ctx.from.id,ctx.chat.id,prompt.message_id,target.groupId,target.postId,list?'list':'single');
  });

  bot.use(async (ctx,next) => {
    if (ctx.callbackQuery) return next();
    if (!ctx.msg?.reply_to_message) return next();
    if (ctx.msg.text?.startsWith('/')) return next();
    const target = store.replyTarget(ctx.from.id,ctx.chat.id,ctx.msg.reply_to_message.message_id);
    if (!target) return ctx.reply('Tin được reply không phải bài Facebook bot đã lưu. Hãy reply trực tiếp tin bài viết/ảnh/video của bot.');
    if (!ctx.msg.text) return ctx.reply('Hiện hỗ trợ bằng văn bản. Hãy reply bằng nội dung chữ.');
    try {
      if (target.replyMode === 'inbox') {
        const result = store.queueDirectMessage(ctx.from.id,target.groupId,target.postId,ctx.msg.text);
        return ctx.reply(`Bài ${target.postId}: đã xếp tin nhắn riêng gửi tới ${result.recipientName || 'người đăng'}. Giãn cách an toàn 5-10 phút/tin. Xem /inboxes.`);
      }
      const result = target.replyMode === 'list'
        ? store.queueCommentList(ctx.from.id,target.groupId,[target.postId],parseCommentList(ctx.msg.text))
        : store.queueComments(ctx.from.id,target.groupId,[target.postId],commentText(ctx.msg.text));
      await ctx.reply(`Bài ${target.postId}: đã xếp ${result.queued} bình luận để đăng Facebook; bỏ qua ${result.skipped} nội dung trùng. Xem /comments.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  // Each user's selection indexes belong to their own most recent snapshot.
  const joined = new Map();
  // Numbers stay the snapshot positions used by /select, whatever filter or sort is shown.
  bot.joinedList = (ownerId, query) => {
    const snapshot = joined.get(ownerId);
    if (!snapshot) return null;
    const followed = new Set(store.listGroups(ownerId).map(group => group.url));
    const items = snapshot.groups.map((item, index) => ({index: index+1, name: item.name || null, url: item.url, numericId: item.numericId ?? null, added: followed.has(item.url)}));
    return {...pageItems('joined', items, query), limited: Boolean(snapshot.limited)};
  };
  pager.define('joined', (ctx, query) => {
    const result = bot.joinedList(ctx.from.id, query);
    if (!result) return 'Dùng /joined để tải danh sách nhóm.';
    return {result, title: `Nhóm đã tham gia${result.limited ? ' (đã chạm giới hạn quét, có thể chưa đầy đủ)' : ''}`, empty: 'Không có nhóm. Dùng /joined refresh để tải lại.',
      lines: result.items.map(item => `${item.index}. ${short(item.name || item.url,200)}${item.added ? ' · đã thêm' : ''}\n${item.url}`),
      footer: ['Chọn: /select 1,2 hoặc /select all. Số này là số thứ tự danh sách, không phải ID trong /list.']};
  });
  bot.command('joined', async ctx => {
    const raw = String(ctx.match ?? '').trim(), refresh = /^refresh(?:\s|$)/i.test(raw);
    let query;
    try { query = parseListArgs('joined', refresh ? raw.slice(7) : raw); }
    catch (error) { return ctx.reply(`${error.message}\n${listUsage('joined','joined','[trang|refresh]')}`); }
    let snapshot = joined.get(ctx.from.id);
    if (!snapshot || refresh) {
      if (!collector) return ctx.reply('Chưa cấu hình bộ đọc Facebook.');
      log(`[NHÓM ĐÃ THAM GIA | Tài khoản ${ctx.from.id}] Đang đọc danh sách nhóm…`);
      try {
        snapshot = await collector.joinedGroups(ctx.from.id, { force: refresh });
      } catch (error) {
        // Telegram only shows successful results; the failure reason goes to the console log.
        log(`[NHÓM ĐÃ THAM GIA | Tài khoản ${ctx.from.id}] Thất bại: ${error.code === 'FACEBOOK_COOLDOWN' || error.code === 'RATE_LIMITED' ? 'Facebook đang giới hạn tần suất truy cập.' : error.message}`);
        return;
      }
      log(`[NHÓM ĐÃ THAM GIA | Tài khoản ${ctx.from.id}] Đọc được ${snapshot.groups.length} nhóm${snapshot.limited ? ' (chạm giới hạn quét)' : ''}.`);
      joined.set(ctx.from.id,snapshot);
      store.setNumericIdsByUrl?.(ctx.from.id,snapshot.groups);
    }
    return pager.open(ctx, 'joined', query);
  });
  bot.command('select', async ctx => {
    const snapshot = joined.get(ctx.from.id);
    if (!snapshot?.groups.length) return ctx.reply('Dùng /joined trước để lấy danh sách nhóm của bạn.');
    const arg = String(ctx.match ?? '').trim();
    const indexes = arg.toLowerCase() === 'all' ? snapshot.groups.map((_,i)=>i+1) : [...new Set(arg.split(/[ ,]+/).map(idFrom))];
    if (!indexes.length || indexes.some(i=>!i || i>snapshot.groups.length)) return ctx.reply('Cú pháp: /select 1,2 hoặc /select all. Số thứ tự phải có trong /joined.');
    let added=0;
    for (const index of indexes) if (store.addJoinedGroup(ctx.from.id,snapshot.groups[index-1]).created) added++;
    await ctx.reply(`Đã thêm ${added} nhóm; ${indexes.length-added} nhóm đã có sẵn. Nhóm mới sẽ gửi đợt bài mới nhất đọc được ở lần quét tiếp theo, theo bộ lọc hiện tại. Nhóm đã có giữ nguyên cấu hình. Xem /list để lấy ID quản lý.`);
  });

  function targets(ctx, value) {
    const groups = store.listGroups(ctx.from.id);
    return String(value).toLowerCase() === 'all' ? groups : groups.filter(g=>g.id === idFrom(value));
  }

  async function addInput(ctx, text) {
    const { urls, invalid } = parseGroupInput(text);
    if (!urls.length && !invalid.length) {
      await ctx.reply("Chưa thấy link nhóm. Ví dụ: /add https://www.facebook.com/groups/123456789/");
      return;
    }
    let added = 0;
    let duplicate = 0;
    for (const url of urls) {
      const result = store.addGroup(ctx.from.id, url);
      result.created ? added++ : duplicate++;
    }
    const lines = [`Đã thêm ${added} nhóm. Đã có sẵn: ${duplicate}. Link không hợp lệ: ${invalid.length}.`];
    if (added) lines.push("Lần quét đầu sẽ tạo mốc bài cũ. Dùng /list để xem ID và trạng thái.");
    if (invalid.length) {
      lines.push("Các link bỏ qua (chỉ nhận trang nhóm Facebook):");
      for (const value of invalid.slice(0, 10)) lines.push(`• ${short(value.split(/[?#]/, 1)[0].replace(/\/\/[^/@]+@/, "//[ẩn]@"), 160)}`);
      if (invalid.length > 10) lines.push(`… và ${invalid.length - 10} link khác.`);
    }
    await replyLines(ctx, lines);
  }

  bot.command("add", (ctx) => addInput(ctx, ctx.match));
  bot.command('profile', async ctx => {
    try {
      const {urls,mode,duplicates} = parseProfileInput(ctx.match);
      const results = urls.map(url => store.addProfile(ctx.from.id,url,mode));
      const added = results.filter(result => result.created).length;
      await replyLines(ctx,[
        `Đã thêm ${added}, cập nhật ${results.length-added} trang cá nhân; bỏ qua ${duplicates} link trùng trong lệnh. Quét ${mode === 'all' ? 'bài viết và reel' : mode === 'posts' ? 'bài viết' : 'reel'} cho ${results.length} trang.`,
        ...results.map(({group}) => `#${group.id} ${group.url}\nXem bài/reel: /posts ${group.id}`),
        'Bot sẽ quét từng trang theo lịch. Reply tin của bot hoặc dùng /comment ID_nguồn ID_bài | nội dung để bình luận. Quản lý bằng /list; tạm dừng một trang bằng /pause ID_nguồn.',
      ]);
    } catch (error) { await ctx.reply(error.message); }
  });
  bot.command("list", (ctx) => pager.command(ctx, 'sources', ctx.match, {defaults: {pageSize: 10}, usage: listUsage('sources', 'list')}));
  pager.define('sources', (ctx, query) => {
    const result = store.pageGroups(ctx.from.id, query);
    const defaults = store.getKeywords(ctx.from.id);
    const defaultReject = store.getRejectKeywords?.(ctx.from.id) ?? [];
    return {result, title: '📋 Nguồn đang quản lý', empty: 'Bạn chưa thêm nhóm. Gửi link nhóm hoặc file .txt/.csv.', remove: 'sources', lines: result.items.map((group) => {
      const keywords = group.keywords ?? defaults;
      const rejectKeywords = group.rejectKeywords ?? defaultReject;
      return [
        `#${group.id} ${formatGroupTitle(group)} — ${group.paused ? "tạm dừng" : "đang theo dõi"}`,
        group.url,
        `Khoảng ngày: ${formatDateRange(group.dateRange)}`,
        `Tự bình luận bài mới: ${group.autoReply ? short(group.autoReply,150) : 'tắt'}`,
        `Tự nhắn tin riêng: ${group.autoInbox ? short(group.autoInbox,150) : 'tắt'}`,
        `Tự kết bạn: ${group.autoFriend ? 'bật' : 'tắt'}`,
        `Tự chặn người comment: ${group.autoBlock ? 'bật' : 'tắt'}`,
        `TikTok tự động: ${group.tiktokAuto ? `${group.tiktokAuto.count} link/bài · ${group.tiktokAuto.rank} · sản phẩm: ${group.tiktokAuto.keyword || 'tất cả'}` : 'tắt'}`,
        `Từ khóa nhận (Accept)${group.keywords == null ? " mặc định" : " riêng"}: ${keywords.length ? short(keywords.join("; "), 200) : "tất cả bài"}`,
        `Từ khóa chặn (Reject)${group.rejectKeywords == null ? " mặc định" : " riêng"}: ${rejectKeywords.length ? short(rejectKeywords.join("; "), 200) : "không có"}`,
        `Quét gần nhất: ${scanTime(group.lastScanAt)}${group.initialized ? "" : " — đang chờ tạo mốc"}`,
        group.lastError ? `Lỗi: ${short(group.lastError, 250)}` : null,
      ].filter(Boolean).join("\n") + "\n";
    })};
  });

  bot.command("remove", async (ctx) => {
    const groups = targets(ctx,String(ctx.match ?? '').trim());
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /remove ID hoặc /remove all.');
    for (const group of groups) store.removeGroup(ctx.from.id,group.id);
    await ctx.reply(`Đã xóa ${groups.length} nhóm khỏi danh sách theo dõi.`);
  });

  // One row of any list: the same store call as the desktop buttons and the 🗑 buttons under each list page.
  const deleteUsage = 'Cú pháp: /delete comment|inbox|friend|block|link|source ID\n/delete post|rejected ID_nguồn ID_bài (ẩn bài; bỏ ẩn: /unhide post|rejected ID_nguồn ID_bài)\nID ghi ở đầu mỗi dòng của /comments, /inboxes, /friends, /blocks, /posts, /affiliatelinks, /list.';
  for (const command of ['delete', 'unhide']) bot.command(command, async ctx => {
    const [type = '', ...rest] = String(ctx.match ?? '').trim().split(/\s+/), kind = REMOVE_TYPES[type.toLowerCase()], restore = command === 'unhide';
    if (!kind || (restore && kind !== 'posts' && kind !== 'rejected')) return ctx.reply(deleteUsage);
    let key;
    try { key = removalKey(kind, rest.join(' ')); } catch (error) { return ctx.reply(`${error.message}\n${deleteUsage}`); }
    try { await ctx.reply(removalText(kind, key, store.removeListItem(kind, ctx.from.id, key, {restore}))); }
    catch (error) { await ctx.reply(error.message); }
  });
  const expired = ctx => ctx.answerCallbackQuery({text: 'Nút đã hết hạn. Gửi lại lệnh danh sách hoặc dùng /delete.', show_alert: true});
  async function removeMarked(ctx, id, found) {
    let text;
    try { text = removalText(found.kind, found.key, store.removeListItem(found.kind, ctx.from.id, found.key, {restore: found.restore})); pager.forget(id); }
    catch (error) { return ctx.answerCallbackQuery({text: error.message, show_alert: true}); }
    await ctx.answerCallbackQuery({text: text.slice(0, 190)});
    if (!found.restore) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    if (!await pager.refresh(ctx, found) && found.restore) await ctx.reply(text);
  }
  bot.callbackQuery(/^ld:([a-z0-9]{1,12})$/, async ctx => {
    const found = pager.marked(ctx.match[1], ctx.from.id);
    if (!found) return expired(ctx);
    found.messageId = ctx.callbackQuery.message?.message_id ?? null;
    if (found.restore) return removeMarked(ctx, ctx.match[1], found);
    await ctx.answerCallbackQuery();
    const label = typeof found.key === 'object' ? `${found.key.postId} (nguồn #${found.key.groupId})` : `#${found.key}`;
    const hide = found.kind === 'posts' || found.kind === 'rejected';
    await ctx.reply(`${hide ? 'Ẩn' : 'Xóa'} ${REMOVABLE[found.kind][1]} ${label}?\n${REMOVE_NOTES[found.kind]}`, {reply_markup: {inline_keyboard: [[
      {text: hide ? '🙈 Ẩn' : '🗑 Xóa', callback_data: `ly:${ctx.match[1]}`}, {text: 'Hủy', callback_data: `ln:${ctx.match[1]}`}]]}});
  });
  bot.callbackQuery(/^ly:([a-z0-9]{1,12})$/, ctx => {
    const found = pager.marked(ctx.match[1], ctx.from.id);
    return found ? removeMarked(ctx, ctx.match[1], found) : expired(ctx);
  });
  bot.callbackQuery(/^ln:([a-z0-9]{1,12})$/, async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Đã giữ lại, không xóa.').catch(() => {});
  });

  bot.command('daterange', async ctx => {
    const match = String(ctx.match ?? '').trim().match(/^(\S+)\s+(.+)$/);
    const groups = targets(ctx,match?.[1]);
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /daterange ID|all DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]], hoặc /daterange ID|all off.');
    let range;
    try { range = parseDateRange(match[2]); } catch (error) { return ctx.reply(error.message); }
    for (const group of groups) store.setDateRange(ctx.from.id, group.id, range);
    await ctx.reply(`Đã đặt khoảng ngày cho ${groups.length} nhóm: ${formatDateRange(range)} (giờ Việt Nam). ${range ? 'Lần quét tiếp theo sẽ lấy cả bài cũ phù hợp từ khóa, bỏ qua bài không đọc được ngày. Quét tối đa 300 lượt, không bảo đảm đủ lịch sử.' : 'Tiếp tục chế độ theo dõi thông thường.'}`);
  });

  pager.define('posts', (ctx, query) => {
    const result = store.pagePosts(ctx.from.id, query), id = query.fixed ? query.filters.source : null;
    return {result, title: id ? `Nhóm #${id}` : 'Tất cả nhóm', empty: 'Không có bài đã lưu.', remove: 'posts',
      lines: result.items.map(post => `${post.id}${id ? '' : ` · nguồn #${post.groupId}`} — ${short(post.text || '[Bài đính kèm]',100)}\n${post.url}`),
      footer: id ? [`Bình luận: /comment ${id} ID_bài | nội dung · /commentlist ${id} ID_bài | mỗi dòng một link`] : []};
  });
  bot.command('posts', async ctx => {
    const [rawId = '', ...rest] = String(ctx.match ?? '').trim().split(/\s+/);
    const id = idFrom(rawId), usage = `${listUsage('posts','posts','ID|all [trang]')}\nLấy ID nhóm bằng /list.`;
    if (!id && rawId.toLowerCase() !== 'all') return ctx.reply(usage);
    let query;
    try { query = parseListArgs('posts', rest.join(' ')); } catch (error) { return ctx.reply(`${error.message}\n${usage}`); }
    if (id) Object.assign(query, {filters: {...query.filters, source: id}, fixed: ['source']});
    return pager.open(ctx, 'posts', query);
  });
  bot.command('contacts', async ctx => {
    const url = String(ctx.match || '').trim();
    if (!url) return ctx.reply('Cú pháp: /contacts LINK_BÀI_HOẶC_VIDEO\nQuảng cáo: dùng link bài gốc. Livestream: dùng link /TEN/videos/ID.');
    if (!collector?.collectCommentContacts) return ctx.reply('Chưa cấu hình bộ đọc comment Facebook.');
    try {
      const result = await collector.collectCommentContacts(ctx.from.id, url);
      await replyLines(ctx, [
        `Đã đọc ${result.scanned} comment; ${result.items.length} comment có SĐT/email. Chỉ gồm nội dung đọc được trong lượt quét, tối đa 10 lượt tải; không đảm bảo toàn bộ comment hoặc chủ sở hữu thông tin liên hệ.`,
        ...result.items.map(c => `${short(c.author || 'Không rõ tên')}\nSĐT: ${c.phones.join(', ') || '—'}\nEmail: ${c.emails.join(', ') || '—'}\n${short(c.text, 800)}\n${c.url}`),
      ]);
    } catch (error) { await ctx.reply(error.message); }
  });

  bot.command('comment', async ctx => {
    const all = String(ctx.match ?? '').match(/^\s*all\s*\|([\s\S]+)$/i);
    if (all) {
      try {
        const text = commentText(all[1]);
        const groups = store.listGroups(ctx.from.id);
        if (!groups.length) return ctx.reply('Bạn chưa thêm nhóm.');
        let queued=0, skipped=0;
        for (const group of groups) {
          const result=store.queueComments(ctx.from.id,group.id,null,text);
          queued+=result.queued; skipped+=result.skipped;
        }
        return ctx.reply(`Đã xếp ${queued} bình luận trên ${groups.length} nhóm của bạn, theo bộ lọc từng nhóm; bỏ qua ${skipped} nội dung trùng. Nhóm tạm dừng sẽ chờ /resume. Xem /comments; hủy phần chờ bằng /cancelcomments.`);
      } catch(error) { return ctx.reply(error.message); }
    }
    const match = String(ctx.match ?? '').match(/^\s*(\d+)\s+(all|[A-Za-z0-9_, -]+)\s*\|([\s\S]+)$/i);
    const id = idFrom(match?.[1]);
    if (!id) return ctx.reply('Mọi nhóm: /comment all | Nội dung bình luận\nMột nhóm: /comment 1 all | Nội dung bình luận\nBài chỉ định: /comment 1 12345,67890 | Nội dung bình luận\nID bài lấy bằng /posts 1.');
    const ids = match[2].trim().toLowerCase() === 'all' ? null : [...new Set(match[2].split(',').map(value => value.trim()))];
    if (ids?.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) return ctx.reply('ID bài cách nhau bằng dấu phẩy.');
    try {
      const result = store.queueComments(ctx.from.id,id,ids,match[3]);
      await ctx.reply(`Đã xếp ${result.queued} bình luận; bỏ qua ${result.skipped} nội dung trùng. Đăng lần lượt, cách nhau ít nhất 30 giây. Xem /comments hoặc /cancelcomments ${id} để hủy phần chưa gửi.`);
    } catch(error) { await ctx.reply(error.message); }
  });
  bot.command('commentlist', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+)\s+([A-Za-z0-9_-]+)\s*\|([\s\S]*)$/);
    const id = idFrom(match?.[1]);
    if (!id || match[2].toLowerCase() === 'all') return ctx.reply('Cú pháp: /commentlist ID_nguồn ID_bài |\nlink_1\nlink_2\n...\nMỗi dòng là một bình luận riêng trên bài/reel chỉ định. Nhập 5 dòng để xếp 5 bình luận. Lấy ID bằng /list và /posts ID_nguồn.');
    try {
      const bodies = parseCommentList(match[3]);
      const result = store.queueCommentList(ctx.from.id,id,[match[2]],bodies);
      await ctx.reply(`Bài/reel ${match[2]} · nguồn #${id}: đã xếp ${result.queued}/${bodies.length} bình luận theo thứ tự danh sách; bỏ qua ${result.skipped} nội dung trùng. Mỗi dòng được gửi riêng, giữ nguyên link, cách nhau ít nhất 30 giây. Xem /comments; hủy phần đang chờ bằng /cancelcomments ${id}.`);
    } catch(error) { await ctx.reply(error.message); }
  });
  bot.command('autoreply', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+|all)\s+([\s\S]+)$/i);
    const id = idFrom(match?.[1]);
    const all = match?.[1].toLowerCase() === 'all';
    if (!id && !all) return ctx.reply('Cú pháp: /autoreply ID nội dung hoặc /autoreply all nội dung. Tắt bằng /autoreply all off.');
    try {
      const text = match[2].trim().toLowerCase() === 'off' ? null : commentText(match[2]);
      if (all) {
        const groups = store.listGroups(ctx.from.id);
        if (!groups.length) return ctx.reply('Bạn chưa thêm nhóm.');
        const now=Date.now();
        for (const group of groups) store.setAutoReply(ctx.from.id,group.id,text,now);
        return ctx.reply(text ? `Đã bật tự bình luận cho ${groups.length} nhóm hiện có: ${text}\nChỉ áp dụng bài mới sau lúc bật, phù hợp bộ lọc và sau mốc khởi tạo. Nhóm thêm sau cần bật riêng; nhóm tạm dừng chờ /resume.` : `Đã tắt tự bình luận cho ${groups.length} nhóm, hủy phần tự động đang chờ.`);
      }
      if (!store.setAutoReply(ctx.from.id,id,text)) return ctx.reply('Không tìm thấy nhóm của bạn.');
      await ctx.reply(text ? `Đã bật tự bình luận nhóm #${id}: ${text}\nChỉ bài mới có ngày đăng sau lúc bật, phù hợp bộ lọc và được phát hiện sau mốc ban đầu. Không áp dụng bài cũ.` : `Đã tắt tự bình luận nhóm #${id}, hủy bình luận tự động chưa gửi.`);
    } catch(error) { await ctx.reply(error.message); }
  });
  pager.define('comments', (ctx, query) => {
    const states = {pending:'đang chờ',sending:'đang gửi',sent:'đã đăng',failed:'chưa gửi được',uncertain:'chưa xác nhận — kiểm tra Facebook',cancelled:'đã hủy'};
    const result = store.pageComments(ctx.from.id, query);
    return {result, title: '💬 Bình luận', empty: 'Chưa có bình luận.', remove: 'comments', lines: result.items.map(item => `#${item.id} · nhóm #${item.group_id} · bài ${item.post_id}: ${states[item.state] || item.state}\n${short(item.body,150)}${item.error ? `\n${short(item.error,200)}` : ''}`)};
  });
  bot.command('comments', ctx => pager.command(ctx, 'comments', ctx.match));
  bot.command('cancelcomments', async ctx => {
    const arg = String(ctx.match ?? '').trim(), id = arg ? idFrom(arg) : null;
    if (arg && arg.toLowerCase() !== 'all' && !id) return ctx.reply('Cú pháp: /cancelcomments [ID|all].');
    const count = store.cancelComments(ctx.from.id,id);
    await ctx.reply(`Đã hủy ${count} bình luận đang chờ. Bình luận đang gửi/đã đăng không bị xóa. Dùng /autoreply ID off để tắt phát sinh tự động.`);
  });

  bot.command('autoinbox', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+|all)\s+([\s\S]+)$/i);
    const id = idFrom(match?.[1]);
    const all = match?.[1].toLowerCase() === 'all';
    if (!id && !all) return ctx.reply('Cú pháp: /autoinbox ID nội dung hoặc /autoinbox all nội dung. Tắt bằng /autoinbox all off.\nTrong nội dung có thể dùng {name} để chèn tên người đăng, {link} để chèn link bài.');
    try {
      const text = match[2].trim().toLowerCase() === 'off' ? null : directMessageText(match[2]);
      if (all) {
        const groups = store.listGroups(ctx.from.id);
        if (!groups.length) return ctx.reply('Bạn chưa thêm nguồn.');
        const now = Date.now();
        for (const group of groups) store.setAutoInbox(ctx.from.id,group.id,text,now);
        return ctx.reply(text ? `Đã bật tự nhắn tin riêng cho ${groups.length} nguồn hiện có: ${text}\nChỉ áp dụng bài mới sau lúc bật, có trang cá nhân và phù hợp bộ lọc. Giãn cách an toàn tối thiểu 5–10 phút/tin, tối đa 15 tin/ngày.` : `Đã tắt tự nhắn tin riêng cho ${groups.length} nguồn, hủy tin tự động đang chờ.`);
      }
      if (!store.setAutoInbox(ctx.from.id,id,text)) return ctx.reply('Không tìm thấy nguồn của bạn.');
      await ctx.reply(text ? `Đã bật tự nhắn tin riêng nguồn #${id}: ${text}\nChỉ bài mới có trang cá nhân, ngày đăng sau lúc bật và phù hợp bộ lọc. Giãn cách an toàn tối thiểu 5–10 phút/tin.` : `Đã tắt tự nhắn tin riêng nguồn #${id}, hủy tin tự động chưa gửi.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  bot.command('inbox', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+)\s+(\S+)\s*\|\s*([\s\S]+)$/);
    const id = idFrom(match?.[1]);
    if (!id || !match?.[2] || !match?.[3]) return ctx.reply('Cú pháp: /inbox ID_nguồn ID_bài | nội dung tin nhắn.');
    try {
      const result = store.queueDirectMessage(ctx.from.id, id, match[2].trim(), match[3].trim());
      await ctx.reply(`Bài ${match[2]}: đã xếp tin nhắn riêng gửi tới ${result.recipientName || 'người đăng'}. Giãn cách an toàn 5-10 phút. Xem /inboxes.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  const sendStates = {pending:'đang chờ',sending:'đang gửi',sent:'đã gửi',failed:'thất bại',uncertain:'chưa xác nhận',cancelled:'đã hủy'};
  pager.define('inboxes', (ctx, query) => {
    const result = store.pageDirectMessages(ctx.from.id, query);
    return {result, title: '✉️ Tin nhắn riêng', empty: 'Chưa có tin nhắn riêng nào.', remove: 'inboxes', lines: result.items.map(item => `#${item.id} · nguồn #${item.group_id} · bài ${item.post_id} · người nhận: ${item.recipient_name || 'không rõ'}: ${sendStates[item.state] || item.state}\n${short(item.body,150)}${item.error ? `\nLỗi: ${short(item.error,200)}` : ''}`)};
  });
  bot.command(['inboxes','inboxstatus'], ctx => pager.command(ctx, 'inboxes', ctx.match));

  bot.command('cancelinbox', async ctx => {
    const arg = String(ctx.match ?? '').trim(), id = arg ? idFrom(arg) : null;
    if (arg && arg.toLowerCase() !== 'all' && !id) return ctx.reply('Cú pháp: /cancelinbox [ID|all].');
    const count = store.cancelDirectMessages(ctx.from.id, id);
    await ctx.reply(`Đã hủy ${count} tin nhắn riêng đang chờ. Tin đang gửi/đã gửi không bị hủy.`);
  });

  bot.command('autofriend', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+|all)\s+(on|off)$/i);
    const id = idFrom(match?.[1]);
    const all = match?.[1]?.toLowerCase() === 'all';
    if (!id && !all) return ctx.reply('Cú pháp: /autofriend ID on/off hoặc /autofriend all on/off.\nVí dụ: /autofriend 1 on (bật tự kết bạn với người đăng bài mới nguồn #1).');
    try {
      const enabled = match[2].toLowerCase() === 'on';
      if (all) {
        const groups = store.listGroups(ctx.from.id);
        if (!groups.length) return ctx.reply('Bạn chưa thêm nguồn.');
        const now = Date.now();
        for (const group of groups) store.setAutoFriend(ctx.from.id,group.id,enabled,now);
        return ctx.reply(enabled ? `Đã bật tự kết bạn cho ${groups.length} nguồn hiện có.\nChỉ áp dụng bài mới sau lúc bật, có trang cá nhân và phù hợp bộ lọc.` : `Đã tắt tự kết bạn cho ${groups.length} nguồn, hủy lời mời tự động đang chờ.`);
      }
      if (!store.setAutoFriend(ctx.from.id,id,enabled)) return ctx.reply('Không tìm thấy nguồn của bạn.');
      await ctx.reply(enabled ? `Đã bật tự kết bạn nguồn #${id}.\nChỉ áp dụng cho bài mới có trang cá nhân, ngày đăng sau lúc bật và phù hợp bộ lọc.` : `Đã tắt tự kết bạn nguồn #${id}, hủy lời mời tự động chưa gửi.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  bot.command('autoblock', async ctx => {
    const match = String(ctx.match ?? '').match(/^\s*(\d+|all)\s+(on|off)$/i);
    const id = idFrom(match?.[1]);
    const all = match?.[1]?.toLowerCase() === 'all';
    if (!id && !all) return ctx.reply('Cú pháp: /autoblock ID on/off hoặc /autoblock all on/off.\nVí dụ: /autoblock 1 on (rà soát người comment các bài accept đã lưu của nguồn #1).');
    const enabled = match[2].toLowerCase() === 'on';
    if (all) {
      const groups = store.listGroups(ctx.from.id);
      if (!groups.length) return ctx.reply('Bạn chưa thêm nguồn.');
      const now = Date.now();
      for (const group of groups) store.setAutoBlock(ctx.from.id,group.id,enabled,now);
      return ctx.reply(enabled ? `Đã bật tự chặn người comment cho ${groups.length} nguồn hiện có: rà soát các bài accept đã lưu và mới phát hiện, không chờ gửi Telegram. Gọi API chặn người comment, bỏ qua người đăng và tài khoản bot. Chỉ quét một lần cho mỗi bài; nguồn tạm dừng sẽ chờ.` : `Đã tắt tự chặn người comment cho ${groups.length} nguồn, dừng các thao tác tiếp theo.`);
    }
    if (!store.setAutoBlock(ctx.from.id,id,enabled)) return ctx.reply('Không tìm thấy nguồn của bạn.');
    await ctx.reply(enabled ? `Đã bật tự chặn người comment nhóm #${id}: rà soát các bài accept đã lưu và mới phát hiện, không chờ gửi Telegram. Gọi API chặn người comment, bỏ qua người đăng và tài khoản bot. Chỉ quét một lần cho mỗi bài; nguồn tạm dừng sẽ chờ.` : `Đã tắt tự chặn người comment nhóm #${id}, dừng các thao tác tiếp theo.`);
  });

  pager.define('blocks', (ctx, query) => {
    const states = {pending:'đang chờ',running:'đang chạy',interrupted:'bị gián đoạn, sẽ chạy lại',done:'đã xong',failed:'chưa xong',stopped:'đã dừng'};
    const result = store.pageCommenterBlocks(ctx.from.id, query);
    return {result, title: '🛡 Chặn người comment', empty: 'Chưa có lượt chặn người comment.', remove: 'blocks', lines: blockWaits(ctx.from.id,{limit:query.pageSize,jobs:result.items}).map(job => {
      const progress = job.state === 'running' ? blockProgress(job.id) : null, result = job.result || {};
      const detail = job.wait?.text || (progress ? progress.phase === 'blocking' ? `đang chặn ${progress.index ?? 0}/${progress.total ?? 0}` : `đang đọc bình luận (${progress.comments ?? 0})` : '');
      const counts = ['blocked','skipped','failed','uncertain','pending'].filter(key => result[key]).map(key => `${{blocked:'đã chặn',skipped:'bỏ qua',failed:'lỗi',uncertain:'chưa xác nhận',pending:'chưa xử lý'}[key]} ${result[key]}`).join(', ');
      return `#${job.id} · nguồn #${job.groupId} · bài ${job.postId} · ${job.auto ? 'tự động' : 'thủ công'}: ${states[job.state] || job.state}${detail ? `\n${detail}` : ''}${counts ? `\n${counts}` : ''}${job.error ? `\nLỗi: ${short(job.error,200)}` : ''}`;
    })};
  });
  bot.command(['blocks','blockstatus'], ctx => pager.command(ctx, 'blocks', ctx.match));

  bot.command('cancelblocks', async ctx => {
    const arg = String(ctx.match ?? '').trim(), id = arg ? idFrom(arg) : null;
    if (!arg || arg.toLowerCase() !== 'all' && !id) return ctx.reply('Cú pháp: /cancelblocks ID_nguồn hoặc /cancelblocks all.');
    const count = store.cancelCommenterBlocks(ctx.from.id,id);
    await ctx.reply(`Đã hủy ${count} lượt chặn người comment đang chờ/đang chạy (lượt đang chạy dừng ở lần chặn kế tiếp). Người đã chặn không bị bỏ chặn. Không tắt tự chặn: dùng /autoblock ID off. Bấm lại nút chặn ở bài để chạy lại.`);
  });

  bot.command('friend', async ctx => {
    let groupId, postId;
    const match = String(ctx.match ?? '').match(/^\s*(\d+)\s+(\S+)\s*$/);
    if (match) {
      groupId = idFrom(match[1]);
      postId = match[2].trim();
    } else if (ctx.msg?.reply_to_message) {
      const target = store.replyTarget(ctx.from.id, ctx.chat.id, ctx.msg.reply_to_message.message_id);
      if (target) {
        groupId = target.groupId;
        postId = target.postId;
      }
    }
    if (!groupId || !postId) return ctx.reply('Cú pháp: /friend ID_nguồn ID_bài (hoặc reply trực tiếp vào tin bài viết rồi gõ /friend).');
    try {
      const result = store.queueFriendRequest(ctx.from.id, groupId, postId, 'manual');
      await ctx.reply(`🤝 Bài #${postId}: đã xếp lời mời kết bạn tới ${result.recipientName || 'người đăng'}.\nTrang cá nhân: ${result.recipientUrl}\nXem trạng thái bằng /friends.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  pager.define('friends', (ctx, query) => {
    const result = store.pageFriendRequests(ctx.from.id, query);
    return {result, title: '🤝 Lời mời kết bạn', empty: 'Chưa có lời mời kết bạn nào.', remove: 'friends', lines: result.items.map(item => `#${item.id} · nguồn #${item.group_id} · bài ${item.post_id} · người nhận: ${item.recipient_name || 'không rõ'}: ${sendStates[item.state] || item.state}\n${item.recipient_url}${item.error ? `\nLỗi: ${short(item.error,200)}` : ''}`)};
  });
  bot.command(['friends','friendstatus'], ctx => pager.command(ctx, 'friends', ctx.match));

  bot.command(['cancelfriend','cancelfriends'], async ctx => {
    const arg = String(ctx.match ?? '').trim(), id = arg ? idFrom(arg) : null;
    if (arg && arg.toLowerCase() !== 'all' && !id) return ctx.reply('Cú pháp: /cancelfriend [ID|all].');
    const count = store.cancelFriendRequests(ctx.from.id, id);
    await ctx.reply(`Đã hủy ${count} lời mời kết bạn đang chờ. Lời mời đang gửi/đã gửi không bị hủy.`);
  });

  for (const command of ["pause", "resume"]) {
    bot.command(command, async (ctx) => {
      const argument = String(ctx.match ?? "").trim();
      const id = argument ? idFrom(argument) : null;
      if (argument && argument.toLowerCase() !== 'all' && !id) return ctx.reply(`Cú pháp: /${command} [ID|all]. Bỏ ID để áp dụng tất cả nhóm.`);
      if (id && !store.listGroups(ctx.from.id).some((group) => group.id === id)) return ctx.reply("Không tìm thấy nhóm của bạn với ID này.");
      store.setPaused(ctx.from.id, id, command === "pause");
      if (command === "resume") {
        collector?.clearCooldown?.(ctx.from.id);
        store.clearErrors?.(ctx.from.id, id);
      }
      await ctx.reply(`${command === "pause" ? "Đã tạm dừng" : "Đã tiếp tục"} ${id ? `nhóm #${id}` : "tất cả nhóm"}${command === "resume" ? " và mở khóa quét Facebook" : ""}.`);
    });
  }

  bot.command("unblock", async (ctx) => {
    collector?.clearCooldown?.(ctx.from.id);
    store.clearErrors?.(ctx.from.id, null);
    await ctx.reply("Đã mở khóa cooldown Facebook và xóa thông báo lỗi chờ cho tất cả nhóm. Hệ thống sẽ quét lại ngay.");
  });

  bot.command(["config", "configs", "filters", "filter", "cauhinh"], async (ctx) => {
    const arg = String(ctx.match ?? "").trim();
    const id = /^\d+$/.test(arg) ? idFrom(arg) : null;
    // A bare number is a source ID here; pages and filters use page:N and key:value.
    if (!/^\d+$/.test(arg)) return pager.command(ctx, 'config', arg, {defaults: {pageSize: 10}, usage: `Cú pháp: /config ID (một nguồn) hoặc ${listUsage('sources', 'config', '[page:N]')}`});
    if (!id) return ctx.reply("Cú pháp: /config [ID] để xem cấu hình nguồn chỉ định, hoặc /config để xem tổng quan.");

    const defaultAccept = store.getKeywords(ctx.from.id);
    const defaultReject = store.getRejectKeywords?.(ctx.from.id) ?? [];

    {
      const g = store.listGroups(ctx.from.id).find((group) => group.id === id);
      if (!g) return ctx.reply("Không tìm thấy nguồn của bạn với ID này.");
      const accept = g.keywords ?? defaultAccept;
      const reject = g.rejectKeywords ?? defaultReject;
      const lines = [
        `⚙️ CẤU HÌNH NGUỒN #${g.id}`,
        `• Tên/URL: ${formatGroupTitle(g)}`,
        `• Link: ${g.url}`,
        `• Trạng thái: ${g.paused ? "⏸ Tạm dừng" : "▶️ Đang theo dõi"}`,
        `• Loại: ${g.sourceType === "profile" ? `Trang cá nhân (${g.contentType === "posts" ? "chỉ bài viết" : g.contentType === "reels" ? "chỉ reel" : "bài viết & reel"})` : "Nhóm Facebook"}`,
        `• Từ khóa nhận (Accept) ${g.keywords == null ? "mặc định" : "riêng"}: ${accept.length ? short(accept.join("; "), 1000) : "tất cả bài (không lọc)"}`,
        `• Từ khóa chặn (Reject) ${g.rejectKeywords == null ? "mặc định" : "riêng"}: ${reject.length ? short(reject.join("; "), 1000) : "không có (chưa chặn bài nào)"}`,
        `• Lọc ngày: ${formatDateRange(g.dateRange)}`,
        `• Tự bình luận bài mới: ${g.autoReply ? short(g.autoReply, 300) : "tắt"}`,
        `• Tự nhắn tin riêng: ${g.autoInbox ? short(g.autoInbox, 300) : "tắt"}`,
        `• Tự kết bạn: ${g.autoFriend ? "bật" : "tắt"}`,
        `• Tự chặn người comment: ${g.autoBlock ? "bật" : "tắt"}`,
        `• TikTok tự động: ${g.tiktokAuto ? `${g.tiktokAuto.count} link/bài · ${g.tiktokAuto.rank === "amount" ? "tiền hoa hồng" : "% hoa hồng"} · từ khóa: ${g.tiktokAuto.keyword || "mọi sản phẩm"}` : "tắt"}`,
        `• Quét gần nhất: ${scanTime(g.lastScanAt)}${g.initialized ? "" : " — đang chờ tạo mốc"}`,
        g.lastError ? `• Lỗi gần nhất: ${short(g.lastError, 250)}` : null,
        "",
        "💡 Thao tác nhanh với nguồn này:",
        `- Đổi Accept: /groupkeywords ${g.id} từ 1; từ 2 (dùng off để nhận tất cả, default để dùng mặc định)`,
        `- Đổi Reject: /groupreject ${g.id} từ 1; từ 2 (dùng off để xóa chặn, default để dùng mặc định)`,
        `- Tùy chỉnh bằng nút: /settings ${g.id}`,
      ].filter((line) => line !== null);
      return replyLines(ctx, lines);
    }
  });
  pager.define('config', (ctx, query) => {
    const defaultAccept = store.getKeywords(ctx.from.id);
    const defaultReject = store.getRejectKeywords?.(ctx.from.id) ?? [];
    const result = store.pageGroups(ctx.from.id, query), groups = result.items;
    const lines = [
      "📌 BỘ LỌC MẶC ĐỊNH (Tài khoản của bạn):",
      `• Từ khóa nhận (Accept): ${defaultAccept.length ? short(defaultAccept.join("; "), 1000) : "tất cả bài (không lọc từ khóa)"}`,
      `• Từ khóa loại trừ (Reject): ${defaultReject.length ? short(defaultReject.join("; "), 1000) : "không có (chưa chặn bài nào)"}`,
      "",
      `📊 NGUỒN THEO DÕI (${result.total} nguồn):`,
    ];

    if (!groups.length) {
      lines.push(result.total ? "Không có nguồn ở trang này." : "Chưa thêm nguồn nào. Dùng /add LINK hoặc /joined để thêm.");
    } else {
      for (const g of groups) {
        const accept = g.keywords ?? defaultAccept;
        const reject = g.rejectKeywords ?? defaultReject;
        lines.push(
          `#${g.id} ${formatGroupTitle(g)} — ${g.paused ? "tạm dừng" : "đang theo dõi"}`,
          `  - Accept: ${g.keywords == null ? "mặc định" : "riêng"} (${accept.length ? short(accept.join("; "), 150) : "tất cả bài"})`,
          `  - Reject: ${g.rejectKeywords == null ? "mặc định" : "riêng"} (${reject.length ? short(reject.join("; "), 150) : "không có"})`,
          g.dateRange ? `  - Ngày: ${formatDateRange(g.dateRange)}` : null,
          g.autoReply ? `  - Tự bình luận: ${short(g.autoReply, 100)}` : null,
          g.autoInbox ? `  - Tự nhắn tin: ${short(g.autoInbox, 100)}` : null,
          g.autoFriend ? `  - Tự kết bạn: bật` : null,
          g.autoBlock ? `  - Tự chặn người comment: bật` : null,
          g.tiktokAuto ? `  - TikTok tự động: ${g.tiktokAuto.count} link/bài (${g.tiktokAuto.rank})` : null,
        );
      }
    }

    const footer = [
      "",
      "💡 Lệnh chỉnh sửa cấu hình:",
      "• Đổi Accept mặc định: /keywords từ 1; từ 2 (hoặc /accept, dùng off để xóa)",
      "• Đổi Reject mặc định: /reject từ 1; từ 2 (dùng off để xóa)",
      "• Đổi Accept cho nguồn: /groupkeywords ID|all từ 1; từ 2 (dùng default để kế thừa)",
      "• Đổi Reject cho nguồn: /groupreject ID|all từ 1; từ 2 (dùng default để kế thừa)",
      "• Xem chi tiết 1 nguồn: /config ID hoặc /settings ID",
    ];
    return {result, title: "⚙️ THÔNG TIN CẤU HÌNH HIỆN TẠI", empty: '', lines: lines.filter((l) => l !== null), footer};
  }, 'sources');

  bot.command(["keywords", "accept"], async (ctx) => {
    const argument = String(ctx.match ?? "").trim();
    if (!argument) {
      const current = store.getKeywords(ctx.from.id);
      const reject = store.getRejectKeywords?.(ctx.from.id) ?? [];
      return ctx.reply(`Từ khóa nhận (Accept) mặc định: ${current.length ? short(current.join("; "), 2000) : "tất cả bài"}.\nTừ khóa loại trừ (Reject) mặc định: ${reject.length ? short(reject.join("; "), 2000) : "không có"}.\n\nCú pháp Accept: /keywords từ 1; từ 2 (hoặc /accept)\nCú pháp Reject: /reject từ 1; từ 2\nDùng off để xóa bộ lọc. Xem toàn bộ: /config.`);
    }
    const keywords = parseKeywords(argument);
    store.setKeywords(ctx.from.id, null, keywords);
    await ctx.reply(`Đã đặt bộ lọc nhận (Accept) mặc định: ${keywords.length ? short(keywords.join("; "), 2500) : "tất cả bài"}. Các nhóm có bộ lọc riêng vẫn dùng bộ lọc riêng.`);
  });
  bot.command("reject", async (ctx) => {
    const argument = String(ctx.match ?? "").trim();
    if (!argument) {
      const current = store.getRejectKeywords?.(ctx.from.id) ?? [];
      return ctx.reply(`Từ khóa loại trừ (Reject) mặc định: ${current.length ? short(current.join("; "), 2500) : "không có (chưa chặn bài nào)"}.\nCú pháp: /reject từ 1; từ 2. Dùng /reject off để không chặn bài nào. Xem toàn bộ: /config.`);
    }
    const keywords = parseKeywords(argument);
    store.setRejectKeywords?.(ctx.from.id, null, keywords);
    await ctx.reply(`Đã đặt từ khóa loại trừ (Reject) mặc định: ${keywords.length ? short(keywords.join("; "), 2500) : "không có"}. Bài viết chứa bất kỳ từ nào trong danh sách này sẽ bị bỏ qua.`);
  });
  bot.command(["groupkeywords", "groupaccept"], async (ctx) => {
    const match = String(ctx.match ?? "").trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const groups = targets(ctx,match?.[1]);
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /groupkeywords ID|all từ 1; từ 2. Dùng off để nhận tất cả bài, default để dùng mặc định.');
    const rawKeywords = match[2] ?? '';
    if (rawKeywords.trim().toLowerCase() === 'default') {
      for (const group of groups) store.setKeywords(ctx.from.id, group.id, null);
      return ctx.reply(`Bộ lọc nhận (Accept) cho ${groups.length} nhóm: đã chuyển về mặc định tài khoản.`);
    }
    const keywords = parseKeywords(rawKeywords);
    for (const group of groups) store.setKeywords(ctx.from.id,group.id,keywords);
    await ctx.reply(`Bộ lọc nhận (Accept) cho ${groups.length} nhóm: ${keywords.length ? short(keywords.join('; '),2500) : 'tất cả bài'}.`);
  });
  bot.command("groupreject", async (ctx) => {
    const match = String(ctx.match ?? "").trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const groups = targets(ctx,match?.[1]);
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /groupreject ID|all từ 1; từ 2. Dùng off để không loại trừ từ nào, default để dùng mặc định.');
    const rawKeywords = match[2] ?? '';
    if (rawKeywords.trim().toLowerCase() === 'default') {
      for (const group of groups) store.setRejectKeywords?.(ctx.from.id, group.id, null);
      return ctx.reply(`Từ khóa loại trừ (Reject) cho ${groups.length} nhóm: đã chuyển về mặc định tài khoản.`);
    }
    const keywords = parseKeywords(rawKeywords);
    for (const group of groups) store.setRejectKeywords?.(ctx.from.id,group.id,keywords);
    await ctx.reply(`Từ khóa loại trừ (Reject) cho ${groups.length} nhóm: ${keywords.length ? short(keywords.join('; '),2500) : 'không có'}.`);
  });

  pager.define('hot', (ctx, query) => {
    const result = pageItems('hot', hotItems(store, ctx.from.id), query);
    const top = result.page === 1 && query.sort === 'rank' && query.dir === 'asc' && !query.q && !Object.keys(query.filters).length;
    return {result, title: `🔥 ${top ? `Top ${result.items.length} nguồn sôi động` : 'Nguồn sôi động'} (bài phù hợp bộ lọc trong 48 giờ)`, empty: 'Chưa có nhóm đang theo dõi.',
      lines: result.items.map(item => {
        const group = store.getGroup(item.id);
        const every = group.scanIntervalMs ? ` · quét lại ~${Math.round(group.scanIntervalMs/1000)}s` : '';
        return `${item.rank}. #${item.id} ${formatGroupTitle(group)}\n   ${item.useful} bài phù hợp / ${item.total} bài${every}`;
      }),
      footer: ['Chỉ tính bài khớp Accept/Reject, mỗi người đăng tối đa 2 bài, nên nick ảo spam không đẩy được thứ hạng. Tự tính lại mỗi 5 phút.']};
  });
  bot.command('hot', async ctx => {
    const arg = String(ctx.match ?? '').trim();
    let target;
    // A link asks for one group's rank; otherwise a leading number keeps its old meaning (how many per page).
    if (/^(?:https?:\/\/|(?:www\.|m\.)?facebook\.com\/)/i.test(arg)) {
      let url;
      try { url = normalizeGroupUrl(arg); }
      catch { return ctx.reply('Cú pháp: /hot LINK_NHÓM hoặc /hot [số lượng]. Ví dụ: /hot https://www.facebook.com/groups/826392100466750'); }
      const slug = new URL(url).pathname.split('/')[2].toLowerCase();
      target = store.listGroups(ctx.from.id).find(g => g.sourceType !== 'profile' &&
        (String(g.numericId || '') === slug || g.url.split('/')[4]?.toLowerCase() === slug));
      if (!target) return ctx.reply(`Nhóm này chưa được thêm vào tài khoản của bạn. Chưa có thứ hạng.\nThêm nhóm: /add ${url}`);
      if (target.paused) return ctx.reply(`#${target.id} ${formatGroupTitle(target)}\nNhóm đang tạm dừng nên không được xếp hạng. Tiếp tục: /resume ${target.id}`);
    }
    if (target) {
      const allRanked = hotItems(store, ctx.from.id, 0), item = allRanked.find(entry => entry.id === target.id);
      if (!item) return ctx.reply('Nhóm chưa có dữ liệu xếp hạng.');
      return ctx.reply(`🔥 #${target.id} ${formatGroupTitle(target)}\n${target.url}\nTop ${item.rank}/${allRanked.length} nguồn đang theo dõi của bạn.\n${item.useful} bài phù hợp / ${item.total} bài trong 48 giờ.\nCùng cách xếp hạng với /hot: bài phù hợp bộ lọc, mỗi tác giả tối đa 2 bài; cùng điểm xét tổng bài rồi ID nguồn.`);
    }
    const [first = '', ...rest] = arg.split(/\s+/), size = /^\d+$/.test(first) ? first : null;
    const usage = `Cú pháp: /hot LINK_NHÓM hoặc ${listUsage('hot','hot','[số_lượng]')} [page:N]`;
    let query;
    try { query = parseListArgs('hot', size ? rest.join(' ') : arg, {pageSize: Math.min(50, idFrom(size || '10') || 10)}); }
    catch (error) { return ctx.reply(`${error.message}\n${usage}`); }
    hotItems(store, ctx.from.id, 0);
    return pager.open(ctx, 'hot', query);
  });

  bot.command("status", async (ctx) => {
    const status = store.status(ctx.from.id);
    const groups = store.listGroups(ctx.from.id);
    const scans = groups.map((group) => group.lastScanAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
    const failed = groups.filter((group) => group.lastError);
    const defaultAccept = store.getKeywords(ctx.from.id);
    const defaultReject = store.getRejectKeywords?.(ctx.from.id) ?? [];
    await replyLines(ctx, [
      `Nhóm: ${status.groups} | Đang theo dõi: ${status.active}`,
      `Bài đã lưu: ${status.posts} | Thông báo chờ: ${status.pending}`,
      `Từ khóa nhận (Accept) mặc định: ${defaultAccept.length ? short(defaultAccept.join("; "), 100) : "tất cả bài"}`,
      `Từ khóa chặn (Reject) mặc định: ${defaultReject.length ? short(defaultReject.join("; "), 100) : "không có"}`,
      `Quét gần nhất: ${scanTime(scans.at(-1))}`,
      `Nhóm đang có lỗi: ${failed.length}`,
      ...failed.slice(0, 5).map((group) => `#${group.id}: ${short(group.lastError, 250)}`),
      ...(failed.length > 5 ? [`… xem đủ ${failed.length} nguồn lỗi theo trang: /list status:error`] : []),
      "Dùng /config để xem chi tiết cấu hình, /list để xem từng nguồn. Chu kỳ quét tăng khi số nhóm tăng; không thể bảo đảm độ trễ bằng 0.",
    ]);
  });

  bot.on("message:document", async (ctx) => {
    const document = ctx.msg.document;
    if (!/\.(txt|csv)$/i.test(document.file_name ?? "")) return ctx.reply("Chỉ nhận file .txt hoặc .csv, mã hóa UTF-8.");
    if (document.file_size > maxFileBytes) return ctx.reply(`File quá lớn. Giới hạn: ${maxFileBytes} byte.`);
    let content;
    try {
      const file = await ctx.api.getFile(document.file_id);
      if (file.file_size > maxFileBytes) return ctx.reply(`File quá lớn. Giới hạn: ${maxFileBytes} byte.`);
      content = await downloadText(file, token, maxFileBytes);
    } catch {
      return ctx.reply(`Không đọc được file. Hãy gửi .txt/.csv UTF-8, tối đa ${maxFileBytes} byte, và thử lại.`);
    }
    await addInput(ctx, content);
  });
  bot.on("message:text", (ctx) => {
    if (ctx.msg.text.startsWith("/")) return ctx.reply("Lệnh không có sẵn. Gửi /help để xem hướng dẫn.");
    return addInput(ctx, ctx.msg.text);
  });
  return bot;
}
