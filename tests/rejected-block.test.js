import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { createBot } from '../src/bot.js';
import { rejectedPostButtons } from '../src/post-buttons.js';

test('rejected notification blocks its own author once and updates its single button', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureUser(1,1);
  store.ensureUser(2,2);
  const group = store.addGroup(1,'https://www.facebook.com/groups/123/').group;
  const monitor = new Monitor({store,collector:{},config:{allowedUserIds:[1],metricWindowMs:86400000},log:()=>{},api:{
    async sendMessage(chat,body,options) {
      assert.equal(chat,1);
      assert.ok(options.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'rejected:block'));
      return {message_id:99};
    },
  }});
  store.setRejectedNotify(1,0);
  store.setKeywords(1,null,['wanted']);
  store.observe(group,[],monitor.options());
  store.observe(group,[{id:'10',url:'https://www.facebook.com/groups/123/posts/10',text:'unwanted content without matching term',
    author:'Alice',authorUrl:'https://www.facebook.com/profile.php?id=12345'}],{
    ...monitor.options(),matches:()=>false,
  });
  assert.equal(await monitor.deliverRejected(),true);
  assert.equal(store.nextRejected(Date.now(),[1]),undefined);
  assert.equal(store.replyTarget(1,1,99).replyMode,'rejected');
  assert.equal(store.replyTarget(2,1,99),undefined);
  const blocks=[];
  let failBlock=false;
  const bot = createBot({token:'123:test',allowedUserIds:[1,2],store,collector:{async blockUser(owner,profile,canSubmit,options) {
    assert.equal(options,undefined);
    assert.equal(canSubmit(),true);
    blocks.push([owner,profile]);
    if (failBlock) throw new Error('Không nhận được xác nhận từ Facebook.');
    return {success:true,state:'blocked'};
  }}});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls=[];
  bot.api.config.use(async (_previous,method,payload) => {
    calls.push({method,payload});
    return {ok:true,result:method==='answerCallbackQuery' ? true : {message_id:100}};
  });
  const click = owner => bot.handleUpdate({update_id:owner,callback_query:{id:`q${owner}`,chat_instance:'test',
    from:{id:owner,is_bot:false,first_name:'User'},data:'rejected:block',
    message:{message_id:99,date:1,chat:{id:owner,type:'private'}}}});
  await click(1);
  const reply=calls.find(call=>call.method==='editMessageReplyMarkup').payload;
  assert.deepEqual(blocks,[[1,'https://www.facebook.com/profile.php?id=12345']]);
  assert.equal(reply.reply_markup.inline_keyboard.flat().length,1);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text,'✅ Đã chặn người đăng');
  await click(1);
  assert.equal(blocks.length,1);
  calls.length=0;
  await click(2);
  assert.equal(calls.length,1);
  assert.equal(calls[0].payload.show_alert,true);
  store.prepare('UPDATE posts SET data_json=? WHERE group_id=? AND post_id=?').run(JSON.stringify({author:'Thành viên ẩn danh',authorUrl:'https://www.facebook.com/profile.php?id=12345'}),group.id,'10');
  calls.length=0;
  await click(1);
  assert.equal(calls.length,1);
  assert.match(calls[0].payload.text,/ẩn danh/);
  store.prepare('UPDATE posts SET data_json=? WHERE group_id=? AND post_id=?').run(JSON.stringify({author:'Bob',authorUrl:'https://www.facebook.com/profile.php?id=67890'}),group.id,'10');
  failBlock=true;
  calls.length=0;
  await click(1);
  assert.equal(store.authorBlockState(1,'https://www.facebook.com/profile.php?id=67890'),'uncertain');
  assert.equal(calls.some(call=>call.method==='editMessageReplyMarkup'),false);
  assert.match(calls.find(call=>call.method==='sendMessage').payload.text,/Không xác nhận/);
  await click(1);
  assert.equal(blocks.length,2,'uncertain action must not be submitted again');
});

test('each rejected post has only the author block button, with no commenter block or extra links', () => {
  for (const post of [
    {author:'Thành viên ẩn danh',authorUrl:'https://www.facebook.com/alice'},
    {author:'Alice',authorUrl:'https://evil.example/alice'},
    {},
  ]) {
    const buttons=rejectedPostButtons({...post,url:'https://www.facebook.com/groups/123/posts/10'}).inline_keyboard.flat();
    assert.deepEqual(buttons.map(button => [button.text,button.callback_data,button.url]),
      [['🚫 Chặn người đăng','rejected:block',undefined]]);
  }
});

test('block claims survive restart states and remain scoped to the owner', t => {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const profile='https://www.facebook.com/profile.php?id=12345';
  assert.equal(store.claimAuthorBlock(1,profile),true);
  assert.equal(store.claimAuthorBlock(1,profile),false);
  assert.equal(store.claimAuthorBlock(2,profile),true);
  store.setAuthorBlockState(1,profile,'uncertain');
  assert.equal(store.claimAuthorBlock(1,profile),false);
  store.setAuthorBlockState(1,profile,'failed');
  assert.equal(store.claimAuthorBlock(1,profile),true);
});
