import { Bot } from "grammy";
import { parseGroupInput, parseKeywords } from "./input.js";
import { parseDateRange, formatDateRange } from './dates.js';
import { commentText, parseCommentList } from './comments.js';
import { formatGroupTitle } from './format.js';
import { parseProfileInput } from './profile.js';
import { installNavigation } from './navigation.js';
import { installAffiliateCommands } from './affiliate.js';
import { installTikTokCommands } from './tiktok-commands.js';

export const BOT_COMMANDS = [
  ['menu','Menu chính: nguồn, bộ lọc, bài viết và bình luận'],
  ['keyboard','Mở lại bàn phím menu 2 cột dưới ô nhập'],
  ['sources','Chọn nguồn để quản lý bằng nút'],
  ['settings','Cài đặt nguồn: /settings ID'],
  ['profile','Quét nhiều trang: /profile LINK1 LINK2 [all|posts|reels]'],
  ['joined','Xem nhóm Facebook đã tham gia'], ['select','Chọn nhóm: /select 1,2 hoặc all'],
  ['help','Hướng dẫn và ví dụ lệnh'], ['add','Thêm nhóm: /add LINK'], ['list','Xem ID, tên nhóm và bộ lọc'],
  ['posts','Bài đã lưu: /posts ID [trang]'], ['daterange','Lọc ngày: /daterange ID ngày_đầu [ngày_cuối]'],
  ['comment','Bình luận mọi nhóm: /comment all | nội dung'],
  ['commentlist','Nhiều bình luận: /commentlist ID ID_bài | mỗi dòng một nội dung'],
  ['affiliate','Chuyển link Shopee: /affiliate shopee LINK1 LINK2'],
  ['affiliatetop','Xem top hoa hồng: /affiliatetop 5 [rate|amount]'],
  ['affiliatetopcomment','Lấy top và bình luận: /affiliatetopcomment ID ID_bài 5'],
  ['affiliatelinks','Link affiliate đã tạo: /affiliatelinks [trang]'],
  ['affiliatecomment','Bình luận link đã tạo: /affiliatecomment ID ID_bài | ID_link'],
  ['tiktok','TikTok: trạng thái, kiểm tra hoặc chuyển link sản phẩm'],
  ['tiktoktop','Top hoa hồng TikTok: /tiktoktop 5 [rate|amount]'],
  ['tiktoktopcomment','Lấy top TikTok và bình luận: ID_nguồn ID_bài SỐ_LINK'],
  ['tiktoklinks','Link TikTok đã lưu: /tiktoklinks [trang]'],
  ['tiktokcomment','Bình luận link TikTok: ID_nguồn ID_bài | ID_link'],
  ['tiktokauto','Tự bình luận TikTok theo nguồn: ID SỐ_LINK hoặc ID off'],
  ['autoreply','Tự bình luận: /autoreply ID hoặc all nội dung/off'],
  ['comments','Xem trạng thái 20 bình luận gần nhất'], ['cancelcomments','Hủy bình luận đang chờ: /cancelcomments [ID]'],
  ['keywords','Lọc từ khóa mặc định'], ['groupkeywords','Lọc từ khóa riêng cho nhóm'],
  ['pause','Tạm dừng: /pause [ID]'], ['resume','Tiếp tục: /resume [ID]'], ['remove','Xóa nhóm: /remove ID'],
  ['status','Trạng thái bot'], ['whoami','Xem ID Telegram'],
  ['cancel','Hủy phiên nhập cài đặt'],
].map(([command,description]) => ({command,description}));

export async function registerCommands(api) {
  await api.setMyCommands(BOT_COMMANDS,{scope:{type:'all_private_chats'}});
  await api.setChatMenuButton({menu_button:{type:'commands'}});
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

export function createBot({ token, allowedUserIds, store, collector, affiliate, tiktokAffiliate, maxFileBytes = 1_048_576 }) {
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

  installNavigation(bot,store);
  installAffiliateCommands(bot,store,affiliate);
  installTikTokCommands(bot,store,tiktokAffiliate);

  bot.callbackQuery(['post:comment','post:commentlist','post:no-profile'], async ctx => {
    const target = store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if (!target) return ctx.answerCallbackQuery({text:'Bài viết không còn trong dữ liệu của bạn.',show_alert:true});
    if (ctx.callbackQuery.data === 'post:no-profile') {
      return ctx.answerCallbackQuery({text:'Bài ẩn danh hoặc chưa đọc được link trang cá nhân người đăng.',show_alert:true});
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
    if (!ctx.msg.text) return ctx.reply('Hiện hỗ trợ bình luận bằng văn bản. Hãy reply bằng nội dung chữ.');
    try {
      const result = target.replyMode === 'list'
        ? store.queueCommentList(ctx.from.id,target.groupId,[target.postId],parseCommentList(ctx.msg.text))
        : store.queueComments(ctx.from.id,target.groupId,[target.postId],commentText(ctx.msg.text));
      await ctx.reply(`Bài ${target.postId}: đã xếp ${result.queued} bình luận để đăng Facebook; bỏ qua ${result.skipped} nội dung trùng. Xem /comments.`);
    } catch(error) { await ctx.reply(error.message); }
  });

  // Each user's selection indexes belong to their own most recent snapshot.
  const joined = new Map();
  bot.command('joined', async ctx => {
    const arg = String(ctx.match ?? '').trim().toLowerCase();
    const page = !arg || arg === 'refresh' ? 1 : idFrom(arg);
    if (!page) return ctx.reply('Cú pháp: /joined [trang] hoặc /joined refresh.');
    let snapshot = joined.get(ctx.from.id);
    if (!snapshot || arg === 'refresh') {
      if (!collector) return ctx.reply('Chưa cấu hình bộ đọc Facebook.');
      await ctx.reply('Đang đọc danh sách nhóm đã tham gia từ tài khoản Facebook của bạn…');
      try { snapshot = await collector.joinedGroups(ctx.from.id); }
      catch { return ctx.reply('Không đọc được nhóm. Kiểm tra phiên đăng nhập Facebook của bạn và thử lại /joined refresh.'); }
      joined.set(ctx.from.id,snapshot);
    }
    const items = snapshot.groups.slice((page-1)*15,page*15);
    if (!items.length) return ctx.reply('Không có nhóm ở trang này. Dùng /joined refresh để tải lại.');
    await replyLines(ctx,[`Nhóm đã tham gia · trang ${page}/${Math.ceil(snapshot.groups.length/15)} · ${snapshot.groups.length} nhóm${snapshot.limited ? ' (đã chạm giới hạn quét, có thể chưa đầy đủ)' : ''}`,
      ...items.map((item,index)=>`${(page-1)*15+index+1}. ${short(item.name || item.url,200)}\n${item.url}`),
      'Chọn: /select 1,2 hoặc /select all. Số này là số thứ tự danh sách, không phải ID trong /list.',
      ...(page*15 < snapshot.groups.length ? [`Trang tiếp: /joined ${page+1}`] : [])]);
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
  bot.command("list", async (ctx) => {
    const groups = store.listGroups(ctx.from.id);
    if (!groups.length) return ctx.reply("Bạn chưa thêm nhóm. Gửi link nhóm hoặc file .txt/.csv.");
    const defaults = store.getKeywords(ctx.from.id);
    await replyLines(ctx, groups.map((group) => {
      const keywords = group.keywords ?? defaults;
      return [
        `#${group.id} ${formatGroupTitle(group)} — ${group.paused ? "tạm dừng" : "đang theo dõi"}`,
        group.url,
        `Khoảng ngày: ${formatDateRange(group.dateRange)}`,
        `Tự bình luận bài mới: ${group.autoReply ? short(group.autoReply,150) : 'tắt'}`,
        `TikTok tự động: ${group.tiktokAuto ? `${group.tiktokAuto.count} link/bài · ${group.tiktokAuto.rank} · sản phẩm: ${group.tiktokAuto.keyword || 'tất cả'}` : 'tắt'}`,
        `Từ khóa${group.keywords == null ? " mặc định" : " riêng"}: ${keywords.length ? short(keywords.join("; "), 200) : "tất cả bài"}`,
        `Quét gần nhất: ${scanTime(group.lastScanAt)}${group.initialized ? "" : " — đang chờ tạo mốc"}`,
        group.lastError ? `Lỗi: ${short(group.lastError, 250)}` : null,
      ].filter(Boolean).join("\n") + "\n";
    }));
  });

  bot.command("remove", async (ctx) => {
    const groups = targets(ctx,String(ctx.match ?? '').trim());
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /remove ID hoặc /remove all.');
    for (const group of groups) store.removeGroup(ctx.from.id,group.id);
    await ctx.reply(`Đã xóa ${groups.length} nhóm khỏi danh sách theo dõi.`);
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

  bot.command('posts', async ctx => {
    const [rawId,rawPage='1',extra] = String(ctx.match ?? '').trim().split(/\s+/);
    const id = idFrom(rawId), page = idFrom(rawPage);
    if ((!id && rawId.toLowerCase() !== 'all') || !page || extra || page > 1000000) return ctx.reply('Cú pháp: /posts ID [trang]. Lấy ID nhóm bằng /list.');
    const posts = rawId.toLowerCase() === 'all' ? store.listAllPosts(ctx.from.id,(page-1)*20) : store.listPosts(ctx.from.id,id,(page-1)*20);
    if (!posts.length) return ctx.reply('Không có bài đã lưu ở trang này.');
    await replyLines(ctx,[`${id ? `Nhóm #${id}` : 'Tất cả nhóm'} · trang ${page}`, ...posts.map(post => `${post.id} — ${short(post.text || '[Bài đính kèm]',100)}\n${post.url}`),`Trang tiếp: /posts ${rawId} ${page+1}`]);
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
  bot.command('comments', async ctx => {
    const states = {pending:'đang chờ',sending:'đang gửi',sent:'đã đăng',failed:'chưa gửi được',uncertain:'chưa xác nhận — kiểm tra Facebook',cancelled:'đã hủy'};
    const items = store.listComments(ctx.from.id);
    await replyLines(ctx,items.length ? items.map(item => `#${item.id} · nhóm #${item.group_id} · bài ${item.post_id}: ${states[item.state] || item.state}\n${short(item.body,150)}${item.error ? `\n${short(item.error,200)}` : ''}`) : ['Chưa có bình luận.']);
  });
  bot.command('cancelcomments', async ctx => {
    const arg = String(ctx.match ?? '').trim(), id = arg ? idFrom(arg) : null;
    if (arg && arg.toLowerCase() !== 'all' && !id) return ctx.reply('Cú pháp: /cancelcomments [ID|all].');
    const count = store.cancelComments(ctx.from.id,id);
    await ctx.reply(`Đã hủy ${count} bình luận đang chờ. Bình luận đang gửi/đã đăng không bị xóa. Dùng /autoreply ID off để tắt phát sinh tự động.`);
  });

  for (const command of ["pause", "resume"]) {
    bot.command(command, async (ctx) => {
      const argument = String(ctx.match ?? "").trim();
      const id = argument ? idFrom(argument) : null;
      if (argument && argument.toLowerCase() !== 'all' && !id) return ctx.reply(`Cú pháp: /${command} [ID|all]. Bỏ ID để áp dụng tất cả nhóm.`);
      if (id && !store.listGroups(ctx.from.id).some((group) => group.id === id)) return ctx.reply("Không tìm thấy nhóm của bạn với ID này.");
      store.setPaused(ctx.from.id, id, command === "pause");
      await ctx.reply(`${command === "pause" ? "Đã tạm dừng" : "Đã tiếp tục"} ${id ? `nhóm #${id}` : "tất cả nhóm"}.`);
    });
  }

  bot.command("keywords", async (ctx) => {
    const argument = String(ctx.match ?? "").trim();
    if (!argument) {
      const current = store.getKeywords(ctx.from.id);
      return ctx.reply(`Từ khóa mặc định: ${current.length ? short(current.join("; "), 2500) : "tất cả bài"}.\nCú pháp: /keywords từ 1; từ 2. Dùng /keywords off để nhận tất cả.`);
    }
    const keywords = parseKeywords(argument);
    store.setKeywords(ctx.from.id, null, keywords);
    await ctx.reply(`Đã đặt bộ lọc mặc định: ${keywords.length ? short(keywords.join("; "), 2500) : "tất cả bài"}. Các nhóm có bộ lọc riêng vẫn dùng bộ lọc riêng.`);
  });
  bot.command("groupkeywords", async (ctx) => {
    const match = String(ctx.match ?? "").trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const groups = targets(ctx,match?.[1]);
    if (!groups.length) return ctx.reply('Không tìm thấy nhóm của bạn. Cú pháp: /groupkeywords ID|all từ 1; từ 2. Dùng off để nhận tất cả bài.');
    const keywords = parseKeywords(match[2] ?? '');
    for (const group of groups) store.setKeywords(ctx.from.id,group.id,keywords);
    await ctx.reply(`Bộ lọc cho ${groups.length} nhóm: ${keywords.length ? short(keywords.join('; '),2500) : 'tất cả bài'}.`);
  });

  bot.command("status", async (ctx) => {
    const status = store.status(ctx.from.id);
    const groups = store.listGroups(ctx.from.id);
    const scans = groups.map((group) => group.lastScanAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
    const failed = groups.filter((group) => group.lastError);
    await replyLines(ctx, [
      `Nhóm: ${status.groups} | Đang theo dõi: ${status.active}`,
      `Bài đã lưu: ${status.posts} | Thông báo chờ: ${status.pending}`,
      `Quét gần nhất: ${scanTime(scans.at(-1))}`,
      `Nhóm đang có lỗi: ${failed.length}`,
      ...failed.slice(0, 5).map((group) => `#${group.id}: ${short(group.lastError, 250)}`),
      "Dùng /list để xem từng nhóm. Chu kỳ quét tăng khi số nhóm tăng; không thể bảo đảm độ trễ bằng 0.",
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
