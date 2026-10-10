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
    ...(replyId?{reply_to_message:{message_id:replyId}}:{}),
    entities:text.startsWith('/')?[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]:[]}});
  const click=async(data,owner=1)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(seq),chat_instance:'test',from:from(owner),data,message:{message_id:90,date:1,chat:{id:owner,type:'private'}}}});
  const prompt=()=>calls.filter(c=>c.payload.reply_markup?.force_reply).at(-1).id;
  return {store,group,post,calls,send,click,prompt};
}

test('menu categories cover all commands and sources paginate with owner checks',async t=>{
  const {store,send,click,calls,group}=setup(t);
  await send('/menu');
  assert.equal(calls.at(-1).payload.reply_markup.keyboard.length,4);
  await send('/help all');
  const guide=calls.map(c=>c.payload.text || '').join('\n');
  for(const {command} of BOT_COMMANDS) if(!['help','cancel','settings'].includes(command)) assert.ok(guide.includes(`/${command}`),command);
  for(let i=0;i<9;i++) store.addProfile(1,`https://www.facebook.com/user${i}`);
  await send('/sources');
  assert.match(calls.at(-1).payload.text,/trang 1\/2/);
  await click('nav:sources:2');
  assert.match(calls.at(-1).payload.text,/trang 2\/2/);
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
  await click(`source:defaults:${group.id}`);
  assert.equal(store.getGroup(group.id).keywords,null);
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

test('persistent 2-column reply keyboard activates and handles all 8 menu buttons', async t => {
  const { store, send, calls, group, post } = setup(t);
  await send('/start');
  const keyboardMsg = calls.find(c => c.payload.reply_markup?.keyboard);
  assert.ok(keyboardMsg, 'start command must deliver persistent reply keyboard');
  assert.equal(keyboardMsg.payload.reply_markup.keyboard.length, 4);
  assert.equal(keyboardMsg.payload.reply_markup.keyboard[0].length, 2);
  assert.equal(keyboardMsg.payload.reply_markup.resize_keyboard, true);
  assert.equal(keyboardMsg.payload.reply_markup.is_persistent, true);
  assert.equal(keyboardMsg.payload.reply_markup.one_time_keyboard, false);
  assert.ok(keyboardMsg.payload.reply_markup.keyboard.every(row => row.length === 2));
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);

  await send('/keyboard');
  assert.ok(calls.filter(c => c.payload.reply_markup?.keyboard).length >= 2);

  // 1. Nguồn theo dõi
  await send('📋 Nguồn theo dõi');
  assert.match(calls.at(-1).payload.text, /NGUỒN THEO DÕI/);

  // 2. Bài viết đã lưu
  await send('📄 Bài viết đã lưu');
  assert.match(calls.at(-1).payload.text, /BÀI VIẾT ĐÃ LƯU/);

  // 3. Shopee Affiliate
  await send('🛍 Shopee Affiliate');
  assert.match(calls.at(-1).payload.text, /SHOPEE AFFILIATE/);

  // 4. TikTok Affiliate
  await send('🎵 TikTok Affiliate');
  assert.match(calls.at(-1).payload.text, /TIKTOK AFFILIATE/);

  // 5. Bình luận
  await send('💬 Bình luận');
  assert.match(calls.at(-1).payload.text, /BÌNH LUẬN/);

  // 6. Bộ lọc & Cài đặt
  await send('⚙️ Bộ lọc & Cài đặt');
  assert.match(calls.at(-1).payload.text, /BỘ LỌC/);

  // 7. Trạng thái
  await send('📊 Trạng thái');
  assert.match(calls.at(-1).payload.text, /TRẠNG THÁI/);

  // 8. Hướng dẫn
  await send('❓ Hướng dẫn');
  assert.match(calls.at(-1).payload.text, /HƯỚNG DẪN/);
});

