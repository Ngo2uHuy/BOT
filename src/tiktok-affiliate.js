import { createHash, createHmac } from 'node:crypto';
import { responseJson, validateTopOptions } from './affiliate.js';

export const TIKTOK_API='https://open-api.tiktokglobalshop.com';
export const TIKTOK_SEARCH='/affiliate_creator/202405/open_collaborations/products/search';
export const TIKTOK_PROFILE='/affiliate_creator/202405/profiles';
const HOSTS=new Set(['tiktok.com','www.tiktok.com','shop.tiktok.com','vt.tiktok.com','vm.tiktok.com']);
const id=value=>typeof value==='string' && /^[1-9]\d{0,29}$/.test(value);

export function tiktokUrl(value) {
  const raw=String(value ?? '').trim();
  const authority=raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if(raw.length>2000 || /[\s\\\u0000-\u001f\u007f]/u.test(raw) || !authority || !HOSTS.has(authority.toLowerCase())) throw new Error('Link TikTok HTTPS không hợp lệ.');
  const url=new URL(raw);
  if(!HOSTS.has(url.hostname) || url.pathname==='/') throw new Error('Hãy gửi link sản phẩm TikTok Shop.');
  return raw;
}

export function tiktokProductId(value) {
  if(id(value)) return value;
  const url=new URL(tiktokUrl(value));
  const match=url.pathname.match(/^\/view\/product\/([1-9]\d{0,29})\/?$/)
    || url.pathname.match(/^\/shop\/pdp\/(?:[^/]+\/)?([1-9]\d{0,29})\/?$/);
  return match?.[1] || null;
}

export function parseTikTokInput(text) {
  const values=String(text || '').trim().split(/\s+/).filter(Boolean);
  if(!values.length || values.length>20) throw new Error('Nhập 1–20 link sản phẩm hoặc ID sản phẩm TikTok, cách nhau bằng xuống dòng.');
  for(const value of values) if(!id(value)) {
    const url=new URL(tiktokUrl(value));
    if(!tiktokProductId(value) && !['vt.tiktok.com','vm.tiktok.com'].includes(url.hostname) && !/^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error('Không nhận diện link sản phẩm TikTok. Dùng link /view/product/ID, /shop/pdp/.../ID hoặc link chia sẻ vt/vm.tiktok.com.');
  }
  return [...new Set(values)];
}

export function readTikTokConfig(env) {
  const fields={ownerId:'OWNER_ID',appKey:'APP_KEY',secret:'APP_SECRET',accessToken:'ACCESS_TOKEN',creatorId:'CREATOR_ID',publisherId:'PUBLISHER_ID'};
  const config=Object.fromEntries(Object.entries(fields).map(([key,suffix])=>[key,env[`TIKTOK_AFFILIATE_${suffix}`]?.trim() || '']));
  const campaignId=env.TIKTOK_AFFILIATE_CAMPAIGN_ID?.trim() || '';
  if(!Object.values(config).some(Boolean) && !campaignId) return null;
  if(Object.values(config).some(value=>!value) || !id(config.ownerId) || !Number.isSafeInteger(Number(config.ownerId)) || !id(config.creatorId)
    || !/^[A-Za-z0-9_-]+$/.test(config.appKey) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.publisherId) || campaignId && !id(campaignId)) {
    throw new Error('Cấu hình TikTok Affiliate chưa đầy đủ/hợp lệ. Cần OWNER_ID, APP_KEY, APP_SECRET, ACCESS_TOKEN Creator, CREATOR_ID và PUBLISHER_ID trong .env.');
  }
  return {...config,ownerId:Number(config.ownerId),campaignId};
}

export function tiktokSignature(path,params,body,secret) {
  const query=Object.keys(params).filter(k=>!['sign','access_token'].includes(k)).sort().map(k=>k+String(params[k])).join('');
  return createHmac('sha256',secret).update(secret+path+query+body+secret,'utf8').digest('hex');
}

// Int64 material IDs may arrive as JSON numbers. Preserve original digits.
export function preserveTikTokIds(_key,value,context) {
  return typeof value==='number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source || '') ? context.source : value;
}

export function rankTikTokOffers(products,rank='rate') {
  const found=new Map();
  for(const p of products) {
    if(!p || !id(p.id) || p.has_inventory!==true || p.sale_region!=='VN' || p.commission?.currency!=='VND') continue;
    const rate=p.commission.rate, raw=p.commission.amount;
    const amount=typeof raw==='string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if(!Number.isInteger(rate) || rate<=0 || rate>10000 || !Number.isFinite(amount) || amount<=0) continue;
    const offer={id:p.id,rate:rate/10000,amount,currency:'VND',name:String(p.title || 'Sản phẩm TikTok').replace(/[\r\n]/g,' ').slice(0,150),productUrl:`https://shop.tiktok.com/view/product/${p.id}`};
    if(!found.has(p.id) || offer[rank]>found.get(p.id)[rank]) found.set(p.id,offer);
  }
  const second=rank==='rate'?'amount':'rate';
  return [...found.values()].sort((a,b)=>b[rank]-a[rank] || b[second]-a[second] || a.id.localeCompare(b.id));
}

export class TikTokAffiliate {
  #config;
  #fetch;
  constructor(config=null,fetcher=fetch) {this.#config=config;this.#fetch=fetcher;}
  accountKey(ownerId) {
    const c=this.#config;
    if(!c || c.ownerId!==ownerId) return null;
    return 'tiktok:'+createHash('sha256').update(JSON.stringify([c.appKey,c.creatorId,c.publisherId,c.campaignId || '', 'VN'])).digest('hex');
  }
  async #request(ownerId,path,params={},payload) {
    if(!this.accountKey(ownerId)) throw new Error('TikTok Affiliate chưa được cấu hình cho ID Telegram của bạn.');
    const c=this.#config,body=payload===undefined?'':JSON.stringify(payload);
    const query={...params,app_key:c.appKey,timestamp:Math.floor(Date.now()/1000)};
    const sign=tiktokSignature(path,query,body,c.secret);
    let response,data;
    try {
      response=await this.#fetch(`${TIKTOK_API}${path}?${new URLSearchParams({...query,sign})}`,{
        method:payload===undefined?'GET':'POST',...(payload===undefined?{}:{body}),
        headers:{'content-type':'application/json','x-tts-access-token':c.accessToken},
        redirect:'error',signal:AbortSignal.timeout(15000),
      });
      if(response.ok) data=await responseJson(response,524288,preserveTikTokIds);
      else await response.body?.cancel();
    } catch {throw new Error('TikTok: không tải/đọc được dữ liệu API. Thử lại sau.');}
    if(response.status===429) throw new Error('TikTok đang giới hạn yêu cầu. Thử lại sau.');
    if(data?.code===105002) throw new Error('TikTok: access token đã hết hạn. Cập nhật token Creator trong .env rồi khởi động lại bot.');
    if(!response.ok || data?.code!==0 || !data.data || typeof data.data!=='object') throw new Error('TikTok từ chối yêu cầu. Kiểm tra quyền Creator API, publisher, chiến dịch và token trong cấu hình.');
    return data.data;
  }
  async verify(ownerId) {
    const profile=await this.#request(ownerId,TIKTOK_PROFILE);
    if(profile.creator_user_id!==this.#config.creatorId || profile.selection_region!=='VN' || !profile.permissions?.includes('ADD_AFFILIATE_PERMISSION')) {
      throw new Error('TikTok: token không khớp Creator đã cấu hình hoặc Creator chưa có quyền affiliate tại Việt Nam.');
    }
    return true;
  }
  async #resolve(input) {
    const direct=tiktokProductId(input);
    if(direct) return direct;
    let url=tiktokUrl(input);
    const signal=AbortSignal.timeout(15000);
    for(let hop=0;hop<5;hop++) {
      let response;
      try {response=await this.#fetch(url,{method:'GET',redirect:'manual',signal,headers:{}});}
      catch {throw new Error('Không mở được link chia sẻ TikTok. Hãy dùng link sản phẩm đầy đủ hoặc ID.');}
      await response.body?.cancel();
      if(![301,302,303,307,308].includes(response.status) || !response.headers.get('location')) break;
      // Validate each redirect before following it. Never attach API credentials.
      url=tiktokUrl(new URL(response.headers.get('location'),url).href);
      const product=tiktokProductId(url);
      if(product) return product;
    }
    throw new Error('Không xác định được ID sản phẩm từ link TikTok. Gửi link sản phẩm đầy đủ hoặc ID.');
  }
  async #links(ownerId,ids) {
    const c=this.#config;
    const data=await this.#request(ownerId,`/affiliate_creator/202504/affiliate_sharing_links/publisher/${c.publisherId}/generate_batch`,{},
      {material:{ids,type:'PRODUCT'},...(c.campaignId?{campaign_id:c.campaignId}:{})});
    if(!Array.isArray(data.sharing_links) || data.sharing_links.length>50 || data.failed_materials!==undefined && !Array.isArray(data.failed_materials)) throw new Error('TikTok: phản hồi tạo link không hợp lệ.');
    const failed=new Set((data.failed_materials || []).map(item=>String(item.material_id)));
    const result=new Map();
    for(const item of data.sharing_links) {
      const material=typeof item.material_id==='string'?item.material_id:Number.isSafeInteger(item.material_id)?String(item.material_id):'';
      if(!ids.includes(material) || failed.has(material) || result.has(material)) continue;
      try {result.set(material,tiktokUrl(item.sharing_link));} catch { /* Never use detail_link instead. */ }
    }
    return result;
  }
  async convert(ownerId,input) {
    parseTikTokInput(input);
    await this.verify(ownerId);
    const productId=await this.#resolve(input);
    const links=await this.#links(ownerId,[productId]);
    if(!links.has(productId)) throw new Error('TikTok không tạo được link affiliate cho sản phẩm này. Kiểm tra điều kiện publisher/chiến dịch và quyền truy cập.');
    return {productUrl:`https://shop.tiktok.com/view/product/${productId}`,affiliateUrl:links.get(productId)};
  }
  async topOffers(ownerId,{count=5,rank='rate',keyword=''}={}) {
    validateTopOptions({count,rank,keyword});
    await this.verify(ownerId);
    const products=[],seen=new Set();
    let cursor='',scanned=0;
    for(let page=0;page<10;page++) {
      const data=await this.#request(ownerId,TIKTOK_SEARCH,{page_size:20,sort_field:rank==='rate'?'commission_rate':'commission',sort_order:'DESC',...(cursor?{page_token:cursor}:{})},keyword?{title_keywords:[keyword]}:{});
      if(!Array.isArray(data.products) || data.products.length>20 || data.next_page_token!==undefined && typeof data.next_page_token!=='string') throw new Error('TikTok: dữ liệu danh sách sản phẩm không hợp lệ.');
      products.push(...data.products);scanned+=data.products.length;
      cursor=data.next_page_token || '';
      if(!cursor || !data.products.length || seen.has(cursor)) break;
      seen.add(cursor);
    }
    const selected=rankTikTokOffers(products,rank).slice(0,count);
    if(!selected.length) return {offers:[],scanned,limited:Boolean(cursor),rank,failed:0};
    const links=await this.#links(ownerId,selected.map(p=>p.id));
    const used=new Set();
    const offers=selected.filter(p=>{
      const link=links.get(p.id);
      if(!link || used.has(link)) return false;
      used.add(link);return true;
    }).map(p=>({...p,affiliateUrl:links.get(p.id)}));
    return {offers,scanned,limited:Boolean(cursor),rank,failed:selected.length-offers.length};
  }
}
