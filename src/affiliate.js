import { createHash } from 'node:crypto';

const HOSTS = new Set(['shopee.vn','www.shopee.vn','m.shopee.vn','s.shopee.vn','shope.ee']);
export const SHOPEE_API = 'https://open-api.affiliate.shopee.vn/graphql';

export function shopeeUrl(value) {
  const raw=String(value ?? '').trim();
  if (!raw || raw.length>2000 || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) throw new Error('Link Shopee không hợp lệ.');
  const authority=raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if(!authority || !HOSTS.has(authority.toLowerCase())) throw new Error('Chỉ nhận link HTTPS Shopee Việt Nam, s.shopee.vn hoặc shope.ee.');
  const url=new URL(raw);
  if(!HOSTS.has(url.hostname) || url.username || url.password || url.port || url.pathname==='/') throw new Error('Hãy nhập link sản phẩm Shopee hoặc link chia sẻ sản phẩm.');
  // Keep every query parameter exactly as provided, including tracking fields.
  return raw;
}

export function parseAffiliateUrls(text) {
  const tokens=String(text ?? '').trim().split(/\s+/u).filter(Boolean);
  if(!tokens.length || tokens.length>20) throw new Error('Nhập từ 1 đến 20 link, cách nhau bằng xuống dòng hoặc khoảng trắng.');
  return [...new Set(tokens.map(shopeeUrl))];
}

export function readShopeeConfig(env) {
  const owner=env.SHOPEE_AFFILIATE_OWNER_ID?.trim(), appId=env.SHOPEE_AFFILIATE_APP_ID?.trim(), secret=env.SHOPEE_AFFILIATE_SECRET?.trim();
  if(!owner && !appId && !secret) return null;
  if(!/^[1-9]\d*$/.test(owner || '') || !Number.isSafeInteger(Number(owner)) || !/^[A-Za-z0-9_-]+$/.test(appId || '') || !secret) {
    throw new Error('Cần cấu hình đủ SHOPEE_AFFILIATE_OWNER_ID, SHOPEE_AFFILIATE_APP_ID và SHOPEE_AFFILIATE_SECRET trong .env.');
  }
  return {ownerId:Number(owner),appId,secret};
}

export function shopeeRequest(appId,secret,originUrl,now=Date.now()) {
  // Verified against Shopee VN's official /explorer/v2 request generator.
  const query=`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(shopeeUrl(originUrl))} }) { shortLink } }`;
  return signedQuery(appId,secret,query,now);
}

function signedQuery(appId,secret,query,now=Date.now()) {
  const body=JSON.stringify({query});
  const timestamp=Math.ceil(now/1000);
  const signature=createHash('sha256').update(`${appId}${timestamp}${body}${secret}`,'utf8').digest('hex');
  return {body,headers:{'Content-Type':'application/json',Authorization:`SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`}};
}

export async function responseJson(response,maxBytes=65536,reviver) {
  if(!response.body) throw new Error('empty response');
  const reader=response.body.getReader(), chunks=[];
  let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.length;
      if(size>maxBytes) {await reader.cancel();throw new Error('large response');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'),reviver);
}

export class ShopeeAffiliate {
  #config;
  #fetch;
  constructor(config=null,fetcher=fetch) {this.#config=config;this.#fetch=fetcher;}
  accountKey(ownerId) {
    if(!this.#config || this.#config.ownerId!==ownerId) return null;
    return createHash('sha256').update(this.#config.appId).digest('hex');
  }
  async convert(ownerId,input) {
    const url=shopeeUrl(input);
    const data=await this.#query(ownerId,`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(url)} }) { shortLink } }`);
    try {return shopeeUrl(data?.generateShortLink?.shortLink);}
    catch {throw new Error('Shopee chưa trả về link hợp lệ. Không dùng link gốc thay cho link affiliate.');}
  }
  async #query(ownerId,query,maxBytes=65536) {
    if(!this.accountKey(ownerId)) throw new Error('Chưa cấu hình Shopee Affiliate cho ID Telegram của bạn trên máy chạy bot.');
    let response,data;
    try {
      const request=signedQuery(this.#config.appId,this.#config.secret,query);
      response=await this.#fetch(SHOPEE_API,{method:'POST',...request,redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.ok) data=await responseJson(response,maxBytes);
      else await response.body?.cancel();
    } catch {throw new Error('Không kết nối hoặc không đọc được phản hồi Shopee. Thử lại sau; kiểm tra mạng và cấu hình API.');}
    if(response.status===429) throw new Error('Shopee đang giới hạn yêu cầu. Vui lòng thử lại sau.');
    if(!response.ok || data?.errors?.length) throw new Error('Shopee từ chối tạo link. Kiểm tra quyền Affiliate Open API, App ID/Secret, giờ máy và link sản phẩm.');
    return data?.data;
  }
  async topOffers(ownerId,{count=5,rank='rate',keyword=''}={}) {
    validateTopOptions({count,rank,keyword});
    const offers=[];
    let scanned=0,hasNext=false;
    for(let page=1;page<=5;page++) {
      // Shopee defines sortType=5 as commission RATE descending, not amount.
      const data=await this.#query(ownerId,`query { productOfferV2(listType: 0, sortType: 5, page: ${page}, limit: 50${keyword?`, keyword: ${JSON.stringify(keyword)}`:''}) { nodes { productName productLink offerLink commissionRate commission periodStartTime periodEndTime } pageInfo { hasNextPage } } }`,524288);
      const result=data?.productOfferV2;
      if(!Array.isArray(result?.nodes) || result.nodes.length>50 || typeof result.pageInfo?.hasNextPage!=='boolean') throw new Error('Shopee chưa trả danh sách sản phẩm hợp lệ.');
      offers.push(...result.nodes);scanned+=result.nodes.length;
      hasNext=result.pageInfo.hasNextPage;
      if(!hasNext || !result.nodes.length) break;
    }
    return {offers:rankOffers(offers,rank).slice(0,count),scanned,limited:hasNext,rank};
  }
}

export function validateTopOptions({count,rank,keyword}) {
  if(!Number.isInteger(count) || count<1 || count>20) throw new Error('Số link phải từ 1 đến 20.');
  if(!['rate','amount'].includes(rank)) throw new Error('Chọn rate (tỷ lệ %) hoặc amount (tiền hoa hồng).');
  if(typeof keyword!=='string' || keyword.length>200) throw new Error('Từ khóa tối đa 200 ký tự.');
}

export function parseTopOptions(text) {
  const match=String(text || '').trim().match(/^(\d+)(?:\s+(rate|amount))?(?:\s+([\s\S]+))?$/i);
  if(!match) throw new Error('Nhập SỐ_LINK [rate|amount] [từ khóa]. Ví dụ: 5 rate đồ gia dụng');
  const result={count:Number(match[1]),rank:(match[2] || 'rate').toLowerCase(),keyword:(match[3] || '').trim()};
  validateTopOptions(result);
  return result;
}

export function rankOffers(nodes,rank='rate',now=Date.now()) {
  const decimal=value=>typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const offers=new Map();
  for(const node of nodes) {
    if(!node || typeof node!=='object') continue;
    const rate=decimal(node.commissionRate),amount=decimal(node.commission);
    const timestamp=value=>(typeof value==='number' || typeof value==='string' && /^\d+$/.test(value)) ? Number(value) : NaN;
    const start=timestamp(node.periodStartTime),end=timestamp(node.periodEndTime);
    if(rate===null || amount===null || rate<=0 || amount<=0 || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<0 || start>now/1000 || (end>0 && end<=now/1000)) continue;
    try {
      const productUrl=shopeeUrl(node.productLink),affiliateUrl=shopeeUrl(node.offerLink);
      const url=new URL(productUrl);
      const ids=url.pathname.match(/\/product\/(\d+)\/(\d+)/) || url.pathname.match(/-i\.(\d+)\.(\d+)/);
      const key=ids?`${ids[1]}:${ids[2]}`:url.origin+url.pathname;
      const offer={productUrl,affiliateUrl,rate,amount,name:String(node.productName || 'Sản phẩm Shopee').replace(/[\r\n]/g,' ').slice(0,150)};
      // Avoid posting the same product twice even when tracking URLs differ.
      const previous=offers.get(key);
      if(!previous || offer[rank]>previous[rank]) offers.set(key,offer);
    } catch { /* Do not replace an invalid affiliate URL with the product URL. */ }
  }
  const metric=rank==='amount'?'amount':'rate',secondary=metric==='amount'?'rate':'amount';
  const seen=new Set();
  return [...offers.values()].sort((a,b)=>b[metric]-a[metric] || b[secondary]-a[secondary] || a.productUrl.localeCompare(b.productUrl)).filter(o=>{
    if(seen.has(o.affiliateUrl)) return false;
    seen.add(o.affiliateUrl);return true;
  });
}

export function installAffiliateCommands(bot,store,affiliate=new ShopeeAffiliate()) {
  const active=new Set();
  async function top(ctx,options,target=null) {
    if(!affiliate.accountKey(ctx.from.id)) return info(ctx);
    if(target && !store.getSavedPost(ctx.from.id,target.groupId,target.postId)) return ctx.reply('Không tìm thấy bài/reel đã lưu thuộc nguồn của bạn. Xem /list và /posts ID_nguồn.');
    if(active.has(ctx.from.id)) return ctx.reply('Đang xử lý yêu cầu affiliate trước của bạn. Đợi hoàn tất rồi thử lại.');
    active.add(ctx.from.id);
    try {
      await ctx.reply(`Đang tìm ${options.count} sản phẩm hoa hồng cao theo ${options.rank==='amount'?'tiền hoa hồng':'tỷ lệ %'}${target?' để bình luận vào bài/reel '+target.postId:''}.`);
      let result,links,queued;
      try {
        result=await affiliate.topOffers(ctx.from.id,options);
        links=result.offers.map(offer=>store.saveAffiliateLink(ctx.from.id,affiliate.accountKey(ctx.from.id),offer.productUrl,offer.affiliateUrl));
        if(target && links.length) queued=store.queueCommentList(ctx.from.id,target.groupId,[target.postId],links.map(link=>link.affiliate_url));
      } catch {
        return ctx.reply('Không lấy được danh sách hoặc xếp bình luận. Chưa xếp bình luận từ yêu cầu này. Kiểm tra /affiliate status, quyền API và bài mục tiêu rồi thử lại.');
      }
      if(!links.length) return ctx.reply('Không có sản phẩm hoa hồng dương, còn hiệu lực và có link affiliate hợp lệ trong kết quả đã đọc. Chưa xếp bình luận.');
      await ctx.reply(`Đã chọn ${links.length}/${options.count} link từ ${result.scanned} kết quả Shopee${result.limited?' (còn kết quả chưa quét)':''}. Xếp hạng trong phạm vi đã đọc, không bảo đảm cao nhất toàn sàn. Hoa hồng hiển thị là mức ước tính từ API.\n${target?`Đã xếp ${queued.queued} bình luận; bỏ qua ${queued.skipped} link trùng. Mỗi link một bình luận, cách nhau ít nhất 30 giây. /comments; /cancelcomments ${target.groupId}.`:'Chỉ xem và lưu, chưa bình luận. Dùng /affiliatetopcomment ID_nguồn ID_bài SỐ_LINK để tự lấy top mới và bình luận.'}`);
      for(let i=0;i<links.length;i++) {
        const offer=result.offers[i];
        await ctx.reply(`${i+1}. ${offer.name}\nHoa hồng: ${(offer.rate*100).toLocaleString('vi-VN',{maximumFractionDigits:4})}% · ${offer.amount.toLocaleString('vi-VN',{maximumFractionDigits:2})} đ/đơn (ước tính)\nID link #${links[i].id}\n${links[i].affiliate_url}`,{link_preview_options:{is_disabled:true}});
      }
    } finally {active.delete(ctx.from.id);}
  }
  bot.command('affiliatetop',async ctx=>{
    let options;
    try {options=parseTopOptions(ctx.match || '5');} catch(error) {return ctx.reply(error.message);}
    return top(ctx,options);
  });
  bot.command('affiliatetopcomment',async ctx=>{
    const match=String(ctx.match || '').trim().match(/^([1-9]\d*)\s+([A-Za-z0-9_-]+)\s+([\s\S]+)$/);
    if(!match || !Number.isSafeInteger(Number(match[1])) || match[2].toLowerCase()==='all') return ctx.reply('Cú pháp: /affiliatetopcomment ID_nguồn ID_bài SỐ_LINK [rate|amount] [từ khóa]\nVí dụ: /affiliatetopcomment 1 123456789 5 rate đồ gia dụng\nBot lấy top mới rồi tự xếp mỗi link thành một bình luận trên bài/reel này.');
    let options;
    try {options=parseTopOptions(match[3]);} catch(error) {return ctx.reply(error.message);}
    return top(ctx,options,{groupId:Number(match[1]),postId:match[2]});
  });
  bot.callbackQuery('post:affiliatetop',async ctx=>{
    const target=store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if(!target) return ctx.answerCallbackQuery({text:'Không tìm thấy bài của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    const message=await ctx.reply(`Bài/reel ${target.postId}: chọn số link để tự lấy top Shopee rồi BÌNH LUẬN, mỗi link một lần.\n%: tỷ lệ hoa hồng; đ: tiền hoa hồng ước tính. Xếp hạng trong tối đa 250 kết quả đọc được.\nTùy chọn từ khóa/số khác: /affiliatetopcomment ${target.groupId} ${target.postId} 5 rate từ khóa`,{
      reply_markup:{inline_keyboard:[
        [1,3,5,10].map(count=>({text:`${count} link · %`,callback_data:`afftop:${count}:rate`})),
        [1,3,5,10].map(count=>({text:`${count} link · đ`,callback_data:`afftop:${count}:amount`})),
      ]},
    });
    store.mapMessage(ctx.from.id,ctx.chat.id,message.message_id,target.groupId,target.postId);
  });
  bot.callbackQuery(/^afftop:(1|3|5|10):(rate|amount)$/,async ctx=>{
    const target=store.replyTarget(ctx.from.id,ctx.chat.id,ctx.callbackQuery.message?.message_id);
    if(!target) return ctx.answerCallbackQuery({text:'Không tìm thấy bài của bạn.',show_alert:true});
    await ctx.answerCallbackQuery();
    const [,count,rank]=ctx.callbackQuery.data.split(':');
    return top(ctx,{count:Number(count),rank,keyword:''},target);
  });
  const info=ctx=>ctx.reply(`SHOPEE AFFILIATE\n${affiliate.accountKey(ctx.from.id)?'Đã cấu hình cho tài khoản Telegram này; cần chuyển thử một link để kiểm tra API.':'Chưa cấu hình. Điền thông tin Shopee Affiliate trong .env trên máy chạy bot.'}\n\n/affiliatetop 5 — xem top hoa hồng.\n/affiliatetopcomment ID_nguồn ID_bài 5 [rate|amount] — lấy top rồi bình luận số link đã chọn.\n/affiliate shopee LINK1 LINK2\nChuyển tối đa 20 link, cách nhau bằng xuống dòng/khoảng trắng.\n/affiliatelinks — xem link đã tạo.\n/affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2 — gửi mỗi link thành một bình luận.\nTikTok Affiliate: /tiktok. Không gửi khóa API hoặc cookie qua Telegram.`);
  bot.command('affiliate',async ctx=>{
    const input=String(ctx.match || '').trim();
    if(!input || input==='status') return info(ctx);
    const match=input.match(/^shopee\s+([\s\S]+)$/i);
    if(!match) return info(ctx);
    if(!affiliate.accountKey(ctx.from.id)) return info(ctx);
    if(active.has(ctx.from.id)) return ctx.reply('Đang chuyển danh sách trước của bạn. Đợi hoàn tất rồi gửi tiếp.');
    let urls;
    try {urls=parseAffiliateUrls(match[1]);} catch(error) {return ctx.reply(error.message);}
    active.add(ctx.from.id);
    try {
      await ctx.reply(`Đang chuyển ${urls.length} link Shopee. Kết quả sẽ hiện lần lượt; chưa xếp bình luận Facebook.`);
      let succeeded=0;
      for(const [index,url] of urls.entries()) {
        let link;
        try {
          const converted=await affiliate.convert(ctx.from.id,url);
          link=store.saveAffiliateLink(ctx.from.id,affiliate.accountKey(ctx.from.id),url,converted);
        } catch(error) {
          // Only show our own adapter's fixed messages, never a database or HTTP error payload.
          const message=error?.message?.startsWith('Shopee ') || error?.message?.startsWith('Không kết nối') ? error.message : 'Không lưu hoặc tạo được link. Dùng /affiliate status để kiểm tra cấu hình.';
          await ctx.reply(`Link ${index+1}/${urls.length}: ${message}`);
          continue;
        }
        succeeded++;
        await ctx.reply(`Link ${index+1}/${urls.length} · ID link #${link.id}\n${link.affiliate_url}`,{link_preview_options:{is_disabled:true}});
      }
      await ctx.reply(`Đã tạo và lưu ${succeeded}/${urls.length} link. Xem /affiliatelinks. Để bình luận: /affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2`);
    } finally {active.delete(ctx.from.id);}
  });
  bot.command('affiliatelinks',async ctx=>{
    const account=affiliate.accountKey(ctx.from.id);
    if(!account) return info(ctx);
    const raw=String(ctx.match || '1').trim();
    if(!/^[1-9]\d{0,5}$/.test(raw)) return ctx.reply('Cú pháp: /affiliatelinks [trang].');
    const page=Number(raw), links=store.listAffiliateLinks(ctx.from.id,account,(page-1)*10);
    if(!links.length) return ctx.reply('Chưa có link ở trang này. Dùng /affiliate shopee LINK để tạo.');
    for(const link of links) await ctx.reply(`#${link.id}\n${link.affiliate_url}`,{link_preview_options:{is_disabled:true}});
    await ctx.reply(`Trang ${page}. Trang tiếp: /affiliatelinks ${page+1}\n/affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2`);
  });
  bot.command('affiliatecomment',async ctx=>{
    const match=String(ctx.match || '').match(/^\s*([1-9]\d*)\s+([A-Za-z0-9_-]+)\s*\|\s*([\d,\s]+)$/);
    if(!match || !Number.isSafeInteger(Number(match[1])) || match[2].toLowerCase()==='all') return ctx.reply('Cú pháp: /affiliatecomment ID_nguồn ID_bài | ID_link1,ID_link2\nLấy ID link từ /affiliatelinks; ID nguồn từ /list; ID bài từ /posts ID_nguồn.');
    const ids=match[3].trim().split(/[\s,]+/);
    if(!ids.length || ids.length>20 || ids.some(id=>!(/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))))) return ctx.reply('Chọn từ 1 đến 20 ID link hợp lệ.');
    const account=affiliate.accountKey(ctx.from.id);
    if(!account) return info(ctx);
    try {
      const links=store.affiliateLinksByIds(ctx.from.id,account,ids.map(Number));
      const result=store.queueCommentList(ctx.from.id,Number(match[1]),[match[2]],links.map(link=>link.affiliate_url));
      await ctx.reply(`Đã xếp ${result.queued} bình luận vào bài/reel ${match[2]}; bỏ qua ${result.skipped} link trùng. Gửi theo thứ tự ID bạn nhập, cách nhau ít nhất 30 giây. /comments để xem; /cancelcomments ${match[1]} để hủy phần chờ.`);
    } catch {await ctx.reply('Không xếp được bình luận. Kiểm tra nguồn, bài và tất cả ID link đều thuộc tài khoản hiện tại của bạn.');}
  });
}
