import { parseKeywords } from './input.js';
import { parseDateRange, formatDateRange } from './dates.js';
import { commentText } from './comments.js';

const button = (text, callback_data) => ({text,callback_data});
const HOME = {inline_keyboard:[
  [button('1. Nhóm Facebook','nav:groups'), button('2. Affiliate','nav:affiliates')],
  [button('3. Trang cá nhân','nav:profiles'), button('4. Bài viết đã lưu','nav:posts')],
  [button('💬 Bình luận','nav:comments'), button('⚙️ Bộ lọc & quản lý','nav:filters')],
  [button('📊 Trạng thái','nav:status'), button('❓ Hướng dẫn','nav:help')],
]};
const GUIDES = {
  groups:'1. THU THẬP BÀI VIẾT TRONG NHÓM\n/add LINK1 LINK2 — thêm nhóm hoặc gửi file .txt/.csv.\n/joined → /select 1,2 — chọn nhóm đã tham gia.\n/groupkeywords ID từ khóa — lọc bài cần thu thập.\n/daterange ID ngày_đầu [ngày_cuối] — lọc thời gian.\n/posts ID — xem bài; /settings ID — cài đặt/quét lại.\nBot theo dõi các nhóm đã thêm mà tài khoản có quyền xem, không tìm toàn bộ Facebook.',
  profiles:'3. BÀI VIẾT & REEL TRANG CÁ NHÂN\n/profile LINK1 LINK2 all — thêm nhiều trang.\nThay all bằng posts hoặc reels để quét riêng.\n/groupkeywords ID từ khóa — lọc nội dung.\n/posts ID — xem kết quả; /settings ID — cài đặt, quét lại, tạm dừng/tiếp tục.\nDưới tin bài có nút bình luận và lấy top affiliate.',
  tiktok:'🎵 TIKTOK AFFILIATE\n/tiktok status — cấu hình; /tiktok check — kiểm tra Creator.\n/tiktok LINK1 LINK2 — tạo link sản phẩm.\n/tiktoktop 5 [rate|amount] [từ khóa] — xem top.\n/tiktoktopcomment ID_nguồn ID_bài 5 [rate|amount] [từ khóa] — lấy top và bình luận lên Facebook.\n/tiktoklinks [trang] — link đã lưu.\n/tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2 — bình luận link chọn trước.\n\nTỰ ĐỘNG THEO TỪ KHÓA FACEBOOK\n/groupkeywords ID từ khóa bài Facebook\n/tiktokauto ID 5 rate từ khóa sản phẩm\n/tiktokauto ID off — tắt, hủy phần tự động chờ.\nSố link từ 1–20. rate: %; amount: tiền hoa hồng. Chỉ bài mới sau lúc bật có ngày, qua bộ lọc. Không tìm hoặc bình luận video trên TikTok.\nCần Creator API + quyền Share Link/publisher phù hợp; cấu hình trong .env. Top trong tối đa 200 sản phẩm VN/VND đọc được.',
  facebook:'📘 AFFILIATE TRÊN FACEBOOK\nĐăng link affiliate Shopee/TikTok lên bài nhóm, trang cá nhân và reel Facebook đã lưu.\n\nThủ công: nút “Bình luận top Shopee” / “Bình luận top TikTok” dưới bài → chọn số link.\nTự động TikTok: /groupkeywords ID từ khóa bài Facebook rồi /tiktokauto ID 5 rate từ khóa sản phẩm.\n/commentlist ID ID_bài | mỗi dòng một link — danh sách tự nhập.\n/comments — trạng thái; /cancelcomments ID — hủy phần chờ; /tiktokauto ID off — tắt tự động.\nNguồn đang tạm dừng sẽ chờ /resume ID.',
  affiliate:'🛍 SHOPEE AFFILIATE\n\n/affiliatetop 5 — xem top 5 theo tỷ lệ hoa hồng %.\n/affiliatetop 5 amount — xem top theo tiền hoa hồng ước tính. Có thể thêm từ khóa sản phẩm ở cuối.\n/affiliatetopcomment ID_nguồn ID_bài 5 [rate|amount] [từ khóa] — tự tìm top mới rồi bình luận 5 link, mỗi link một bình luận. Chọn số từ 1–20.\nHoặc bấm “Bình luận top Shopee” dưới tin bài, rồi chọn số link.\nXếp hạng trong tối đa 250 kết quả đọc được bằng tài khoản API của bạn; không bảo đảm cao nhất toàn sàn.\n\n/affiliate status — trạng thái cấu hình tài khoản.\n/affiliate shopee LINK1 LINK2 — chuyển link bạn nhập.\n/affiliatelinks [trang] — link đã tạo và ID link.\n/affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2 — bình luận link đã chọn.\n\nLệnh xem top/chuyển link chưa đăng bình luận. Khóa API cấu hình trong .env trên máy chạy bot, gắn với ID Telegram của bạn. TikTok Affiliate: /tiktok.',
  add:'➕ THÊM NGUỒN\n\nNhóm: /add LINK1 LINK2\nHoặc gửi file .txt/.csv chứa link nhóm.\nNhóm đã tham gia: /joined → /select 1,2 hoặc /select all.\n\nTrang cá nhân: /profile LINK1 LINK2 all\nTách nhiều link bằng xuống dòng, khoảng trắng hoặc dấu phẩy. Đổi all thành posts (bài viết) hoặc reels.\n\nNhóm thêm bằng /add tạo mốc cũ ở lần đầu. Trang cá nhân và nhóm chọn từ /joined nhận đợt bài đầu phù hợp bộ lọc.',
  posts:'🔎 QUÉT & XEM BÀI\n\n/sources — chọn nguồn rồi bấm “Quét lại” hoặc “Xem bài”.\n/posts ID [trang] — bài/reel của một nguồn.\n/posts all [trang] — bài từ tất cả nguồn.\n/list — cấu hình chi tiết mọi nguồn.\n\nBot quét định kỳ khi nguồn đang chạy. “Quét lại” đưa nguồn vào lượt quét tiếp theo; không bảo đảm lấy đủ lịch sử. Dùng bộ lọc ngày để lấy bài cũ trong khoảng cần tìm.',
  filters:'⚙️ BỘ LỌC & CÀI ĐẶT\n\n/sources — chọn nguồn để chỉnh bằng nút: từ khóa, ngày, tự bình luận và loại nội dung trang cá nhân.\n/keywords từ 1; từ 2 — từ khóa mặc định.\n/groupkeywords ID|all từ 1; từ 2 — từ khóa riêng.\nDùng off để nhận tất cả; nút “Dùng từ khóa mặc định” bỏ bộ lọc riêng.\n/daterange ID|all DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]]\n/daterange ID off — bỏ lọc ngày.\n\nKhớp ít nhất một từ khóa, không phân biệt dấu/chữ hoa. Ngày dùng giờ Việt Nam; bài không rõ ngày bị bỏ qua khi lọc ngày.\n/pause ID|all · /resume ID|all · /remove ID',
  comments:'💬 BÌNH LUẬN & LINK\n\nDưới tin bài: bấm “Bình luận” để nhập một nội dung; “Danh sách bình luận” để nhập mỗi dòng một nội dung/link. Reply tin bài trực tiếp cũng gửi một bình luận.\n\n/comment ID ID_bài | nội dung\n/comment ID ID_bài1,ID_bài2 | nội dung\n/comment ID all | nội dung\n/comment all | nội dung — mọi nguồn.\n\n/commentlist ID ID_bài |\nlink_1\nlink_2\nNhập 5 dòng khác nhau để xếp 5 bình luận riêng, giữ nguyên link affiliate.\n\n/autoreply ID|all nội dung — bật cho bài mới phù hợp sau thời điểm bật. Dùng off để tắt.\n/comments — trạng thái 20 bình luận gần nhất.\n/cancelcomments ID|all — hủy phần đang chờ.\n\nGửi lần lượt, cách nhau ít nhất 30 giây; bỏ qua nội dung trùng. Bài/reel phải đã được lưu. Nguồn tạm dừng chưa gửi bình luận.',
  status:'📊 TRẠNG THÁI\n\n/status — tổng số nguồn, bài, thông báo chờ và lỗi quét.\n/comments — kết quả gửi bình luận.\n/sources — xem và chỉnh từng nguồn.\n/whoami — ID Telegram để quản trị viên cấp quyền.\n\nPhiên Facebook được cấu hình trên máy chạy bot. Không gửi mật khẩu/cookie qua Telegram. Khi mất quyền xem hoặc phiên hết hạn, kiểm tra đăng nhập trên máy chạy bot.',
  help:'❓ HƯỚNG DẪN TỔNG QUAN\n/menu — mở menu chính\n/sources — quản lý danh sách nguồn\n/posts — xem bài đã lưu\n/add LINK — thêm nhóm\n/profile LINK all — thêm trang cá nhân\n/affiliate — Shopee Affiliate\n/tiktok — TikTok Affiliate\n/comments — trạng thái bình luận\n/status — trạng thái hệ thống\n/keyboard — bật lại bàn phím menu',
};

export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 Nguồn theo dõi' }, { text: '📄 Bài viết đã lưu' }],
    [{ text: '🛍 Shopee Affiliate' }, { text: '🎵 TikTok Affiliate' }],
    [{ text: '💬 Bình luận' }, { text: '⚙️ Bộ lọc & Cài đặt' }],
    [{ text: '📊 Trạng thái' }, { text: '❓ Hướng dẫn' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: 'Chọn chức năng bên dưới…',
};

export function installNavigation(bot,store) {
  const prompts = new Map();
  const key = (ctx,id) => `${ctx.from.id}:${ctx.chat.id}:${id}`;
  const reply = (ctx,text,markup=HOME) => ctx.reply(text,{reply_markup:markup,link_preview_options:{is_disabled:true}});
  const home = ctx => reply(ctx,'🏠 MENU CHÍNH\nChọn chức năng trên bàn phím bên dưới ô nhập tin nhắn.\nGửi /menu để mở lại bất cứ lúc nào.', MAIN_KEYBOARD);
  async function sources(ctx,page=1,type=null) {
    const all=store.listGroups(ctx.from.id).filter(g=>!type || (g.sourceType || 'group')===type), items=all.slice((page-1)*8,page*8);
    if(!items.length) return reply(ctx,all.length ? 'Trang danh sách không tồn tại. Dùng /sources để về đầu.' : 'Chưa có nguồn. Chọn “Thêm nguồn” để bắt đầu.');
    const rows=items.map(g=>[button(`${g.paused?'⏸':'▶️'} #${g.id} ${(g.label || g.url).slice(0,45)}`,`source:open:${g.id}`)]);
    const paging=[];
    const route=type==='group'?'groupsources':type==='profile'?'profilesources':'sources';
    if(page>1) paging.push(button('← Trước',`nav:${route}:${page-1}`));
    if(page*8<all.length) paging.push(button('Tiếp →',`nav:${route}:${page+1}`));
    if(paging.length) rows.push(paging);
    rows.push([button('🏠 Menu','nav:home')]);
    return reply(ctx,`NGUỒN THEO DÕI · ${all.length} nguồn · trang ${page}/${Math.ceil(all.length/8)}\nChọn một nguồn để xem bài và tùy chỉnh.`,{inline_keyboard:rows});
  }
  const own = (ctx,id) => store.listGroups(ctx.from.id).find(g=>g.id===id);
  async function detail(ctx,id) {
    const g=own(ctx,id);
    if(!g) return reply(ctx,'Không tìm thấy nguồn của bạn.');
    const keywords=g.keywords ?? store.getKeywords(ctx.from.id);
    const rows=[
      [button('📄 Xem bài',`source:posts:${id}`),button('🔄 Quét lại',`source:scan:${id}`)],
      [button(g.paused?'▶️ Tiếp tục':'⏸ Tạm dừng',`source:${g.paused?'resume':'pause'}:${id}`)],
      [button('🔤 Từ khóa',`source:keywords:${id}`),button('📅 Khoảng ngày',`source:dates:${id}`)],
      [button('Dùng từ khóa mặc định',`source:defaults:${id}`)],
      [button('💬 Tự bình luận',`source:auto:${id}`)],
      [button('🎵 TikTok tự động',`source:tiktok:${id}`),button('Tắt TikTok tự động',`source:tiktokoff:${id}`)],
    ];
    if(g.sourceType==='profile') rows.push([button('Bài viết',`source:postsOnly:${id}`),button('Reel',`source:reelsOnly:${id}`),button('Cả hai',`source:both:${id}`)]);
    rows.push([button('📋 Các nguồn','nav:sources:1'),button('🏠 Menu','nav:home')]);
    return reply(ctx,`NGUỒN #${id} · ${g.paused?'Tạm dừng':'Đang theo dõi'}\n${g.label || g.url}\n${g.url}\nLoại: ${g.sourceType==='profile'?`Trang cá nhân · ${g.contentType==='posts'?'bài viết':g.contentType==='reels'?'reel':'bài viết và reel'}`:'Nhóm'}\nTừ khóa ${g.keywords===null?'mặc định':'riêng'}: ${(keywords.join('; ') || 'tất cả').slice(0,600)}\nNgày: ${formatDateRange(g.dateRange)}\nTự bình luận: ${(g.autoReply || 'tắt').slice(0,600)}\nTikTok tự động: ${g.tiktokAuto?`${g.tiktokAuto.count} link/bài · ${g.tiktokAuto.rank}`:'tắt'}\n${g.lastError ? `Lỗi: ${g.lastError.slice(0,300)}\n`:''}Xóa nguồn: /remove ${id}\nHủy bình luận chờ: /cancelcomments ${id}`,{inline_keyboard:rows});
  }
  bot.command(['menu', 'start', 'keyboard', 'banphim'], home);

  // Xử lý 8 nút trên bàn phím menu cố định 2 cột
  bot.hears(/^(?:📋\s*)?Nguồn theo dõi$/i, ctx => sources(ctx, 1));
  bot.hears(/^(?:📄\s*)?Bài viết đã lưu$/i, async ctx => {
    const posts = store.listAllPosts(ctx.from.id, 0);
    if (!posts.length) {
      return reply(ctx, 'Chưa có bài viết nào được lưu.\n\n• Thêm nhóm: /add LINK\n• Thêm trang cá nhân: /profile LINK all\n• Nhóm đã tham gia: /joined');
    }
    const lines = [
      `📄 BÀI VIẾT ĐÃ LƯU GẦN NHẤT · ${posts.length} bài\n`,
      ...posts.slice(0, 5).map(p => `• Bài #${p.id} (nguồn #${p.group_id || '?'})\n  ${p.url}\n  ${(p.text || '[Bài/reel đính kèm]').slice(0, 100)}\n  👉 Bình luận: /comment ${p.group_id} ${p.id} | nội dung\n`),
      posts.length > 5 ? 'Xem tiếp: /posts all 2 · Xem theo nguồn: /posts ID_nguồn' : 'Xem theo nguồn: /posts ID_nguồn',
    ];
    return reply(ctx, lines.join('\n'), {
      inline_keyboard: [
        [button('📋 Danh sách nguồn', 'nav:sources:1')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:🛍\s*)?Shopee Affiliate$/i, async ctx => {
    return reply(ctx, GUIDES.affiliate, {
      inline_keyboard: [
        [button('🔥 Xem top hoa hồng', 'nav:affiliates')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:🎵\s*)?TikTok Affiliate$/i, async ctx => {
    return reply(ctx, GUIDES.tiktok, {
      inline_keyboard: [
        [button('📘 Affiliate trên Facebook', 'nav:facebook')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:💬\s*)?Bình luận$/i, async ctx => {
    const states = { pending: 'đang chờ', sending: 'đang gửi', sent: 'đã đăng', failed: 'chưa gửi được', uncertain: 'chưa xác nhận', cancelled: 'đã hủy' };
    const items = store.listComments(ctx.from.id);
    if (items.length) {
      const lines = [
        `💬 TRẠNG THÁI BÌNH LUẬN GẦN ĐÂY\n`,
        ...items.slice(0, 5).map(item => `#${item.id} · nguồn #${item.group_id} · bài ${item.post_id}: ${states[item.state] || item.state}\n${(item.body || '').slice(0, 80)}${item.error ? `\nLỗi: ${(item.error || '').slice(0, 100)}` : ''}\n`),
        '• Xem tất cả: /comments',
        '• Hủy bình luận chờ: /cancelcomments',
        '• Gửi bình luận: /comment ID_nguồn ID_bài | nội dung',
      ];
      return reply(ctx, lines.join('\n'), {
        inline_keyboard: [
          [button('📋 Danh sách nguồn', 'nav:sources:1')],
          [button('🏠 Menu', 'nav:home')],
        ],
      });
    }
    return reply(ctx, GUIDES.comments, {
      inline_keyboard: [
        [button('📋 Danh sách nguồn', 'nav:sources:1')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:⚙️\s*)?Bộ lọc & Cài đặt$/i, async ctx => {
    return reply(ctx, GUIDES.filters, {
      inline_keyboard: [
        [button('📋 Chọn nguồn cài đặt', 'nav:sources:1')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:📊\s*)?Trạng thái$/i, async ctx => {
    const status = store.status(ctx.from.id);
    const errors = store.listGroups(ctx.from.id).filter(g => g.lastError);
    return reply(ctx, `📊 TRẠNG THÁI HỆ THỐNG\n\nNguồn theo dõi: ${status.groups} · đang chạy: ${status.active}\nBài/reel đã lưu: ${status.posts}\nThông báo chờ gửi: ${status.pending}\nNguồn có lỗi: ${errors.length}\n${errors.slice(0, 5).map(g => `#${g.id}: ${g.lastError.slice(0, 200)}`).join('\n')}\n\n• /comments — chi tiết bình luận\n• /whoami — ID Telegram của bạn`, {
      inline_keyboard: [
        [button('📋 Quản lý nguồn', 'nav:sources:1')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });
  bot.hears(/^(?:❓\s*)?Hướng dẫn$/i, async ctx => {
    return reply(ctx, '❓ HƯỚNG DẪN & CÁC TÍNH NĂNG\n\nChọn một chủ đề bên dưới để xem hướng dẫn chi tiết:', {
      inline_keyboard: [
        [button('1. Thu thập bài viết trong các nhóm', 'nav:groups')],
        [button('2. Affiliate TikTok · Facebook · Shopee', 'nav:affiliates')],
        [button('3. Thu thập bài viết & reel từ trang cá nhân', 'nav:profiles')],
        [button('⚙️ Bộ lọc & cài đặt', 'nav:filters'), button('📊 Trạng thái', 'nav:status')],
        [button('🏠 Menu', 'nav:home')],
      ],
    });
  });

  bot.command('help',ctx=>{
    const topic=String(ctx.match || '').trim();
    return topic==='all' ? (async()=>{for(const text of Object.values(GUIDES)) await reply(ctx,text);})() : GUIDES[topic] ? reply(ctx,GUIDES[topic]) : home(ctx);
  });
  bot.command('sources',ctx=>sources(ctx));
  bot.command('settings',ctx=>{
    const arg=String(ctx.match || '').trim();
    return /^[1-9]\d*$/.test(arg) ? detail(ctx,Number(arg)) : sources(ctx);
  });
  bot.callbackQuery(/^nav:(home|help|add|posts|filters|comments|status|affiliate|affiliates|tiktok|facebook|groups|profiles|(?:sources|groupsources|profilesources)(?::\d+)?)$/,async ctx=>{
    await ctx.answerCallbackQuery();
    const [,topic,page]=ctx.callbackQuery.data.split(':');
    if(topic==='home') return home(ctx);
    if(topic==='help') return reply(ctx,GUIDES.help || '❓ HƯỚNG DẪN SỬ DỤNG BOT',{inline_keyboard:[
      [button('1. Thu thập bài viết trong các nhóm','nav:groups')],
      [button('2. Affiliate TikTok · Facebook · Shopee','nav:affiliates')],
      [button('3. Quét trang cá nhân & Reels','nav:profiles')],
      [button('⚙️ Bộ lọc & cài đặt','nav:filters'),button('📊 Trạng thái','nav:status')],
      [button('🏠 Menu','nav:home')],
    ]});
    if(topic==='sources') return sources(ctx,Number(page || 1));
    if(topic==='groupsources' || topic==='profilesources') return sources(ctx,Number(page || 1),topic==='groupsources'?'group':'profile');
    if(topic==='groups' || topic==='profiles') return reply(ctx,GUIDES[topic],{inline_keyboard:[
      [button('📋 Nguồn đã thêm',`nav:${topic==='groups'?'groupsources':'profilesources'}:1`)],
      [button('🔎 Xem bài & quét','nav:posts'),button('⚙️ Bộ lọc','nav:filters')],
      [button('🏠 Menu','nav:home')],
    ]});
    if(topic==='affiliates') return reply(ctx,'2. AFFILIATE\nChọn nền tảng. “Facebook” quản lý đăng link Shopee/TikTok lên Facebook.',{inline_keyboard:[
      [button('🎵 TikTok Affiliate','nav:tiktok')],
      [button('📘 Affiliate trên Facebook','nav:facebook')],
      [button('🛍 Shopee Affiliate','nav:affiliate')],
      [button('🏠 Menu','nav:home')],
    ]});
    if(topic==='status') {
      const status=store.status(ctx.from.id);
      const errors=store.listGroups(ctx.from.id).filter(g=>g.lastError);
      return reply(ctx,`📊 TRẠNG THÁI\nNguồn: ${status.groups} · đang chạy: ${status.active}\nBài/reel đã lưu: ${status.posts}\nThông báo chờ: ${status.pending}\nNguồn có lỗi: ${errors.length}\n${errors.slice(0,5).map(g=>`#${g.id}: ${g.lastError.slice(0,200)}`).join('\n')}\n/comments — trạng thái bình luận\n/whoami — ID Telegram`);
    }
    return reply(ctx,GUIDES[topic]);
  });
  bot.callbackQuery(/^source:(open|posts|scan|pause|resume|keywords|dates|defaults|auto|tiktok|tiktokoff|postsOnly|reelsOnly|both):(\d+)$/,async ctx=>{
    const [,action,raw]=ctx.callbackQuery.data.split(':'), id=Number(raw), g=own(ctx,id);
    if(!g) return ctx.answerCallbackQuery({text:'Không tìm thấy nguồn của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    if(action==='tiktok') return reply(ctx,`TikTok tự động nguồn #${id}: ${g.tiktokAuto?`${g.tiktokAuto.count} link/bài · ${g.tiktokAuto.rank} · sản phẩm: ${g.tiktokAuto.keyword || 'tất cả'}`:'tắt'}\nĐặt từ khóa Facebook: /groupkeywords ${id} từ khóa\nBật: /tiktokauto ${id} 5 rate từ khóa sản phẩm\nTắt: /tiktokauto ${id} off\nChỉ bài mới có ngày đăng sau khi bật và phù hợp bộ lọc.`);
    if(action==='tiktokoff') store.setTikTokAuto(ctx.from.id,id,null,null);
    if(action==='posts') {
      const posts=store.listPosts(ctx.from.id,id,0);
      // Show links and commands without truncating IDs or losing the source.
      if(!posts.length) return reply(ctx,`Chưa có bài đã lưu. Bấm “Quét lại” trong /settings ${id}.`);
      for(let i=0;i<posts.length;i+=5) await reply(ctx,posts.slice(i,i+5).map(p=>`${p.id} · ${(p.text || '[Bài/reel đính kèm]').slice(0,100)}\n${p.url}\n/comment ${id} ${p.id} | nội dung\n/commentlist ${id} ${p.id} | mỗi dòng một link`).join('\n\n')+`\n\nTrang tiếp theo: /posts ${id} 2`);
      return;
    }
    if(action==='scan') {
      store.requestScan(ctx.from.id,id);
      await reply(ctx,g.paused?'Đã ghi nhận yêu cầu quét. Bấm “Tiếp tục” để nguồn hoạt động.':'Đã đưa nguồn vào lượt quét tiếp theo.');
    }
    if(action==='pause' || action==='resume') store.setPaused(ctx.from.id,id,action==='pause');
    if(action==='defaults') store.setKeywords(ctx.from.id,id,null);
    if(['postsOnly','reelsOnly','both'].includes(action)) {
      if(g.sourceType!=='profile') return reply(ctx,'Tùy chọn này chỉ dành cho trang cá nhân.');
      store.addProfile(ctx.from.id,g.url,{postsOnly:'posts',reelsOnly:'reels',both:'all'}[action]);
    }
    if(['keywords','dates','auto'].includes(action)) {
      const hints={keywords:'Nhập từ khóa, cách nhau bằng dấu ;. Nhập off để nhận tất cả.',dates:'Nhập DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]], hoặc off để bỏ lọc ngày.',auto:'Nhập nội dung tự bình luận cho bài mới, hoặc off để tắt. Nội dung này sẽ được đăng lên Facebook khi có bài mới phù hợp.'};
      for(const [k,v] of prompts) if(v.until<Date.now()) prompts.delete(k);
      const message=await ctx.reply(`Cài đặt nguồn #${id}\n${hints[action]}\nTrả lời tin này để lưu; /cancel để hủy.`,{reply_markup:{force_reply:true}});
      prompts.set(key(ctx,message.message_id),{id,action,until:Date.now()+30*60000});
      return;
    }
    return detail(ctx,id);
  });
  bot.command('cancel',async ctx=>{
    for(const k of prompts.keys()) if(k.startsWith(`${ctx.from.id}:${ctx.chat.id}:`)) prompts.delete(k);
    return reply(ctx,'Đã hủy phiên nhập cài đặt. Bình luận đã xếp hàng vẫn giữ nguyên; dùng /cancelcomments để hủy phần chờ.');
  });
  bot.use(async(ctx,next)=>{
    const id=ctx.msg?.reply_to_message?.message_id;
    if(!id) return next();
    const k=key(ctx,id), pending=prompts.get(k);
    if(!pending) return next();
    if(ctx.msg.text?.startsWith('/')) return next();
    if(pending.until<Date.now() || !own(ctx,pending.id)) {prompts.delete(k);return reply(ctx,'Phiên nhập đã hết hạn hoặc nguồn đã bị xóa. Mở lại /settings.');}
    if(!ctx.msg.text) return reply(ctx,'Hãy trả lời bằng văn bản vào tin yêu cầu cài đặt.');
    try {
      const text=ctx.msg.text.trim();
      if(pending.action==='keywords') store.setKeywords(ctx.from.id,pending.id,parseKeywords(text));
      if(pending.action==='dates') store.setDateRange(ctx.from.id,pending.id,parseDateRange(text));
      if(pending.action==='auto') store.setAutoReply(ctx.from.id,pending.id,text.toLowerCase()==='off'?null:commentText(text));
      prompts.delete(k);
      await reply(ctx,'Đã lưu cài đặt.');
      return detail(ctx,pending.id);
    } catch(error) {return reply(ctx,`${error.message}\nTrả lời lại tin yêu cầu cài đặt để sửa.`);}
  });
}
