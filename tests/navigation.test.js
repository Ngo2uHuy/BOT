import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot, BOT_COMMANDS } from '../src/bot.js';
import { postButtons } from '../src/post-buttons.js';

function setup(t) {
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);
  const {group}=store.addProfile(1,'https://www.facebook.com/alice');
  const post={id:'42',url:'https://www.facebook.com/reel/42',text:'hello'};
  store.observe(group,[post],{render:()=> 'hello',matches:()=>true,metricWindowMs:60000});
  store.mapMessage(1,1,90,group.id,post.id);
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls=[];let seq=100;
  bot.api.config.use(async(_previous,method,payload)=>{
    calls.push({method,payload,id:++seq});
    return {ok:true,result:method==='answerCallbackQuery'?true:{message_id:seq}};
  });
  const from=id=>({id,is_bot:false,first_name:'User'});
  const send=async(text,replyId=null,owner=1)=>bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:1,chat:{id:owner,type:'private'},from:from(owner),text,
    ...(replyId?{reply_to_message:typeof replyId==='object'?replyId:{message_id:replyId}}:{}),
    entities:text.startsWith('/')?[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]:[]}});
  const click=async(data,owner=1)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(seq),chat_instance:'test',from:from(owner),data,message:{message_id:90,date:1,chat:{id:owner,type:'private'}}}});
  const prompt=()=>calls.filter(c=>c.payload.reply_markup?.force_reply).at(-1).id;
  return {store,group,post,calls,send,click,prompt};
}

test('menu categories cover all commands and sources paginate with owner checks',async t=>{
  const {store,send,click,calls,group}=setup(t);
  await send('/menu');
  assert.equal(calls.at(-1).payload.reply_markup.inline_keyboard.length,4);
  await send('/help all');
  const guide=calls.map(c=>c.payload.text || '').join('\n');
  for(const {command} of BOT_COMMANDS) if(!['help','cancel','settings'].includes(command)) assert.ok(guide.includes(`/${command}`),command);
  for(let i=0;i<9;i++) store.addProfile(1,`https://www.facebook.com/user${i}`);
  await send('/sources');
  assert.match(calls.at(-1).payload.text,/Trang 1\/2 · tổng 10/);
  assert.equal(calls.at(-1).payload.reply_markup.inline_keyboard.length,10,'8 sources, the page buttons and Menu');
  await click('nav:sources:2');
  assert.match(calls.at(-1).payload.text,/Trang 2\/2/);
  await send('/sources type:profile sort:name- user');
  assert.match(calls.at(-1).payload.text,/Trang 1\/2 · tổng 9\nĐang áp dụng: type:profile · sort:name- · tìm "user"/);
  const next=calls.at(-1).payload.reply_markup.inline_keyboard.at(-2)[0].callback_data;
  await click(next);
  assert.match(calls.at(-1).payload.text,/Trang 2\/2 · tổng 9/);
  assert.equal(calls.at(-1).payload.reply_markup.inline_keyboard.length,3,'1 source, the page buttons and Menu');
  await click('nav:profilesources:1');
  assert.match(calls.at(-1).payload.text,/tổng 10/);
  assert.doesNotMatch(calls.at(-1).payload.text,/type:/);
  await click(`source:pause:${group.id}`,2);
  assert.equal(calls.at(-1).payload.show_alert,true);
  assert.equal(store.getGroup(group.id).paused,false);
  await click('nav:status');
  assert.match(calls.at(-1).payload.text,/Nguồn: 10/);
});

test('settings prompts validate, remain owner scoped, cancel, and persist values',async t=>{
  const {store,group,click,send,prompt}=setup(t);
  await click(`source:keywords:${group.id}`);
  const keywordsPrompt=prompt();
  await send('wrong owner',keywordsPrompt,2);
  assert.equal(store.getGroup(group.id).keywords,null);
  await send('áo; quần',keywordsPrompt);
  assert.deepEqual(store.getGroup(group.id).keywords,['áo','quần']);
  await click(`source:reject:${group.id}`);
  const rejectPrompt=prompt();
  await send('vay tiền; lừa đảo',rejectPrompt);
  assert.deepEqual(store.getGroup(group.id).rejectKeywords,['vay tiền','lừa đảo']);
  await click(`source:defaults:${group.id}`);
  assert.equal(store.getGroup(group.id).keywords,null);
  assert.equal(store.getGroup(group.id).rejectKeywords,null);
  await click(`source:dates:${group.id}`);
  const datePrompt=prompt();
  await send('31/02/2026',datePrompt);
  assert.equal(store.getGroup(group.id).dateRange,null);
  await send('01/10/2026',datePrompt);
  assert.ok(store.getGroup(group.id).dateRange);
  await click(`source:auto:${group.id}`);
  await send('hello',prompt());
  assert.equal(store.getGroup(group.id).autoReply,'hello');
  await click(`source:auto:${group.id}`);
  const oldPrompt=prompt();
  await send('/cancel',oldPrompt);
  await send('off',oldPrompt);
  assert.equal(store.getGroup(group.id).autoReply,'hello');
  await click(`source:pause:${group.id}`);
  assert.equal(store.getGroup(group.id).paused,true);
  await click(`source:reelsOnly:${group.id}`);
  assert.equal(store.getGroup(group.id).contentType,'reels');
  await click(`source:resume:${group.id}`);
  assert.equal(store.getGroup(group.id).paused,false);
  await click(`source:scan:${group.id}`);
  assert.equal(store.getGroup(group.id).lastScanAt,null);
});

test('list button persists reply mode and commands replied to posts never become comments',async t=>{
  const {store,post,click,send,prompt}=setup(t);
  assert.ok(postButtons(post).inline_keyboard.flat().some(b=>b.callback_data==='post:commentlist'));
  await click('post:commentlist');
  const id=prompt();
  assert.equal(store.replyTarget(1,1,id).replyMode,'list');
  await send('/menu',id);
  assert.equal(store.listComments(1).length,0);
  await send('https://s.shopee.vn/a\nhttps://s.shopee.vn/b',id);
  assert.equal(store.listComments(1).length,2);
  await click('post:comment');
  await send('one\nmultiline comment',prompt());
  assert.equal(store.listComments(1).length,3);
});

test('menu delivers inline keyboard', async t => {
  const { store, send, calls, group, post } = setup(t);
  await send('/start');
  const menuMsg = calls.find(c => c.payload.reply_markup?.inline_keyboard);
  assert.ok(menuMsg, 'start command must deliver inline keyboard');
  assert.ok(menuMsg.payload.reply_markup.inline_keyboard.length >= 4);

  await send('/menu');
  assert.ok(calls.filter(c => c.payload.reply_markup?.inline_keyboard).length >= 2);
});


test('search reports whether a group was already added by name, link or ID',async t=>{
  const {store,send,calls}=setup(t);
  const last=()=>calls.filter(c=>c.method==="sendMessage").at(-1).payload;
  const {group}=store.addGroup(1,'https://www.facebook.com/groups/viec.lam.hn');
  store.setNumericId?.(group.id,'123456');
  await send('/search https://www.facebook.com/groups/viec.lam.hn/?ref=share');
  assert.match(last().text,/✅ Đã thêm 1 nguồn/);
  assert.ok(last().reply_markup.inline_keyboard.some(row=>row[0].callback_data===`source:open:${group.id}`));
  await send('/search VIEC LAM');
  assert.match(last().text,/✅ Đã thêm 1 nguồn/);
  await send('/search https://www.facebook.com/groups/khac');
  assert.match(last().text,/❌ Chưa thêm/);
  await send('/search viec',null,2);
  assert.match(last().text,/❌ Chưa thêm/);
});

test('/hot ranks the owner sources by posts in the last 48 hours with their planned rescan interval',async t=>{
  const {store,send,calls}=setup(t);
  const now=Date.now();
  const busy=store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/busy/',name:'Busy'}).group;
  store.observe(busy,[1,2,3].map(i=>({id:`b${i}`,url:`https://www.facebook.com/groups/busy/posts/b${i}`,text:'x',publishedAt:new Date(now-i*3600000).toISOString()})),{render:()=>'x',matches:()=>true,metricWindowMs:60000});
  store.scheduleScan(busy.id,false,{minMs:10000,maxMs:600000,plannedMs:43000});
  store.addJoinedGroup(2,{url:'https://www.facebook.com/groups/other/',name:'Other'});
  await send('/hot 5');
  const text=calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text).join('\n');
  assert.match(text,/1\. #\d+ Busy[^\n]*\n\s+3 bài phù hợp \/ 3 bài · quét lại ~43s/);
  assert.ok(!text.includes('Other'));
});

test('/search reports global hot rank, exact IDs, paused sources and owner isolation',async t=>{
  const {store,send,calls}=setup(t);
  const last=()=>calls.filter(c=>c.method==='sendMessage').at(-1).payload.text;
  const now=Date.now();
  const busy=store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/busy/',name:'Việc làm Hà Nội'}).group;
  const quiet=store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/quiet/',name:'Việc làm Huế'}).group;
  store.setNumericId(quiet.id,'987654321');
  store.observe(busy,[1,2,3].map(i=>({id:`rank${i}`,url:`${busy.url}posts/rank${i}`,text:'x',publishedAt:new Date(now-1000).toISOString()})),{render:()=>'x',matches:()=>true,metricWindowMs:60000});
  store.addJoinedGroup(2,{url:'https://www.facebook.com/groups/private/',name:'Việc làm riêng'});
  await send('/search viec lam');
  assert.match(last(),/Top 1\/3 · 3 bài phù hợp \/ 3 bài/);
  assert.match(last(),/Top 3\/3 · 0 bài phù hợp \/ 0 bài/);
  assert.ok(!last().includes('Việc làm riêng'));
  await send('/search 987654321');
  assert.match(last(),/Đã thêm 1 nguồn/);
  assert.match(last(),/Top 3\/3/);
  await send(`/search ${busy.id}`);
  assert.match(last(),/Top 1\/3/);
  store.setPaused(1,quiet.id,true);
  await send('/search https://www.facebook.com/groups/quiet/?ref=share');
  assert.match(last(),/Tạm dừng · không xếp hạng/);
  assert.doesNotMatch(last(),/Top \d/);
  await send('/search busy',null,2);
  assert.match(last(),/Chưa thêm/);
});

test('/hot group URL returns its full rank beyond top ten and resolves numeric aliases safely',async t=>{
  const {store,send,calls}=setup(t);
  const last=()=>calls.filter(c=>c.method==='sendMessage').at(-1).payload.text;
  for(let i=0;i<11;i++) store.addGroup(1,`https://www.facebook.com/groups/rank${i}/`);
  const target=store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/target/',name:'Nhóm cần tìm'}).group;
  store.setNumericId(target.id,'826392100466750');
  await send('/hot https://www.facebook.com/groups/826392100466750');
  assert.match(last(),/Nhóm cần tìm/);
  assert.match(last(),/Top 13\/13/);
  await send('/hot https://m.facebook.com/groups/target/?ref=share');
  assert.match(last(),/Top 13\/13/);
  await send('/hot https://www.facebook.com/groups/826392100466750',null,2);
  assert.match(last(),/chưa được thêm/);
  assert.doesNotMatch(last(),/Nhóm cần tìm|Top 13/);
  await send('/hot https://facebook.com.evil.test/groups/target/');
  assert.match(last(),/Cú pháp/);
  await send('/hot https://www.facebook.com/groups/target/posts/123');
  assert.match(last(),/Cú pháp/);
  store.setPaused(1,target.id,true);
  await send('/hot https://www.facebook.com/groups/target');
  assert.match(last(),/tạm dừng/);
  assert.doesNotMatch(last(),/Top \d/);
  await send('/hot 2');
  assert.match(last(),/Top 2 nguồn/);
});

test('/testfilter reports accept/reject precedence, effective group filters and ownership without writes',async t=>{
  const {store,group,send,calls}=setup(t);
  const last=()=>calls.filter(c=>c.method==='sendMessage').at(-1).payload.text;
  store.setKeywords(1,null,['có bạn']);
  store.setRejectKeywords(1,null,['mình nhận']);
  await send('/testfilter default | CÓ BẠN nào giúp không');
  assert.match(last(),/✅ NHẬN/); assert.match(last(),/Accept khớp: có bạn/);
  await send('/testfilter default | ấn phẩm cơ bản');
  assert.match(last(),/❌ LOẠI/); assert.match(last(),/Không khớp từ khóa Accept/);
  await send(`/testfilter ${group.id} | CÓ BẠN, mình nhận làm`);
  assert.match(last(),/❌ LOẠI/); assert.match(last(),/Reject khớp: mình nhận/);
  await send('/testfilter',{message_id:5,text:'CÓ BẠN hỗ trợ không'});
  assert.match(last(),/✅ NHẬN/);
  await send('/testfilter',{message_id:6,caption:'Ấn phẩm cơ bản'});
  assert.match(last(),/❌ LOẠI/);
  await send(`/testfilter ${group.id} | CÓ BẠN`,null,2);
  assert.match(last(),/Không tìm thấy nguồn của bạn/);
  await send('/testfilter default | '); assert.match(last(),/Cú pháp/);
  // ensureUser runs for every command; no posts or action queues are created.
  assert.equal(store.status(1).posts,1);
  assert.equal(store.listComments(1).length,0);
  store.setKeywords(1,group.id,[]);
  store.setRejectKeywords(1,group.id,[]);
  await send(`/testfilter ${group.id} | mình nhận làm`);
  assert.match(last(),/✅ NHẬN/); assert.match(last(),/Accept trống/);
  assert.deepEqual(store.getKeywords(1),['có bạn']);
});

test('source detail toggles auto block of commenters for the owner only',async t=>{
  const {store,click,calls,group}=setup(t);
  const last=()=>calls.filter(c=>c.method==='sendMessage').at(-1).payload;
  await click(`source:open:${group.id}`);
  assert.ok(last().reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`source:autoblock:${group.id}`));
  await click(`source:autoblock:${group.id}`);
  assert.equal(store.getGroup(group.id).autoBlock,true);
  assert.match(last().text,/Tự chặn người comment: bật/);
  await click(`source:autoblock:${group.id}`,2);
  assert.equal(store.getGroup(group.id).autoBlock,true);
  await click(`source:autoblock:${group.id}`);
  assert.equal(store.getGroup(group.id).autoBlock,false);
  assert.match(last().text,/Tự chặn người comment: tắt/);
});
