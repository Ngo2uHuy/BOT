import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { createBot } from '../src/bot.js';
import { rateLimitError } from '../src/facebook-cooldown.js';
import { profileIdFromHtml } from '../src/direct-messages.js';
import { postButtons } from '../src/post-buttons.js';
import { commenterBlockWaits, commenterProfiles, COMMENTER_BLOCK_PAUSE_MIN_MS, COMMENTER_BLOCK_PAUSE_MAX_MS, commenterBlockPauseMs, COMMENTER_PROGRESS_TTL_MS } from '../src/commenter-block.js';
import { submitHttpAction } from '../src/facebook-http.js';
import { readCommentContactsApi } from '../src/comment-contacts.js';
import { deferredError, RequestLimiter } from '../src/facebook-graphql.js';
import { readConfig } from '../src/config.js';

const POST_URL = 'https://www.facebook.com/groups/123/posts/10';
const AUTHOR = 'https://www.facebook.com/profile.php?id=12345';
const profile = id => `https://www.facebook.com/profile.php?id=${id}`;
const comment = (id, authorId, extra = {}) => ({id:`c${id}`,author:`User ${authorId}`,authorUrl:profile(authorId),text:'x',url:`${POST_URL}?comment_id=${id}`,...extra});

function setup(t, {filename = ':memory:', publishedAt = new Date(Date.now() - 3600000).toISOString(), collector = {}} = {}) {
  const store = new Store(filename);
  t.after(() => { try { store.close(); } catch { /* Closed by the test. */ } });
  store.ensureUser(1,1);
  store.ensureUser(2,2);
  const group = store.addGroup(1,'https://www.facebook.com/groups/123/').group;
  const sent = [], edits = [];
  const api = {
    async sendMessage(chat,text,options) { sent.push({chat,text,options}); return {message_id:200+sent.length}; },
    async editMessageReplyMarkup(chat,message,options) { edits.push({chat,message,options}); return true; },
  };
  const monitor = new Monitor({store,collector:{async accountId() { return '999'; },...collector},api,config:{allowedUserIds:[1,2],metricWindowMs:86400000},log:()=>{}});
  const waits = [];
  monitor.wait = async ms => { waits.push(ms); };
  store.observe(group,[],monitor.options());
  store.observe(group,[{id:'10',url:POST_URL,text:'wanted',author:'Alice',authorUrl:AUTHOR,publishedAt}],monitor.options());
  store.mapMessage(1,1,99,group.id,'10');
  return {store,group,monitor,sent,edits,waits};
}

function telegram(store, collector) {
  const bot = createBot({token:'123:test',allowedUserIds:[1,2],store,collector});
  bot.botInfo = {id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls = [];
  bot.api.config.use(async (_previous,method,payload) => { calls.push({method,payload}); return {ok:true,result:method === 'answerCallbackQuery' ? true : {message_id:100}}; });
  let update = 0;
  const click = (owner,data,message = 99) => bot.handleUpdate({update_id:++update,callback_query:{id:`q${update}`,chat_instance:'test',
    from:{id:owner,is_bot:false,first_name:'User'},data,message:{message_id:message,date:1,chat:{id:owner,type:'private'}}}});
  return {calls,click};
}

test('targets exclude the post author, the bot account, anonymous members, duplicates and profiles without a numeric ID', () => {
  const {profiles,unknown} = commenterProfiles([
    comment(1,'12345'),
    comment(2,'222'), comment(3,'222'),
    comment(4,'999'),
    comment(5,'0',{author:'Thành viên ẩn danh',authorUrl:''}),
    comment(6,'0',{author:'Vanity',authorUrl:'https://www.facebook.com/vanity.user'}),
    comment(7,'0',{author:'Graph',authorUrl:'https://www.facebook.com/graph.user',authorId:'333'}),
    comment(8,'0',{author:'Alice',authorUrl:'https://www.facebook.com/groups/123/user/12345/'}),
  ],{post:{author:'Alice',authorUrl:AUTHOR},accountId:'999'});
  // Vanity-only commenters are kept for lazy resolution right before blocking.
  assert.deepEqual(profiles,[profile(222),'https://www.facebook.com/vanity.user',profile(333)]);
  assert.equal(unknown,1);
  // A vanity-only post author is also matched by name, so the post author is never blocked.
  assert.deepEqual(commenterProfiles([comment(1,'444',{author:'Bob'}),comment(2,'555')],{post:{author:'Bob',authorUrl:'https://www.facebook.com/bob.vn'}}).profiles,[profile(555)]);
});

test('pressing starts one job per post right away, whatever the publish time', async t => {
  const {store} = setup(t,{publishedAt:new Date(Date.now() - 60000).toISOString()});
  const blocks = [];
  const {calls,click} = telegram(store,{async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; }});
  const before = Date.now();
  await click(1,'post:block-commenters');
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'pending');
  assert.ok(job.runAt >= before && job.runAt <= Date.now());
  assert.match(calls.find(call => call.method === 'answerCallbackQuery').payload.text,/ngay bây giờ/);
  const markup = calls.find(call => call.method === 'editMessageReplyMarkup').payload.reply_markup.inline_keyboard.flat();
  assert.equal(markup.find(button => button.callback_data === 'post:block-commenters').text,'⏳ Đang chặn người comment');
  calls.length = 0;
  await click(1,'post:block-commenters');
  assert.equal(store.prepare('SELECT COUNT(*) AS n FROM commenter_block_jobs').get().n,1);
  assert.match(calls[0].payload.text,/Đang chặn/);
  calls.length = 0;
  await click(2,'post:block-commenters');
  assert.equal(calls[0].payload.show_alert,true);
  assert.equal(store.commenterBlockJob(2,POST_URL),undefined);
  assert.deepEqual(blocks,[]);
});

test('a job scheduled for later by an older version is brought forward by a new press', async t => {
  const {store,group} = setup(t);
  const {calls,click} = telegram(store,{async blockUser() { return {success:true,state:'blocked'}; }});
  store.scheduleCommenterBlock(1,1,99,group.id,'10',POST_URL,Date.now()+1800000);
  const later = postButtons({url:POST_URL},{commenters:store.commenterBlockJob(1,POST_URL)}).inline_keyboard.flat();
  assert.match(later.find(button => button.callback_data === 'post:block-commenters').text,/^⏳ Chặn người comment lúc \d{2}:\d{2}$/);
  await click(1,'post:block-commenters');
  assert.ok(store.commenterBlockJob(1,POST_URL).runAt <= Date.now());
  assert.match(calls[0].payload.text,/ngay bây giờ/);
});

test('a due job blocks each new commenter once, pausing between blocks, then reports and relabels', async t => {
  const blocks = [];
  const collector = {
    async collectCommentContacts(owner,url,options) { assert.equal(owner,1); assert.equal(url,POST_URL); assert.equal(options.low,true); return {scanned:5,items:[],comments:[comment(1,'12345'),comment(2,'222'),comment(3,'333'),comment(4,'444'),comment(5,'222'),comment(6,'999')]}; },
    async accountId(owner,options) { assert.equal(options.low,true); return '999'; },
    async blockUser(owner,url,canSubmit,options) { assert.equal(canSubmit(),true); assert.equal(options.low,true); blocks.push(url); return {success:true,state:'blocked'}; },
  };
  const {store,monitor,sent,edits,waits} = setup(t,{collector});
  store.claimAuthorBlock(1,profile(333)); store.setAuthorBlockState(1,profile(333),'blocked');
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,Date.now()-1);
  assert.equal(await monitor.commenterBlockOne(Date.now()+1000),true);
  assert.deepEqual(blocks,[profile(222),profile(444)]);
  assert.equal(waits.length,1);
  assert.ok(waits[0] >= COMMENTER_BLOCK_PAUSE_MIN_MS && waits[0] <= COMMENTER_BLOCK_PAUSE_MAX_MS);
  assert.equal(commenterBlockPauseMs(() => 0),COMMENTER_BLOCK_PAUSE_MIN_MS);
  assert.equal(commenterBlockPauseMs(() => 1),COMMENTER_BLOCK_PAUSE_MAX_MS);
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'done');
  assert.deepEqual([job.result.blocked,job.result.skipped,job.result.uncertain,job.result.failed],[2,1,0,0]);
  assert.equal(store.authorBlockState(1,profile(222)),'blocked');
  assert.equal(store.authorBlockState(1,AUTHOR),undefined);
  assert.equal(store.authorBlockState(1,profile(999)),undefined);
  const report = sent.at(-1);
  assert.equal(report.options.reply_parameters.message_id,99);
  assert.match(report.text,/Đã chặn: 2\nBỏ qua: 1/);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard.flat().find(button => button.callback_data === 'post:block-commenters').text,'✅ Đã chặn 2 người comment');
  assert.equal(await monitor.commenterBlockOne(Date.now()+1000),false,'single pass only');
});

test('a rate limit stops the remaining blocks and a new press resumes without re-sending', async t => {
  const blocks = [];
  let limit = true;
  const collector = {
    async collectCommentContacts() { return {scanned:3,items:[],comments:[comment(1,'222'),comment(2,'333'),comment(3,'444')]}; },
    async blockUser(owner,url) {
      blocks.push(url);
      if (url === profile(333) && limit) throw rateLimitError();
      return {success:true,state:'blocked'};
    },
  };
  const {store,monitor,sent,edits} = setup(t,{collector});
  const groupId = store.replyTarget(1,1,99).groupId;
  store.scheduleCommenterBlock(1,1,99,groupId,'10',POST_URL,0);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333)]);
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'failed');
  assert.deepEqual([job.result.blocked,job.result.failed,job.result.pending],[1,1,1]);
  assert.match(sent.at(-1).text,/Dừng sớm: \[RATE_LIMITED\]/);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard.flat().find(button => button.callback_data === 'post:block-commenters').text,'⚠️ Chặn người comment chưa xong');
  assert.equal(await monitor.commenterBlockOne(),false,'the account is held after a rate limit');
  monitor.actionBackoff.clear();
  limit = false;
  assert.equal(store.scheduleCommenterBlock(1,1,99,groupId,'10',POST_URL,0).scheduled,true);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333),profile(333),profile(444)]);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
});

test('a first-page-only comment list is blocked, reported as not fully scanned and left unfinished', async t => {
  const blocks = [];
  const collector = {
    async collectCommentContacts() { return {scanned:2,items:[],comments:[comment(1,'222'),comment(2,'333')],complete:false}; },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  };
  const {store,monitor,sent,edits} = setup(t,{collector});
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333)]);
  const job = store.commenterBlockJob(1,POST_URL);
  assert.deepEqual([job.state,job.result.blocked,job.result.incomplete],['failed',2,true]);
  assert.match(sent.at(-1).text,/đọc 2 comment, chưa quét hết/);
  assert.match(sent.at(-1).text,/Chưa đọc hết bình luận/);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard.flat().find(button => button.callback_data === 'post:block-commenters').text,'⚠️ Chặn người comment chưa xong');
});

test('no readable comments is reported and can be retried', async t => {
  const collector = {
    async collectCommentContacts() { throw Object.assign(new Error('Không đọc được comment'),{code:'NO_COMMENTS'}); },
    async blockUser() { throw new Error('unexpected'); },
  };
  const {store,monitor,sent,edits} = setup(t,{collector});
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'failed');
  assert.match(sent.at(-1).text,/chưa có comment/);
  assert.equal(edits.at(-1).options.reply_markup.inline_keyboard.flat().find(button => button.callback_data === 'post:block-commenters').text,'💬 Chưa có comment để chặn');
});

test('a job running at restart is not resumed silently: the owner is told and may press again', async t => {
  const dir = mkdtempSync(path.join(tmpdir(),'commenter-block-'));
  const filename = path.join(dir,'monitor.sqlite');
  const first = setup(t,{filename});
  first.store.scheduleCommenterBlock(1,1,99,first.store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  first.store.commenterBlockJobState(first.store.commenterBlockJob(1,POST_URL).id,'running');
  first.store.claimAuthorBlock(1,profile(222));
  first.store.close();
  const blocks = [];
  const store = new Store(filename);
  // Registered after the stores' close hooks: Windows cannot delete an open SQLite file.
  t.after(() => { store.close(); rmSync(dir,{recursive:true,force:true}); });
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'interrupted');
  assert.equal(store.authorBlockState(1,profile(222)),'uncertain');
  const sent = [];
  const monitor = new Monitor({store,collector:{
    async accountId() { return '999'; },
    async collectCommentContacts() { return {scanned:2,items:[],comments:[comment(1,'222'),comment(2,'333')]}; },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  },api:{async sendMessage(chat,text) { sent.push(text); return {message_id:1}; },async editMessageReplyMarkup() { return true; }},
  config:{allowedUserIds:[1],metricWindowMs:86400000},log:()=>{}});
  monitor.wait = async () => {};
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'stopped');
  assert.match(sent[0],/Bot đã dừng/);
  assert.deepEqual(blocks,[]);
  assert.equal(store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,0).scheduled,true);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(333)],'the unconfirmed profile is never re-sent');
});

test('vanity HTML matcher accepts only IDs bound to that vanity and never the viewer', () => {
  const vanity = 'ten.abc';
  assert.equal(profileIdFromHtml({html:'<meta property="al:android:url" content="fb://profile/111">',vanity}),'111');
  assert.equal(profileIdFromHtml({html:'<meta content="fb://profile/112" property="al:ios:url" />',vanity}),'112');
  assert.equal(profileIdFromHtml({html:'"userVanity":"ten.abc","userID":"113"',vanity}),'113');
  assert.equal(profileIdFromHtml({html:'"userID":"114","userVanity":"ten.abc"',vanity}),'114');
  assert.equal(profileIdFromHtml({html:'"userVanity":"tenXabc","userID":"115","userVanity":"ten.abcd","userID":"116"',vanity}),null);
  assert.equal(profileIdFromHtml({html:'"profile_id":"117","entity_id":"118"',vanity}),null);
  assert.equal(profileIdFromHtml({html:'<meta property="al:android:url" content="fb://profile/999">',vanity,ownId:'999'}),null);
  assert.equal(profileIdFromHtml({html:'"USER_ID":"998","userVanity":"ten.abc","userID":"998"',vanity}),null);
  assert.equal(profileIdFromHtml({location:'/profile.php?id=119',vanity}),'119');
  assert.equal(profileIdFromHtml({location:'https://evil.example/profile.php?id=120',vanity}),null);
  assert.equal(profileIdFromHtml({location:'https://www.facebook.com/login/',html:'"userVanity":"ten.abc","userID":"121"',vanity}),null);
});

test('vanity commenters resolve right before blocking; the post author is excluded after resolving', async t => {
  const blocks = [], resolved = [], scans = [];
  const ids = {'https://www.facebook.com/alice.vn':'12345','https://www.facebook.com/bob.vn':'222','https://www.facebook.com/ghost.vn':null,'https://www.facebook.com/carol.vn':'333'};
  const collector = {
    async collectCommentContacts(owner,url,options) { scans.push(options); return {scanned:5,items:[],comments:[
      comment(1,'0',{author:'Alice 2',authorUrl:'https://www.facebook.com/alice.vn'}),
      comment(2,'0',{author:'Bob',authorUrl:'https://www.facebook.com/bob.vn'}),
      comment(3,'0',{author:'Ghost',authorUrl:'https://www.facebook.com/ghost.vn'}),
      comment(4,'222'),
      comment(5,'0',{author:'Carol',authorUrl:'https://www.facebook.com/carol.vn'}),
    ]}; },
    async resolveProfileId(owner,url) { resolved.push(url); return ids[url]; },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  };
  const {store,monitor,sent} = setup(t,{collector});
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  await monitor.commenterBlockOne();
  assert.deepEqual(scans.map(({canContinue,onProgress,...rest}) => rest),[{passes:500,partial:false,low:true}]);
  assert.deepEqual(blocks,[profile(222),profile(333)],'author (resolved 12345) and duplicate 222 are not blocked');
  assert.equal(store.authorBlockState(1,AUTHOR),undefined);
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'failed');
  assert.deepEqual([job.result.blocked,job.result.unresolved],[2,1]);
  assert.match(sent.at(-1).text,/Không lấy được ID số từ link tên: 1/);
  // A vanity-only post author is resolved once and a commenter listed by numeric ID is matched to him.
  const second = setup(t,{collector:{...collector,async collectCommentContacts() { return {scanned:2,items:[],comments:[comment(1,'777',{author:'Alias'}),comment(2,'888')]}; },
    async resolveProfileId(owner,url) { resolved.push(url); return url === 'https://www.facebook.com/dave.vn' ? '777' : null; }}});
  second.store.prepare('UPDATE posts SET data_json=json_set(data_json,\'$.author\',\'Dave\',\'$.authorUrl\',\'https://www.facebook.com/dave.vn\')').run();
  second.store.scheduleCommenterBlock(1,1,99,second.store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  blocks.length = 0; resolved.length = 0;
  await second.monitor.commenterBlockOne();
  assert.deepEqual(resolved,['https://www.facebook.com/dave.vn']);
  assert.deepEqual(blocks,[profile(888)]);
});

test('a rate limit while reading comments or resolving a vanity stops the job without blocking a partial list', async t => {
  const blocks = [];
  const {store,monitor,sent} = setup(t,{collector:{
    async collectCommentContacts() { throw rateLimitError(); },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  }});
  const groupId = store.replyTarget(1,1,99).groupId;
  store.scheduleCommenterBlock(1,1,99,groupId,'10',POST_URL,0);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'failed');
  assert.deepEqual(blocks,[]);
  assert.match(sent.at(-1).text,/Dừng sớm: \[RATE_LIMITED\]/);
  assert.equal(await monitor.commenterBlockOne(),false,'the account is held');
  monitor.actionBackoff.clear();
  monitor.collector.collectCommentContacts = async () => ({scanned:3,items:[],comments:[comment(1,'222'),comment(2,'0',{author:'V',authorUrl:'https://www.facebook.com/v.vn'}),comment(3,'444')]});
  monitor.collector.resolveProfileId = async () => { throw rateLimitError(); };
  assert.equal(store.scheduleCommenterBlock(1,1,99,groupId,'10',POST_URL,0).scheduled,true);
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'failed');
  assert.deepEqual(blocks,[profile(222)]);
  assert.deepEqual([job.result.blocked,job.result.pending,job.result.unresolved],[1,2,0]);
});

test('only accepted notifications offer the commenter block, share the post job and keep their other buttons', async t => {
  const pending = postButtons({url:POST_URL},{commenters:{state:'pending',runAt:Date.now()}}).inline_keyboard.flat();
  assert.equal(pending.find(button => button.callback_data === 'post:block-commenters').text,'⏳ Đang chặn người comment');
  assert.equal(pending.some(button => button.callback_data === 'rejected:block'),false);
  const blocks = [];
  const collector = {
    async collectCommentContacts() { return {scanned:2,items:[],comments:[comment(1,'222'),comment(2,'333')]}; },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  };
  const {store,group,monitor,sent,edits} = setup(t,{collector,publishedAt:new Date(Date.now()-600000).toISOString()});
  store.mapMessage(1,1,98,group.id,'10');
  const {calls,click} = telegram(store,collector);
  await click(1,'rejected:block-commenters',98);
  assert.equal(calls[0].payload.show_alert,true,'the rejected callback is refused on an accepted notification');
  assert.equal(store.commenterBlockJob(1,POST_URL),undefined);
  calls.length = 0;
  await click(1,'post:block-commenters',98);
  assert.match(calls.find(call => call.method === 'answerCallbackQuery').payload.text,/ngay bây giờ/);
  const accepted = calls.find(call => call.method === 'editMessageReplyMarkup').payload.reply_markup.inline_keyboard.flat();
  assert.ok(accepted.some(button => button.callback_data === 'post:comment'));
  assert.equal(accepted.find(button => button.callback_data === 'post:block-commenters').text,'⏳ Đang chặn người comment');
  calls.length = 0;
  await click(1,'post:block-commenters',99);
  assert.equal(store.prepare('SELECT COUNT(*) AS n FROM commenter_block_jobs').get().n,1,'one job per owner and post');
  assert.match(calls.find(call => call.method === 'answerCallbackQuery').payload.text,/Đang chặn/);
  calls.length = 0;
  await click(2,'post:block-commenters',98);
  assert.equal(calls[0].payload.show_alert,true);
  store.prepare('UPDATE commenter_block_jobs SET run_at=0').run();
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333)]);
  assert.equal(sent.at(-1).options.reply_parameters.message_id,98);
  const finished = edits.at(-1);
  assert.equal(finished.message,98);
  const buttons = finished.options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.callback_data === 'post:comment') && buttons.some(button => button.callback_data === 'nav:home'));
  assert.equal(buttons.find(button => button.callback_data === 'post:block-commenters').text,'✅ Đã chặn 2 người comment');
  assert.equal(buttons.some(button => /^rejected:/.test(button.callback_data || '')),false);
});

const commentsCollector = (blocks = [], list = [comment(2,'222')]) => ({
  async collectCommentContacts() { return {scanned:list.length,items:[],comments:list}; },
  async accountId() { return '999'; },
  async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
});
const autoJob = (store, group, runAt = Date.now()-1, repeatUntil = Date.now()+86400000) => {
  store.prepare('UPDATE groups SET auto_block=1 WHERE id=?').run(group.id);
  store.scheduleAutoCommenterBlock(1,1,99,group.id,'10',POST_URL,runAt,repeatUntil);
};

test('/autoblock sets and clears the source column, one source or all', async t => {
  const {store,group} = setup(t);
  const second = store.addGroup(1,'https://www.facebook.com/groups/456/').group;
  let update = 100;
  const bot = createBot({token:'123:test',allowedUserIds:[1,2],store,collector:{}});
  bot.botInfo = {id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const sentTexts = [];
  bot.api.config.use(async (_previous,method,payload) => { if (method === 'sendMessage') sentTexts.push(payload.text); return {ok:true,result:{message_id:100}}; });
  const send = text => bot.handleUpdate({update_id:++update,message:{message_id:update,date:1,chat:{id:1,type:'private'},from:{id:1,is_bot:false,first_name:'U'},text,entities:[{type:'bot_command',offset:0,length:text.split(' ')[0].length}]}});
  await send(`/autoblock ${group.id} on`);
  assert.equal(store.getGroup(group.id).autoBlock,true);
  assert.ok(store.getGroup(group.id).autoBlockSince > 0);
  assert.equal(store.getGroup(second.id).autoBlock,false);
  await send('/autoblock all on');
  assert.equal(store.getGroup(second.id).autoBlock,true);
  await send('/autoblock all off');
  assert.equal(store.getGroup(group.id).autoBlock,false);
  assert.equal(store.getGroup(second.id).autoBlockSince,null);
  await send('/autoblock');
  assert.match(sentTexts.at(-1),/Cú pháp: \/autoblock/);
});

test('enabling auto block queues older accepted posts before Telegram delivery and attaches the later message', async t => {
  const {store,group,monitor} = setup(t,{collector:commentsCollector()});
  store.setAutoBlock(1,group.id,true);
  assert.equal(store.commenterBlockJob(1,POST_URL).messageId,0);
  await monitor.deliverOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.ok(job,'job created');
  assert.equal(job.state,'pending');
  assert.ok(job.repeatUntil > Date.now()+86300000);
  assert.equal(job.messageId,201);
  assert.equal(job.groupId,group.id);
});

test('delivery does not schedule when auto block is off', async t => {
  const {store,group,monitor} = setup(t,{collector:commentsCollector()});
  await monitor.deliverOne();
  assert.equal(store.commenterBlockJob(1,POST_URL),undefined);
});

test('auto block scans saved posts without a Telegram message, excluding author and self', async t => {
  const blocks = [];
  const {store,group,monitor,sent,edits} = setup(t,{collector:commentsCollector(blocks,[comment(1,'12345'),comment(2,'999'),comment(3,'222'),comment(4,'222')])});
  store.prepare('DELETE FROM message_posts').run();
  store.setAutoBlock(1,group.id,true);
  assert.equal(await monitor.commenterBlockOne(),true);
  assert.deepEqual(blocks,[profile(222)]);
  assert.equal(sent[0].options.reply_parameters,undefined);
  assert.equal(edits.length,0);
  assert.equal(store.commenterBlockJob(1,POST_URL).result.blocked,1);
  assert.doesNotMatch(sent[0].text,/Không lấy được ID/);
});

test('observing an accepted post queues auto block even when Telegram fails', async t => {
  const {store,group,monitor} = setup(t,{collector:commentsCollector()});
  store.setAutoBlock(1,group.id,true);
  monitor.api.sendMessage = async () => { throw new Error('Telegram offline'); };
  const url = 'https://www.facebook.com/groups/123/posts/11';
  store.observe(group,[{id:'11',url,text:'wanted',author:'Alice',authorUrl:AUTHOR,publishedAt:new Date().toISOString()}],monitor.options());
  await monitor.deliverOne();
  const job = store.commenterBlockJob(1,url);
  assert.equal(job.state,'pending');
  assert.equal(job.messageId,0);
  const until = job.repeatUntil;
  store.setAutoBlock(1,group.id,true);
  assert.equal(store.commenterBlockJob(1,url).repeatUntil,until);
});

test('enable respects ownership, current filters and date range for stored posts', t => {
  const {store,group} = setup(t);
  assert.equal(store.setAutoBlock(2,group.id,true),0);
  assert.equal(store.getGroup(group.id).autoBlock,false);
  store.setRejectKeywords(1,group.id,['wanted']);
  store.setAutoBlock(1,group.id,true);
  assert.equal(store.commenterBlockJob(1,POST_URL),undefined);
  store.setRejectKeywords(1,group.id,[]);
  store.prepare('UPDATE groups SET date_range_json=? WHERE id=?').run(JSON.stringify({start:Date.parse('2000-01-01'),end:Date.parse('2000-01-02')}),group.id);
  store.setAutoBlock(1,group.id,true);
  assert.equal(store.commenterBlockJob(1,POST_URL),undefined);
});

test('paused sources wait and off/on leaves a completed auto job finished', async t => {
  const blocks = [];
  const {store,group,monitor} = setup(t,{collector:commentsCollector(blocks)});
  store.setPaused(1,group.id,true);
  store.setAutoBlock(1,group.id,true);
  assert.equal(await monitor.commenterBlockOne(),false);
  store.setPaused(1,group.id,false);
  await monitor.commenterBlockOne();
  store.setAutoBlock(1,group.id,false);
  store.setAutoBlock(1,group.id,true);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222)]);
});

test('unknown or unresolvable post authors stop blocking rather than risk blocking the author', async t => {
  for (const authorUrl of ['', 'https://www.facebook.com/alice.vn']) {
    const blocks = [];
    const {store,group,monitor} = setup(t,{collector:{...commentsCollector(blocks),async resolveProfileId() { return null; }}});
    const post = JSON.parse(store.prepare('SELECT data_json FROM posts WHERE group_id=?').get(group.id).data_json);
    store.prepare('UPDATE posts SET data_json=? WHERE group_id=?').run(JSON.stringify({...post,authorUrl}),group.id);
    store.setAutoBlock(1,group.id,true);
    await monitor.commenterBlockOne();
    assert.deepEqual(blocks,[]);
  }
});

test('an unknown bot identity stops blocks and pending jobs survive pruning', async t => {
  const blocks = [];
  const {store,group,monitor} = setup(t,{collector:{...commentsCollector(blocks),async accountId() { return null; }}});
  store.setAutoBlock(1,group.id,true);
  store.prepare('DELETE FROM message_posts').run();
  store.prepare('DELETE FROM deliveries').run();
  store.prepare('UPDATE posts SET first_seen_at=0,last_seen_at=0').run();
  assert.equal(store.prunePosts(1),0);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[]);
});

test('anonymous post actor is excluded while other commenters use the same HTTP mutation as reject', async t => {
  const requests=[];
  const collector={
    async accountId() { return '999'; },
    async collectCommentContacts() {
      const nodes=[['12345','Người tham gia ẩn danh'],['999','Bot'],['222','Other']].map(([id,name],i)=>({node:{__typename:'Comment',legacy_fbid:String(i+1),author:{id,name},body:{text:'hi'}}}));
      return readCommentContactsApi(async()=>JSON.stringify({data:{node:{comments:{edges:nodes,page_info:{has_next_page:false}}}}}),{id:'10',url:POST_URL});
    },
    async blockUser(owner,url,canSubmit) {
      return submitHttpAction({session:{form:{__user:'999'},headers:{}},kind:'block',target:new URL(url).searchParams.get('id'),canSubmit,
        request:{async post(endpoint,{form}) {requests.push({endpoint,form});return {status:()=>200,headers:()=>({}),text:async()=>JSON.stringify({data:{user_block:{viewer:{}}}})};}}});
    },
  };
  const {store,group,monitor}=setup(t,{collector});
  const post=JSON.parse(store.prepare('SELECT data_json FROM posts WHERE group_id=?').get(group.id).data_json);
  store.prepare('UPDATE posts SET data_json=? WHERE group_id=?').run(JSON.stringify({...post,author:'Người tham gia ẩn danh'}),group.id);
  store.setAutoBlock(1,group.id,true);
  await monitor.commenterBlockOne();
  assert.equal(store.authorBlockState(1,profile(222)),'blocked');
  // Rejected post handler uses the same collector but targets the author directly.
  store.prepare('UPDATE posts SET data_json=? WHERE group_id=?').run(JSON.stringify({...post,author:'Alice',authorUrl:profile(333)}),group.id);
  store.mapMessage(1,1,98,group.id,'10','rejected');
  const {click}=telegram(store,collector);
  await click(1,'rejected:block',98);
  assert.equal(store.authorBlockState(1,profile(333)),'blocked');
  assert.deepEqual(requests.map(r=>JSON.parse(r.form.variables).input.user_id),['222','333']);
  assert.ok(requests.every(r=>r.endpoint==='https://www.facebook.com/api/graphql/' && r.form.doc_id==='27871511059188774'));
});

test('auto retries retain read errors and uncertain block results instead of silently showing zero', async t => {
  const {store,group,monitor,sent}=setup(t,{collector:{...commentsCollector(),async blockUser() {throw new Error('unconfirmed block response');}}});
  store.setAutoBlock(1,group.id,true);
  await monitor.commenterBlockOne();
  const job=store.commenterBlockJob(1,POST_URL);
  assert.equal(job.result.uncertain,1);
  assert.match(job.error,/unconfirmed block response/);
  assert.match(sent.at(-1).text,/unconfirmed block response/);
});

test('auto blocking scans once even after the setting is enabled again', async t => {
  let scans = 0;
  const blocks = [];
  const collector = commentsCollector(blocks);
  const read = collector.collectCommentContacts;
  collector.collectCommentContacts = async (...args) => { scans++; return read(...args); };
  const {store,group,monitor} = setup(t,{collector});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
  assert.equal(await monitor.commenterBlockOne(Date.now()+900000),false);
  store.setAutoBlock(1,group.id,false);
  store.setAutoBlock(1,group.id,true);
  assert.equal(await monitor.commenterBlockOne(Date.now()+86400000),false);
  assert.equal(scans,1);
  assert.equal(blocks.length,1);
});

test('restart cancels a legacy queued repeat but preserves an unread first pass', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'comment-once-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const filename = path.join(dir,'state.db');
  const {store,group,monitor} = setup(t,{filename});
  autoJob(store,group);
  const result = {blocked:2,scanned:3};
  store.commenterBlockJobState(store.commenterBlockJob(1,POST_URL).id,'pending',result);
  const other = `${POST_URL}1`;
  store.observe(group,[{id:'101',url:other,text:'wanted',author:'Alice',authorUrl:AUTHOR,publishedAt:new Date().toISOString()}],monitor.options());
  store.scheduleAutoCommenterBlock(1,1,0,group.id,'101',other,0,Date.now()+86400000);
  store.close();
  const reopened = new Store(filename);
  try {
    assert.equal(reopened.commenterBlockJob(1,POST_URL).state,'stopped');
    assert.deepEqual(reopened.commenterBlockJob(1,POST_URL).result,result);
    assert.equal(reopened.commenterBlockJob(1,other).state,'pending');
  } finally { reopened.close(); }
});

test('turning auto block off ends pending auto jobs; a manual job is untouched', async t => {
  const {store,group} = setup(t,{collector:commentsCollector()});
  autoJob(store,group);
  store.setAutoBlock(1,group.id,false);
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'stopped');
  assert.equal(job.repeatUntil,null);
});

test('turning auto block off during a read prevents subsequent block calls', async t => {
  const {store,group,monitor} = setup(t,{collector:{
    async collectCommentContacts() { store.setAutoBlock(1,group.id,false); return {scanned:1,items:[],comments:[comment(2,'222')]}; },
    async accountId() { return '999'; },
    async blockUser() { return {success:true,state:'blocked'}; },
  }});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'stopped');
  assert.equal(job.result.blocked,0);
});

test('the pass inside the last 15 minutes of the window finishes the job instead of re-queuing', async t => {
  const {store,group,monitor} = setup(t,{collector:commentsCollector()});
  autoJob(store,group,Date.now()-1,Date.now()+600000);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
});

test('an auto job interrupted by a restart stops until a manual retry', async t => {
  const {store,group,monitor,sent} = setup(t,{collector:commentsCollector()});
  autoJob(store,group);
  const id = store.commenterBlockJob(1,POST_URL).id;
  store.commenterBlockJobState(id,'interrupted');
  const until = store.commenterBlockJob(1,POST_URL).repeatUntil;
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'stopped');
  assert.equal(sent.length,1);
  store.scheduleCommenterBlock(1,1,99,group.id,'10',POST_URL,Date.now()-5000);
  assert.equal(store.commenterBlockJob(1,POST_URL).repeatUntil,until);
});

test('a deferred read (hourly cap) keeps the job pending until retryAt, without a Telegram message', async t => {
  const retryAt = Date.now() + 600000;
  const {store,group,monitor,sent} = setup(t,{collector:{...commentsCollector(),async collectCommentContacts() { throw deferredError(retryAt); }}});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'pending');
  assert.equal(job.runAt,retryAt);
  assert.match(job.error,/SCAN_DEFERRED/);
  assert.equal(sent.length,0);
});

const pagedComments = () => {
  const pages = {'':['1','222','c1'], c1:['2','333','c2'], c2:['3','444',null]}, cursors = [];
  const state = {budget: 2, cursors};
  state.fetchText = async cursor => {
    cursors.push(cursor);
    if (state.budget-- <= 0) throw deferredError(Date.now()+600000);
    const [id, author, next] = pages[cursor ?? ''];
    return JSON.stringify({data:{node:{comments:{edges:[{node:{__typename:'Comment',legacy_fbid:id,author:{id:author,name:`U${author}`},body:{text:'hi'}}}],
      page_info:{has_next_page:Boolean(next),end_cursor:next}}}}});
  };
  state.collect = (owner,url,options) => readCommentContactsApi(state.fetchText,{id:'10',url:POST_URL},options);
  return state;
};

test('a read deferred mid-pagination saves its cursor and commenters; the next run reads on from there', async t => {
  const blocks = [], paged = pagedComments();
  const {store,group,monitor,sent} = setup(t,{collector:{...commentsCollector(blocks),collectCommentContacts:paged.collect}});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  let job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'pending');
  assert.deepEqual(blocks,[]);
  assert.equal(job.result.progress.cursor,'c2');
  assert.equal(job.result.progress.pages,2);
  assert.deepEqual(job.result.progress.comments.map(c => c.authorId),['222','333']);
  assert.equal(sent.length,0);
  paged.budget = 5; paged.cursors.length = 0; monitor.actionBackoff.clear();
  store.prepare('UPDATE commenter_block_jobs SET run_at=0 WHERE id=?').run(job.id);
  await monitor.commenterBlockOne();
  job = store.commenterBlockJob(1,POST_URL);
  assert.deepEqual(paged.cursors,['c2']);
  assert.deepEqual(blocks,[profile(222),profile(333),profile(444)]);
  assert.equal(job.state,'done');
  assert.equal(job.result.scanned,3);
  assert.equal(job.result.progress,undefined);
});

test('saved read progress survives a deferral before any page and is dropped once stale or after a switch-off', async t => {
  const paged = pagedComments(), seen = [];
  const {store,group,monitor} = setup(t,{collector:{...commentsCollector(),async collectCommentContacts(owner,url,options) { seen.push(options.resume); return paged.collect(owner,url,options); }}});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  const saved = store.commenterBlockJob(1,POST_URL).result.progress;
  paged.budget = 0; monitor.actionBackoff.clear();
  store.prepare('UPDATE commenter_block_jobs SET run_at=0').run();
  await monitor.commenterBlockOne();
  assert.deepEqual({...store.commenterBlockJob(1,POST_URL).result.progress,at:0},{...saved,at:0}, 'deferred again on the resumed page');
  store.prepare('UPDATE commenter_block_jobs SET run_at=0,result_json=? WHERE owner_id=1').run(JSON.stringify({retries:0,progress:{...saved,at:Date.now()-COMMENTER_PROGRESS_TTL_MS-1}}));
  monitor.actionBackoff.clear();
  await monitor.commenterBlockOne();
  assert.equal(seen.at(-1),undefined);
  monitor.collector.collectCommentContacts = async (owner,url,options) => { store.setAutoBlock(1,group.id,false); return paged.collect(owner,url,{...options,canContinue:() => true}); };
  paged.budget = 0; monitor.actionBackoff.clear();
  store.prepare('UPDATE commenter_block_jobs SET run_at=0,state=?,result_json=? WHERE owner_id=1').run('pending',JSON.stringify({retries:0,progress:saved}));
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'stopped');
  assert.equal(job.result.progress,undefined);
});

test('restart keeps a deferred auto read with saved progress pending', t => {
  const dir = mkdtempSync(path.join(tmpdir(),'comment-progress-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const filename = path.join(dir,'state.db');
  const {store,group} = setup(t,{filename});
  autoJob(store,group);
  const result = {scanned:0,retries:0,progress:{cursor:'c2',pages:2,comments:[{id:'1',authorId:'222'}],at:Date.now()}};
  store.commenterBlockJobState(store.commenterBlockJob(1,POST_URL).id,'pending',result);
  store.close();
  const reopened = new Store(filename);
  try {
    assert.equal(reopened.commenterBlockJob(1,POST_URL).state,'pending');
    assert.deepEqual(reopened.commenterBlockJob(1,POST_URL).result,result);
  } finally { reopened.close(); }
});

test('a commenter already unconfirmed or in flight keeps the job from finishing', async t => {
  const {store,group,monitor} = setup(t,{collector:commentsCollector()});
  autoJob(store,group);
  store.claimAuthorBlock(1,profile(222));
  store.setAuthorBlockState(1,profile(222),'uncertain');
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.notEqual(job.state,'done');
  assert.equal(job.result.uncertain,1);
  assert.equal(job.result.skipped,0);
});

test('off/on or pause/resume while a job runs does not leave it stopped', async t => {
  const blocks = [];
  const {store,group,monitor} = setup(t,{collector:{...commentsCollector(blocks,[comment(2,'222'),comment(3,'333')]),
    async blockUser(owner,url) { blocks.push(url); if (blocks.length === 1) { store.setAutoBlock(1,group.id,false); store.setAutoBlock(1,group.id,true); } return {success:true,state:'blocked'}; }}});
  store.setAutoBlock(1,group.id,true);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'pending');
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333)]);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
});

test('pausing the source mid-job re-queues it and resume finishes it', async t => {
  const blocks = [];
  const {store,group,monitor} = setup(t,{collector:{...commentsCollector(blocks,[comment(2,'222'),comment(3,'333')]),
    async blockUser(owner,url) { blocks.push(url); if (blocks.length === 1) store.setPaused(1,group.id,true); return {success:true,state:'blocked'}; }}});
  store.setAutoBlock(1,group.id,true);
  await monitor.commenterBlockOne();
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'pending');
  store.setPaused(1,group.id,false);
  await monitor.commenterBlockOne();
  assert.deepEqual(blocks,[profile(222),profile(333)]);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
});

test('an auto job on a post without comments retries every 30 minutes up to 6 times, silently, then ends', async t => {
  const {store,group,monitor,sent} = setup(t,{collector:{...commentsCollector(),async collectCommentContacts() { throw Object.assign(new Error('none'),{code:'NO_COMMENTS'}); }}});
  autoJob(store,group);
  for (let i = 1; i < 6; i++) {
    const before = Date.now();
    await monitor.commenterBlockOne();
    const job = store.commenterBlockJob(1,POST_URL);
    assert.equal(job.state,'pending');
    assert.equal(job.result.retries,i);
    assert.ok(job.runAt >= before + 1800000);
    store.prepare('UPDATE commenter_block_jobs SET run_at=0 WHERE id=?').run(job.id);
  }
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'done');
  assert.match(job.error,/Không có comment/);
  assert.equal(sent.length,0);
});

test('turning auto block off stops the comment read through canContinue', async t => {
  let keep;
  const {store,group,monitor} = setup(t,{collector:{...commentsCollector(),async collectCommentContacts(owner,url,options) {
    store.setAutoBlock(1,group.id,false); keep = options.canContinue(); return {comments:[comment(2,'222')]}; }}});
  autoJob(store,group);
  await monitor.commenterBlockOne();
  assert.equal(keep,false);
});

test('progress is kept in memory while blocking and cleared when the job ends', async t => {
  const seen = [];
  let monitor, jobId;
  const collector = {
    async collectCommentContacts(owner,url,options) {
      options.onProgress({pages:2,comments:40});
      seen.push(monitor.commenterBlockProgress(jobId));
      return {scanned:3,items:[],comments:[comment(1,'222'),comment(2,'333'),comment(3,'444')]};
    },
    async blockUser(owner,url) { seen.push(monitor.commenterBlockProgress(jobId)); return {success:true,state:'blocked'}; },
  };
  const ctx = setup(t,{collector});
  monitor = ctx.monitor;
  let changes = 0; monitor.onChange = () => changes++;
  const groupId = ctx.store.replyTarget(1,1,99).groupId;
  ctx.store.scheduleCommenterBlock(1,1,99,groupId,'10',POST_URL,0);
  jobId = ctx.store.commenterBlockJob(1,POST_URL).id;
  await monitor.commenterBlockOne();
  assert.deepEqual([seen[0].phase,seen[0].pages,seen[0].comments],['reading',2,40]);
  assert.deepEqual([seen[1].phase,seen[1].total,seen[1].index],['blocking',3,0]);
  assert.deepEqual([seen[3].index,seen[3].counts.blocked],[2,2]);
  assert.ok(ctx.waits.length >= 2 && changes > 5);
  assert.equal(monitor.commenterBlockProgress(jobId),null);
  assert.equal(ctx.store.commenterBlockJob(1,POST_URL).state,'done');
});

test('an hourly-cap deferral leaves a retry time on the job and no live progress', async t => {
  const retryAt = Date.now() + 1800000;
  const {store,monitor} = setup(t,{collector:{async collectCommentContacts() { throw Object.assign(new Error('hoãn'),{code:'SCAN_DEFERRED',retryAt}); }}});
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,0);
  const id = store.commenterBlockJob(1,POST_URL).id;
  await monitor.commenterBlockOne();
  const job = store.commenterBlockJob(1,POST_URL);
  assert.equal(job.state,'pending');
  assert.equal(job.runAt,retryAt);
  assert.equal(monitor.commenterBlockProgress(id),null);
});

const URL2 = 'https://www.facebook.com/groups/123/posts/11';
const tick = async until => { for (let i = 0; i < 100 && !until(); i++) await new Promise(resolve => setImmediate(resolve)); };
function parallelSetup(t, collector) {
  const ctx = setup(t,{collector});
  ctx.store.observe(ctx.group,[{id:'11',url:URL2,text:'wanted',author:'Alice',authorUrl:AUTHOR,publishedAt:new Date(Date.now() - 3600000).toISOString()}],ctx.monitor.options());
  ctx.store.scheduleCommenterBlock(1,1,99,ctx.group.id,'10',POST_URL,Date.now()-1);
  ctx.store.scheduleCommenterBlock(1,1,0,ctx.group.id,'11',URL2,Date.now()-1);
  return ctx;
}

test('workers finish blocking the current post before reading another post of the same owner', async t => {
  const events = [];
  let release;
  const collector = {
    async collectCommentContacts(owner,url) { events.push(`read:${url}`); return {comments:[comment(1,'222'),comment(2,'333')]}; },
    async blockUser(owner,url) {
      events.push(`block:${url}`);
      if (url === profile(222)) await new Promise(resolve => { release = resolve; });
      return {success:true,state:'blocked'};
    },
  };
  const {store,monitor} = parallelSetup(t,collector);
  const first = monitor.commenterBlockOne();
  await tick(() => release);
  assert.equal(await monitor.commenterBlockOne(),false);
  assert.equal(store.commenterBlockJob(1,URL2).state,'pending');
  assert.equal(monitor.commenterBlockWaits(1).find(job => job.postUrl === URL2).wait.reason,'accountBusy');
  assert.match(monitor.commenterBlockWaits(1).find(job => job.postUrl === URL2).wait.text,/Đang xử lý người comment của bài trước/);
  release();
  await first;
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'done');
  assert.equal(await monitor.commenterBlockOne(),true);
  assert.deepEqual(events,[`read:${POST_URL}`,`block:${profile(222)}`,`block:${profile(333)}`,`read:${URL2}`]);
  assert.equal(store.commenterBlockJob(1,URL2).state,'done');
});

test('a busy owner does not prevent another owner from reading comments', async t => {
  const started = [], gates = [];
  const {monitor} = queueSetup(t,{
    async collectCommentContacts(owner,url) { started.push(owner); await new Promise(resolve => gates.push(resolve)); return {comments:[]}; },
    async blockUser() { throw new Error('unexpected'); },
  });
  const runs = [monitor.commenterBlockOne(),monitor.commenterBlockOne()];
  await tick(() => started.length === 2);
  assert.deepEqual(started.slice().sort(),[1,2]);
  assert.equal(await monitor.commenterBlockOne(),false);
  gates.forEach(open => open());
  await Promise.all(runs);
});

test('BLOCK_INTERVAL_SECONDS sets the pause between blocks and BLOCK_WORKERS is bounded', async t => {
  const collector = {
    async collectCommentContacts() { return {scanned:2,items:[],comments:[comment(1,'222'),comment(2,'333')]}; },
    async blockUser() { return {success:true,state:'blocked'}; },
  };
  const {store,monitor,waits} = setup(t,{collector});
  monitor.config.blockIntervalMs = 2000; monitor.random = () => 1;
  store.scheduleCommenterBlock(1,1,99,store.replyTarget(1,1,99).groupId,'10',POST_URL,Date.now()-1);
  await monitor.commenterBlockOne();
  assert.deepEqual(waits,[4000]);
  assert.equal(commenterBlockPauseMs(() => 0,2000),2000);
  assert.equal(commenterBlockPauseMs(() => 0,0),0);
  const base = {ALLOWED_TELEGRAM_USER_IDS:'1',TELEGRAM_BOT_TOKEN:'123:test'};
  const config = readConfig(base);
  assert.deepEqual([config.blockWorkers,config.blockIntervalMs],[3,15000]);
  assert.equal(readConfig({...base,BLOCK_WORKERS:'8',BLOCK_INTERVAL_SECONDS:'0'}).blockWorkers,8);
  assert.throws(() => readConfig({...base,BLOCK_WORKERS:'9'}),/BLOCK_WORKERS/);
  assert.throws(() => readConfig({...base,BLOCK_WORKERS:'0'}),/BLOCK_WORKERS/);
  assert.throws(() => readConfig({...base,BLOCK_INTERVAL_SECONDS:'301'}),/BLOCK_INTERVAL_SECONDS/);
});

const URL3 = 'https://www.facebook.com/groups/456/posts/20';
function queueSetup(t, collector) {
  const ctx = parallelSetup(t,collector);
  const other = ctx.store.addGroup(2,'https://www.facebook.com/groups/456/').group;
  ctx.store.observe(other,[],ctx.monitor.options());
  ctx.store.observe(other,[{id:'20',url:URL3,text:'wanted',author:'Bob',authorUrl:AUTHOR,publishedAt:new Date(Date.now() - 3600000).toISOString()}],ctx.monitor.options());
  const now = Date.now();
  ctx.store.scheduleCommenterBlock(2,2,0,other.id,'20',URL3,now-5000);
  ctx.store.scheduleCommenterBlock(1,1,99,ctx.group.id,'10',POST_URL,now-3000);
  ctx.store.scheduleCommenterBlock(1,1,0,ctx.group.id,'11',URL2,now-2000);
  return {...ctx,other,now,jobs:Object.fromEntries([[1,POST_URL],[2,URL2]].map(([n,url]) => [n,ctx.store.commenterBlockJob(1,url)]))};
}
const waitOf = (items,url) => items.find(item => item.postUrl === url);

test('queue position follows the worker order globally without exposing other owners jobs', t => {
  const {store,now} = queueSetup(t);
  const items = commenterBlockWaits(store,1,{now});
  assert.equal(items.length,2);
  assert.ok(items.every(item => item.ownerId === 1));
  assert.deepEqual(items.map(item => item.postUrl).sort(),[POST_URL,URL2]);
  const first = waitOf(items,POST_URL).wait, second = waitOf(items,URL2).wait;
  assert.deepEqual([first.position,first.total,first.reason,first.until],[2,3,'turn',null]);
  assert.deepEqual([second.position,second.total],[3,3]);
  assert.match(second.text,/Đứng thứ 3\/3/);
  const owner2 = commenterBlockWaits(store,2,{now});
  assert.equal(owner2.length,1);
  assert.equal(owner2[0].wait.position,1);
});

test('wait reasons: busy workers, retry timer, paused source, stopped runtime, hold, cooldown and budget', t => {
  const {store,group,now,jobs} = queueSetup(t);
  const running = store.nextCommenterBlockJob(now,[2]);
  store.commenterBlockJobState(running.id,'running');
  let items = commenterBlockWaits(store,1,{now,workers:1});
  assert.deepEqual([waitOf(items,POST_URL).wait.reason,waitOf(items,POST_URL).wait.position,waitOf(items,POST_URL).wait.total,waitOf(items,POST_URL).wait.running],['busy',1,2,1]);
  assert.match(waitOf(items,POST_URL).wait.text,/1 luồng đang bận/);
  assert.equal(commenterBlockWaits(store,1,{now,workers:3})[0].wait.reason,'turn');
  assert.equal(commenterBlockWaits(store,1,{now,stopped:true})[0].wait.reason,'stopped');
  items = commenterBlockWaits(store,1,{now,blocked:() => ({reason:'hold',until:now+60000}),ownerIds:[2]});
  assert.deepEqual([items[0].wait.reason,items[0].wait.until,items[0].wait.position],['hold',now+60000,null]);
  items = commenterBlockWaits(store,1,{now,blocked:() => ({reason:'cooldown',until:null})});
  assert.equal(items[0].wait.reason,'cooldown');
  items = commenterBlockWaits(store,1,{now,budgetUntil:() => now+900000});
  assert.deepEqual([items[0].wait.reason,items[0].wait.until],['budget',now+900000]);
  assert.ok(items[0].wait.position >= 1);
  const later = now + 600000;
  store.finishCommenterBlockJob(running.id,'pending',{},null,null);
  store.prepare("UPDATE commenter_block_jobs SET state='pending',run_at=? WHERE id=?").run(later,jobs[2].id);
  items = commenterBlockWaits(store,1,{now});
  assert.deepEqual([waitOf(items,URL2).wait.reason,waitOf(items,URL2).wait.until,waitOf(items,URL2).wait.position],['retry',later,null]);
  store.setPaused(1,group.id,true);
  items = commenterBlockWaits(store,1,{now});
  assert.ok(items.every(item => item.wait.reason === 'paused' && item.wait.until === null && item.wait.position === null));
  assert.equal(commenterBlockWaits(store,1,{now,stopped:true})[0].wait.reason,'stopped');
});

test('monitor reports account hold and the limiter background budget as wait reasons', t => {
  const budgetAt = Date.now() + 1200000;
  const {monitor,now} = queueSetup(t,{graphql:{limiter:{lowBudgetUntil:() => budgetAt}}});
  const mine = () => monitor.commenterBlockWaits(1,{now}).map(item => item.wait);
  assert.ok(mine().every(wait => wait.reason === 'budget' && wait.until === budgetAt && wait.position));
  const until = monitor.holdAction('block',1,null,now);
  assert.ok(mine().every(wait => wait.reason === 'hold' && wait.until === until && wait.position === null));
  monitor.collector.canScan = () => false;
  assert.ok(mine().every(wait => wait.reason === 'cooldown'));
});

test('limiter reports when the background budget frees up', async () => {
  let clock = 1000000;
  const limiter = new RequestLimiter({minDelayMs:0,maxDelayMs:0,maxPerHour:4,now:() => clock,sleep:async () => {}});
  assert.equal(limiter.lowBudgetUntil(1),null);
  for (let i = 0; i < 3; i++) { await limiter.run(1,async () => i); clock += 1000; }
  assert.equal(limiter.lowBudgetUntil(1),1000000 + 3600000);
  assert.equal(limiter.lowBudgetUntil(2),null);
});

test('cancelling blocks only touches the owner jobs, by source or all, and keeps finished jobs', t => {
  const {store,other,group,now,jobs} = queueSetup(t);
  store.commenterBlockJobState(jobs[2].id,'done',{blocked:1});
  assert.equal(store.cancelCommenterBlocks(1,other.id),0);
  assert.equal(store.commenterBlockJob(2,URL3).state,'pending');
  assert.equal(store.cancelCommenterBlocks(1,group.id),1);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'stopped');
  assert.equal(store.commenterBlockJob(1,URL2).state,'done');
  assert.equal(store.commenterBlockJob(2,URL3).state,'pending');
  assert.equal(store.cancelCommenterBlocks(1),0);
  assert.equal(store.cancelCommenterBlocks(2),1);
  assert.equal(store.commenterBlockQueue(now).length,0);
});

test('a running job stops before the next block after it is cancelled', async t => {
  const blocks = [];
  let release;
  const collector = {
    async collectCommentContacts() { await new Promise(resolve => { release = resolve; }); return {scanned:1,items:[],comments:[comment(1,'222')]}; },
    async blockUser(owner,url) { blocks.push(url); return {success:true,state:'blocked'}; },
  };
  const {store,monitor,group} = setup(t,{collector});
  store.scheduleCommenterBlock(1,1,99,group.id,'10',POST_URL,0);
  const run = monitor.commenterBlockOne();
  await tick(() => release && store.commenterBlockJob(1,POST_URL).state === 'running');
  assert.equal(store.cancelCommenterBlocks(1,group.id),1);
  release();
  await run;
  assert.deepEqual(blocks,[]);
  assert.equal(store.commenterBlockJob(1,POST_URL).state,'stopped');
});
