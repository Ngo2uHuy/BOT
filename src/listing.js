import { normalizeSearchText } from './input.js';

const QUEUE = ['pending','sending','sent','failed','uncertain','cancelled'];
const BLOCK = ['pending','running','interrupted','done','failed','stopped'];
const POSTS = {size:20,sort:'seen',dir:'desc',sorts:['seen','published','author','source'],filters:{source:'id',kind:['post','reel'],type:['group','profile'],hidden:['yes']}};
// One whitelist for the store (SQL), the desktop service (validation) and Telegram (`key:value` words).
export const LISTS = {
  comments:{size:20,sort:'id',dir:'desc',sorts:['id','time','state','source'],filters:{state:QUEUE,source:'id',mode:['manual','auto','tiktok']}},
  inboxes:{size:20,sort:'id',dir:'desc',sorts:['id','time','state','name','source'],filters:{state:QUEUE,source:'id',mode:['manual','auto']}},
  friends:{size:20,sort:'id',dir:'desc',sorts:['id','time','state','name','source'],filters:{state:QUEUE,source:'id',mode:['manual','auto']}},
  blocks:{size:20,sort:'id',dir:'desc',sorts:['id','time','state','source'],filters:{state:BLOCK,source:'id',mode:['manual','auto']}},
  posts:POSTS, rejected:POSTS,
  links:{size:10,sort:'updated',dir:'desc',sorts:['updated','id','origin'],filters:{}},
  sources:{size:20,sort:'id',dir:'asc',sorts:['id','name','scan','interval'],filters:{type:['group','profile'],status:['active','paused','error'],auto:['on','off']}},
  hot:{size:20,sort:'rank',dir:'asc',sorts:['rank','total','missed','interval','scan','name'],filters:{type:['group','profile'],status:['ok','error']}},
  joined:{size:15,sort:'order',dir:'asc',sorts:['order','name'],filters:{status:['new','added']}},
  // /search results: the query is free text matched by its own rules (slug, numeric ID, words).
  search:{size:20,sort:'rank',dir:'asc',sorts:['rank'],filters:{}},
};

// `strict` (desktop/Telegram input) rejects unknown values; the store falls back to defaults instead.
export function listQuery(kind,raw={},{strict=false}={}) {
  const spec=LISTS[kind];
  if(!spec) throw new Error('Danh sách không hỗ trợ.');
  const fail=message=>{if(strict) throw new Error(message);};
  const number=(value,fallback,max,name)=>{
    if(value==null || value==='') return fallback;
    const n=Number(value);
    if(Number.isSafeInteger(n) && n>=1 && n<=max) return n;
    fail(`${name} không hợp lệ (1–${max}).`);return fallback;
  };
  const page=number(raw.page,1,1000000,'Trang'),pageSize=number(raw.pageSize,spec.size,100,'Số dòng mỗi trang');
  let q='';
  if(raw.q!=null && typeof raw.q!=='string') fail('Từ khóa tìm kiếm không hợp lệ.');
  else q=String(raw.q ?? '').trim();
  if(q.length>200) {fail('Từ khóa tìm kiếm tối đa 200 ký tự.');q=q.slice(0,200);}
  const filters={};
  if(raw.filters!=null && (typeof raw.filters!=='object' || Array.isArray(raw.filters))) fail('Bộ lọc không hợp lệ.');
  else for(const [key,value] of Object.entries(raw.filters ?? {})) {
    if(value==null || value==='' || value==='all') continue;
    const allowed=Object.hasOwn(spec.filters,key) ? spec.filters[key] : null,text=String(value).toLowerCase();
    if(allowed==='id' && /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text))) filters[key]=Number(text);
    else if(Array.isArray(allowed) && allowed.includes(text)) filters[key]=text;
    else fail(allowed ? `${key} chỉ nhận ${allowed==='id' ? 'ID số' : allowed.join('|')}.` : `Không có bộ lọc ${String(key).slice(0,30)}.`);
  }
  let sort=spec.sort,dir=spec.dir;
  if(raw.sort!=null && raw.sort!=='') {if(spec.sorts.includes(raw.sort)) sort=raw.sort;else fail(`sort chỉ nhận ${spec.sorts.join('|')}.`);}
  if(raw.dir!=null && raw.dir!=='') {if(raw.dir==='asc' || raw.dir==='desc') dir=raw.dir;else fail('Chiều sắp xếp chỉ nhận asc|desc.');}
  return {page,pageSize,q,filters,sort,dir};
}

// Short values repeat a lot (error texts, source names), so their folded form is memoized.
const folded=new Map();
export function fold(value) {
  if(value==null) return null;
  const text=String(value);
  if(text.length>200) return normalizeSearchText(text);
  let result=folded.get(text);
  if(result===undefined) {
    if(folded.size>=5000) folded.clear();
    folded.set(text,result=normalizeSearchText(text));
  }
  return result;
}
// Folded text stored once per row (SQL `search_key`), so a search runs a plain LIKE instead of folding every row.
export const searchKey=(...values)=>fold(values.filter(value=>value!=null && value!=='').join('\n'));
// For `LIKE ? ESCAPE '\'`: % and _ typed by the user stay literal.
export const likePattern=q=>`%${fold(q).replace(/[\\%_]/g,'\\$&')}%`;
// A page past the end (rows removed since) shows the last page instead of an empty one.
export function pageInfo(total,query) {
  const pages=Math.max(1,Math.ceil(total/query.pageSize)),page=Math.min(query.page,pages);
  return {total,page,pages,pageSize:query.pageSize,hasMore:page<pages,offset:(page-1)*query.pageSize};
}

const MEMORY = {
  hot:{id:item=>item.id,search:item=>[item.name,item.url,item.id,item.numericId],
    sort:{rank:item=>item.rank,total:item=>item.total,missed:item=>item.missedByFeed,interval:item=>item.scanIntervalMs ?? -1,scan:item=>item.lastScanAt ?? -1,name:item=>fold(item.name || item.url)},
    filter:{type:(item,value)=>item.type===value,status:(item,value)=>(value==='error')===Boolean(item.lastError)}},
  joined:{id:item=>item.index,search:item=>[item.name,item.url,item.numericId],
    sort:{order:item=>item.index,name:item=>fold(item.name || item.url)},
    filter:{status:(item,value)=>(value==='added')===item.added}},
};
// Lists computed in memory (rankings, Facebook snapshots) get the same filter/sort/page shape as the SQL ones.
export function pageItems(kind,items,raw) {
  const query=listQuery(kind,raw),spec=MEMORY[kind],needle=query.q && fold(query.q),sign=query.dir==='desc' ? -1 : 1,key=spec.sort[query.sort];
  const list=items.filter(item=>Object.entries(query.filters).every(([name,value])=>spec.filter[name](item,value))
    && (!needle || spec.search(item).some(value=>value!=null && fold(value).includes(needle))))
    .sort((a,b)=>{const x=key(a),y=key(b);return ((x<y ? -1 : x>y ? 1 : 0) || spec.id(a)-spec.id(b))*sign;});
  const {offset,...info}=pageInfo(list.length,query);
  return {items:list.slice(offset,offset+query.pageSize),...info};
}

// Same ranking as /hot: useful posts, then all posts, then source ID; rank is global, before any filter.
// The profile parses a week of posts, so paging and the 5 s dashboard poll reuse it briefly.
const hotCache=new WeakMap();
export function hotItems(store,ownerId,maxAgeMs=30000) {
  const cache=hotCache.get(store) ?? new Map(),hit=cache.get(ownerId);
  if(hit && Date.now()-hit.at<maxAgeMs) return hit.items;
  const items=rankHot(store,ownerId);
  cache.set(ownerId,{at:Date.now(),items});hotCache.set(store,cache);
  return items;
}
function rankHot(store,ownerId) {
  return [...(store.activityProfile?.(ownerId) ?? new Map())].sort((a,b)=>b[1].recent-a[1].recent || b[1].total-a[1].total || a[0]-b[0]).map(([id,item],index)=>{
    const group=store.getGroup(id);
    return {id,rank:index+1,name:group.label || null,url:group.url,type:group.sourceType || 'group',numericId:group.numericId ?? null,useful:item.recent,total:item.total,
      missedByFeed:item.missed,scanIntervalMs:group.scanIntervalMs,lastScanAt:group.lastScanAt,lastError:group.lastError};
  });
}

// `/cmd [trang] [khóa:giá_trị …] [sort:khóa[-]] [từ khóa]`; unknown `x:y` words (links) stay in the search text.
export function parseListArgs(kind,text,defaults={}) {
  const spec=LISTS[kind],raw={...defaults,filters:{}},words=[];
  for(const [index,token] of String(text ?? '').trim().split(/\s+/).filter(Boolean).entries()) {
    const [,key,value]=token.match(/^([a-z]+):(.+)$/i) ?? [],name=key?.toLowerCase();
    if(index===0 && /^\d+$/.test(token)) raw.page=token;
    else if(name==='page') raw.page=value;
    else if(name==='sort') {const [,sort,sign]=value.match(/^(.*?)([+-]?)$/);raw.sort=sort.toLowerCase();raw.dir=sign==='-' ? 'desc' : 'asc';}
    else if(name && Object.hasOwn(spec.filters,name)) raw.filters[name]=value;
    else words.push(token);
  }
  raw.q=words.join(' ');
  return listQuery(kind,raw,{strict:true});
}
export function listUsage(kind,command=kind,first='[trang]') {
  const spec=LISTS[kind];
  return `Cú pháp: /${command} ${first} ${Object.entries(spec.filters).map(([key,values])=>`[${key}:${values==='id' ? 'ID' : values.join('|')}]`).join(' ')} [sort:${spec.sorts.join('|')}[-]] [từ khóa]`.replace(/\s+/g,' ');
}
function describeQuery(kind,query) {
  const spec=LISTS[kind],parts=Object.entries(query.filters).filter(([key])=>!query.fixed?.includes(key)).map(([key,value])=>`${key}:${value}`);
  if(query.sort!==spec.sort || query.dir!==spec.dir) parts.push(`sort:${query.sort}${query.dir==='desc' ? '-' : ''}`);
  if(query.q && !query.fixed?.includes('q')) parts.push(`tìm "${query.q}"`);
  return parts.join(' · ');
}

function truncate(value,limit) {
  const text=String(value ?? '');
  if(text.length<=limit) return text;
  let part=text.slice(0,limit-1);
  if(/[\uD800-\uDBFF]$/.test(part)) part=part.slice(0,-1);
  return `${part}…`;
}

// Lists whose rows can be removed one by one (store.removeListItem), with the /delete type word and what the owner is told first.
export const REMOVABLE={comments:['comment','bình luận'],inboxes:['inbox','tin nhắn riêng'],friends:['friend','lời mời kết bạn'],blocks:['block','lượt chặn người comment'],
  posts:['post','bài viết'],rejected:['rejected','bài bị loại'],links:['link','link affiliate'],sources:['source','nguồn']};
export const REMOVE_TYPES={...Object.fromEntries(Object.entries(REMOVABLE).map(([kind,[type]])=>[type,kind])),
  ...Object.fromEntries(Object.keys(REMOVABLE).map(kind=>[kind,kind])),dm:'inboxes',group:'sources'};
const SENT_NOTE='Đang chờ: hủy và xóa khỏi hàng đợi. Đã gửi/chưa xác nhận: chỉ ẩn khỏi danh sách (giữ lại để chống gửi lặp), không gỡ được trên Facebook. Đang gửi: chưa xóa được.';
const HIDE_NOTE='Chỉ ẩn khỏi danh sách: bot vẫn nhớ bài nên không thông báo, bình luận hay nhắn tin tự động lại. Xem lại bằng bộ lọc hidden:yes.';
export const REMOVE_NOTES={comments:SENT_NOTE,inboxes:SENT_NOTE,friends:SENT_NOTE,
  blocks:'Xóa lượt chặn; người đã chặn không bị bỏ chặn. Lượt đang chạy: dừng bằng /cancelblocks trước. Nguồn đang bật /autoblock có thể tạo lại lượt chặn cho bài còn mới khi quét lại hoặc khi bật lại.',
  posts:HIDE_NOTE,rejected:HIDE_NOTE,links:'Xóa link khỏi thư viện. Bình luận đã xếp hàng/đã đăng giữ nguyên nội dung link.',
  sources:'Xóa nguồn, bài đã lưu và hàng đợi liên quan trong bot. Bình luận đã đăng trên Facebook vẫn còn.'};
// Posts are keyed by source and post ID (`3 123` or `3:123`), every other list by its numeric ID.
export function removalKey(kind,value) {
  const text=String(value ?? '').trim();
  if(kind==='posts' || kind==='rejected') {
    const [,group,post]=text.match(/^([1-9]\d{0,15})[\s:]+([A-Za-z0-9_-]{1,200})$/) ?? [];
    if(!group || !Number.isSafeInteger(Number(group))) throw new Error('Cần ID_nguồn và ID_bài, ví dụ: 3 1234567890.');
    return {groupId:Number(group),postId:post};
  }
  if(!/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('ID không hợp lệ.');
  return Number(text);
}
const removalLabel=(kind,key)=>typeof key==='object' ? `${key.postId} (nguồn #${key.groupId})` : `#${key}`;
export function removalText(kind,key,{action}) {
  const [type,name]=REMOVABLE[kind],label=removalLabel(kind,key);
  if(action==='restored') return `Đã bỏ ẩn ${name} ${label}.`;
  if(action==='deleted') return `Đã xóa ${name} ${label}.`;
  return typeof key==='object' ? `Đã ẩn ${name} ${label}. Bot vẫn nhớ bài nên không gửi hay tự động lại. Bỏ ẩn: /unhide ${type} ${key.groupId} ${key.postId}`
    : `Đã ẩn ${name} ${label} khỏi danh sách: mục đã gửi được giữ để chống gửi lặp, không gỡ được trên Facebook.`;
}
const rowKey=(kind,item)=>kind==='posts' || kind==='rejected' ? {groupId:item.groupId,postId:String(item.id)} : item.id;

const pagers=new WeakMap();
// One pager per bot: the filters live in memory per owner, so callback data only carries a short token and the page.
export function listPager(bot) {
  if(pagers.has(bot)) return pagers.get(bot);
  const renderers=new Map(),sessions=new Map(),marks=new Map();
  let seq=Math.floor(Math.random()*36**4),markSeq=seq;
  // A 🗑 button names the exact row it was drawn for (kept here), so a list that changed since cannot shift it to another row.
  function mark(owner,kind,item,token,page,restore) {
    const id=(++markSeq).toString(36),key=rowKey(kind,item);
    marks.set(id,{owner,kind,key,token,page,restore});
    if(marks.size>3000) marks.delete(marks.keys().next().value);
    const label=typeof key==='object' ? truncate(key.postId,14) : `#${key}`;
    return {text:`${restore ? '♻️' : '🗑'} ${label}`,callback_data:`ld:${id}`};
  }
  async function show(ctx,token,session,editId=null) {
    const {render,kind}=renderers.get(session.name),view=await render(ctx,session.query);
    if(typeof view==='string') return ctx.reply(view);
    const {result}=view,filtered=describeQuery(kind,session.query);
    const lines=[`${view.title} · Trang ${result.page}/${result.pages} · tổng ${result.total}${filtered ? `\nĐang áp dụng: ${filtered}` : ''}`,
      ...(view.lines.length ? view.lines : [filtered ? 'Không có mục phù hợp bộ lọc/tìm kiếm.' : view.empty]),...(view.footer ?? [])];
    const nav=[];
    if(result.page>2) nav.push(['⏮',1]);
    if(result.page>1) nav.push(['◀️',result.page-1]);
    if(result.page<result.pages) nav.push(['▶️',result.page+1]);
    if(result.page<result.pages-1) nav.push(['⏭',result.pages]);
    // `keyboard` rows (e.g. one button per source) go above the page buttons, `after` rows below them;
    // `remove` (a REMOVABLE kind) adds one 🗑 button per row of the page between the two.
    const removeButtons=view.remove ? result.items.slice(0,40).map(item=>mark(ctx.from.id,view.remove,item,token,result.page,Boolean(session.query.filters?.hidden))) : [];
    const removeRows=Array.from({length:Math.ceil(removeButtons.length/4)},(_,index)=>removeButtons.slice(index*4,index*4+4));
    const rows=[...(view.keyboard ?? []),...(nav.length ? [nav.map(([text,page])=>({text,callback_data:`lp:${token}:${page}`}))] : []),...removeRows,...(view.after ?? [])];
    const markup=rows.length ? {inline_keyboard:rows} : undefined;
    const messages=[];
    let message='';
    for(const line of lines) {
      const value=truncate(line,3500);
      if(message && message.length+value.length+1>3900) {messages.push(message);message='';}
      message+=`${message ? '\n' : ''}${value}`;
    }
    messages.push(message);
    // After a removal the list message itself is redrawn when it fits one message; otherwise a new copy is sent.
    if(editId && messages.length===1) {
      try {return await ctx.api.editMessageText(ctx.chat.id,editId,messages[0],{link_preview_options:{is_disabled:true},reply_markup:markup ?? {inline_keyboard:[]}});}
      catch {/* Too old or deleted: send it again. */}
    }
    for(const [index,text] of messages.entries()) await ctx.reply(text,{link_preview_options:{is_disabled:true},...(markup && index===messages.length-1 ? {reply_markup:markup} : {})});
  }
  bot.callbackQuery(/^lp:([a-z0-9]{1,12}):(\d{1,7})$/,async ctx=>{
    const session=sessions.get(ctx.match[1]);
    if(!session || session.owner!==ctx.from.id) return ctx.answerCallbackQuery({text:'Danh sách đã hết hạn. Gửi lại lệnh để xem.',show_alert:true});
    await ctx.answerCallbackQuery();
    return show(ctx,ctx.match[1],{...session,query:{...session.query,page:Number(ctx.match[2])}});
  });
  const pager={
    // `name` keys the renderer, so two commands can page the same list kind (Shopee and TikTok links).
    define(name,render,kind=name) {renderers.set(name,{render,kind});},
    open(ctx,name,query) {
      const token=(++seq).toString(36);
      sessions.set(token,{owner:ctx.from.id,name,query});
      if(sessions.size>500) sessions.delete(sessions.keys().next().value);
      return show(ctx,token,sessions.get(token));
    },
    marked(id,owner) {const found=marks.get(id);return found?.owner===owner ? found : null;},
    forget(id) {marks.delete(id);},
    // Redraws the page a 🗑 button came from; false when that list session expired.
    async refresh(ctx,found) {
      const session=sessions.get(found.token);
      if(!session || session.owner!==ctx.from.id) return false;
      await show(ctx,found.token,{...session,query:{...session.query,page:found.page}},found.messageId);
      return true;
    },
    command(ctx,name,text,{defaults,usage}={}) {
      const {kind}=renderers.get(name);
      let query;
      try {query=parseListArgs(kind,text,defaults);}
      catch(error) {return ctx.reply(`${error.message}\n${usage || listUsage(kind,name)}`);}
      return pager.open(ctx,name,query);
    },
  };
  pagers.set(bot,pager);
  return pager;
}
