import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { parseEnv } from 'node:util';
import { DesktopService, logLevel } from '../desktop/service.js';
import { settingsUpdate, writeSettings } from '../desktop/settings.js';
import { Monitor } from '../src/monitor.js';
import { sessionFile } from '../src/facebook-http.js';

async function fixture(t,{content='',...options}={}) {
  const baseDir=await mkdtemp(path.join(os.tmpdir(),'affiliate-desktop-test-'));
  if(content) await writeFile(path.join(baseDir,'.env'),content);
  const calls={collect:0,comment:0,joined:0,close:0};
  const collectorFactory=()=>({async close(){calls.close++;},async collect(){calls.collect++;return [];},async comment(){calls.comment++;},async joinedGroups(){calls.joined++;return {groups:[{name:'Nhóm thử',url:'https://www.facebook.com/groups/demo/'}],limited:false};}});
  const events=[];
  const service=new DesktopService({baseDir,env:{},emit:event=>events.push(event),collectorFactory,...options});
  t.after(async()=>{await service.close();await rm(baseDir,{recursive:true,force:true});});
  await service.init();
  return {service,baseDir,calls,events};
}

function seed(service,ownerId=1) {
  const group=service.store.addJoinedGroup(ownerId,{name:'Nhóm thử',url:`https://www.facebook.com/groups/owner${ownerId}/`}).group;
  const post={id:'post1',url:`${group.url}posts/post1`,text:'Nhà bếp',publishedAt:new Date().toISOString()};
  const monitor=new Monitor({store:service.store,config:{allowedUserIds:[ownerId],metricWindowMs:86400000}});
  service.store.observe(group,[post],monitor.options());
  return {group,post};
}

test('Zalo candidates and copy buttons stay scoped to the post owner', async t => {
  const {service} = await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const {group,post} = seed(service);
  post.text = 'Liên hệ +84 912 345 678 hoặc 0912.345.678';
  service.store.prepare('UPDATE posts SET data_json=? WHERE group_id=? AND post_id=?').run(JSON.stringify(post),group.id,post.id);
  assert.deepEqual(service.posts({ownerId:1}).items[0].zaloPhones,['0912345678']);
  service.store.mapMessage(1,1,99,group.id,post.id);
  const result = await service.callback({ownerId:1,data:'post:zalo',messageId:99});
  assert.deepEqual(result.messages[0].buttons[0][0].copy_text,{text:'0912345678'});
  assert.equal(result.messages[0].buttons.at(-1)[0].url,'https://chat.zalo.me/');
  const other = await service.callback({ownerId:2,data:'post:zalo',messageId:99});
  assert.ok(other.messages.every(message => !message.text.includes('0912345678')));
  assert.deepEqual(service.posts({ownerId:2}).items,[]);
});

test('desktop initializes locally without Telegram and does no scanning or posting',async t=>{
  const {service,calls}=await fixture(t);
  const state=await service.call('bootstrap');
  assert.deepEqual(state.owners,[1]);assert.equal(state.ownerId,1);
  assert.equal(state.runtime.running,false);assert.equal(state.runtime.telegramRunning,false);
  assert.equal(state.runtime.loginOpen,false);assert.equal(state.settings.hasSecrets.TELEGRAM_BOT_TOKEN,false);
  assert.ok(state.commands.some(item=>item.command==='tiktokauto'));
  assert.equal(calls.collect,0);assert.equal(calls.comment,0);assert.equal(calls.joined,0);
  assert.deepEqual({...state.stats},{groups:0,active:0,posts:0,pending:0});
});

test('desktop commands, buttons and force replies reuse owner-checked bot behavior',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  let result=await service.call('command',{text:'/add https://facebook.com/groups/test/'});
  assert.match(result.messages[0].text,/Đã thêm 1/);
  assert.equal(service.bootstrap().sources.length,1);
  const menu=await service.call('command',{text:'/menu'});
  assert.ok(menu.messages[0].buttons.flat().some(button=>button.callback_data==='nav:affiliates'));
  const groupId=service.bootstrap().sources[0].id;
  result=await service.call('callback',{data:`source:keywords:${groupId}`,messageId:menu.messages[0].messageId});
  const prompt=result.messages.find(message=>message.forceReply);assert.ok(prompt);
  await service.call('command',{text:'mỹ phẩm; nhà bếp',replyToMessageId:prompt.messageId});
  assert.deepEqual(service.store.getGroup(groupId).keywords,['mỹ phẩm','nhà bếp']);
  await service.call('callback',{data:`source:pause:${groupId}`,ownerId:2});
  assert.equal(service.store.getGroup(groupId).paused,false);
  await assert.rejects(service.call('command',{text:'/list',ownerId:3}),/không có trong danh sách/);
  assert.equal((await service.call('bootstrap',{ownerId:2})).sources.length,0);
});

test('desktop preserves long command results and redacts complete secrets before error truncation',async t=>{
  const secret='long-secret-value';
  const {service}=await fixture(t,{content:`TELEGRAM_BOT_TOKEN=123456:${secret}\n`});
  const help=await service.command({text:'/help all'});
  assert.ok(help.messages.some(message=>message.text.length>500));
  const masked=service.safe('x'.repeat(495)+`123456:${secret}`);
  assert.ok(!masked.includes('12345'));assert.ok(!masked.includes(secret));
  assert.match(service.redact(`full 123456:${secret} end`),/full \[ẨN\] end/);
});

test('desktop post/comment facade isolates owners and enriches posts with source IDs',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const {group,post}=seed(service,1);seed(service,2);
  const posts=await service.call('posts',{ownerId:1});
  assert.equal(posts.items.length,1);assert.equal(posts.items[0].groupId,group.id);assert.equal(posts.hasMore,false);
  assert.equal((await service.call('posts',{ownerId:2,sourceId:group.id})).items.length,0);
  await service.call('command',{ownerId:1,text:`/commentlist ${group.id} ${post.id} | https://s.shopee.vn/a\nhttps://s.shopee.vn/b`});
  assert.equal((await service.call('comments',{ownerId:1})).items.length,2);
  assert.equal((await service.call('comments',{ownerId:2})).items.length,0);
  assert.ok(service.store.listComments(1).every(comment=>comment.state==='pending'));
  await assert.rejects(service.call('posts',{page:0}),/Trang/);
});

test('explicit runtime start processes comments, stop closes workers, Telegram outbox stays unchanged',async t=>{
  const {service,calls}=await fixture(t);
  const {group,post}=seed(service);
  await service.command({text:`/comment ${group.id} ${post.id} | kiểm thử`});
  assert.equal(calls.comment,0);
  const before=service.store.prepare('SELECT * FROM deliveries').all();
  await service.start();
  for(let attempt=0;attempt<30 && calls.comment===0;attempt++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls.comment,1);
  await service.stop();
  assert.equal(service.runtime().running,false);
  assert.equal(service.store.listComments(1)[0].state,'sent');
  assert.deepEqual(service.store.prepare('SELECT * FROM deliveries').all(),before);
  assert.equal(service.store.prepare('SELECT count(*) n FROM message_posts').get().n,0);
});

test('desktop settings mask secrets, retain blank secrets, preserve unknown keys, and validate before writing',async t=>{
  const content='# keep me\nUNRELATED="some # thing"\nSHOPEE_AFFILIATE_OWNER_ID=1\nSHOPEE_AFFILIATE_APP_ID=app123\nSHOPEE_AFFILIATE_SECRET=secret-test-value\n';
  const {service,baseDir}=await fixture(t,{content});
  const settings=await service.call('settings.get');
  assert.equal(settings.values.SHOPEE_AFFILIATE_SECRET,'');assert.equal(settings.hasSecrets.SHOPEE_AFFILIATE_SECRET,true);
  assert.ok(!JSON.stringify(service.bootstrap()).includes('secret-test-value'));
  await service.call('settings.save',{values:{SHOPEE_AFFILIATE_SECRET:'',SCAN_WORKERS:2}});
  let saved=await readFile(path.join(baseDir,'.env'),'utf8');
  assert.match(saved,/# keep me/);assert.match(saved,/UNRELATED="some # thing"/);
  assert.equal(parseEnv(saved).SHOPEE_AFFILIATE_SECRET,'secret-test-value');assert.equal(service.config.scanWorkers,2);
  await assert.rejects(service.call('settings.save',{values:{SCAN_WORKERS:17}}),/SCAN_WORKERS/);
  assert.equal(await readFile(path.join(baseDir,'.env'),'utf8'),saved);
  await service.call('settings.save',{values:{SHOPEE_AFFILIATE_OWNER_ID:'',SHOPEE_AFFILIATE_APP_ID:''},clearSecrets:['SHOPEE_AFFILIATE_SECRET']});
  assert.equal((await service.call('settings.get')).hasSecrets.SHOPEE_AFFILIATE_SECRET,false);
  assert.equal(service.bootstrap().affiliate.shopee,false);
});

test('settings reject newline injection and any unsupported secret quoting without changing file',async t=>{
  const {baseDir}=await fixture(t,{content:'UNRELATED=keep\n'});
  assert.throws(()=>settingsUpdate({}, {DATA_DIR:'data\nINJECTED=1'}),/một dòng/);
  assert.throws(()=>settingsUpdate({}, {UNEXPECTED_KEY:'x'}),/không hợp lệ/);
  const old=await readFile(path.join(baseDir,'.env'),'utf8');
  await assert.rejects(writeSettings(baseDir,old,{SHOPEE_AFFILIATE_SECRET:"quote'and\\n"}),/nguyên vẹn/);
  assert.equal(await readFile(path.join(baseDir,'.env'),'utf8'),old);
});

test('invalid existing config opens repairable settings but cannot run',async t=>{
  const {service}=await fixture(t,{content:'SCAN_WORKERS=17\nTIKTOK_AFFILIATE_APP_SECRET=hidden\n'});
  assert.ok(service.bootstrap().runtime.error);
  assert.equal(service.bootstrap().settings.hasSecrets.TIKTOK_AFFILIATE_APP_SECRET,true);
  await assert.rejects(service.start(),/Cần sửa cấu hình/);
  const state=await service.call('settings.save',{values:{SCAN_WORKERS:2},clearSecrets:['TIKTOK_AFFILIATE_APP_SECRET']});
  assert.equal(state.runtime.error,null);assert.equal(service.config.scanWorkers,2);
});

test('live lock is held even when idle and released on close',async t=>{
  const {service,baseDir}=await fixture(t);
  const second=new DesktopService({baseDir,env:{}});
  await assert.rejects(second.init(),/ứng dụng khác/);
  await service.close();
  await assert.rejects(access(path.join(baseDir,'data','monitor.lock')));
  await second.init();await second.close();
});

test('changing data directory acquires its lock first, isolates data, and leaves old database intact',async t=>{
  const {service,baseDir}=await fixture(t);
  seed(service);
  const oldDatabase=path.join(baseDir,'data','monitor.sqlite');
  await service.call('settings.save',{values:{DATA_DIR:'./data-second'}});
  assert.equal(service.bootstrap().stats.posts,0);
  assert.equal(service.runtime().dataDir,path.join(baseDir,'data-second'));
  await access(oldDatabase);await assert.rejects(access(path.join(baseDir,'data','monitor.lock')));
  await access(path.join(baseDir,'data-second','monitor.lock'));
});

test('affiliate saved links remain scoped to current provider account and owner',async t=>{
  const shopeeFactory=()=>({accountKey:owner=>owner===1?'shopee-current':null});
  const tiktokFactory=()=>({accountKey:owner=>owner===1?'tiktok:current':null});
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n',shopeeFactory,tiktokFactory});
  service.store.saveAffiliateLink(1,'shopee-current','https://shopee.vn/a','https://s.shopee.vn/a');
  service.store.saveAffiliateLink(1,'shopee-old','https://shopee.vn/old','https://s.shopee.vn/old');
  service.store.saveAffiliateLink(1,'tiktok:current','https://www.tiktok.com/view/product/1','https://vt.tiktok.com/a');
  const shopee=await service.call('links',{provider:'shopee'});
  assert.equal(shopee.items.length,1);assert.equal(shopee.items[0].account_key,undefined);
  assert.equal((await service.call('links',{provider:'tiktok'})).items.length,1);
  assert.equal((await service.call('links',{provider:'shopee',ownerId:2})).items.length,0);
});

test('manual login validates cookie and checkpoint, never returns cookies, and prevents runtime/config races',async t=>{
  const context=new EventEmitter();let valid=false,checkpoint=false,closed=false;
  context.pages=()=>[{async goto(){},url:()=>checkpoint?'https://www.facebook.com/checkpoint/':'https://www.facebook.com/'}];
  context.cookies=async()=>valid?[{name:'c_user',value:'100012345',domain:'.facebook.com'},{name:'xs',value:'private-cookie',domain:'.facebook.com'}]:[];
  context.close=async()=>{closed=true;context.emit('close');};
  const channels=[];
  const chromium={async launchPersistentContext(profile,options){channels.push(options.channel);return context;}};
  const {service}=await fixture(t,{chromium});
  await service.call('login.open');assert.equal(service.runtime().loginOpen,true);
  await assert.rejects(service.start(),/Hoàn tất/);
  await assert.rejects(service.call('settings.save',{values:{SCAN_WORKERS:2}}),/Dừng hệ thống/);
  await assert.rejects(service.call('login.finish'),/Chưa đăng nhập/);
  valid=true;checkpoint=true;
  await assert.rejects(service.call('login.finish'),/xác minh/);
  checkpoint=false;await service.call('login.finish');
  assert.equal(closed,true);assert.equal(service.runtime().loginOpen,false);
  assert.ok(!JSON.stringify(service.bootstrap()).includes('private-cookie'));
  assert.deepEqual(channels,['chrome']);
  const saved=JSON.parse(await readFile(sessionFile(service.config.dataDir,1),'utf8'));
  assert.deepEqual(saved.cookies.map(cookie=>cookie.name),['c_user','xs']);
});

test('hot ranks sources by useful posts and exposes the planned scan interval',async t=>{
  const {service}=await fixture(t);
  const quiet=service.store.addJoinedGroup(1,{name:'Nhóm im',url:'https://www.facebook.com/groups/quiet/'}).group;
  const busy=service.store.addJoinedGroup(1,{name:'Nhóm sôi',url:'https://www.facebook.com/groups/busy/'}).group;
  const monitor=new Monitor({store:service.store,config:{allowedUserIds:[1],metricWindowMs:86400000}});
  const post=(group,id)=>({id,url:`${group.url}posts/${id}`,text:'Nhà bếp',publishedAt:new Date().toISOString()});
  service.store.observe(quiet,[post(quiet,'q1')],monitor.options());
  service.store.observe(busy,[post(busy,'b1'),post(busy,'b2'),post(busy,'b3')],monitor.options());
  service.store.scheduleScan(busy.id,false,{minMs:1000,maxMs:60000,plannedMs:45000});
  const {items}=await service.call('hot',{ownerId:1});
  assert.deepEqual(items.map(item=>item.id),[busy.id,quiet.id]);
  assert.equal(items[0].useful,3);assert.equal(items[0].total,3);assert.equal(items[0].name,'Nhóm sôi');
  assert.equal(items[0].scanIntervalMs,45000);assert.equal(items[1].scanIntervalMs,null);
  assert.equal((await service.call('hot',{ownerId:1,limit:1})).items.length,1);
});

test('inboxes and friends lists are scoped to the owner',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const first=seed(service,1),second=seed(service,2);
  service.store.enqueueDirectMessage(first.group.id,first.post.id,'https://www.facebook.com/a','A','Xin chào','manual',Date.now());
  service.store.enqueueFriendRequest(first.group.id,first.post.id,'https://www.facebook.com/a','A','manual',Date.now());
  service.store.enqueueFriendRequest(second.group.id,second.post.id,'https://www.facebook.com/b','B','manual',Date.now());
  const inboxes=await service.call('inboxes',{ownerId:1});
  assert.equal(inboxes.items.length,1);assert.equal(inboxes.items[0].state,'pending');assert.equal(inboxes.items[0].body,'Xin chào');
  assert.equal((await service.call('inboxes',{ownerId:2})).items.length,0);
  const friends=await service.call('friends',{ownerId:1});
  assert.equal(friends.items.length,1);assert.equal(friends.items[0].recipient_name,'A');
  assert.deepEqual((await service.call('friends',{ownerId:2})).items.map(item=>item.recipient_name),['B']);
  await assert.rejects(service.call('inboxes',{ownerId:3}),/không có trong danh sách/);
});

test('blocks list is scoped to the owner and carries the wait state shown on post cards',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const first=seed(service,1),second=seed(service,2);
  service.store.scheduleCommenterBlock(1,1,0,first.group.id,first.post.id,first.post.url,1000);
  service.store.scheduleCommenterBlock(2,2,0,second.group.id,second.post.id,second.post.url,500);
  const {items}=await service.call('blocks',{ownerId:1});
  assert.equal(items.length,1);
  assert.equal(items[0].postUrl,first.post.url);assert.equal(items[0].state,'pending');assert.equal(items[0].auto,false);
  assert.equal(items[0].wait.reason,'stopped');assert.equal(items[0].wait.position,2);assert.equal(items[0].wait.total,2);
  assert.equal('chatId' in items[0],false);
  assert.deepEqual((await service.call('blocks',{ownerId:2})).items.map(item=>item.postUrl),[second.post.url]);
  const extras=service.posts({ownerId:1}).items[0].commenterBlock;
  assert.equal(extras.wait.reason,'stopped');assert.match(extras.wait.text,/Hệ thống đang dừng/);
  service.running=true;
  const turn=service.posts({ownerId:1}).items[0].commenterBlock.wait;
  assert.deepEqual([turn.reason,turn.position,turn.total],['turn',2,2]);
  const cancelled=await service.call('command',{ownerId:1,text:'/cancelblocks all'});
  assert.match(cancelled.messages[0].text,/Đã hủy 1 lượt/);
  assert.equal(service.store.commenterBlockJob(2,second.post.url).state,'pending');
  assert.equal((await service.call('blocks',{ownerId:1})).items[0].state,'stopped');
  await assert.rejects(service.call('blocks',{ownerId:3}),/không có trong danh sách/);
});

test('retry blocks supports one job and all eligible jobs, scoped to the owner',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const first=seed(service,1),second=seed(service,2);
  const add=(owner,source,suffix,state,runAt=0,result=null)=>{
    const url=`${source.post.url}?job=${suffix}`;
    service.store.scheduleCommenterBlock(owner,owner,0,source.group.id,source.post.id,url,runAt);
    const job=service.store.commenterBlockJob(owner,url);
    service.store.commenterBlockJobState(job.id,state,result);
    return {...job,url};
  };
  const failed=add(1,first,'failed','failed');
  const stopped=add(1,first,'stopped','stopped');
  const progress={progress:{at:Date.now(),cursor:'saved'}};
  const later=add(1,first,'later','pending',Date.now()+60000,progress);
  const running=add(1,first,'running','running');
  const done=add(1,first,'done','done');
  const foreign=add(2,second,'foreign','failed');
  assert.equal((await service.call('retryBlocks',{ownerId:1,id:foreign.id})).count,0);
  assert.equal((await service.call('retryBlocks',{ownerId:1,id:failed.id})).count,1);
  assert.equal(service.store.commenterBlockJob(1,stopped.url).state,'stopped');
  assert.equal((await service.call('retryBlocks',{ownerId:1})).count,2);
  assert.equal((await service.call('retryBlocks',{ownerId:1})).count,0);
  assert.equal(service.store.commenterBlockJob(1,stopped.url).state,'pending');
  assert.deepEqual(service.store.commenterBlockJob(1,later.url).result,progress);
  assert.equal(service.store.commenterBlockJob(1,running.url).state,'running');
  assert.equal(service.store.commenterBlockJob(1,done.url).state,'done');
  assert.equal(service.store.commenterBlockJob(2,foreign.url).state,'failed');
  await assert.rejects(service.call('retryBlocks',{ownerId:3}),/không có trong danh sách/);
  await assert.rejects(service.call('retryBlocks',{ownerId:1,id:-1}));
});

test('health reports sane defaults while the runtime is stopped',async t=>{
  const {service}=await fixture(t);
  const health=await service.call('health');
  assert.equal(health.running,false);assert.equal(health.cooldown,false);assert.equal(health.slowdown,1);
  assert.equal(health.deferredUntil,null);assert.equal(health.plan,null);assert.equal(health.feedWatermark,null);
  assert.ok(['api','browser'].includes(health.scanMode));assert.equal(typeof health.browserless,'boolean');
  assert.ok(health.maxPerHour>0);assert.ok(health.feedPollMs>=0);
});

test('logLevel flags failures, limits and slowdowns as warnings',()=>{
  for(const message of ['[API | Tài khoản 1] POST X → HTTP 200 rate_limited','[TẠM HOÃN tài khoản 1] chờ 30 phút','Bình luận #3 Thất bại: lỗi mạng']) assert.equal(logLevel(message),'warning',message);
  assert.equal(logLevel('[QUÉT NHÓM #1] 3 bài, 0 bài mới (12 ms)'),'info');
});

test('rejected posts and post callbacks are scoped to the owner and reuse bot blocking',async t=>{
  const blocked=[];
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n',collectorFactory:()=>({async close(){},async blockUser(owner,url){blocked.push([owner,url]);return {success:true,state:'blocked'};},async collectCommentContacts(){return {scanned:0,items:[]};}})});
  const group=service.store.addJoinedGroup(1,{name:'Nhóm thử',url:'https://www.facebook.com/groups/own1/'}).group;
  service.store.addJoinedGroup(2,{name:'Khác',url:'https://www.facebook.com/groups/own2/'});
  const post={id:'p1',url:`${group.url}posts/p1`,text:'vay tiền nhanh',author:'An',authorUrl:'https://www.facebook.com/an.nguyen',publishedAt:new Date().toISOString()};
  const monitor=new Monitor({store:service.store,config:{allowedUserIds:[1],metricWindowMs:86400000}});
  await service.command({ownerId:1,text:'/rejected on'});
  assert.equal(typeof service.bootstrap().rejectedSince,'number');
  service.store.observe(group,[post],{...monitor.options(),matches:()=>false});
  const list=await service.call('rejected',{ownerId:1});
  assert.equal(list.items.length,1);assert.equal(list.items[0].profileUrl,'https://www.facebook.com/an.nguyen');
  assert.equal((await service.call('rejected',{ownerId:2})).items.length,0);
  await assert.rejects(service.call('postCallback',{ownerId:2,groupId:group.id,postId:'p1',mode:'rejected',data:'rejected:block'}),/không còn trong dữ liệu/);
  await assert.rejects(service.call('postCallback',{ownerId:1,groupId:group.id,postId:'p1',data:'source:pause:1'}),/không hợp lệ/);
  await service.call('postCallback',{ownerId:1,groupId:group.id,postId:'p1',mode:'rejected',data:'rejected:block'});
  assert.deepEqual(blocked,[[1,'https://www.facebook.com/an.nguyen']]);
  assert.equal((await service.call('rejected',{ownerId:1})).items[0].authorState,'blocked');
  await service.call('postCallback',{ownerId:1,groupId:group.id,postId:'p1',data:'post:block-commenters'});
  const item=service.posts({ownerId:1}).items[0];
  assert.equal(item.commenterBlock.state,'pending');assert.match(item.commenterBlock.label,/người comment/);
  assert.equal(service.posts({ownerId:2}).items.length,0);
  // Runtime stopped: a pending job is flagged; with a running monitor the live progress is exposed for the owner's job only.
  assert.equal(item.commenterBlock.waitingRuntime,true);assert.equal(item.commenterBlock.progress,null);
  const id=service.store.commenterBlockJob(1,post.url).id;
  service.running=true;
  service.monitor={commenterBlockProgress:jobId=>jobId===id?{phase:'blocking',total:4,index:1,counts:{blocked:1}}:null};
  const live=service.posts({ownerId:1}).items[0].commenterBlock;
  assert.equal(live.waitingRuntime,false);assert.deepEqual([live.progress.phase,live.progress.total,live.progress.index],['blocking',4,1]);
  service.running=false;service.monitor=null;
});

function fakeTelegram({failStart=false,failInit=false}={}) {
  const bot={calls:[],running:false,api:{async getWebhookInfo(){return {url:''};},async setMyCommands(){},async setChatMenuButton(){},async sendMessage(){}}};
  bot.init=async()=>{if(failInit) throw new Error('401 bot 123456:secretabc không hợp lệ');};
  bot.handleUpdate=async()=>{};
  bot.isRunning=()=>bot.running;
  bot.start=()=>new Promise((resolve,reject)=>{bot.running=true;bot.stopRun=resolve;if(failStart) {bot.running=false;reject(new Error('409 Conflict 123456:secretabc'));}});
  bot.stop=async()=>{bot.calls.push('stop');bot.running=false;bot.stopRun?.();};
  return bot;
}

test('with a token desktop runs a real Telegram bot on the shared store and delivery loop, and stop halts it',async t=>{
  const bots=[],options=[],monitors=[];
  const {service,events}=await fixture(t,{content:'TELEGRAM_BOT_TOKEN=123456:secretabc\n',
    telegramFactory:option=>{options.push(option);const bot=fakeTelegram();bots.push(bot);return bot;},
    monitorFactory:option=>{const monitor=new Monitor(option);monitors.push(monitor);return monitor;}});
  await service.start();
  assert.equal(bots.length,1);assert.equal(options[0].token,'123456:secretabc');assert.equal(options[0].store,service.store);
  assert.equal(monitors[0].api,bots[0].api);assert.equal(monitors[0].deliveryLoop,Monitor.prototype.deliveryLoop);
  assert.equal(service.runtime().telegramRunning,true);assert.equal(service.runtime().mode,'telegram');
  await bots[0].handleUpdate({});
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.ok(events.some(event=>event.event==='changed'));
  await service.stop();
  assert.deepEqual(bots[0].calls,['stop']);assert.equal(service.runtime().telegramRunning,false);
});

test('Telegram startup failure falls back to local mode with the token redacted, scanning continues',async t=>{
  const monitors=[];
  const {service,calls}=await fixture(t,{content:'TELEGRAM_BOT_TOKEN=123456:secretabc\n',
    telegramFactory:()=>fakeTelegram({failInit:true}),monitorFactory:option=>{const monitor=new Monitor(option);monitors.push(monitor);return monitor;}});
  const {group,post}=seed(service);
  await service.command({text:`/comment ${group.id} ${post.id} | kiểm thử`});
  await service.start();
  for(let attempt=0;attempt<30 && calls.comment===0;attempt++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls.comment,1);
  const runtime=service.runtime();
  assert.equal(runtime.telegramRunning,false);assert.match(runtime.telegramError,/401/);
  assert.notEqual(monitors[0].deliveryLoop,Monitor.prototype.deliveryLoop);
  assert.ok(!JSON.stringify([service.logs,runtime]).includes('secretabc'));
  await service.stop();
});

test('Telegram polling error after start is reported without stopping the scan',async t=>{
  const {service}=await fixture(t,{content:'TELEGRAM_BOT_TOKEN=123456:secretabc\n',telegramFactory:()=>fakeTelegram({failStart:true})});
  await service.start();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(service.runtime().running,true);assert.equal(service.runtime().telegramRunning,false);
  assert.match(service.runtime().telegramError,/409/);assert.ok(!service.runtime().telegramError.includes('secretabc'));
  await service.stop();
});

test('desktop lists accept validated page, page size, search, filters and sort; joined snapshot is paged locally',async t=>{
  const {service,calls}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const first=seed(service,1),second=seed(service,2);
  service.store.queueCommentList(1,first.group.id,['post1'],Array.from({length:25},(_,i)=>`Bình luận ${i} ${i%5 ? '' : '50%'}`));
  service.store.queueComments(2,second.group.id,['post1'],'Bình luận 50% khác');
  const page=await service.call('comments',{ownerId:1,page:2,pageSize:10,sort:'id',dir:'asc'});
  assert.deepEqual([page.total,page.pages,page.page,page.items.length,page.hasMore],[25,3,2,10,true]);
  assert.ok(page.items[0].id<page.items[9].id);
  const search=await service.call('comments',{ownerId:1,q:'50%',filters:{state:'pending',source:first.group.id}});
  assert.equal(search.total,5);
  assert.equal((await service.call('comments',{ownerId:1,filters:{source:second.group.id}})).total,0);
  for(const args of [{sort:'body'},{dir:'up'},{pageSize:500},{page:0},{filters:{owner:2}},{filters:{state:'gone'}},{q:{}},{filters:'state'}])
    await assert.rejects(service.call('comments',{ownerId:1,...args}),/không hợp lệ|chỉ nhận|Không có bộ lọc|tối đa/);
  const posts=await service.call('posts',{ownerId:1,sourceId:first.group.id,q:'nha bep',filters:{kind:'post'},sort:'published'});
  assert.equal(posts.total,1);assert.equal(posts.items[0].groupId,first.group.id);assert.ok(posts.items[0].commenterBlock);
  await assert.rejects(service.call('posts',{ownerId:1,filters:{kind:'video'}}),/kind chỉ nhận/);
  const sources=await service.call('sources',{ownerId:1,q:'owner1',filters:{type:'group',status:'active'},sort:'name'});
  assert.deepEqual(sources.items.map(item=>item.id),[first.group.id]);
  assert.equal((await service.call('hot',{ownerId:1,pageSize:1,sort:'total',dir:'desc'})).items[0].rank,1);
  assert.equal((await service.call('links',{ownerId:1,provider:'shopee',q:'x'})).total,0);
  const joined=await service.call('joined',{ownerId:1,q:'demo'});
  assert.deepEqual(joined.items.map(item=>[item.index,item.added]),[[1,false]]);
  assert.equal((await service.call('joined',{ownerId:1,filters:{status:'added'}})).total,0);
  assert.equal(calls.joined,1,'paging reuses the snapshot');
  await service.call('joined',{ownerId:1,refresh:true});
  assert.equal(calls.joined,2);
  await assert.rejects(service.call('joined',{ownerId:1,refresh:'yes'}),/không hợp lệ/);
});

test('bootstrap leaves out the log buffer the renderer already holds',async t=>{
  const {service}=await fixture(t);
  assert.ok((await service.call('bootstrap',{ownerId:1})).logs.length>0);
  assert.deepEqual((await service.call('bootstrap',{ownerId:1,logs:false})).logs,[]);
});

test('remove applies the store rules to one row of a whitelisted list for the selected owner',async t=>{
  const {service}=await fixture(t,{content:'ALLOWED_TELEGRAM_USER_IDS=1,2\n'});
  const first=seed(service,1);seed(service,2);
  service.store.queueComments(1,first.group.id,[first.post.id],'Xin chào');
  const id=service.comments({ownerId:1}).items[0].id;
  for (const list of ['hot','joined','__proto__',null]) await assert.rejects(service.call('remove',{ownerId:1,list,id}),/không hỗ trợ/);
  await assert.rejects(service.call('remove',{ownerId:1,list:'comments',id:{}}),/không hợp lệ/);
  await assert.rejects(service.call('remove',{ownerId:1,list:'comments',id,restore:'yes'}),/không hợp lệ/);
  await assert.rejects(service.call('remove',{ownerId:2,list:'comments',id}),/Không tìm thấy bản ghi của bạn/);
  await assert.rejects(service.call('remove',{ownerId:3,list:'comments',id}),/không có trong danh sách/);
  assert.deepEqual(await service.call('remove',{ownerId:1,list:'comments',id:String(id)}),{action:'deleted',message:`Đã xóa bình luận #${id}.`});
  assert.equal(service.comments({ownerId:1}).total,0);
  const key=`${first.group.id}:${first.post.id}`;
  await assert.rejects(service.call('remove',{ownerId:2,list:'posts',id:key}),/Không tìm thấy/);
  assert.equal((await service.call('remove',{ownerId:1,list:'posts',id:key})).action,'hidden');
  assert.equal(service.posts({ownerId:1}).total,0);
  assert.deepEqual(service.posts({ownerId:1,filters:{hidden:'yes'}}).items.map(post=>post.id),[first.post.id]);
  assert.equal((await service.call('remove',{ownerId:1,list:'posts',id:key,restore:true})).action,'restored');
  assert.equal(service.posts({ownerId:1}).total,1);
  assert.equal(service.posts({ownerId:2}).total,1);
});
