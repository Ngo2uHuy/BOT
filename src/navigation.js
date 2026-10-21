import { parseKeywords, normalizeSearchText } from './input.js';
import { parseDateRange, formatDateRange } from './dates.js';
import { commentText } from './comments.js';
import { directMessageText } from './direct-messages.js';
import { listPager, listQuery, listUsage, hotItems, pageInfo } from './listing.js';

const button = (text, callback_data) => ({text,callback_data});
const HOME = {inline_keyboard:[
  [button('1. Nhóm Facebook','nav:groups'), button('2. Affiliate','nav:affiliates')],
  [button('3. Trang cá nhân','nav:profiles'), button('4. Bài viết đã lưu','nav:posts')],
  [button('💬 Bình luận','nav:comments'), button('⚙️ Cấu hình & bộ lọc','nav:filters')],
  [button('📊 Trạng thái','nav:status'), button('❓ Hướng dẫn','nav:help')],
]};
const GUIDES = {
  testfilter:'🧪 THỬ ACCEPT/REJECT\n/testfilter default | nội dung bài\n/testfilter ID | nội dung bài — dùng bộ lọc hiệu lực của nguồn.\nHoặc trả lời tin nhắn bằng /testfilter hay /testfilter ID.\nHiển thị từ khóa Accept/Reject khớp và lý do nhận/loại. Reject được ưu tiên. Giữ dấu, không phân biệt hoa/thường. Chỉ kiểm tra, không gửi bình luận.',
  groups:'1. THU THẬP BÀI VIẾT TRONG NHÓM\n/add LINK1 LINK2 — thêm nhóm hoặc gửi file .txt/.csv.\n/joined [trang|refresh] [status:new|added] [từ khóa] → /select 1,2 — chọn nhóm đã tham gia.\n/search tên, link hoặc ID — kiểm tra nhóm đã được thêm chưa.\n/groupkeywords ID từ khóa — lọc bài cần thu thập.\n/daterange ID ngày_đầu [ngày_cuối] — lọc thời gian.\n/posts ID — xem bài; /settings ID — cài đặt/quét lại.\nBot theo dõi các nhóm đã thêm mà tài khoản có quyền xem, không tìm toàn bộ Facebook.',
  profiles:'3. BÀI VIẾT & REEL TRANG CÁ NHÂN\n/profile LINK1 LINK2 all — thêm nhiều trang.\nThay all bằng posts hoặc reels để quét riêng.\n/groupkeywords ID từ khóa — lọc nội dung.\n/posts ID — xem kết quả; /settings ID — cài đặt, quét lại, tạm dừng/tiếp tục.\nDưới tin bài có nút bình luận và lấy top affiliate.',
  tiktok:'🎵 TIKTOK AFFILIATE\n/tiktok status — cấu hình; /tiktok check — kiểm tra Creator.\n/tiktok LINK1 LINK2 — tạo link sản phẩm.\n/tiktoktop 5 [rate|amount] [từ khóa] — xem top.\n/tiktoktopcomment ID_nguồn ID_bài 5 [rate|amount] [từ khóa] — lấy top và bình luận lên Facebook.\n/tiktoklinks [trang] [sort:updated|id|origin[-]] [từ khóa] — link đã lưu.\n/tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2 — bình luận link chọn trước.\n\nTỰ ĐỘNG THEO TỪ KHÓA FACEBOOK\n/groupkeywords ID từ khóa bài Facebook\n/tiktokauto ID 5 rate từ khóa sản phẩm\n/tiktokauto ID off — tắt, hủy phần tự động chờ.\nSố link từ 1–20. rate: %; amount: tiền hoa hồng. Chỉ bài mới sau lúc bật có ngày, qua bộ lọc. Không tìm hoặc bình luận video trên TikTok.\nCần Creator API + quyền Share Link/publisher phù hợp; cấu hình trong .env. Top trong tối đa 200 sản phẩm VN/VND đọc được.',
  facebook:'📘 AFFILIATE TRÊN FACEBOOK\nĐăng link affiliate Shopee/TikTok lên bài nhóm, trang cá nhân và reel Facebook đã lưu.\n\nThủ công: nút “Bình luận top Shopee” / “Bình luận top TikTok” dưới bài → chọn số link.\nTự động TikTok: /groupkeywords ID từ khóa bài Facebook rồi /tiktokauto ID 5 rate từ khóa sản phẩm.\n/commentlist ID ID_bài | mỗi dòng một link — danh sách tự nhập.\n/comments — trạng thái; /cancelcomments ID — hủy phần chờ; /tiktokauto ID off — tắt tự động.\nNguồn đang tạm dừng sẽ chờ /resume ID.',
  affiliate:'🛍 SHOPEE AFFILIATE\n\n/affiliatetop 5 — xem top 5 theo tỷ lệ hoa hồng %.\n/affiliatetop 5 amount — xem top theo tiền hoa hồng ước tính. Có thể thêm từ khóa sản phẩm ở cuối.\n/affiliatetopcomment ID_nguồn ID_bài 5 [rate|amount] [từ khóa] — tự tìm top mới rồi bình luận 5 link, mỗi link một bình luận. Chọn số từ 1–20.\nHoặc bấm “Bình luận top Shopee” dưới tin bài, rồi chọn số link.\nXếp hạng trong tối đa 250 kết quả đọc được bằng tài khoản API của bạn; không bảo đảm cao nhất toàn sàn.\n\n/affiliate status — trạng thái cấu hình tài khoản.\n/affiliate shopee LINK1 LINK2 — chuyển link bạn nhập.\n/affiliatelinks [trang] [sort:updated|id|origin[-]] [từ khóa] — link đã tạo và ID link.\n/affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2 — bình luận link đã chọn.\n\nLệnh xem top/chuyển link chưa đăng bình luận. Khóa API cấu hình trong .env trên máy chạy bot, gắn với ID Telegram của bạn. TikTok Affiliate: /tiktok.',
  add:'➕ THÊM NGUỒN\n\nNhóm: /add LINK1 LINK2\nHoặc gửi file .txt/.csv chứa link nhóm.\nNhóm đã tham gia: /joined → /select 1,2 hoặc /select all.\n\nTrang cá nhân: /profile LINK1 LINK2 all\nTách nhiều link bằng xuống dòng, khoảng trắng hoặc dấu phẩy. Đổi all thành posts (bài viết) hoặc reels.\n\nNhóm thêm bằng /add tạo mốc cũ ở lần đầu. Trang cá nhân và nhóm chọn từ /joined nhận đợt bài đầu phù hợp bộ lọc.',
  posts:'🔎 QUÉT & XEM BÀI\n\n/sources — chọn nguồn rồi bấm “Quét lại” hoặc “Xem bài”.\n/posts ID [trang] [kind:post|reel] [sort:seen|published|author[-]] [từ khóa] — bài/reel của một nguồn.\n/posts all [trang] [source:ID] [type:group|profile] … — bài từ tất cả nguồn.\n/list [trang] [type:group|profile] [status:active|paused|error] [auto:on|off] [từ khóa] — cấu hình chi tiết từng nguồn.\n/hot [số lượng] [page:N] [sort:rank|total|missed|interval|scan|name[-]] [từ khóa] — nguồn sôi động và chu kỳ quét lại.\nCú pháp lọc chung: /help lists.\n\nBot quét định kỳ khi nguồn đang chạy. “Quét lại” đưa nguồn vào lượt quét tiếp theo; không bảo đảm lấy đủ lịch sử. Dùng bộ lọc ngày để lấy bài cũ trong khoảng cần tìm.',
  filters:'⚙️ BỘ LỌC & CÀI ĐẶT\n\n/config [ID] — xem thông tin cấu hình hiện tại (từ khóa accept, reject, bộ lọc...).\n/sources — chọn nguồn để chỉnh bằng nút: từ khóa, ngày, tự bình luận và loại nội dung trang cá nhân.\n/keywords từ 1; từ 2 — từ khóa nhận (Accept) mặc định.\n/accept từ 1; từ 2 — tương đương /keywords.\n/reject từ 1; từ 2 — từ khóa loại trừ (Reject) mặc định.\n/groupkeywords ID|all từ 1; từ 2 — từ khóa nhận riêng cho nguồn.\n/groupaccept ID|all từ 1; từ 2 — tương đương /groupkeywords.\n/groupreject ID|all từ 1; từ 2 — từ khóa loại trừ riêng cho nguồn.\nDùng off để xóa bộ lọc; default để dùng mặc định; nút “Dùng từ khóa mặc định” bỏ bộ lọc riêng.\n/daterange ID|all DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]]\n/daterange ID|all now — đặt mốc từ thời điểm hiện tại đến tương lai.\n/daterange ID off — bỏ lọc ngày.\n\nKhi khởi động hệ thống, bộ lọc ngày tự động bắt đầu từ thời gian hiện tại đến tương lai (mới nhất). Khớp ít nhất một từ khóa accept và loại bỏ bài chứa bất kỳ từ khóa reject nào. Ngày dùng giờ Việt Nam; bài không rõ ngày bị bỏ qua khi lọc ngày.\n/pause ID|all · /resume ID|all · /remove ID\n/rejected on|off — nhận tin bài bị loại theo từ khóa (chỉ bài thấy từ lúc bật).',
  comments:'💬 BÌNH LUẬN & TIN NHẮN RIÊNG & KẾT BẠN\n\nDưới tin bài: bấm “Bình luận” để nhập một nội dung; “Danh sách bình luận” để nhập mỗi dòng một nội dung/link; bấm “Nhắn tin riêng” để gửi tin nhắn Messenger cho người đăng; bấm “🤝 Kết bạn” để gửi lời mời kết bạn.\n\n/comment ID ID_bài | nội dung\n/comment ID ID_bài1,ID_bài2 | nội dung\n/comment ID all | nội dung\n/comment all | nội dung — mọi nguồn.\n\n/commentlist ID ID_bài |\nlink_1\nlink_2\nNhập 5 dòng khác nhau để xếp 5 bình luận riêng, giữ nguyên link affiliate.\n\n/autoreply ID|all nội dung — bật cho bài mới phù hợp sau thời điểm bật. Dùng off để tắt.\n/comments [trang] [state:pending|sent|failed…] [source:ID] [mode:manual|auto|tiktok] [sort:id|time|state|source[-]] [từ khóa] — trạng thái bình luận.\n/cancelcomments ID|all — hủy phần đang chờ.\n\n📩 NHẮN TIN RIÊNG (INBOX):\n/autoinbox ID|all nội dung — tự động nhắn tin cho người đăng bài mới ({name}=tên, {link}=link bài). Tắt: /autoinbox ID off.\n/inbox ID ID_bài | nội dung — gửi tin riêng thủ công cho người đăng.\n/inboxes [trang] [state:…] [source:ID] [mode:manual|auto] [từ khóa] — tin nhắn riêng.\n/cancelinbox ID|all — hủy tin nhắn riêng đang chờ.\n\n🤝 KẾT BẠN (FRIEND REQUEST):\n/autofriend ID|all on/off — tự động kết bạn với người đăng bài mới phù hợp bộ lọc.\n/autoblock ID|all on/off — rà soát bài accept đã lưu và mới phát hiện, chặn người comment trừ người đăng/bot (chỉ quét một lần cho mỗi bài).\n/blocks [trang] [state:pending|running|done|failed…] [mode:manual|auto] [từ khóa] — lượt chặn người comment: vị trí hàng đợi, lý do chờ và giờ dự kiến.\n/cancelblocks ID_nguồn|all — hủy lượt chặn đang chờ/đang chạy (không tắt /autoblock).\n/friend ID ID_bài — gửi lời mời kết bạn thủ công (hoặc reply tin bài rồi gõ /friend).\n/friends [trang] [state:…] [source:ID] [từ khóa] — lời mời kết bạn.\n/cancelfriend ID|all — hủy lời mời kết bạn đang chờ.\n\n📇 LIÊN HỆ TỪ BÌNH LUẬN:\n/contacts LINK_BÀI_HOẶC_VIDEO — lấy SĐT/email có trong bình luận của bài.\n\nGiãn cách an toàn 5–10 phút/lần để bảo vệ tài khoản Facebook. Gửi lần lượt; bài/reel phải đã được lưu. Nguồn tạm dừng chưa gửi thao tác.',
  status:'📊 TRẠNG THÁI\n\n/status — tổng số nguồn, bài, thông báo chờ, từ khóa mặc định và lỗi quét.\n/config — xem đầy đủ thông tin cấu hình hiện tại.\n/comments — kết quả gửi bình luận.\n/sources — xem và chỉnh từng nguồn.\n/whoami — ID Telegram để quản trị viên cấp quyền.\n\nPhiên Facebook được cấu hình trên máy chạy bot. Không gửi mật khẩu/cookie qua Telegram. Khi mất quyền xem hoặc phiên hết hạn, kiểm tra đăng nhập trên máy chạy bot.',
  lists:'📑 DANH SÁCH: TRANG, LỌC, SẮP XẾP, TÌM KIẾM\n/lệnh [trang] [khóa:giá_trị …] [sort:khóa[-]] [từ khóa tìm kiếm]\nVí dụ: /comments 2 state:failed sort:time- hết hàng\n• Số đứng đầu là trang; page:N cũng được.\n• Lọc theo lệnh: state:, source:ID, mode:manual|auto, kind:post|reel, type:group|profile, status:…, auto:on|off. Gõ sai, bot liệt kê giá trị hợp lệ.\n• sort:khóa tăng dần, sort:khóa- giảm dần.\n• Phần còn lại là từ khóa tìm (không phân biệt hoa/thường và dấu).\nÁp dụng: /comments /inboxes /friends /blocks /posts /list /sources /hot /affiliatelinks /tiktoklinks /joined; /config và /search có nút chuyển trang (/config dùng page:N vì số đứng đầu là ID nguồn). Kết quả ghi “Trang x/y · tổng z”; bấm ⏮ ◀️ ▶️ ⏭ để chuyển trang, giữ nguyên bộ lọc.\n\n🗑 XÓA TỪNG MỤC\nBấm 🗑 #ID dưới danh sách (có hỏi xác nhận) hoặc /delete comment|inbox|friend|block|link|source ID.\nMục đang chờ bị hủy và xóa; mục đã gửi/chưa xác nhận chỉ ẩn khỏi danh sách để chống gửi lặp, không gỡ được trên Facebook; mục đang gửi/lượt chặn đang chạy chưa xóa được.\nBài viết chỉ ẩn (bot vẫn nhớ bài nên không gửi lại): /delete post ID_nguồn ID_bài; xem bài ẩn: /posts all hidden:yes (nút ♻️ để bỏ ẩn) hoặc /unhide post ID_nguồn ID_bài. Bài bị loại: /delete rejected …, /unhide rejected ….',
  help:'❓ HƯỚNG DẪN TỔNG QUAN\n/menu — mở menu chính\n/config — xem thông tin cấu hình hiện tại\n/sources — quản lý danh sách nguồn\n/posts — xem bài đã lưu\n/add LINK — thêm nhóm\n/profile LINK all — thêm trang cá nhân\n/affiliate — Shopee Affiliate\n/tiktok — TikTok Affiliate\n/comments — trạng thái bình luận\n/status — trạng thái hệ thống\n/help lists — lọc, sắp xếp, tìm kiếm danh sách',
};

export function installNavigation(bot,store) {
  const prompts = new Map();
  const key = (ctx,id) => `${ctx.from.id}:${ctx.chat.id}:${id}`;
  const reply = (ctx,text,markup=HOME) => ctx.reply(text,{reply_markup:markup,link_preview_options:{is_disabled:true}});
  const home = ctx => reply(ctx,'🏠 MENU CHÍNH\nChọn chức năng bên dưới.\nGửi /menu để mở lại bất cứ lúc nào.', HOME);
  const pager=listPager(bot);
  const sourceButton=g=>[button(`${g.paused?'⏸':'▶️'} #${g.id} ${(g.label || g.url).slice(0,45)}`,`source:open:${g.id}`)];
  // Button menu over the same SQL page as /list; filters and search ride on the pager session.
  pager.define('sourcemenu',(ctx,query)=>{
    const result=store.pageGroups(ctx.from.id,query);
    return {result,title:'NGUỒN THEO DÕI',empty:'Chưa có nguồn. Chọn “Thêm nguồn” để bắt đầu.',lines:result.items.length ? ['Chọn một nguồn để xem bài và tùy chỉnh.'] : [],
      keyboard:result.items.map(sourceButton),after:[[button('🏠 Menu','nav:home')]]};
  },'sources');
  const sources=(ctx,page=1,type=null)=>pager.open(ctx,'sourcemenu',{...listQuery('sources',{page,pageSize:8,filters:{type}}),fixed:type ? ['type'] : []});
  // A pasted link may use the vanity slug or numeric ID while the stored URL uses the other, so compare both.
  async function search(ctx,query) {
    const raw=String(query || '').trim();
    if(!raw) return reply(ctx,'Cách dùng: /search tên nhóm, link nhóm hoặc ID nhóm.');
    // Punctuation-insensitive so "viec lam" also finds the slug "viec.lam.hn".
    const words=value=>normalizeSearchText(value).replace(/[^a-z0-9]+/g,' ').trim();
    const q=words(raw);
    const slug=raw.match(/\/groups\/([A-Za-z0-9._-]+)/)?.[1]?.toLowerCase() || raw.match(/[?&]id=(\d+)/)?.[1] || null;
    const found=store.listGroups(ctx.from.id).filter(g=>{
      const ids=[g.url.split('/')[4]?.toLowerCase(),g.numericId].filter(Boolean);
      if(slug) return ids.includes(slug);
      if(/^\d+$/.test(raw)) return ids.includes(raw) || String(g.id)===raw;
      return q && (words(g.label).includes(q) || words(g.url).includes(q));
    });
    if(!found.length) return reply(ctx,`❌ Chưa thêm nguồn nào khớp “${raw.slice(0,100)}”.\nThêm nhóm: /add LINK`);
    hotItems(store,ctx.from.id,0);
    return pager.open(ctx,'search',{...listQuery('search',{q:raw.slice(0,200)}),fixed:['q'],ids:found.map(g=>g.id)});
  }
  // Ranked like /hot; the matching sources are fixed when the search runs, the page buttons only move through them.
  pager.define('search',(ctx,query)=>{
    const ranked=hotItems(store,ctx.from.id),ranks=new Map(ranked.map(item=>[item.id,item]));
    const found=store.listGroups(ctx.from.id).filter(g=>query.ids.includes(g.id))
      .sort((a,b)=>(ranks.get(a.id)?.rank ?? Infinity)-(ranks.get(b.id)?.rank ?? Infinity) || a.id-b.id);
    const {offset,...result}=pageInfo(found.length,query),shown=found.slice(offset,offset+query.pageSize);
    return {result:{...result,items:shown},title:`✅ Đã thêm ${found.length} nguồn khớp “${query.q.slice(0,100)}”`,empty:'Nguồn không còn trong danh sách.',
      lines:shown.map(g=>{
        const activity=ranks.get(g.id);
        const rank=activity ? `Top ${activity.rank}/${ranked.length} · ${activity.useful} bài phù hợp / ${activity.total} bài`
          : g.paused ? 'Tạm dừng · không xếp hạng' : 'Chưa có dữ liệu xếp hạng';
        return `#${g.id} ${(g.label || g.url).slice(0,60)}\n${rank}\n`;
      }),
      footer:['Hạng trong tất cả nguồn đang theo dõi của bạn, theo bài phù hợp bộ lọc trong 48 giờ (như /hot), mỗi tác giả tối đa 2 bài. Cùng điểm xét tổng bài, rồi ID nguồn.\nChọn một nguồn để xem chi tiết.'],
      keyboard:shown.map(sourceButton),after:[[button('🏠 Menu','nav:home')]]};
  });
  const own = (ctx,id) => store.listGroups(ctx.from.id).find(g=>g.id===id);
  async function detail(ctx,id) {
    const g=own(ctx,id);
    if(!g) return reply(ctx,'Không tìm thấy nguồn của bạn.');
    const keywords=g.keywords ?? store.getKeywords(ctx.from.id);
    const rejectKeywords=g.rejectKeywords ?? (store.getRejectKeywords?.(ctx.from.id) ?? []);
    const rows=[
      [button('📄 Xem bài',`source:posts:${id}`),button('🔄 Quét lại',`source:scan:${id}`)],
      [button(g.paused?'▶️ Tiếp tục':'⏸ Tạm dừng',`source:${g.paused?'resume':'pause'}:${id}`)],
      [button('🔤 Từ khóa nhận',`source:keywords:${id}`),button('🚫 Từ khóa chặn',`source:reject:${id}`)],
      [button('📅 Khoảng ngày',`source:dates:${id}`),button('Dùng từ khóa mặc định',`source:defaults:${id}`)],
      [button('💬 Tự bình luận',`source:auto:${id}`),button('📩 Tự nhắn tin',`source:autoinbox:${id}`)],
      [button(g.autoFriend ? '🤝 Tắt tự kết bạn' : '🤝 Tự kết bạn',`source:autofriend:${id}`),button(g.autoBlock ? '🚫 Tắt tự chặn người comment' : '🚫 Tự chặn người comment',`source:autoblock:${id}`)],
      [button('🎵 TikTok tự động',`source:tiktok:${id}`),button('Tắt TikTok tự động',`source:tiktokoff:${id}`)],
    ];
    if(g.sourceType==='profile') rows.push([button('Bài viết',`source:postsOnly:${id}`),button('Reel',`source:reelsOnly:${id}`),button('Cả hai',`source:both:${id}`)]);
    rows.push([button('📋 Các nguồn','nav:sources:1'),button('🏠 Menu','nav:home')]);
    return reply(ctx,`NGUỒN #${id} · ${g.paused?'Tạm dừng':'Đang theo dõi'}\n${g.label || g.url}\n${g.url}\nLoại: ${g.sourceType==='profile'?`Trang cá nhân · ${g.contentType==='posts'?'bài viết':g.contentType==='reels'?'reel':'bài viết và reel'}`:'Nhóm'}\nTừ khóa nhận (Accept) ${g.keywords===null?'mặc định':'riêng'}: ${(keywords.join('; ') || 'tất cả').slice(0,500)}\nTừ khóa chặn (Reject) ${g.rejectKeywords===null?'mặc định':'riêng'}: ${(rejectKeywords.join('; ') || 'không có').slice(0,500)}\nNgày: ${formatDateRange(g.dateRange)}\nTự bình luận: ${(g.autoReply || 'tắt').slice(0,500)}\nTự nhắn tin: ${(g.autoInbox || 'tắt').slice(0,500)}\nTự kết bạn: ${g.autoFriend ? 'bật' : 'tắt'}\nTự chặn người comment: ${g.autoBlock ? 'bật' : 'tắt'}\nTikTok tự động: ${g.tiktokAuto?`${g.tiktokAuto.count} link/bài · ${g.tiktokAuto.rank}`:'tắt'}\n${g.lastError ? `Lỗi: ${g.lastError.slice(0,300)}\n`:''}Xóa nguồn: /remove ${id}\nHủy bình luận chờ: /cancelcomments ${id}`,{inline_keyboard:rows});
  }
  bot.command(['menu', 'start'], home);

  bot.command('help',ctx=>{
    const topic=String(ctx.match || '').trim();
    return topic==='all' ? (async()=>{for(const text of Object.values(GUIDES)) await reply(ctx,text);})() : GUIDES[topic] ? reply(ctx,GUIDES[topic]) : home(ctx);
  });
  bot.command('sources',ctx=>pager.command(ctx,'sourcemenu',ctx.match,{defaults:{pageSize:8},usage:listUsage('sources','sources')}));
  bot.command('search',ctx=>search(ctx,ctx.match));
  bot.command('settings',ctx=>{
    const arg=String(ctx.match || '').trim();
    return /^[1-9]\d*$/.test(arg) ? detail(ctx,Number(arg)) : sources(ctx);
  });
  bot.callbackQuery(/^nav:(home|help|add|posts|filters|filterhelp|comments|status|affiliate|affiliates|tiktok|facebook|groups|profiles|(?:sources|groupsources|profilesources)(?::\d+)?)$/,async ctx=>{
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
      const defaultAccept=store.getKeywords(ctx.from.id);
      const defaultReject=store.getRejectKeywords?.(ctx.from.id) ?? [];
      return reply(ctx,`📊 TRẠNG THÁI\nNguồn: ${status.groups} · đang chạy: ${status.active}\nBài/reel đã lưu: ${status.posts}\nThông báo chờ: ${status.pending}\nTừ khóa nhận (Accept) mặc định: ${defaultAccept.length ? defaultAccept.join('; ').slice(0, 100) : 'tất cả bài'}\nTừ khóa chặn (Reject) mặc định: ${defaultReject.length ? defaultReject.join('; ').slice(0, 100) : 'không có'}\nNguồn có lỗi: ${errors.length}\n${errors.slice(0,5).map(g=>`#${g.id}: ${g.lastError.slice(0,200)}`).join('\n')}\n/hot — top nguồn sôi động và chu kỳ quét lại\n/config — xem chi tiết cấu hình\n/comments — trạng thái bình luận\n/whoami — ID Telegram`);
    }
    if(topic==='filters') {
      const current=store.getKeywords(ctx.from.id);
      const reject=store.getRejectKeywords?.(ctx.from.id) ?? [];
      const groups=store.listGroups(ctx.from.id);
      const customAccept=groups.filter(g=>g.keywords!==null).length;
      const customReject=groups.filter(g=>g.rejectKeywords!==null).length;
      return reply(ctx,`⚙️ CẤU HÌNH BỘ LỌC HIỆN TẠI\n\n📌 Mặc định tài khoản:\n• Từ khóa nhận (Accept): ${current.length ? current.join('; ').slice(0,500) : 'tất cả bài (không lọc)'}\n• Từ khóa loại trừ (Reject): ${reject.length ? reject.join('; ').slice(0,500) : 'không có (chưa chặn bài nào)'}\n\n📊 Nguồn theo dõi: ${groups.length} nguồn (${customAccept} nguồn có accept riêng, ${customReject} nguồn có reject riêng)\n\nGửi /config để xem chi tiết cấu hình mọi nguồn, hoặc chọn nút bên dưới:`,{inline_keyboard:[
        [button('📋 Danh sách nguồn & cài đặt','nav:sources:1')],
        [button('❓ Hướng dẫn bộ lọc','nav:filterhelp')],
        [button('🏠 Menu chính','nav:home')]
      ]});
    }
    if(topic==='filterhelp') return reply(ctx,GUIDES.filters,{inline_keyboard:[[button('⚙️ Cấu hình bộ lọc hiện tại','nav:filters')],[button('🏠 Menu','nav:home')]]});
    return reply(ctx,GUIDES[topic]);
  });
  bot.callbackQuery(/^source:(open|posts|scan|pause|resume|keywords|reject|dates|defaults|auto|autoinbox|autofriend|autoblock|tiktok|tiktokoff|postsOnly|reelsOnly|both):(\d+)$/,async ctx=>{
    const [,action,raw]=ctx.callbackQuery.data.split(':'), id=Number(raw), g=own(ctx,id);
    if(!g) return ctx.answerCallbackQuery({text:'Không tìm thấy nguồn của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    if(action==='autofriend') {
      store.setAutoFriend(ctx.from.id,id,!g.autoFriend);
      return detail(ctx,id);
    }
    if(action==='autoblock') {
      store.setAutoBlock(ctx.from.id,id,!g.autoBlock);
      return detail(ctx,id);
    }
    if(action==='tiktok') return reply(ctx,`TikTok tự động nguồn #${id}: ${g.tiktokAuto?`${g.tiktokAuto.count} link/bài · ${g.tiktokAuto.rank} · sản phẩm: ${g.tiktokAuto.keyword || 'tất cả'}`:'tắt'}\nĐặt từ khóa Facebook: /groupkeywords ${id} từ khóa\nBật: /tiktokauto ${id} 5 rate từ khóa sản phẩm\nTắt: /tiktokauto ${id} off\nChỉ bài mới có ngày đăng sau khi bật và phù hợp bộ lọc.`);
    if(action==='tiktokoff') store.setTikTokAuto(ctx.from.id,id,null,null);
    if(action==='posts') {
      if(!store.listPosts(ctx.from.id,id,0).length) return reply(ctx,`Chưa có bài đã lưu. Bấm “Quét lại” trong /settings ${id}.`);
      // Same pages and ◀️ ▶️ buttons as /posts ID.
      return listPager(bot).open(ctx,'posts',{...listQuery('posts',{filters:{source:id}}),fixed:['source']});
    }
    if(action==='scan') {
      store.requestScan(ctx.from.id,id);
      await reply(ctx,g.paused?'Đã ghi nhận yêu cầu quét. Bấm “Tiếp tục” để nguồn hoạt động.':'Đã đưa nguồn vào lượt quét tiếp theo.');
    }
    if(action==='pause' || action==='resume') store.setPaused(ctx.from.id,id,action==='pause');
    if(action==='defaults') {
      store.setKeywords(ctx.from.id,id,null);
      store.setRejectKeywords?.(ctx.from.id,id,null);
    }
    if(['postsOnly','reelsOnly','both'].includes(action)) {
      if(g.sourceType!=='profile') return reply(ctx,'Tùy chọn này chỉ dành cho trang cá nhân.');
      store.addProfile(ctx.from.id,g.url,{postsOnly:'posts',reelsOnly:'reels',both:'all'}[action]);
    }
    if(['keywords','reject','dates','auto','autoinbox'].includes(action)) {
      const hints={
        keywords:'Nhập từ khóa nhận (Accept), cách nhau bằng dấu ;. Nhập off để nhận tất cả.',
        reject:'Nhập từ khóa chặn (Reject), cách nhau bằng dấu ;. Nhập off để không chặn từ nào.',
        dates:'Nhập DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]], hoặc off để bỏ lọc ngày.',
        auto:'Nhập nội dung tự bình luận cho bài mới, hoặc off để tắt. Nội dung này sẽ được đăng lên Facebook khi có bài mới phù hợp. Random nội dung: {Chào|Hi} bạn, {inbox|ib} mình nhé.',
        autoinbox:'Nhập nội dung tự nhắn tin riêng cho người đăng bài mới ({name}=tên, {link}=link bài), hoặc off để tắt.'
      };
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
      if(pending.action==='reject') store.setRejectKeywords?.(ctx.from.id,pending.id,parseKeywords(text));
      if(pending.action==='dates') store.setDateRange(ctx.from.id,pending.id,parseDateRange(text));
      if(pending.action==='auto') store.setAutoReply(ctx.from.id,pending.id,text.toLowerCase()==='off'?null:commentText(text));
      if(pending.action==='autoinbox') store.setAutoInbox(ctx.from.id,pending.id,text.toLowerCase()==='off'?null:directMessageText(text));
      prompts.delete(k);
      await reply(ctx,'Đã lưu cài đặt.');
      return detail(ctx,pending.id);
    } catch(error) {return reply(ctx,`${error.message}\nTrả lời lại tin yêu cầu cài đặt để sửa.`);}
  });
}
