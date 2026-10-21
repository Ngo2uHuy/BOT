import { parseTopOptions } from './affiliate.js';
import { listPager } from './listing.js';
import { TikTokAffiliate, parseTikTokInput } from './tiktok-affiliate.js';

export function installTikTokCommands(bot,store,affiliate=new TikTokAffiliate()) {
  const active=new Set();
  const info=ctx=>ctx.reply(`TIKTOK AFFILIATE\n${affiliate.accountKey(ctx.from.id)?'Đã cấu hình. /tiktok check để kiểm tra đúng Creator và quyền affiliate VN.':'Chưa cấu hình tài khoản TikTok cho ID Telegram này. Xem README, điền cấu hình trên máy chạy bot.'}\n/tiktok LINK1 LINK2 — tạo link từ sản phẩm hoặc ID\n/tiktoktop 5 [rate|amount] [từ khóa] — xem top\n/tiktoktopcomment ID_nguồn ID_bài 5 [rate|amount] [từ khóa] — lấy top và bình luận lên Facebook\n/tiktoklinks [trang] — link đã lưu\n/tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2 — bình luận các link đã chọn\n/tiktokauto ID_nguồn 5 rate từ khóa sản phẩm — tự động cho bài Facebook mới; dùng off để tắt\nAPI tạo link yêu cầu quyền Read Affiliate Share Link và publisher hợp lệ. Khóa/token chỉ cấu hình trong .env.`);
  const safeError=error=>/^TikTok|^Không mở được link chia sẻ TikTok|^Không xác định được ID sản phẩm|^Link TikTok HTTPS|^Hãy gửi link sản phẩm/.test(error?.message || '')?error.message:'Không xử lý được yêu cầu TikTok. Kiểm tra cấu hình và thử lại.';
  async function top(ctx,options,target=null) {
    if(!affiliate.accountKey(ctx.from.id)) return info(ctx);
    if(target && !store.getSavedPost(ctx.from.id,target.groupId,target.postId)) return ctx.reply('Không tìm thấy bài Facebook đã lưu của bạn. Xem /list và /posts ID_nguồn.');
    if(active.has(ctx.from.id)) return ctx.reply('Đang xử lý yêu cầu TikTok trước. Vui lòng đợi.');
    active.add(ctx.from.id);
    try {
      await ctx.reply(`Đang tìm top ${options.count} sản phẩm TikTok theo ${options.rank==='rate'?'tỷ lệ %':'tiền hoa hồng'}${target?' và xếp bình luận lên Facebook':''}.`);
      let result,links,queued;
      try {
        result=await affiliate.topOffers(ctx.from.id,options);
        links=result.offers.map(offer=>store.saveAffiliateLink(ctx.from.id,affiliate.accountKey(ctx.from.id),offer.productUrl,offer.affiliateUrl));
        if(target && links.length) queued=store.queueCommentList(ctx.from.id,target.groupId,[target.postId],links.map(link=>link.affiliate_url));
      } catch(error) {return ctx.reply(`${safeError(error)}\nChưa xếp bình luận từ yêu cầu này.`);}
      await ctx.reply(`Đã lấy ${links.length}/${options.count} link TikTok từ ${result.scanned} sản phẩm đã đọc${result.limited?' (còn kết quả chưa quét)':''}; ${result.failed || 0} sản phẩm chọn nhưng không có link chia sẻ hợp lệ. Chỉ xếp hạng sản phẩm VN, hoa hồng VND, còn hàng trong dữ liệu đọc được; không bảo đảm top toàn sàn.\n${target?`Đã xếp ${queued?.queued || 0} bình luận; bỏ qua ${queued?.skipped || 0} link trùng. Mỗi link một bình luận, cách nhau ít nhất 30 giây. /comments; /cancelcomments ${target.groupId}.`:'Chỉ xem và lưu, chưa bình luận.'}`);
      for(let i=0;i<links.length;i++) {
        const o=result.offers[i];
        await ctx.reply(`${i+1}. ${o.name}\nHoa hồng ước tính: ${(o.rate*100).toLocaleString('vi-VN',{maximumFractionDigits:2})}% · ${o.amount.toLocaleString('vi-VN')} VND/đơn\nID link #${links[i].id}\n${links[i].affiliate_url}`,{link_preview_options:{is_disabled:true}});
      }
    } finally {active.delete(ctx.from.id);}
  }
  bot.command('tiktok',async ctx=>{
    const input=String(ctx.match || '').trim();
    if(!input || input==='status') return info(ctx);
    if(!affiliate.accountKey(ctx.from.id)) return info(ctx);
    if(active.has(ctx.from.id)) return ctx.reply('Đang xử lý yêu cầu TikTok trước. Vui lòng đợi.');
    let values;
    try {if(input!=='check') values=parseTikTokInput(input);} catch(error) {return ctx.reply(error.message);}
    active.add(ctx.from.id);
    try {
      if(input==='check') {
        try {await affiliate.verify(ctx.from.id);return ctx.reply('Token khớp Creator đã cấu hình và có quyền affiliate tại Việt Nam. Quyền tạo link publisher cần kiểm tra bằng một sản phẩm đủ điều kiện.');}
        catch(error) {return ctx.reply(safeError(error));}
      }
      let count=0;
      await ctx.reply(`Đang tạo link TikTok cho ${values.length} sản phẩm. Chưa xếp bình luận.`);
      for(const [index,value] of values.entries()) {
        let link;
        try {
          const result=await affiliate.convert(ctx.from.id,value);
          link=store.saveAffiliateLink(ctx.from.id,affiliate.accountKey(ctx.from.id),result.productUrl,result.affiliateUrl);
        } catch(error) {await ctx.reply(`Sản phẩm ${index+1}: ${safeError(error)}`);continue;}
        count++;
        await ctx.reply(`#${link.id}\n${link.affiliate_url}`,{link_preview_options:{is_disabled:true}});
      }
      await ctx.reply(`Đã lưu ${count}/${values.length} link. /tiktoklinks để xem; /tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2 để bình luận.`);
    } finally {active.delete(ctx.from.id);}
  });
  bot.command('tiktoktop',async ctx=>{
    let options;
    try {options=parseTopOptions(ctx.match || '5');} catch(error) {return ctx.reply(error.message);}
    return top(ctx,options);
  });
  bot.command('tiktokauto',async ctx=>{
    const match=String(ctx.match || '').trim().match(/^([1-9]\d*)\s+([\s\S]+)$/);
    if(!match || !Number.isSafeInteger(Number(match[1]))) return ctx.reply('Tự động theo nguồn Facebook:\n1. /groupkeywords ID từ khóa Facebook\n2. /tiktokauto ID SỐ_LINK [rate|amount] [từ khóa sản phẩm]\nVí dụ: /tiktokauto 1 5 rate đồ gia dụng\nTắt: /tiktokauto 1 off. Chỉ bài mới sau lúc bật, có ngày và phù hợp bộ lọc.');
    const group=store.getGroup(Number(match[1]));
    if(!group || group.ownerId!==ctx.from.id) return ctx.reply('Không tìm thấy nguồn Facebook của bạn.');
    if(match[2].trim().toLowerCase()==='off') {
      store.setTikTokAuto(ctx.from.id,group.id,null,null);
      return ctx.reply(`Đã tắt TikTok tự động nguồn #${group.id}, hủy việc lấy link và bình luận tự động đang chờ.`);
    }
    const account=affiliate.accountKey(ctx.from.id);
    if(!account) return info(ctx);
    let options;
    try {options=parseTopOptions(match[2]);} catch(error) {return ctx.reply(error.message);}
    try {await affiliate.verify(ctx.from.id);} catch(error) {return ctx.reply(safeError(error));}
    store.setTikTokAuto(ctx.from.id,group.id,options,account);
    const keywords=store.effectiveKeywords(group);
    return ctx.reply(`Đã bật TikTok tự động cho nguồn #${group.id}: tối đa ${options.count} link/bài, theo ${options.rank==='rate'?'%':'tiền hoa hồng'}.\nTừ khóa bài Facebook: ${keywords.length?keywords.join('; ').slice(0,800):'tất cả bài'}.\nTừ khóa sản phẩm TikTok: ${options.keyword || 'không giới hạn'}.\nChỉ bài mới sau lúc bật, có ngày đăng và qua bộ lọc; sau mốc khởi tạo. ${group.paused?'Nguồn đang tạm dừng; /resume '+group.id+' để tiếp tục.':''}\nTắt: /tiktokauto ${group.id} off. ${group.autoReply?'Nguồn còn bật bình luận văn bản; dùng /autoreply '+group.id+' off nếu chỉ muốn link TikTok.':''}`);
  });
  bot.command('tiktoktopcomment',async ctx=>{
    const match=String(ctx.match || '').trim().match(/^([1-9]\d*)\s+([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
    if(!match || !Number.isSafeInteger(Number(match[1])) || match[2].toLowerCase()==='all') return ctx.reply('Cú pháp: /tiktoktopcomment ID_nguồn ID_bài SỐ_LINK [rate|amount] [từ khóa]. Ví dụ: /tiktoktopcomment 1 123456789 5 rate đồ gia dụng');
    let options;
    try {options=parseTopOptions(match[3]);} catch(error) {return ctx.reply(error.message);}
    return top(ctx,options,{groupId:Number(match[1]),postId:match[2]});
  });
  const pager=listPager(bot);
  pager.define('tiktoklinks',(ctx,query)=>{
    const account=affiliate.accountKey(ctx.from.id);
    if(!account) return 'Chưa cấu hình tài khoản TikTok cho ID Telegram này. Xem /tiktok status.';
    const result=store.pageAffiliateLinks(ctx.from.id,account,query);
    return {result,title:'🎵 Link TikTok đã lưu',empty:'Chưa có link TikTok. Dùng /tiktoktop 5 hoặc /tiktok LINK.',remove:'links',lines:result.items.map(link=>`#${link.id} · ${link.affiliate_url}`),
      footer:['/tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2']};
  },'links');
  bot.command('tiktoklinks',ctx=>affiliate.accountKey(ctx.from.id) ? pager.command(ctx,'tiktoklinks',ctx.match) : info(ctx));
  bot.command('tiktokcomment',async ctx=>{
    const match=String(ctx.match || '').match(/^\s*([1-9]\d*)\s+([A-Za-z0-9_-]+)\s*\|\s*([\d,\s]+)$/);
    if(!match || !Number.isSafeInteger(Number(match[1])) || match[2].toLowerCase()==='all') return ctx.reply('Cú pháp: /tiktokcomment ID_nguồn ID_bài | ID_link1,ID_link2. ID link lấy từ /tiktoklinks.');
    const ids=match[3].trim().split(/[\s,]+/);
    if(ids.length>20 || ids.some(v=>!(/^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))))) return ctx.reply('Chọn 1–20 ID link TikTok hợp lệ.');
    const account=affiliate.accountKey(ctx.from.id);
    if(!account) return info(ctx);
    try {
      const links=store.affiliateLinksByIds(ctx.from.id,account,ids.map(Number));
      const result=store.queueCommentList(ctx.from.id,Number(match[1]),[match[2]],links.map(l=>l.affiliate_url));
      return ctx.reply(`Đã xếp ${result.queued} bình luận, bỏ qua ${result.skipped} link trùng. /comments; /cancelcomments ${match[1]}.`);
    } catch {return ctx.reply('Không xếp được bình luận: bài, nguồn và tất cả ID link TikTok phải thuộc tài khoản hiện tại.');}
  });
  bot.callbackQuery('post:tiktoktop',async ctx=>{
    const target=store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if(!target) return ctx.answerCallbackQuery({text:'Không tìm thấy bài của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    const prompt=await ctx.reply(`Bài Facebook ${target.postId}: chọn số link để TỰ LẤY TOP TIKTOK VÀ BÌNH LUẬN. % là tỷ lệ; VND là tiền hoa hồng ước tính. Mỗi link một bình luận.\nTùy chỉnh: /tiktoktopcomment ${target.groupId} ${target.postId} 5 rate từ khóa`,{reply_markup:{inline_keyboard:[
      [1,3,5,10].map(n=>({text:`${n} link · %`,callback_data:`ttop:${n}:rate`})),
      [1,3,5,10].map(n=>({text:`${n} link · VND`,callback_data:`ttop:${n}:amount`})),
    ]}});
    store.mapMessage(ctx.from.id,ctx.chat.id,prompt.message_id,target.groupId,target.postId);
  });
  bot.callbackQuery(/^ttop:(1|3|5|10):(rate|amount)$/,async ctx=>{
    const target=store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if(!target) return ctx.answerCallbackQuery({text:'Không tìm thấy bài của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    const [,count,rank]=ctx.callbackQuery.data.split(':');
    return top(ctx,{count:Number(count),rank,keyword:''},target);
  });
}
