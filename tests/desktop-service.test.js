import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { parseEnv } from 'node:util';
import { DesktopService } from '../desktop/service.js';
import { settingsUpdate, writeSettings } from '../desktop/settings.js';
import { Monitor } from '../src/monitor.js';

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
  await assert.rejects(service.call('settings.save',{values:{SCAN_WORKERS:9}}),/SCAN_WORKERS/);
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
  const {service}=await fixture(t,{content:'SCAN_WORKERS=9\nTIKTOK_AFFILIATE_APP_SECRET=hidden\n'});
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
  context.cookies=async()=>valid?[{name:'c_user',value:'private-cookie'}]:[];
  context.close=async()=>{closed=true;context.emit('close');};
  const chromium={async launchPersistentContext(){return context;}};
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
});
