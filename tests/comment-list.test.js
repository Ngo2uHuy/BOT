import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { Monitor } from '../src/monitor.js';
import { parseCommentList } from '../src/comments.js';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(()=>store.close());
  store.ensureUser(1,1); store.ensureUser(2,2);
  const {group} = store.addProfile(1,'https://www.facebook.com/alice');
  store.observe(group,[{id:'42',url:'https://www.facebook.com/reel/42',text:'Reel'}],{metricWindowMs:60000,render:()=> 'Reel',matches:()=>true});
  return {store,group};
}

test('comment list keeps affiliate queries intact and validates every line',()=>{
  assert.deepEqual(parseCommentList(' https://s.shopee.vn/a?x=1&y=2 \r\n\r\nhttps://shopee.vn/b?af_id=123 '),[
    'https://s.shopee.vn/a?x=1&y=2','https://shopee.vn/b?af_id=123',
  ]);
  assert.throws(()=>parseCommentList('\n  '));
  assert.throws(()=>parseCommentList(`valid\n${'x'.repeat(2001)}`));
});

test('five list entries are sent separately in order to the exact same post',async t=>{
  const {store,group} = fixture(t);
  const bodies = Array.from({length:5},(_,i)=>`https://s.shopee.vn/link${i+1}?affiliate_id=123&sub_id=${i+1}`);
  assert.deepEqual(store.queueCommentList(1,group.id,['42'],bodies),{queued:5,skipped:0});
  assert.deepEqual(store.queueCommentList(1,group.id,['42'],bodies),{queued:0,skipped:5});
  const sent=[];
  const monitor = new Monitor({store,config:{allowedUserIds:[1]},api:{async sendMessage(){}},
    collector:{async comment(owner,url,body,canSubmit){assert.equal(await canSubmit(),true);sent.push({owner,url,body});}}});
  for (let i=0;i<5;i++) assert.equal(await monitor.commentOne(),true);
  assert.equal(await monitor.commentOne(),false);
  assert.deepEqual(sent,bodies.map(body=>({owner:1,url:'https://www.facebook.com/reel/42',body})));
  assert.ok(store.listComments(1).every(item=>item.state==='sent'));
});

test('list rejects foreign/missing posts and rolls back partial failures; pause and cancel still apply',t=>{
  const {store,group} = fixture(t);
  assert.throws(()=>store.queueCommentList(2,group.id,['42'],['a','b']));
  assert.throws(()=>store.queueCommentList(1,group.id,['missing'],['a','b']));
  assert.throws(()=>store.queueCommentList(1,group.id,['42'],['a','']));
  assert.equal(store.listComments(1).length,0);
  const enqueue=store.enqueueComment;
  store.enqueueComment=function(...args){ if(args[2]==='b') throw new Error('fixture failure');return enqueue.apply(this,args); };
  assert.throws(()=>store.queueCommentList(1,group.id,['42'],['a','b']));
  assert.equal(store.listComments(1).length,0);
  store.enqueueComment=enqueue;
  assert.deepEqual(store.queueCommentList(1,group.id,['42'],['a','a','b']),{queued:2,skipped:1});
  store.setPaused(1,group.id,true);
  assert.equal(store.nextComment([1]),undefined);
  assert.equal(store.cancelComments(2,group.id),0);
  assert.equal(store.cancelComments(1,group.id),2);
  store.setPaused(1,group.id,false);
  assert.equal(store.nextComment([1]),undefined);
});

test('Telegram commentlist maps lines to a single saved target and rejects malformed input',async t=>{
  const {store,group} = fixture(t);
  const bot = createBot({token:'123:test',allowedUserIds:[1,2],store});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const replies=[];
  bot.api.config.use(async(_prev,method,payload)=>{replies.push(payload.text);return {ok:true,result:{message_id:replies.length}};});
  const send=async(text,owner=1)=>bot.handleUpdate({update_id:replies.length+1,message:{message_id:1,date:1,
    chat:{id:owner,type:'private'},from:{id:owner,is_bot:false,first_name:'User'},text,
    entities:[{type:'bot_command',offset:0,length:'/commentlist'.length}]}});
  await send(`/commentlist ${group.id} 42 |\nhttps://s.shopee.vn/link1\nhttps://s.shopee.vn/link2`);
  assert.match(replies.at(-1),/đã xếp 2\/2/);
  assert.equal(store.listComments(1).length,2);
  await send(`/commentlist ${group.id} 42 | third`,2);
  await send(`/commentlist ${group.id} all | third`);
  await send(`/commentlist ${group.id} 42 |\n`);
  await send(`/commentlist ${group.id} 42,43 | third`);
  assert.equal(store.listComments(1).length,2);
  assert.equal(store.listComments(2).length,0);
});
