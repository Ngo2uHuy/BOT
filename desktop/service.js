import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Store } from '../src/store.js';
import { zaloPhones } from '../src/zalo.js';
import { normalizeAuthorUrl } from '../src/facebook.js';
import { isAnonymousAuthor } from '../src/direct-messages.js';
import { commenterBlockLabel } from '../src/post-buttons.js';
import { commenterBlockWaits } from '../src/commenter-block.js';
import { FacebookCollector, profileDirectory } from '../src/facebook.js';
import { launchLoginBrowser, saveHttpSession } from '../src/facebook-http.js';
import { createBot, prepareBot, BOT_COMMANDS } from '../src/bot.js';
import { Monitor } from '../src/monitor.js';
import { ShopeeAffiliate } from '../src/affiliate.js';
import { TikTokAffiliate } from '../src/tiktok-affiliate.js';
import { acquireDesktopLock } from './lock.js';
import { desktopConfig, readSettings, publicSettings, settingsUpdate, writeSettings } from './settings.js';
import { listQuery, pageItems, hotItems, REMOVABLE, removalKey, removalText } from '../src/listing.js';

function positive(value,name='ID') {
  const number=Number(value);
  if(!Number.isSafeInteger(number) || number<1) throw new Error(`${name} không hợp lệ.`);
  return number;
}
// Renderer input is untrusted: unknown filters, sort keys or directions are rejected rather than ignored.
const listArgs=(kind,{page,pageSize,q,filters,sort,dir}={})=>listQuery(kind,{page,pageSize,q,filters,sort,dir},{strict:true});

/** Local facade: no Telegram polling or sends. The existing bot handles command
 * validation; real Facebook writes only occur after explicit runtime.start. */
// Routine progress stays "info"; failures, limits and slowdowns are surfaced as warnings in the UI.
export function logLevel(message) {
  return /thất bại|lỗi|không đọc được|không gửi được|chưa gửi được|giới hạn|tạm hoãn|tốc độ|đăng xuất|rate.?limit|checkpoint|HTTP [45]\d\d|→ (?:rate_limited|login|schema)/i.test(String(message)) ? 'warning' : 'info';
}

export class DesktopService {
  constructor({baseDir=process.env.DESKTOP_WORKSPACE || process.cwd(),env=process.env,emit=()=>{},collectorFactory=config=>new FacebookCollector(config),monitorFactory=options=>new Monitor(options),shopeeFactory=config=>new ShopeeAffiliate(config),tiktokFactory=config=>new TikTokAffiliate(config),telegramFactory=options=>createBot(options),chromium}={}) {
    Object.assign(this,{baseDir:path.resolve(baseDir),inherited:env,emit,collectorFactory,monitorFactory,shopeeFactory,tiktokFactory,telegramFactory,chromium});
    this.logs=[];this.running=false;this.closed=false;this.context=new AsyncLocalStorage();
    this.telegram=null;this.telegramRun=null;this.telegramError=null;this.changedTimer=null;
    this.nextMessageId=-Date.now();this.nextUpdateId=0;this.activeCommand=false;
  }
  redact(value) {
    let message=String(value ?? '');
    for(const key of ['TELEGRAM_BOT_TOKEN','SHOPEE_AFFILIATE_SECRET','TIKTOK_AFFILIATE_APP_SECRET','TIKTOK_AFFILIATE_ACCESS_TOKEN']) {
      const value=this.env?.[key];
      if(value) message=message.split(value).join('[ẨN]');
    }
    return message.replace(/\d{5,}:[A-Za-z0-9_-]+/g,'[TOKEN]');
  }
  safe(error) {return this.redact(typeof error==='string'?error:error?.description || error?.message || 'Lỗi không xác định').slice(0,500);}
  log(message,level='info') {
    const entry={at:new Date().toISOString(),level,message:this.safe(message)};
    this.logs.push(entry);if(this.logs.length>250) this.logs.shift();
    this.emit({event:'log',data:entry});
    if(this.running) this.changed();
  }
  // Telegram and the scan loops write the shared store; tell the UI to reload (throttled).
  changed() {
    if(this.changedTimer) return;
    this.changedTimer=setTimeout(()=>{this.changedTimer=null;this.emit({event:'changed'});},1000);
    this.changedTimer.unref?.();
  }
  async init() {
    if(this.store) return this.bootstrap();
    await mkdir(this.baseDir,{recursive:true});
    const {content,env}=await readSettings(this.baseDir,this.inherited);
    this.content=content;this.env=env;
    try {this.config=desktopConfig(env,this.baseDir);}
    catch(error) {
      this.configError=this.safe(error);
      // Open the settings screen even when optional API configuration is partial.
      const fallback={DATA_DIR:env.DATA_DIR};
      if(/^[1-9]\d*(?:\s*,\s*[1-9]\d*)*$/.test(env.ALLOWED_TELEGRAM_USER_IDS || '')) fallback.ALLOWED_TELEGRAM_USER_IDS=env.ALLOWED_TELEGRAM_USER_IDS;
      try {this.config=desktopConfig(fallback,this.baseDir);} catch {this.config=desktopConfig({DATA_DIR:env.DATA_DIR},this.baseDir);}
    }
    this.release=await acquireDesktopLock(this.config.dataDir);
    try {
      this.store=new Store(path.join(this.config.dataDir,'monitor.sqlite'));
      const count=this.store.initStartupDateRange();
      this.configure();
      if(count>0) this.log(`Đã khởi tạo bộ lọc thời gian từ hiện tại đến tương lai cho ${count} nguồn.`);
    }
    catch(error) {this.store?.close();this.store=null;await this.release();this.release=null;throw error;}
    this.log('Desktop sẵn sàng. Chưa bắt đầu quét hoặc đăng bình luận.');
    if(this.configError) this.log(this.configError,'warning');
    return this.bootstrap();
  }
  newCollector() {return this.collectorFactory({...this.config,log:message=>this.log(message,logLevel(message))});}
  configure() {
    for(const owner of this.config.allowedUserIds) this.store.ensureUser(owner,owner);
    this.ownerId=this.config.allowedUserIds.includes(this.ownerId)?this.ownerId:this.config.allowedUserIds[0];
    this.collector=this.newCollector();
    this.shopee=this.shopeeFactory(this.config.shopeeAffiliate);
    this.tiktok=this.tiktokFactory(this.config.tiktokAffiliate);
    this.bot=createBot({token:'123456:desktop_local_only',allowedUserIds:this.config.allowedUserIds,store:this.store,
      collector:this.botCollector(),affiliate:this.shopee,tiktokAffiliate:this.tiktok,log:message=>this.log(message,logLevel(message)),...this.blockHooks()});
    this.bot.botInfo={id:123456,is_bot:true,first_name:'Affiliate Desktop',username:'affiliate_desktop_bot'};
    this.bot.api.config.use(async(_previous,method,payload)=>{
      const messageId=payload.message_id ?? --this.nextMessageId;
      const text=this.redact(payload.text || payload.caption || '');
      const messages=this.context.getStore();
      if(['sendMessage','editMessageText','sendPhoto','sendVideo'].includes(method)) {
        const message={text,messageId,buttons:payload.reply_markup?.inline_keyboard || [],forceReply:Boolean(payload.reply_markup?.force_reply)};
        if(messages) messages.push(message);else if(text) this.log(text);
        return {ok:true,result:{message_id:messageId,date:Math.floor(Date.now()/1000),chat:{id:payload.chat_id,type:'private'},text}};
      }
      if(method==='answerCallbackQuery') {
        if(text && messages) messages.push({text,messageId,buttons:[]});
        return {ok:true,result:true};
      }
      // Never delegate to previous: even unexpected API methods stay local.
      throw new Error('Thao tác Telegram này không có trong desktop.');
    });
  }
  // Queue position/wait reasons need the live monitor; when it is stopped only the store-side reasons are known.
  blockWaits(owner,options={}) {
    const stopped=!this.running,hook=this.monitor?.commenterBlockWaits;
    return hook ? hook.call(this.monitor,owner,{...options,stopped}) : commenterBlockWaits(this.store,owner,{...options,stopped});
  }
  blockHooks() {return {blockWaits:(owner,options)=>this.blockWaits(owner,options),blockProgress:id=>this.monitor?.commenterBlockProgress?.(id) ?? null};}
  botCollector() {
    return {joinedGroups:owner=>{if(this.loginContext) throw new Error('Đóng cửa sổ đăng nhập trước.');return this.collector.joinedGroups(owner);},
        blockUser:(owner,url,canSubmit)=>{if(this.loginContext) throw Object.assign(new Error('Đóng cửa sổ đăng nhập trước.'),{commentSubmitted:false});return this.collector.blockUser(owner,url,canSubmit);},
        collectCommentContacts:(owner,url)=>{if(this.loginContext) throw new Error('Đóng cửa sổ đăng nhập trước.');return this.collector.collectCommentContacts(owner,url);},
        clearCooldown:owner=>this.collector.clearCooldown?.(owner)};
  }
  owner(value) {
    const owner=positive(value ?? this.ownerId,'Tài khoản');
    if(!this.config.allowedUserIds.includes(owner)) throw new Error('Tài khoản không có trong danh sách được cấu hình.');
    return owner;
  }
  runtime() {return {running:this.running,loginOpen:Boolean(this.loginContext),loginOwnerId:this.loginOwnerId ?? null,telegramRunning:Boolean(this.telegram?.isRunning()),telegramConfigured:Boolean(this.env?.TELEGRAM_BOT_TOKEN?.trim()),telegramError:this.telegramError,mode:this.telegram?'telegram':'local',error:this.configError || null,dataDir:this.config.dataDir};}
  // `logs:false` skips the 250-line buffer the renderer already holds (it is sent again only on a fresh start).
  bootstrap({ownerId,logs=true}={}) {
    const owner=this.owner(ownerId);this.ownerId=owner;
    return {owners:this.config.allowedUserIds,ownerId:owner,sources:this.store.listGroups(owner),stats:this.store.status(owner),runtime:this.runtime(),
      settings:publicSettings(this.env),logs:logs===false?[]:this.logs,commands:BOT_COMMANDS,keywords:this.store.getKeywords(owner),rejectKeywords:this.store.getRejectKeywords?.(owner) || [],rejectedSince:this.store.getRejectedNotify(owner),affiliate:{shopee:Boolean(this.shopee.accountKey(owner)),tiktok:Boolean(this.tiktok.accountKey(owner))}};
  }
  async command({text,ownerId,replyToMessageId}={}) {
    if(typeof text!=='string' || !text.trim() || text.length>1048576) throw new Error('Nhập nội dung lệnh hợp lệ (tối đa 1 MB).');
    if(this.activeCommand) throw new Error('Đang xử lý thao tác trước. Vui lòng chờ hoàn tất.');
    const owner=this.owner(ownerId),command=text.match(/^\/\S+/)?.[0],messages=[];
    const message={message_id:--this.nextMessageId,date:Math.floor(Date.now()/1000),chat:{id:owner,type:'private'},from:{id:owner,is_bot:false,first_name:'Desktop'},text,entities:command?[{type:'bot_command',offset:0,length:command.length}]:[]};
    if(replyToMessageId!=null) message.reply_to_message={message_id:Number(replyToMessageId),date:0,chat:message.chat};
    this.activeCommand=true;
    try {await this.context.run(messages,()=>this.bot.handleUpdate({update_id:++this.nextUpdateId,message}));}
    finally {this.activeCommand=false;}
    this.emit({event:'state',data:this.runtime()});
    return {messages};
  }
  async callback({data,messageId,ownerId}={}) {
    if(typeof data!=='string' || data.length>128) throw new Error('Nút không hợp lệ.');
    if(this.activeCommand) throw new Error('Đang xử lý thao tác trước.');
    const owner=this.owner(ownerId),messages=[];
    this.activeCommand=true;
    try {await this.context.run(messages,()=>this.bot.handleUpdate({update_id:++this.nextUpdateId,callback_query:{id:String(this.nextUpdateId),chat_instance:'desktop',from:{id:owner,is_bot:false,first_name:'Desktop'},data,message:{message_id:Number(messageId)||--this.nextMessageId,date:0,chat:{id:owner,type:'private'}}}}));}
    finally {this.activeCommand=false;}
    return {messages};
  }
  // `sourceId` is the older argument for filters.source.
  posts({ownerId,sourceId='all',...args}={}) {
    const owner=this.owner(ownerId),filters=sourceId==='all'||sourceId==null?args.filters:{...args.filters,source:positive(sourceId,'Nguồn')};
    const result=this.store.pagePosts(owner,listArgs('posts',{...args,filters}));
    // One job query and one queue-position pass for the whole page instead of per card.
    const jobs=new Map(this.store.commenterBlocksByUrls(owner,result.items.map(post=>post.url).filter(Boolean)).map(job=>[job.postUrl,job]));
    const waiting=[...jobs.values()].filter(job=>job.state==='pending' || job.state==='interrupted');
    const waits=new Map(waiting.length ? this.blockWaits(owner,{jobs:waiting}).map(job=>[job.id,job.wait]) : []);
    return {...result,items:result.items.map(post=>{const job=jobs.get(post.url) ?? null;return {...post,...this.postExtras(owner,post,job,waits.get(job?.id) ?? null)};})};
  }
  // Same visibility rules as the Telegram post buttons (post-buttons.js): profile only for non-anonymous authors.
  postExtras(owner,post,job,wait) {
    const profileUrl=(!post.author || !isAnonymousAuthor(post.author)) ? normalizeAuthorUrl(post.authorUrl) : null;
    const active=job?.state==='pending' || job?.state==='running',result=job?.result;
    const commenterBlock={label:commenterBlockLabel(job),state:job?.state ?? null,runAt:job?.runAt ?? null,error:job?.error ?? null,waitingRuntime:Boolean(active && !this.running),wait:wait && {position:wait.position,total:wait.total,running:wait.running,workers:wait.workers,reason:wait.reason,until:wait.until,text:wait.text},
      progress:active ? this.monitor?.commenterBlockProgress?.(job.id) ?? null : null,
      result:result ? Object.fromEntries(['blocked','skipped','unknown','unresolved','uncertain','failed','pending','scanned','noComments','incomplete','retries'].filter(key=>result[key]!=null).map(key=>[key,result[key]])) : null};
    return {zaloPhones:zaloPhones(post),profileUrl,commenterBlock};
  }
  rejected({ownerId,...args}={}) {
    const owner=this.owner(ownerId),result=this.store.pageRejected(owner,listArgs('rejected',args));
    const items=result.items.map(post=>{const profileUrl=(!post.author || !isAnonymousAuthor(post.author)) ? normalizeAuthorUrl(post.authorUrl) : null;
      return {...post,profileUrl,authorState:profileUrl ? this.store.authorBlockState(owner,profileUrl) ?? null : null};});
    return {...result,items,since:this.store.getRejectedNotify(owner)};
  }
  // Telegram maps a notification message to its post; desktop maps a synthetic message so the owner-checked callbacks can be reused.
  async postCallback({ownerId,groupId,postId,mode='single',data}={}) {
    if(!['post:block-commenters','rejected:block'].includes(data) || (data==='rejected:block')!==(mode==='rejected')) throw new Error('Thao tác không hợp lệ.');
    const owner=this.owner(ownerId),messageId=--this.nextMessageId;
    this.store.mapMessage(owner,owner,messageId,positive(groupId,'Nguồn'),String(postId),mode);
    if(!this.store.replyTarget(owner,owner,messageId)) throw new Error('Bài viết không còn trong dữ liệu của bạn.');
    return this.callback({data,messageId,ownerId:owner});
  }
  retryBlocks({ownerId,id}={}) {
    const count=this.store.retryCommenterBlocks(this.owner(ownerId),id == null ? null : positive(id,'Lượt chặn'));
    return {count,message:`Đã đưa ${count} lượt chặn về hàng đợi thử lại.`};
  }
  comments({ownerId,...args}={}) {return this.store.pageComments(this.owner(ownerId),listArgs('comments',args));}
  inboxes({ownerId,...args}={}) {return this.store.pageDirectMessages(this.owner(ownerId),listArgs('inboxes',args));}
  friends({ownerId,...args}={}) {return this.store.pageFriendRequests(this.owner(ownerId),listArgs('friends',args));}
  sources({ownerId,...args}={}) {return this.store.pageGroups(this.owner(ownerId),listArgs('sources',args));}
  blocks({ownerId,...args}={}) {
    const owner=this.owner(ownerId),page=this.store.pageCommenterBlocks(owner,listArgs('blocks',args));
    return {...page,items:this.blockWaits(owner,{jobs:page.items}).map(({chatId,messageId,result,...job})=>({...job,result:result && Object.fromEntries(['blocked','skipped','unknown','unresolved','uncertain','failed','pending','scanned','noComments','incomplete'].filter(key=>result[key]!=null).map(key=>[key,result[key]])),
      progress:job.state==='running' ? this.monitor?.commenterBlockProgress?.(job.id) ?? null : null}))};
  }
  // Spam-resistant activity ranking (same numbers as /hot) with each source's planned rescan interval; `limit` is the older pageSize.
  hot({ownerId,limit,...args}={}) {
    const owner=this.owner(ownerId);
    return pageItems('hot',hotItems(this.store,owner),listArgs('hot',{...args,pageSize:args.pageSize ?? limit}));
  }
  // The Facebook snapshot lives in the local bot (/joined, /select); load it once, then page it here.
  async joined({ownerId,refresh=false,...args}={}) {
    const owner=this.owner(ownerId),query=listArgs('joined',args);
    if(refresh!==false && refresh!==true) throw new Error('Tham số làm mới không hợp lệ.');
    if(refresh || !this.bot.joinedList(owner,query)) await this.command({ownerId:owner,text:refresh?'/joined refresh':'/joined'});
    return this.bot.joinedList(owner,query) ?? {items:[],total:0,page:1,pages:1,pageSize:query.pageSize,hasMore:false,limited:false,unavailable:true};
  }
  // Scan engine state for the dashboard: request pacing, feed lane and the last activity plan.
  health({ownerId}={}) {
    const owner=this.owner(ownerId),limiter=this.collector?.graphql?.limiter;
    const plan=this.monitor?.plans?.get(owner),feed=this.monitor?.feeds?.get(owner);
    const intervals=plan?[...plan.intervals.values()].sort((a,b)=>a-b):[];
    return {running:this.running,scanMode:this.config.scanMode,browserless:this.config.browserless,
      cooldown:this.collector?.canScan ? !this.collector.canScan(owner,false) : false,
      slowdown:limiter?.slowdown?.(owner) ?? 1,deferredUntil:(this.monitor?.deferredOwners?.get(owner) ?? 0)>Date.now()?this.monitor.deferredOwners.get(owner):null,
      maxPerHour:this.config.apiMaxRequestsPerHour,usedLastHour:limiter?.usedLastHour?.(owner) ?? null,feedPollMs:this.config.feedPollMs,feedWatermark:feed?.watermark ?? null,
      plan:plan?{at:plan.at,groups:intervals.length,fastestMs:intervals[0] ?? null,medianMs:intervals[intervals.length>>1] ?? null,slowestMs:intervals.at(-1) ?? null}:null};
  }
  links({ownerId,provider='shopee',...args}={}) {
    const owner=this.owner(ownerId),query=listArgs('links',args);
    if(!['shopee','tiktok'].includes(provider)) throw new Error('Chọn Shopee hoặc TikTok.');
    const key=this[provider].accountKey(owner);
    if(!key) return {items:[],total:0,page:1,pages:1,pageSize:query.pageSize,hasMore:false};
    const result=this.store.pageAffiliateLinks(owner,key,query);
    return {...result,items:result.items.map(({account_key,owner_id,...item})=>item)};
  }
  // One row of a list: the same store call and wording as /delete and the 🗑 buttons in Telegram.
  remove({ownerId,list,id,restore=false}={}) {
    const owner=this.owner(ownerId);
    if(typeof list!=='string' || !Object.hasOwn(REMOVABLE,list)) throw new Error('Danh sách không hỗ trợ xóa.');
    if(typeof restore!=='boolean' || (typeof id!=='string' && typeof id!=='number')) throw new Error('Mục cần xóa không hợp lệ.');
    const key=removalKey(list,id),result=this.store.removeListItem(list,owner,key,{restore});
    this.changed();
    return {...result,message:removalText(list,key,result)};
  }
  async saveSettings({values={},clearSecrets=[]}={}) {
    if(this.running || this.loginContext || this.activeCommand) throw new Error('Dừng hệ thống và hoàn tất thao tác đang chạy trước khi lưu cấu hình.');
    const latest=await readSettings(this.baseDir,this.inherited),update=settingsUpdate(latest.env,values,clearSecrets);
    const config=desktopConfig(update.env,this.baseDir);
    // Acquire a new lock before committing a DATA_DIR change. The old database
    // remains untouched if the target directory belongs to a running process.
    const moved=config.dataDir!==this.config.dataDir;
    let release,store;
    if(moved) {
      release=await acquireDesktopLock(config.dataDir);
      try {store=new Store(path.join(config.dataDir,'monitor.sqlite'));}
      catch(error) {await release();throw error;}
    }
    try {await writeSettings(this.baseDir,latest.content,update.changes);}
    catch(error) {store?.close();await release?.();throw error;}
    await this.collector.close();
    if(moved) {this.store.close();await this.release();this.store=store;this.release=release;}
    this.env=update.env;this.config=config;this.configError=null;
    this.configure();this.log('Đã lưu cấu hình. Hệ thống vẫn đang dừng.');
    return this.bootstrap();
  }
  async start() {
    if(this.configError) throw new Error(`Cần sửa cấu hình: ${this.configError}`);
    if(this.loginContext || this.activeCommand) throw new Error('Hoàn tất đăng nhập hoặc thao tác đang chạy trước.');
    if(this.running) return this.runtime();
    if(this.monitor) await this.stop();
    await this.collector.validateSessions?.(this.config.allowedUserIds);
    const count=this.store.initStartupDateRange(Date.now(),{all:false});
    if(count>0) this.log(`Đã cập nhật bộ lọc thời gian từ hiện tại cho ${count} nguồn.`);
    let api={sendMessage:async(_chat,text)=>{this.log(text);return {message_id:--this.nextMessageId};}},telegram=null;
    this.telegramError=null;
    const token=this.env.TELEGRAM_BOT_TOKEN?.trim();
    if(token) {
      // A bad token, webhook or 409 must not block scanning: fall back to local mode and report it.
      try {
        telegram=this.telegramFactory({token,allowedUserIds:this.config.allowedUserIds,store:this.store,collector:this.botCollector(),affiliate:this.shopee,tiktokAffiliate:this.tiktok,log:message=>this.log(message,logLevel(message)),...this.blockHooks()});
        await prepareBot(telegram);
        api=telegram.api;
      } catch(error) {
        telegram=null;this.telegramError=this.safe(error);
        this.log(`Telegram không khởi động được, tiếp tục ở chế độ cục bộ: ${this.telegramError}`,'warning');
      }
    }
    this.monitor=this.monitorFactory({store:this.store,collector:this.collector,api,config:this.config,tiktokAffiliate:this.tiktok,log:message=>this.log(message,logLevel(message)),onChange:()=>this.changed()});
    // Without Telegram keep outbox/message IDs intact for the CLI bot to deliver later.
    if(!telegram) this.monitor.deliveryLoop=async()=>{};
    else this.runTelegram(telegram);
    this.running=true;
    this.monitorRun=this.monitor.start().catch(error=>{this.log(error,'error');this.monitor?.abort.abort();this.running=false;this.emit({event:'state',data:this.runtime()});});
    this.log(`Đã bắt đầu quét Facebook và xử lý hàng đợi bình luận.${this.telegram?' Bot Telegram đang chạy.':''}`);
    this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  runTelegram(telegram) {
    const handle=telegram.handleUpdate.bind(telegram);
    telegram.handleUpdate=async update=>{try {return await handle(update);} finally {this.changed();}};
    this.telegram=telegram;
    this.telegramRun=telegram.start({allowed_updates:['message','callback_query']}).catch(error=>{
      if(this.telegram!==telegram) return;
      this.telegramError=this.safe(error);
      this.log(`Telegram dừng: ${this.telegramError}`,'error');
      this.emit({event:'state',data:this.runtime()});
    });
  }
  async stopTelegram() {
    const telegram=this.telegram,run=this.telegramRun;
    this.telegram=null;this.telegramRun=null;
    if(telegram?.isRunning()) await telegram.stop().catch(()=>{});
    await run;
  }
  async stop() {
    if(!this.monitor && !this.running) return this.runtime();
    this.running=false;
    this.monitor?.abort.abort();this.monitor?.commentWake?.();
    await this.stopTelegram();
    await this.collector.close();
    await this.monitorRun;
    this.monitor=null;this.monitorRun=null;
    this.collector=this.newCollector();
    this.log('Đã dừng quét và xử lý bình luận.');this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  async loginOpen({ownerId}={}) {
    const owner=this.owner(ownerId);
    if(this.running || this.activeCommand) throw new Error('Dừng hệ thống trước khi đăng nhập Facebook.');
    if(this.loginContext) {
      if(this.loginOwnerId!==owner) throw new Error('Đóng cửa sổ đăng nhập hiện tại trước khi chọn tài khoản khác.');
      return this.runtime();
    }
    await this.collector.close();
    this.collector=this.newCollector();
    const profile=profileDirectory(this.config.dataDir,owner);await mkdir(profile,{recursive:true,mode:0o700});
    const chromium=this.chromium || (await import('playwright')).chromium;
    let context;
    try {
      context=await launchLoginBrowser(chromium,profile);
      this.loginContext=context;this.loginOwnerId=owner;
      context.on('close',()=>{if(this.loginContext===context){this.loginContext=null;this.loginOwnerId=null;this.emit({event:'state',data:this.runtime()});}});
      const page=context.pages()[0] || await context.newPage();
      await page.goto('https://www.facebook.com/',{waitUntil:'domcontentloaded',timeout:45000});
    } catch {
      await context?.close().catch(()=>{});this.loginContext=null;this.loginOwnerId=null;
      throw new Error('Không mở được Facebook. Cài Google Chrome (hoặc Chromium bằng npm run install-browser) và kiểm tra kết nối mạng.');
    }
    this.log(`Đã mở cửa sổ đăng nhập Facebook cho tài khoản ${owner}. Hoàn tất thủ công rồi chọn Lưu phiên.`);
    this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  async loginFinish() {
    const context=this.loginContext;
    if(!context) throw new Error('Chưa mở cửa sổ đăng nhập.');
    const cookies=await context.cookies('https://www.facebook.com');
    if(!cookies.some(cookie=>cookie.name==='c_user' && cookie.value)) throw new Error('Chưa đăng nhập Facebook. Hoàn tất trong cửa sổ trình duyệt.');
    if(context.pages().some(page=>/\/(checkpoint|challenge|two_step_verification)(\/|$)/i.test(new URL(page.url()).pathname))) throw new Error('Facebook còn yêu cầu xác minh. Hoàn tất thủ công trước khi lưu phiên.');
    // The browserless lane runs on these cookies alone, so the login window is only needed once.
    const tab=context.pages()[0];
    const userAgent=tab?.evaluate ? await tab.evaluate(()=>navigator.userAgent).catch(()=>null) : null;
    try{await saveHttpSession(this.config.dataDir,this.loginOwnerId,{cookies,userAgent});}
    catch{throw new Error('Phiên Facebook thiếu cookie c_user/xs. Hoàn tất đăng nhập trong cửa sổ trình duyệt.');}
    await this.loginCancel();this.log('Đã lưu phiên Facebook (cookie dùng cho HTTP-only). Có thể bắt đầu hệ thống.');return this.runtime();
  }
  async loginCancel() {
    const context=this.loginContext;this.loginContext=null;this.loginOwnerId=null;
    await context?.close();this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  async call(method,args={}) {
    if(this.closed) throw new Error('Ứng dụng đang đóng.');
    if(this.shuttingDown && ['command','callback','postCallback','retryBlocks','joined','settings.save','runtime.start','login.open'].includes(method)) throw new Error('Ứng dụng đang đóng.');
    if(!this.store) await this.init();
    switch(method) {
      case 'init':case 'state':case 'bootstrap':return this.bootstrap(args);
      case 'command':return this.command(args);
      case 'callback':return this.callback(args);
      case 'sources':return this.sources(args);
      case 'joined':return this.joined(args);
      case 'posts':return this.posts(args);
      case 'rejected':return this.rejected(args);
      case 'postCallback':return this.postCallback(args);
      case 'comments':return this.comments(args);
      case 'inboxes':return this.inboxes(args);
      case 'friends':return this.friends(args);
      case 'blocks':return this.blocks(args);
      case 'retryBlocks':return this.retryBlocks(args);
      case 'hot':return this.hot(args);
      case 'health':return this.health(args);
      case 'links':return this.links(args);
      case 'remove':return this.remove(args);
      case 'settings.get':return publicSettings(this.env);
      case 'settings.save':return this.saveSettings(args);
      case 'runtime.start':return this.start(args);
      case 'runtime.stop':return this.stop();
      case 'login.open':return this.loginOpen(args);
      case 'login.finish':return this.loginFinish();
      case 'login.cancel':return this.loginCancel();
      default:throw new Error('Thao tác desktop không được hỗ trợ.');
    }
  }
  async quiesce() {
    this.shuttingDown=true;
    this.monitor?.abort.abort();this.monitor?.commentWake?.();
    // Stop in-flight browser navigation immediately; the RPC queue can then drain
    // without closing SQLite underneath commands that are still unwinding.
    await Promise.allSettled([this.stopTelegram(),this.collector?.close(),this.loginContext?.close()]);
  }
  async close() {
    if(this.closed) return;
    this.closed=true;clearTimeout(this.changedTimer);
    try {await this.stop();await this.loginCancel();await this.collector?.close();}
    finally {try {this.store?.close();this.store=null;}finally {await this.release?.();this.release=null;}}
  }
}

async function main() {
  if(process.env.DESKTOP_WORKSPACE) process.chdir(process.env.DESKTOP_WORKSPACE);
  const send=payload=>process.stdout.write(JSON.stringify(payload)+'\n');
  const service=new DesktopService({emit:send});
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  let queue=Promise.resolve(),closing=false;
  async function close() {
    if(closing) return;closing=true;lines.close();
    const interrupted=service.quiesce();
    await queue.catch(()=>{});await interrupted;await service.close();process.stdin.pause();
  }
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>void close());
  lines.on('line',line=>{
    if(closing) return;
    if(line.length>1500000) {send({id:null,error:'Yêu cầu vượt giới hạn.'});return;}
    queue=queue.then(async()=>{
      let request;
      try {
        request=JSON.parse(line);
        if(!request || !['number','string'].includes(typeof request.id) || typeof request.method!=='string') throw new Error('Yêu cầu desktop không hợp lệ.');
        if(request.method==='shutdown') {send({id:request.id,result:true});setImmediate(()=>void close());return;}
        const result=await service.call(request.method,request.args ?? {});send({id:request.id,result});
      } catch(error) {send({id:request?.id ?? null,error:service.safe(error)});}
    });
  });
  lines.once('close',()=>void close());
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(()=>{process.exitCode=1;});
