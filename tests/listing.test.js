import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { listQuery, parseListArgs, pageItems } from '../src/listing.js';

function seed(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.ensureUser(1,1); store.ensureUser(2,2);
  const group = store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/bep/',name:'Đồ Gia Dụng Bếp'}).group;
  const other = store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/khac/',name:'Nhóm khác'}).group;
  const foreign = store.addJoinedGroup(2,{url:'https://www.facebook.com/groups/rieng/',name:'Đồ Gia Dụng riêng'}).group;
  const options = {render:() => 'x',matches:() => true,metricWindowMs:60000};
  const posts = (prefix,count,kind) => Array.from({length:count},(_,i) => ({id:`${prefix}${i+1}`,url:`https://www.facebook.com/groups/bep/posts/${prefix}${i+1}`,
    text:`Bếp gas ${i+1}${i === 0 ? ' giảm 50%_off' : ''}`,author:`Tác giả ${i+1}`,publishedAt:new Date(Date.now()-i*60000).toISOString(),...(kind ? {kind} : {})}));
  store.observe(group,posts('p',23),options);
  store.observe(group,posts('r',2,'reel'),options);
  store.observe(other,posts('o',3),options);
  store.observe(foreign,posts('f',4),options);
  store.queueCommentList(1,group.id,['p1','p2','p3'],['link A','giảm 100%','x_y']);
  store.queueComments(1,other.id,['o1'],'Khác nhóm');
  store.queueComments(2,foreign.id,['f1'],'giảm 100% riêng');
  return {store,group,other,foreign};
}

test('store pages lists in SQL with exact totals, owner scope and stable order',t => {
  const {store,group} = seed(t);
  const first = store.pagePosts(1,{pageSize:10}), last = store.pagePosts(1,{pageSize:10,page:3});
  assert.deepEqual([first.total,first.pages,first.page,first.items.length,first.hasMore],[28,3,1,10,true]);
  assert.deepEqual([last.page,last.items.length,last.hasMore],[3,8,false]);
  const ids = new Set([1,2,3].flatMap(page => store.pagePosts(1,{pageSize:10,page}).items.map(post => `${post.groupId}:${post.id}`)));
  assert.equal(ids.size,28);
  assert.equal(store.pagePosts(1,{page:99}).page,2,'past the end shows the last page');
  assert.equal(store.pagePosts(2,{}).total,4);
  assert.ok(store.pagePosts(1,{q:'riêng'}).items.every(post => post.groupId !== 3));
  assert.equal(store.pagePosts(1,{filters:{source:group.id,kind:'reel'}}).total,2);
  assert.equal(store.pagePosts(1,{filters:{kind:'post'}}).total,26);
  assert.equal(store.pagePosts(1,{filters:{type:'profile'}}).total,0);
  assert.equal(store.pagePosts(1,{q:'TAC GIA 23'}).items[0].id,'p23','search ignores case and accents');
  assert.equal(store.pagePosts(1,{sort:'author',dir:'asc',pageSize:1}).items[0].author,'Tác giả 1');
});

test('search treats % and _ literally; unknown sort keys fall back in the store and are rejected for user input',t => {
  const {store} = seed(t);
  assert.deepEqual(store.pageComments(1,{q:'%'}).items.map(item => item.body),Array(3).fill('giảm 100%'));
  assert.deepEqual(store.pageComments(1,{q:'_'}).items.map(item => item.body),Array(3).fill('x_y'));
  assert.equal(store.pagePosts(1,{q:'50%_off'}).total,3);
  assert.equal(store.pagePosts(1,{q:'50%-off'}).total,0);
  assert.equal(store.pagePosts(1,{q:"'; DROP TABLE posts; --"}).total,0);
  assert.equal(store.pageComments(2,{q:'%'}).total,1,'other owner sees only their own row');
  const fallback = store.pageComments(1,{sort:'body; DROP TABLE comments',dir:'sideways'});
  assert.deepEqual(fallback.items.map(item => item.id),[10,9,8,7,6,5,4,3,2,1]);
  assert.throws(() => listQuery('comments',{sort:'body'},{strict:true}),/sort chỉ nhận/);
  assert.throws(() => listQuery('comments',{dir:'up'},{strict:true}),/Chiều/);
  assert.throws(() => listQuery('comments',{filters:{owner_id:2}},{strict:true}),/Không có bộ lọc/);
  assert.throws(() => listQuery('comments',{filters:{state:'deleted'}},{strict:true}),/state chỉ nhận/);
  assert.throws(() => listQuery('comments',{pageSize:101},{strict:true}),/Số dòng/);
  assert.throws(() => listQuery('comments',{page:0},{strict:true}),/Trang/);
  assert.deepEqual(listQuery('comments',{filters:{owner_id:2,state:'bad'},pageSize:500}),{page:1,pageSize:20,q:'',filters:{},sort:'id',dir:'desc'});
});

test('queue, block, link and source lists filter by state, source and mode',t => {
  const {store,group,other} = seed(t);
  const id = store.pageComments(1,{}).items.at(-1).id;
  store.commentState(id,'failed','Lỗi mạng');
  assert.deepEqual(store.pageComments(1,{filters:{state:'failed'}}).items.map(item => item.id),[id]);
  assert.equal(store.pageComments(1,{q:'loi mang'}).total,1);
  assert.equal(store.pageComments(1,{filters:{source:other.id}}).total,1);
  assert.equal(store.pageComments(1,{filters:{source:3}}).total,0,'a foreign source ID shows nothing');
  assert.equal(store.pageComments(1,{filters:{mode:'auto'}}).total,0);
  store.scheduleCommenterBlock(1,1,0,group.id,'p1','https://www.facebook.com/groups/bep/posts/p1',1000);
  store.scheduleCommenterBlock(2,2,0,3,'f1','https://www.facebook.com/groups/rieng/posts/f1',1000);
  assert.deepEqual(store.pageCommenterBlocks(1,{filters:{mode:'manual',state:'pending'}}).items.map(job => [job.postId,job.sourceName]),[['p1','Đồ Gia Dụng Bếp']]);
  for (let i = 0; i < 12; i++) store.saveAffiliateLink(1,'shopee:1',`https://shopee.vn/item-${i}`,`https://s.shopee.vn/aff${i}`,1000+i);
  store.saveAffiliateLink(2,'shopee:1','https://shopee.vn/item-x','https://s.shopee.vn/foreign',5000);
  const links = store.pageAffiliateLinks(1,'shopee:1',{});
  assert.deepEqual([links.total,links.pages,links.items[0].affiliate_url],[12,2,'https://s.shopee.vn/aff11']);
  assert.equal(store.pageAffiliateLinks(1,'shopee:1',{q:'item-1',sort:'origin'}).total,3);
  store.setPaused(1,other.id,true);
  store.setAutoFriend(1,group.id,true);
  assert.deepEqual(store.pageGroups(1,{filters:{status:'paused'}}).items.map(item => item.id),[other.id]);
  assert.deepEqual(store.pageGroups(1,{filters:{auto:'on'}}).items.map(item => item.id),[group.id]);
  assert.deepEqual(store.pageGroups(1,{q:'do gia'}).items.map(item => item.id),[group.id]);
  assert.deepEqual(store.pageGroups(1,{sort:'name',dir:'desc'}).items.map(item => item.id),[other.id,group.id]);
});

test('in-memory lists share the filter, sort and page shape',() => {
  const items = Array.from({length:7},(_,i) => ({id:i+1,rank:i+1,name:`Nhóm ${i % 2 ? 'Bếp' : 'Xe'} ${i}`,url:`u${i}`,type:i < 5 ? 'group' : 'profile',total:i,missedByFeed:0,lastError:i === 3 ? 'x' : null}));
  const page = pageItems('hot',items,{pageSize:2,page:2,filters:{type:'group'}});
  assert.deepEqual([page.total,page.pages,page.items.map(item => item.id)],[5,3,[3,4]]);
  assert.deepEqual(pageItems('hot',items,{q:'bep',sort:'total',dir:'desc'}).items.map(item => item.id),[6,4,2]);
  assert.deepEqual(pageItems('hot',items,{filters:{status:'error'}}).items.map(item => item.id),[4]);
  assert.deepEqual(parseListArgs('comments','2 state:failed sort:time- hết hàng https://x.y/a'),
    {page:2,pageSize:20,q:'hết hàng https://x.y/a',filters:{state:'failed'},sort:'time',dir:'desc'});
  assert.throws(() => parseListArgs('comments','sort:body'),/sort chỉ nhận/);
});

function botSetup(t) {
  const fixture = seed(t);
  const bot = createBot({token:'123:test',allowedUserIds:[1,2],store:fixture.store});
  bot.botInfo = {id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls = []; let seq = 100;
  bot.api.config.use(async (_previous,method,payload) => {
    calls.push({method,payload});
    return {ok:true,result:method === 'answerCallbackQuery' ? true : {message_id:++seq}};
  });
  const from = id => ({id,is_bot:false,first_name:'User'});
  const send = (text,owner=1) => bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:1,chat:{id:owner,type:'private'},from:from(owner),text,
    entities:[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]}});
  const click = (data,owner=1) => bot.handleUpdate({update_id:++seq,callback_query:{id:String(seq),chat_instance:'test',from:from(owner),data,message:{message_id:90,date:1,chat:{id:owner,type:'private'}}}});
  const last = () => calls.filter(call => call.method === 'sendMessage').at(-1).payload;
  const buttons = () => last().reply_markup?.inline_keyboard?.[0] ?? [];
  return {...fixture,send,click,calls,last,buttons};
}

test('/posts pages with filters and inline buttons that keep the filter',async t => {
  const {send,click,last,buttons,calls,group} = botSetup(t);
  await send(`/posts ${group.id} 2 kind:post sort:published-`);
  assert.match(last().text,/^Nhóm #\d+ · Trang 2\/2 · tổng 23\nĐang áp dụng: kind:post · sort:published-/);
  assert.doesNotMatch(last().text,/source:/);
  assert.deepEqual(buttons().map(button => button.text),['◀️']);
  const back = buttons()[0].callback_data;
  assert.ok(Buffer.byteLength(back) <= 64);
  await click(back);
  assert.match(last().text,/Trang 1\/2 · tổng 23/);
  assert.match(last().text,/^p1 — /m);
  assert.ok(!last().text.includes('r1'),'reels stay filtered out on the next page');
  await click(back,2);
  assert.equal(calls.at(-1).method,'answerCallbackQuery');
  assert.match(calls.at(-1).payload.text,/hết hạn/);
  await send('/posts all bếp gas 1');
  assert.match(last().text,/Tất cả nhóm · Trang 1\/1 · tổng \d+\nĐang áp dụng: tìm "bếp gas 1"/);
  await send('/posts all kind:video');
  assert.match(last().text,/kind chỉ nhận post\|reel[\s\S]*Cú pháp: \/posts ID\|all \[trang\]/);
  await send('/posts');
  assert.match(last().text,/Cú pháp: \/posts/);
  await click(`source:posts:${group.id}`);
  assert.match(last().text,/^Nhóm #\d+ · Trang 1\/2 · tổng 25\n[\s\S]*\/commentlist \d+ ID_bài/);
  assert.deepEqual(buttons().map(button => button.text),['▶️']);
});

test('/comments pages, filters by state and source and searches the owner rows only',async t => {
  const {store,send,click,last,buttons,other} = botSetup(t);
  for (let i = 0; i < 25; i++) store.queueComments(1,other.id,['o2'],`Bình luận ${i}`);
  await send('/comments');
  assert.match(last().text,/^💬 Bình luận · Trang 1\/2 · tổng 35/);
  assert.deepEqual(buttons().map(button => button.text),['▶️']);
  await click(buttons()[0].callback_data);
  assert.match(last().text,/Trang 2\/2 · tổng 35/);
  await send(`/comments source:${other.id} sort:id 2`);
  assert.match(last().text,/Trang 1\/2 · tổng 25\nĐang áp dụng: source:\d+ · sort:id · tìm "2"/,'only a leading number is the page');
  await send(`/comments 2 source:${other.id} sort:id`);
  assert.match(last().text,/Trang 2\/2 · tổng 26\nĐang áp dụng: source:\d+ · sort:id/);
  await send('/comments giảm 100%');
  assert.match(last().text,/tổng 3\nĐang áp dụng: tìm "giảm 100%"\n[\s\S]*giảm 100%$/);
  assert.doesNotMatch(last().text,/riêng/);
  await send('/comments state:wrong');
  assert.match(last().text,/state chỉ nhận pending\|sending\|sent\|failed\|uncertain\|cancelled\.\nCú pháp: \/comments \[trang\] \[state:/);
});

test('search keys are written with each row, re-keyed when the error changes and backfilled for older rows',t => {
  const {store,group} = seed(t);
  const id = store.pageComments(1,{q:'link a'}).items[0].id;
  store.commentState(id,'failed','Không tìm thấy ô bình luận');
  assert.deepEqual(store.pageComments(1,{q:'khong tim thay o'}).items.map(item => item.id),[id]);
  store.commentState(id,'pending',null);
  assert.equal(store.pageComments(1,{q:'khong tim thay o'}).total,0);
  store.db.exec("UPDATE posts SET search=NULL,author_key=NULL,kind=NULL,published_at=NULL; UPDATE comments SET search=NULL");
  assert.equal(store.pagePosts(1,{q:'bep gas'}).total,0,'a row without its key is not matched until backfilled');
  assert.equal(store.backfillKeys(),true);
  assert.equal(store.pagePosts(1,{q:'bep gas'}).total,28);
  assert.equal(store.pagePosts(1,{filters:{kind:'reel',source:group.id}}).total,2);
  assert.equal(store.pageComments(1,{q:'giảm 100%'}).total,3);
  assert.equal(store.pagePosts(1,{sort:'author',dir:'asc',pageSize:1}).items[0].author,'Tác giả 1');
});

test('reopening the database keeps its keys and indexes (migration is idempotent)',async t => {
  const {mkdtemp,rm} = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(),'listing-'));
  const file = path.join(dir,'monitor.sqlite');
  let store = new Store(file);store.ensureUser(1,1);
  const group = store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/a/',name:'A'}).group;
  store.observe(group,[{id:'1',url:'https://www.facebook.com/groups/a/posts/1',text:'Nồi cơm điện',publishedAt:new Date().toISOString()}],{render:()=>'x',matches:()=>true,metricWindowMs:60000});
  store.close();
  store = new Store(file);t.after(async () => { store.close(); await rm(dir,{recursive:true,force:true}); });
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('posts_seen','posts_group_search','rejected_seen','comments_created')").all();
  assert.equal(indexes.length,4);
  assert.equal(store.pagePosts(1,{q:'noi com dien'}).total,1);
});

test('rejected rows carry their post sort values and search the reason too',t => {
  const store = new Store(':memory:');t.after(() => store.close());
  store.ensureUser(1,1);store.setRejectedNotify(1,0);store.setKeywords(1,null,['bán']);
  const group = store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/a/',name:'A'}).group;
  const now = Date.now(), post = (id,text,author,kind) => ({id,url:`https://www.facebook.com/groups/a/posts/${id}`,text,author,publishedAt:new Date(now-Number(id)*1000).toISOString(),...(kind ? {kind} : {})});
  store.observe(group,[post('1','Cần mua tủ','Bình'),post('2','Hỏi đường','An','reel'),post('3','Bán xe','Chi')],{now,render:()=>'x',matches:(text,accept) => accept.some(word => text.toLowerCase().includes(word)),metricWindowMs:60000});
  const all = store.pageRejected(1,{sort:'author',dir:'asc'});
  assert.deepEqual(all.items.map(item => item.id),['2','1']);
  assert.match(all.items[0].reason,/./);
  assert.deepEqual(store.pageRejected(1,{filters:{kind:'reel'}}).items.map(item => item.id),['2']);
  assert.deepEqual(store.pageRejected(1,{q:'can mua'}).items.map(item => item.id),['1']);
  assert.deepEqual(store.pageRejected(1,{sort:'published',dir:'desc'}).items.map(item => item.id),['1','2']);
});

test('/config pages its source list with page:N while a bare number stays a source ID; /search pages its matches',async t => {
  const {store,send,click,last,buttons,group} = botSetup(t);
  for (let i = 0; i < 25; i++) store.addJoinedGroup(1,{url:`https://www.facebook.com/groups/thu${i}/`,name:`Nhóm thử ${i}`});
  await send('/config');
  assert.match(last().text,/THÔNG TIN CẤU HÌNH HIỆN TẠI · Trang 1\/3 · tổng 27/);
  await click(buttons().at(-1).callback_data);
  assert.match(last().text,/Trang 3\/3/);
  await send(`/config ${group.id}`);
  assert.match(last().text,/CẤU HÌNH NGUỒN #/);
  await send('/config page:2 nhóm thử');
  assert.match(last().text,/Trang 2\/3 · tổng 25/);
  await send('/search nhom thu');
  assert.match(last().text,/Đã thêm 25 nguồn khớp “nhom thu” · Trang 1\/2 · tổng 25/);
  assert.equal(last().reply_markup.inline_keyboard.length,22,'20 sources, the page buttons and Menu');
  await click(last().reply_markup.inline_keyboard[20][0].callback_data);
  assert.match(last().text,/Trang 2\/2/);
  assert.equal(last().reply_markup.inline_keyboard.length,7);
});

test('/delete and the 🗑 buttons remove one row after confirmation, redraw the page and stay owner-checked',async t => {
  const {store,send,click,last,calls,group} = botSetup(t);
  const alert = () => calls.filter(call => call.method === 'answerCallbackQuery').at(-1).payload.text;
  const edits = () => calls.filter(call => call.method === 'editMessageText').map(call => call.payload);
  await send('/comments');
  const trash = last().reply_markup.inline_keyboard.flat().filter(button => button.text.startsWith('🗑'));
  assert.equal(trash.length,10);
  assert.equal(trash[0].text,'🗑 #10');
  assert.ok(trash.every(button => Buffer.byteLength(button.callback_data) <= 64));
  assert.ok(last().reply_markup.inline_keyboard.every(row => row.length <= 4));
  await click(trash[0].callback_data,2);
  assert.match(alert(),/hết hạn/,'another owner cannot use the button');
  await click(trash[0].callback_data);
  assert.match(last().text,/^Xóa bình luận #10\?\nĐang chờ: hủy/);
  const [yes,no] = last().reply_markup.inline_keyboard[0];
  assert.ok(Buffer.byteLength(yes.callback_data) <= 64);
  await click(no.callback_data);
  assert.equal(edits().at(-1).text,'Đã giữ lại, không xóa.');
  assert.equal(store.pageComments(1,{}).total,10);
  await click(yes.callback_data,2);
  assert.match(alert(),/hết hạn/);
  await click(yes.callback_data);
  assert.equal(store.pageComments(1,{}).total,9);
  assert.equal(edits().at(-2).text,'Đã xóa bình luận #10.');
  assert.match(edits().at(-1).text,/^💬 Bình luận · Trang 1\/1 · tổng 9/,'the list message is redrawn on its page');
  assert.equal(edits().at(-1).message_id,90);
  await click(yes.callback_data);
  assert.match(alert(),/hết hạn/);

  await send('/delete comment 9',2);
  assert.equal(last().text,'Không tìm thấy bản ghi của bạn.');
  store.commentState(9,'sending');
  await send('/delete comment 9');
  assert.equal(last().text,'Đang gửi, thử lại sau.');
  store.commentState(9,'sent');
  await send('/delete c 9');
  assert.match(last().text,/^Cú pháp: \/delete/);
  await send('/delete comment 9');
  assert.match(last().text,/^Đã ẩn bình luận #9 khỏi danh sách/);
  await send('/delete comment x');
  assert.match(last().text,/^ID không hợp lệ\.\nCú pháp: \/delete/);
  await send('/unhide comment 9');
  assert.match(last().text,/^Cú pháp: \/delete/);

  await send(`/delete post ${group.id} p1`);
  assert.equal(last().text,`Đã ẩn bài viết p1 (nguồn #${group.id}). Bot vẫn nhớ bài nên không gửi hay tự động lại. Bỏ ẩn: /unhide post ${group.id} p1`);
  await send(`/posts ${group.id}`);
  assert.match(last().text,/tổng 24/);
  await send('/posts all hidden:yes');
  assert.match(last().text,new RegExp(`tổng 1\\nĐang áp dụng: hidden:yes\\np1 · nguồn #${group.id} — `));
  const restore = last().reply_markup.inline_keyboard.flat().find(button => button.text === '♻️ p1');
  await click(restore.callback_data);
  assert.match(alert(),/Đã bỏ ẩn bài viết p1/);
  assert.match(edits().at(-1).text,/tổng 0/);
  assert.equal(store.pagePosts(1,{filters:{source:group.id}}).total,25);
  await send(`/unhide post ${group.id}:p1`);
  assert.equal(last().text,'Không tìm thấy bản ghi của bạn.');
});
