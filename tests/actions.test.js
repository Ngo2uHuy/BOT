import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { submitComment } from '../src/comments.js';
import { extractVisiblePostSnapshots, normalizeSnapshots } from '../src/facebook.js';
import { normalizeMedia } from '../src/media.js';
import { registerCommands, createBot } from '../src/bot.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { postButtons } from '../src/post-buttons.js';

test('post buttons link to the correct post/profile and provide anonymous fallback',()=>{
  const markup=postButtons({url:'https://www.facebook.com/groups/123/posts/10',authorUrl:'https://www.facebook.com/profile.php?id=8'});
  assert.equal(markup.inline_keyboard[0][0].callback_data,'post:comment');
  assert.equal(new URL(markup.inline_keyboard[0][1].url).searchParams.get('url'),'https://www.facebook.com/groups/123/posts/10');
  assert.equal(markup.inline_keyboard[2][0].url,'https://www.facebook.com/profile.php?id=8');
  assert.equal(postButtons({url:'https://www.facebook.com/groups/123/posts/10'}).inline_keyboard[2][0].callback_data,'post:no-profile');
});

test('comment button prompts without posting, maps the prompt and enforces ownership',async t=>{
  const {store,group}=setup(t);
  store.mapMessage(1,1,99,group.id,'10');
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls=[];
  bot.api.config.use(async(_prev,method,payload)=>{
    calls.push({method,payload});
    return {ok:true,result:method==='answerCallbackQuery' ? true : {message_id:100}};
  });
  const click=async(owner,data)=>bot.handleUpdate({update_id:owner,callback_query:{id:`q${owner}`,chat_instance:'test',from:{id:owner,is_bot:false,first_name:'User'},data,
    message:{message_id:99,date:1,chat:{id:owner,type:'private'},reply_to_message:{message_id:98}}}});
  await click(1,'post:comment');
  assert.equal(calls.find(call=>call.method==='sendMessage').payload.reply_markup.force_reply,true);
  assert.equal(store.replyTarget(1,1,100).postId,'10');
  assert.equal(store.listComments(1).length,0);
  await bot.handleUpdate({update_id:3,message:{message_id:101,date:1,chat:{id:1,type:'private'},from:{id:1,is_bot:false,first_name:'User'},reply_to_message:{message_id:100},text:'Bình luận từ nút'}});
  assert.equal(store.listComments(1)[0].body,'Bình luận từ nút');
  const sends=calls.filter(call=>call.method==='sendMessage').length;
  await click(2,'post:comment');
  assert.equal(calls.filter(call=>call.method==='sendMessage').length,sends);
  assert.equal(calls.at(-1).payload.show_alert,true);
  await click(1,'post:no-profile');
  assert.equal(calls.at(-1).payload.show_alert,true);
});

function setup(t) {
  const store = new Store(':memory:'); t.after(()=>store.close());
  store.ensureUser(1,1); store.ensureUser(2,2);
  const group = store.addGroup(1,'https://www.facebook.com/groups/123/').group;
  const options = {now:2000,metricWindowMs:86400000,render:()=> 'body',matches:()=>true};
  const post = (id,extras={}) => ({id,url:`https://www.facebook.com/groups/123/posts/${id}`,text:'hello',...extras});
  store.observe(group,[post('10')],options);
  const config = {allowedUserIds:[1],metricWindowMs:86400000,pollIntervalMs:60000,metricRefreshMs:600000};
  return {store,group,options,post,config};
}

test('permalink dialog without article or timestamp supports its main comment editor',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<div role="dialog">
      <div role="textbox" contenteditable="true" aria-label="Bình luận dưới tên Test"></div>
      <script>document.querySelector('[role="textbox"]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();const c=document.createElement('div');c.setAttribute('role','article');c.textContent=e.target.innerText;const a=document.createElement('a');a.href='?comment_id=1';c.append(a);document.querySelector('[role="dialog"]').append(c);e.target.innerText='';}});</script></div>`}));
    await page.goto('https://www.facebook.com/groups/123/posts/10');
    await submitComment(page,{id:'10',url:page.url()},'Test');
    assert.equal(await page.locator('[role="article"]').innerText(),'Test');
    // Nested landmarks and an unrelated visible dialog must not block the post.
    await page.evaluate(()=>{
      const dialog=document.querySelector('[role="dialog"]');
      const outer=document.createElement('main'); outer.setAttribute('role','main');
      dialog.replaceWith(outer); outer.append(dialog);
      const inner=document.createElement('div'); inner.setAttribute('role','main');
      while(dialog.firstChild) inner.append(dialog.firstChild);
      dialog.append(inner);
      const unrelated=document.createElement('div');unrelated.setAttribute('role','dialog');unrelated.textContent='Notification';document.body.append(unrelated);
      const box=document.querySelector('[role="textbox"]');box.style.display='none';
      const label=document.createElement('span');label.id='comment-label';label.textContent='Viết bình luận';inner.append(label);
      box.removeAttribute('aria-label');box.setAttribute('aria-labelledby','comment-label');
      setTimeout(()=>box.style.display='',500);
    });
    await submitComment(page,{id:'10',url:page.url()},'Nested dialog');
    assert.equal(await page.locator('[role="article"]').last().innerText(),'Nested dialog');
    await assert.rejects(submitComment(page,{id:'11',url:'https://www.facebook.com/groups/123/posts/11'},'Wrong'),error=>error.commentSubmitted===false);
  } finally {await browser.close();}
});

test('explicit manual retry is allowed only for comments known not to have been sent',t=>{
  const {store,group}=setup(t);
  store.queueComments(1,group.id,['10'],'retry');
  const item=store.nextComment([1]);
  store.commentState(item.id,'failed','No editor');
  assert.equal(store.queueComments(1,group.id,['10'],'retry').queued,1);
  store.commentState(item.id,'uncertain');
  assert.equal(store.queueComments(1,group.id,['10'],'retry').queued,0);
});

test('manual batches validate ownership, all selection, duplicate prevention and message mappings',t=>{
  const {store,group,options,post} = setup(t);
  store.observe(group,[post('11',{groupName:'Nhóm thử nghiệm'})],options);
  assert.equal(store.getGroup(group.id).label,'Nhóm thử nghiệm');
  assert.throws(()=>store.queueComments(2,group.id,null,'hello'));
  assert.throws(()=>store.queueComments(1,group.id,['11','missing'],'hello'));
  assert.equal(store.listComments(1).length,0);
  assert.deepEqual(store.queueComments(1,group.id,null,'hello'),{queued:2,skipped:0});
  assert.deepEqual(store.queueComments(1,group.id,['11'],'hello'),{queued:0,skipped:1});
  store.mapMessage(1,1,77,group.id,'11');
  assert.equal(store.replyTarget(1,1,77).postId,'11');
  assert.equal(store.replyTarget(2,1,77),undefined);
  assert.equal(store.replyTarget(1,2,77),undefined);
  assert.equal(store.cancelComments(2,null),0);
  assert.equal(store.cancelComments(1,group.id),2);
  assert.equal(store.nextComment([1]),undefined);
});

test('auto reply excludes history, unknown dates, baseline and reobserved posts; disabling cancels pending',t=>{
  const {store,group,options,post} = setup(t);
  store.setAutoReply(1,group.id,'auto',3000);
  store.observe(group,[post('10',{publishedAt:new Date(4000).toISOString()}),post('11',{publishedAt:new Date(2000).toISOString()}),post('12'),post('13',{publishedAt:new Date(4000).toISOString()})],{...options,now:5000});
  assert.deepEqual(store.listComments(1).map(row=>row.post_id),['13']);
  store.observe(group,[post('13',{publishedAt:new Date(4000).toISOString()})],{...options,now:6000});
  assert.equal(store.listComments(1).length,1);
  assert.equal(store.setAutoReply(2,group.id,null),0);
  store.setAutoReply(1,group.id,null);
  assert.equal(store.nextComment([1]),undefined);
});

test('comment worker submits once and never retries an ambiguous failure',async t=>{
  const {store,group,config} = setup(t);
  store.queueComments(1,group.id,['10'],'hello');
  let attempts=0;
  const monitor = new Monitor({store,config,collector:{comment:async()=>{attempts++; throw new Error('connection lost');}},api:{sendMessage:async()=>({message_id:1})},log:()=>{}});
  assert.equal(await monitor.commentOne(),true);
  assert.equal(await monitor.commentOne(),false);
  assert.equal(attempts,1);
  assert.equal(store.listComments(1)[0].state,'uncertain');
});

test('comment success is recorded and disabling auto while browser is queued prevents submission',async t=>{
  const {store,group,config} = setup(t);
  store.queueComments(1,group.id,['10'],'manual');
  const monitor = new Monitor({store,config,collector:{comment:async(_owner,_url,_body,allowed)=>assert.equal(await allowed(),true)},api:{sendMessage:async()=>({message_id:1})}});
  await monitor.commentOne();
  assert.equal(store.listComments(1)[0].state,'sent');
  store.setAutoReply(1,group.id,'auto',1000);
  store.db.prepare('UPDATE posts SET data_json=? WHERE group_id=? AND post_id=?').run(JSON.stringify({publishedAt:new Date(2000).toISOString()}),group.id,'10');
  store.enqueueComment(group.id,'10','auto','auto',3000);
  const item=store.nextComment([1]);
  assert.equal(store.canComment(item),true);
  store.setAutoReply(1,group.id,null);
  assert.equal(store.canComment(item),false);
});

test('existing databases migrate and interrupted comments remain uncertain after restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'fb-actions-test-'));
  let store;
  try {
    const filename=path.join(dir,'state.sqlite');
    const legacy=new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE users(owner_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,keywords_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE groups(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL REFERENCES users(owner_id),url TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,initialized INTEGER NOT NULL DEFAULT 0,last_scan_at INTEGER,last_error TEXT,keywords_json TEXT,UNIQUE(owner_id,url));`);
    legacy.close();
    store=new Store(filename);store.ensureUser(1,1);
    const group=store.addGroup(1,'https://www.facebook.com/groups/123/').group;
    store.observe(group,[{id:'10',url:'https://www.facebook.com/groups/123/posts/10',text:'x'}],{metricWindowMs:10000,render:()=>'',matches:()=>true});
    store.queueComments(1,group.id,['10'],'hello');
    const item=store.nextComment([1]);store.commentState(item.id,'sending');
    store.mapMessage(1,1,88,group.id,'10');store.setAutoReply(1,group.id,'auto');
    store.close();store=new Store(filename);
    assert.equal(store.nextComment([1]),undefined);
    assert.equal(store.listComments(1)[0].state,'uncertain');
    assert.equal(store.replyTarget(1,1,88).postId,'10');
    assert.equal(store.getGroup(group.id).autoReply,'auto');
  } finally {
    store?.close();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('fb-actions-test-'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('media delivery sends photos/video, maps replies and falls back on Telegram rejection',async t=>{
  const {store,group,config,options,post} = setup(t);
  store.observe(group,[post('11',{media:[{type:'photo',url:'https://scontent.fbcdn.net/photo.jpg'},{type:'video',url:'https://video.fbcdn.net/movie.mp4'}]})],options);
  const item = store.nextDelivery(Date.now(),[1]); store.delivered(item,55);
  const calls=[];
  const api={sendPhoto:async(...args)=>{calls.push(['photo',...args]);return {message_id:56};},sendVideo:async()=>{throw {error_code:400};},sendMessage:async(...args)=>{calls.push(['fallback',...args]);return {message_id:57};}};
  const monitor = new Monitor({store,config,collector:{},api});
  await monitor.deliverMedia(); monitor.lastSent.clear(); await monitor.deliverMedia();
  assert.deepEqual(calls.map(call=>call[0]),['photo','fallback']);
  assert.equal(store.replyTarget(1,1,56).postId,'11');
  assert.equal(store.replyTarget(1,1,57).postId,'11');
  assert.equal(store.nextMedia([1]),undefined);
  assert.equal(normalizeMedia([{type:'photo',url:'http://localhost/secret'},{type:'photo',url:'https://fbcdn.net.evil.test/p'}]).length,0);
});

test('Telegram command menu and reply commands reach the owned post',async t=>{
  const {store,group} = setup(t);
  store.mapMessage(1,1,99,group.id,'10');
  const commands=[];
  await registerCommands({setMyCommands:async list=>commands.push(...list),setChatMenuButton:async()=>{}});
  assert.ok(commands.some(item=>item.command==='autoreply'));
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const replies=[];
  bot.api.config.use(async(_prev,_method,payload)=>{replies.push(payload.text);return {ok:true,result:{message_id:100}};});
  const send = async(text,reply,owner=1)=>bot.handleUpdate({update_id:Math.floor(Math.random()*100000),message:{message_id:10,date:0,chat:{id:owner,type:'private'},from:{id:owner,is_bot:false,first_name:'user'},text,
    ...(reply ? {reply_to_message:{message_id:reply}} : {entities:[{type:'bot_command',offset:0,length:text.split(' ')[0].length}]})}});
  await send('Bình luận thử',99);
  assert.equal(store.listComments(1)[0].body,'Bình luận thử');
  await send('Không được gửi',99,2);
  assert.equal(store.listComments(2).length,0);
  await send('/comment 1 10 | Bình luận khác');
  assert.equal(store.listComments(1).length,2);
  await send('/autoreply 1 auto');
  assert.equal(store.getGroup(1).autoReply,'auto');
  await send('/autoreply 1 off');
  assert.equal(store.getGroup(1).autoReply,null);
  const own=store.addGroup(1,'https://www.facebook.com/groups/456/').group;
  const other=store.addGroup(2,'https://www.facebook.com/groups/789/').group;
  const observe={metricWindowMs:10000,render:()=>'',matches:()=>true};
  store.observe(own,[{id:'20',url:'https://www.facebook.com/groups/456/posts/20',text:'post'}],observe);
  store.observe(other,[{id:'30',url:'https://www.facebook.com/groups/789/posts/30',text:'post'}],observe);
  await send('/comment all | All groups test');
  assert.equal(store.listComments(1).filter(row=>row.body==='All groups test').length,2);
  assert.equal(store.listComments(2).length,0);
  await send('/autoreply all Auto all');
  assert.equal(store.getGroup(group.id).autoReply,'Auto all');
  assert.equal(store.getGroup(own.id).autoReply,'Auto all');
  assert.equal(store.getGroup(other.id).autoReply,null);
  await send('/autoreply all off');
  assert.equal(store.getGroup(own.id).autoReply,null);
});

test('browser fixture extracts attachments without avatars or comment media and submits only target composer',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent(`<base href="https://www.facebook.com/"><div role="article" id="post">
      <h2><a href="/person"><img src="https://scontent.fbcdn.net/avatar.jpg" width="32" height="32">Author</a></h2>
      <a href="/groups/123/posts/10">time</a><div data-ad-preview="message">Hello</div>
      <img width="300" height="200" src="https://scontent.fbcdn.net/photo.jpg">
      <video width="300" height="200" src="https://video.fbcdn.net/video.mp4"></video>
      <div role="article"><img width="300" height="200" src="https://scontent.fbcdn.net/comment.jpg"></div>
      <div role="textbox" contenteditable="true" aria-label="Viết bình luận"></div></div>
      <div role="article"><a href="/groups/123/posts/100">other post</a><div role="textbox" contenteditable="true" aria-label="Viết bình luận"></div></div>
      <script>document.querySelector('#post [role="textbox"]').addEventListener('keydown', e=>{if(e.key==='Enter'){e.preventDefault();const c=document.createElement('div');c.setAttribute('role','article');c.textContent=e.target.innerText;const a=document.createElement('a');a.href='/groups/123/posts/10?comment_id=123';a.textContent='time';c.append(a);document.querySelector('#post').append(c);e.target.innerText='';}});</script>`);
    const posts=normalizeSnapshots(await page.evaluate(extractVisiblePostSnapshots),'https://www.facebook.com/groups/123');
    assert.deepEqual(posts[0].media.map(item=>item.type),['photo','video']);
    await submitComment(page,{id:'10'},'A test comment');
    assert.equal(await page.locator('#post [role="article"]').last().innerText(),'A test commenttime');
    await assert.rejects(submitComment(page,{id:'100'},'Cancelled',()=>false),/hủy/);
    assert.equal(await page.locator('#post [role="article"]').count(),2);
  } finally {await browser.close();}
});

