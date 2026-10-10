import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Store } from '../src/store.js';
import { FacebookCollector, profileDirectory } from '../src/facebook.js';
import { createBot, BOT_COMMANDS } from '../src/bot.js';
import { Monitor } from '../src/monitor.js';
import { ShopeeAffiliate } from '../src/affiliate.js';
import { TikTokAffiliate } from '../src/tiktok-affiliate.js';
import { acquireDesktopLock } from './lock.js';
import { desktopConfig, readSettings, publicSettings, settingsUpdate, writeSettings } from './settings.js';

function positive(value,name='ID') {
  const number=Number(value);
  if(!Number.isSafeInteger(number) || number<1) throw new Error(`${name} không hợp lệ.`);
  return number;
}
function pageNumber(value) {
  const page=positive(value ?? 1,'Trang');
  if(page>1000000) throw new Error('Trang vượt giới hạn.');
  return page;
}

/** Local facade: no Telegram polling or sends. The existing bot handles command
 * validation; real Facebook writes only occur after explicit runtime.start. */
export class DesktopService {
  constructor({baseDir=process.env.DESKTOP_WORKSPACE || process.cwd(),env=process.env,emit=()=>{},collectorFactory=config=>new FacebookCollector(config),monitorFactory=options=>new Monitor(options),shopeeFactory=config=>new ShopeeAffiliate(config),tiktokFactory=config=>new TikTokAffiliate(config),chromium}={}) {
    Object.assign(this,{baseDir:path.resolve(baseDir),inherited:env,emit,collectorFactory,monitorFactory,shopeeFactory,tiktokFactory,chromium});
    this.logs=[];this.running=false;this.closed=false;this.context=new AsyncLocalStorage();
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
    try {this.store=new Store(path.join(this.config.dataDir,'monitor.sqlite'));this.configure();}
    catch(error) {this.store?.close();this.store=null;await this.release();this.release=null;throw error;}
    this.log('Desktop sẵn sàng. Chưa bắt đầu quét hoặc đăng bình luận.');
    if(this.configError) this.log(this.configError,'warning');
    return this.bootstrap();
  }
  configure() {
    for(const owner of this.config.allowedUserIds) this.store.ensureUser(owner,owner);
    this.ownerId=this.config.allowedUserIds.includes(this.ownerId)?this.ownerId:this.config.allowedUserIds[0];
    this.collector=this.collectorFactory(this.config);
    this.shopee=this.shopeeFactory(this.config.shopeeAffiliate);
    this.tiktok=this.tiktokFactory(this.config.tiktokAffiliate);
    this.bot=createBot({token:'123456:desktop_local_only',allowedUserIds:this.config.allowedUserIds,store:this.store,
      collector:{joinedGroups:owner=>{if(this.loginContext) throw new Error('Đóng cửa sổ đăng nhập trước.');return this.collector.joinedGroups(owner);}},affiliate:this.shopee,tiktokAffiliate:this.tiktok});
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
  owner(value) {
    const owner=positive(value ?? this.ownerId,'Tài khoản');
    if(!this.config.allowedUserIds.includes(owner)) throw new Error('Tài khoản không có trong danh sách được cấu hình.');
    return owner;
  }
  runtime() {return {running:this.running,loginOpen:Boolean(this.loginContext),loginOwnerId:this.loginOwnerId ?? null,telegramRunning:false,mode:'local',error:this.configError || null,dataDir:this.config.dataDir};}
  bootstrap({ownerId}={}) {
    const owner=this.owner(ownerId);this.ownerId=owner;
    return {owners:this.config.allowedUserIds,ownerId:owner,sources:this.store.listGroups(owner),stats:this.store.status(owner),runtime:this.runtime(),
      settings:publicSettings(this.env),logs:this.logs,commands:BOT_COMMANDS,keywords:this.store.getKeywords(owner),affiliate:{shopee:Boolean(this.shopee.accountKey(owner)),tiktok:Boolean(this.tiktok.accountKey(owner))}};
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
  posts({ownerId,sourceId='all',page:rawPage}={}) {
    const owner=this.owner(ownerId),page=pageNumber(rawPage),source=sourceId==='all'||sourceId==null?null:positive(sourceId,'Nguồn');
    const rows=this.store.prepare(`SELECT p.group_id,p.data_json,p.first_seen_at,g.name FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? ${source?'AND g.id=?':''} ORDER BY p.first_seen_at DESC,p.group_id,p.post_id LIMIT 21 OFFSET ?`).all(owner,...(source?[source]:[]),(page-1)*20);
    return {items:rows.slice(0,20).map(row=>({...JSON.parse(row.data_json),groupId:row.group_id,firstSeenAt:row.first_seen_at,sourceName:row.name})),page,hasMore:rows.length>20};
  }
  comments({ownerId}={}) {return {items:this.store.listComments(this.owner(ownerId))};}
  links({ownerId,provider='shopee',page:rawPage}={}) {
    const owner=this.owner(ownerId),page=pageNumber(rawPage);
    if(!['shopee','tiktok'].includes(provider)) throw new Error('Chọn Shopee hoặc TikTok.');
    const key=this[provider].accountKey(owner);
    if(!key) return {items:[],page,hasMore:false};
    const items=this.store.listAffiliateLinks(owner,key,(page-1)*10).map(({account_key,owner_id,...item})=>item);
    return {items,page,hasMore:items.length===10 && this.store.listAffiliateLinks(owner,key,page*10).length>0};
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
    const localApi={sendMessage:async(_chat,text)=>{this.log(text);return {message_id:--this.nextMessageId};}};
    this.monitor=this.monitorFactory({store:this.store,collector:this.collector,api:localApi,config:this.config,tiktokAffiliate:this.tiktok,log:message=>this.log(message,'warning')});
    // Keep Telegram outbox/message IDs intact. Desktop reads collected posts
    // directly, and the Telegram CLI can deliver its own pending outbox later.
    this.monitor.deliveryLoop=async()=>{};
    this.running=true;
    this.monitorRun=this.monitor.start().catch(error=>{this.log(error,'error');this.monitor?.abort.abort();this.running=false;this.emit({event:'state',data:this.runtime()});});
    this.log('Đã bắt đầu quét Facebook và xử lý hàng đợi bình luận. Telegram không chạy trong desktop.');
    this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  async stop() {
    if(!this.monitor && !this.running) return this.runtime();
    this.running=false;
    this.monitor?.abort.abort();this.monitor?.commentWake?.();
    await this.collector.close();
    await this.monitorRun;
    this.monitor=null;this.monitorRun=null;
    this.collector=this.collectorFactory(this.config);
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
    this.collector=this.collectorFactory(this.config);
    const profile=profileDirectory(this.config.dataDir,owner);await mkdir(profile,{recursive:true,mode:0o700});
    const chromium=this.chromium || (await import('playwright')).chromium;
    let context;
    try {
      context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:1280,height:900},acceptDownloads:false,serviceWorkers:'block',timeout:30000});
      this.loginContext=context;this.loginOwnerId=owner;
      context.on('close',()=>{if(this.loginContext===context){this.loginContext=null;this.loginOwnerId=null;this.emit({event:'state',data:this.runtime()});}});
      const page=context.pages()[0] || await context.newPage();
      await page.goto('https://www.facebook.com/',{waitUntil:'domcontentloaded',timeout:45000});
    } catch {
      await context?.close().catch(()=>{});this.loginContext=null;this.loginOwnerId=null;
      throw new Error('Không mở được Facebook. Cài Chromium bằng npm run install-browser và kiểm tra kết nối mạng.');
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
    await this.loginCancel();this.log('Đã lưu phiên Facebook. Có thể bắt đầu hệ thống.');return this.runtime();
  }
  async loginCancel() {
    const context=this.loginContext;this.loginContext=null;this.loginOwnerId=null;
    await context?.close();this.emit({event:'state',data:this.runtime()});return this.runtime();
  }
  async call(method,args={}) {
    if(this.closed) throw new Error('Ứng dụng đang đóng.');
    if(this.shuttingDown && ['command','callback','settings.save','runtime.start','login.open'].includes(method)) throw new Error('Ứng dụng đang đóng.');
    if(!this.store) await this.init();
    switch(method) {
      case 'init':case 'state':case 'bootstrap':return this.bootstrap(args);
      case 'command':return this.command(args);
      case 'callback':return this.callback(args);
      case 'sources':return {items:this.store.listGroups(this.owner(args.ownerId))};
      case 'posts':return this.posts(args);
      case 'comments':return this.comments(args);
      case 'links':return this.links(args);
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
    await Promise.allSettled([this.collector?.close(),this.loginContext?.close()]);
  }
  async close() {
    if(this.closed) return;
    this.closed=true;
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
