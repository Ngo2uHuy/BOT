import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parseDateRange } from '../src/dates.js';

test('joined groups deliver the first batch and all posts are owner scoped',t=>{
  const {store}=setup(t);
  const {group,created}=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/joined/',name:'Joined'});
  assert.equal(created,true);
  assert.equal(store.getGroup(group.id).initialized,true);
  store.observe(group,[post('joined-post')],options(100));
  assert.equal(store.nextDelivery(100,[111]).post_id,'joined-post');
  assert.equal(store.listAllPosts(111).length,1);
  assert.equal(store.listAllPosts(222).length,0);
  store.setPaused(111,group.id,true);
  assert.equal(store.addJoinedGroup(111,{url:group.url,name:'Renamed'}).created,false);
  assert.equal(store.getGroup(group.id).paused,true);
});

test('joined listings store numeric IDs of slug groups and backfill groups already followed',t=>{
  const {store}=setup(t);
  const {group}=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/pmzalo/',name:'Zalo',numericId:'964496467736241'});
  assert.equal(store.getGroup(group.id).numericId,'964496467736241');
  const old=store.addGroup(111,'https://www.facebook.com/groups/codeweb/').group;
  const other=store.addGroup(222,'https://www.facebook.com/groups/codeweb/').group;
  assert.equal(store.setNumericIdsByUrl(111,[{url:'https://www.facebook.com/groups/codeweb/',numericId:'435653381691334'},{url:'https://www.facebook.com/groups/missing/',numericId:'12345678'},{url:'https://www.facebook.com/groups/nameless/'}]),1);
  assert.equal(store.getGroup(old.id).numericId,'435653381691334');
  assert.equal(store.getGroup(other.id).numericId,null,'other owners are untouched');
});

test('a scan missing the timestamp preserves a previously observed publication date',t=>{
  const {store,group}=setup(t);
  store.observe(group,[{...post('1'),publishedAt:'2025-10-10T00:00:00Z'}],options(100));
  store.observe(group,[{...post('1'),publishedAt:null}],options(200));
  assert.equal(store.listPosts(111,group.id)[0].publishedAt,'2025-10-10T00:00:00Z');
});

test('range backfills baseline posts, excludes unknown/outside dates and preserves deduplication', t => {
  const {store,group} = setup(t);
  const old = {...post('1'), publishedAt:'2025-10-10T00:00:00Z'};
  store.observe(group,[old],options(100));
  assert.equal(store.setDateRange(222,group.id,parseDateRange('10/10/2025')),0);
  store.setDateRange(111,group.id,parseDateRange('10/10/2025 10/10/2025'));
  const now = Date.parse('2026-10-10T00:00:00Z');
  store.observe(group,[old, post('2'), {...post('3'), publishedAt:'2025-10-11T00:00:00Z'}],options(now));
  const delivery = store.nextDelivery(now,[111]);
  assert.equal(delivery.post_id,'1');
  store.delivered(delivery,123);
  store.observe(group,[old],options(now+1));
  assert.equal(store.nextDelivery(now+1,[111]),undefined);
});

const render = (group,post) => `${group.url}\n${post.text}\n${post.reactions ?? 'unknown'}`;
const matches = (text,words) => !words.length || words.some(word => text.includes(word));
const options = (now) => ({now,metricWindowMs:86400000,render,matches});
const post = (id,text='new post',reactions=null) => ({id,url:`https://www.facebook.com/groups/demo/posts/${id}`,text,reactions});
test('streaming baseline batches stay silent and background work preserves the fast scan clock',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],{...options(100),finalize:false});
  store.observe(group,[post('2')],{...options(200),finalize:false});
  assert.equal(store.getGroup(group.id).initialized,false);
  assert.equal(store.getGroup(group.id).lastScanAt,null);
  assert.equal(store.nextDelivery(200,[111]),undefined);
  store.observe(group,[post('1'),post('2')],options(300));
  assert.equal(store.nextDelivery(300,[111]),undefined);
  store.observe(group,[post('3')],{...options(400),finalize:false});
  assert.equal(store.getGroup(group.id).lastScanAt,300);
  assert.equal(store.nextDelivery(400,[111]).post_id,'3');
});
function setup(t,filename=':memory:') {
  const store = new Store(filename);
  t.after(() => store.close());
  store.ensureUser(111,111); store.ensureUser(222,222);
  const group = store.addGroup(111,'https://www.facebook.com/groups/demo/').group;
  return {store,group};
}

test('baseline is silent, subsequent posts enqueue once and count changes update the same message',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],options(100));
  assert.equal(store.nextDelivery(100,[111]),undefined);
  store.observe(group,[post('1'),post('2')],options(200));
  const delivery = store.nextDelivery(200,[111]);
  assert.equal(delivery.post_id,'2');
  store.delivered(delivery,777);
  store.observe(group,[post('2')],options(300));
  assert.equal(store.nextDelivery(300,[111]),undefined);
  store.observe(group,[post('2','new post',5)],options(400));
  assert.equal(store.nextDelivery(400,[111]).message_id,777);
  assert.match(store.nextDelivery(400,[111]).body,/5$/);
});

test('users cannot modify each other groups and removed allowlist users cannot be dispatched',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],options(100));
  store.observe(group,[post('2')],options(200));
  assert.deepEqual(store.listGroups(222),[]);
  assert.equal(store.removeGroup(222,group.id),false);
  assert.equal(store.setPaused(222,group.id,true),0);
  assert.equal(store.setKeywords(222,group.id,['secret']),0);
  assert.equal(store.nextDelivery(200,[222]),undefined);
  assert.equal(store.nextDelivery(200,[]),undefined);
  assert.ok(store.nextDelivery(200,[111]));
});

test('deleting a group cancels posts and queued deliveries',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],options(100));
  store.observe(group,[post('2')],options(200));
  store.removeGroup(111,group.id);
  assert.equal(store.nextDelivery(200,[111]),undefined);
  assert.equal(store.status(111).posts,0);
});

test('transaction rolls back both post observation and baseline when formatting fails',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],options(100));
  assert.throws(() => store.observe(group,[post('2')],{...options(200),render:() => {throw new Error('failure');}}));
  assert.equal(store.status(111).posts,1);
  assert.equal(store.getGroup(group.id).lastScanAt,100);
  store.observe(group,[post('2')],options(300));
  assert.ok(store.nextDelivery(300,[111]));
});

test('per-group keywords override defaults and null metrics never become zero',t => {
  const {store,group} = setup(t);
  store.setKeywords(111,null,['buy']);
  store.observe(group,[post('1')],options(100));
  store.observe(group,[post('2','sell')],options(200));
  assert.equal(store.nextDelivery(200,[111]),undefined);
  store.setKeywords(111,group.id,['sell']);
  store.observe(group,[post('2','sell')],options(300));
  assert.match(store.nextDelivery(300,[111]).body,/unknown$/);
});

test('reject keywords filter out posts and per-group reject keywords override defaults', t => {
  const {store,group} = setup(t);
  store.setRejectKeywords(111,null,['spam']);
  assert.deepEqual(store.getRejectKeywords(111), ['spam']);
  assert.deepEqual(store.effectiveRejectKeywords(group), ['spam']);
  store.observe(group,[post('1')],options(100));
  const realOptions = (now) => ({now,metricWindowMs:86400000,render,matches: (text,kw,rej) => (!kw.length || kw.some(w=>text.includes(w))) && !(rej?.some(w=>text.includes(w)))});
  store.observe(group,[post('2','buy now spam')],realOptions(200));
  assert.equal(store.nextDelivery(200,[111]),undefined);
  store.observe(group,[post('3','buy now clean')],realOptions(300));
  assert.equal(store.nextDelivery(300,[111]).post_id,'3');
  store.setRejectKeywords(111,group.id,['banned']);
  assert.deepEqual(store.effectiveRejectKeywords(store.getGroup(group.id)), ['banned']);
});

test('outbox survives restart and retry schedule; pause prevents sending',() => {
  const directory = mkdtempSync(path.join(tmpdir(),'fb-monitor-store-'));
  const filename = path.join(directory,'test.sqlite');
  let store;
  try {
    store = new Store(filename); store.ensureUser(111,111);
    const group = store.addGroup(111,'https://www.facebook.com/groups/demo/').group;
    store.observe(group,[post('1')],options(100));
    store.observe(group,[post('2')],options(200));
    const delivery = store.nextDelivery(200,[111]);
    store.deliveryFailed(delivery,5000,200);
    store.mapMessage(111,111,998,group.id,'2','list');
    store.close(); store = new Store(filename);
    assert.equal(store.replyTarget(111,111,998).replyMode,'list');
    assert.equal(store.nextDelivery(5000,[111]),undefined);
    assert.ok(store.nextDelivery(5200,[111]));
    store.setPaused(111,group.id,true);
    assert.equal(store.nextDelivery(6000,[111]),undefined);
    store.setPaused(111,group.id,false);
    assert.ok(store.nextDelivery(6000,[111]));
  } finally {
    store?.close();
    // mkdtempSync returned this dedicated test directory, never a workspace root.
    rmSync(directory,{recursive:true,force:true});
  }
});

test('legacy message mappings migrate with single-comment behavior',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'fb-navigation-migration-'));
  const filename=path.join(directory,'test.sqlite');
  let store;
  try {
    store=new Store(filename);store.ensureUser(111,111);
    const group=store.addGroup(111,'https://www.facebook.com/groups/demo/').group;
    store.observe(group,[post('1')],options(100));
    store.mapMessage(111,111,77,group.id,'1');
    store.db.exec('ALTER TABLE message_posts DROP COLUMN reply_mode');
    store.close();store=new Store(filename);
    assert.equal(store.replyTarget(111,111,77).replyMode,'single');
  } finally {
    store?.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('legacy groups migrate incremental scan columns without losing rows',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'fb-scan-migration-'));
  const filename=path.join(directory,'test.sqlite');
  let store;
  try {
    store=new Store(filename);store.ensureUser(111,111);
    const group=store.addGroup(111,'https://www.facebook.com/groups/demo/').group;
    for (const column of ['numeric_id','last_seen_time','next_scan_at','scan_interval_ms']) store.db.exec(`ALTER TABLE groups DROP COLUMN ${column}`);
    store.close();store=new Store(filename);
    const columns=store.db.prepare('PRAGMA table_info(groups)').all().map(column=>column.name);
    for (const column of ['numeric_id','last_seen_time','next_scan_at','scan_interval_ms']) assert.ok(columns.includes(column),column);
    const migrated=store.getGroup(group.id);
    assert.equal(migrated.url,'https://www.facebook.com/groups/demo/');
    assert.deepEqual([migrated.numericId,migrated.lastSeenTime,migrated.nextScanAt,migrated.scanIntervalMs],[null,null,null,null]);
  } finally {
    store?.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('observe counts new posts and advances the watermark without trusting future dates',t=>{
  const {store,group}=setup(t);
  const now=Date.parse('2026-10-10T00:00:00Z');
  const dated=(id,at)=>({...post(id),publishedAt:new Date(at).toISOString()});
  assert.equal(store.observe(group,[dated('1',now-5000),dated('2',now-1000)],options(now)),2);
  assert.equal(store.getGroup(group.id).lastSeenTime,now-1000);
  assert.equal(store.observe(group,[dated('1',now-5000),dated('3',now+86400000)],options(now)),1);
  assert.equal(store.getGroup(group.id).lastSeenTime,now);
  assert.equal(store.observe(group,[dated('1',now-5000)],options(now+10)),0);
  assert.equal(store.getGroup(group.id).lastSeenTime,now);
});

test('numeric group IDs are validated before being stored as aliases',t=>{
  const {store,group}=setup(t);
  assert.equal(store.setNumericId(group.id,'not-a-number'),0);
  assert.equal(store.setNumericId(group.id,'123456789012345'),1);
  assert.equal(store.setNumericId(group.id,'123456789012345'),0);
  assert.equal(store.getGroup(group.id).numericId,'123456789012345');
});

test('adaptive interval shortens on new posts, backs off to the maximum and explicit rescans run immediately',t=>{
  const {store,group}=setup(t);
  const limits={minMs:120000,maxMs:300000};
  assert.equal(store.scheduleScan(group.id,false,{...limits,now:0}),120000);
  assert.equal(store.scheduleScan(group.id,false,{...limits,now:0}),180000);
  assert.equal(store.scheduleScan(group.id,false,{...limits,now:0}),270000);
  assert.equal(store.scheduleScan(group.id,false,{...limits,now:0}),300000);
  assert.equal(store.scheduleScan(group.id,true,{...limits,now:1000}),120000);
  assert.equal(store.getGroup(group.id).nextScanAt,121000);
  store.recordScanError(group.id,'',1000);
  assert.deepEqual(store.dueGroups([111],5000,5000),[]);
  assert.equal(store.dueGroups([111],5000,121000)[0].id,group.id);
  store.requestScan(111,group.id);
  assert.equal(store.dueGroups([111],5000,5000)[0].id,group.id);
});

test('initStartupDateRange sets start to startup time and end to null, resets last_scan_at', t => {
  const {store} = setup(t);
  const g1 = store.addGroup(111,'https://www.facebook.com/groups/g1/').group;
  const g2 = store.addGroup(111,'https://www.facebook.com/groups/g2/').group;
  store.setDateRange(111, g2.id, { start: 1000, end: 2000 });
  const startup = 500000;
  assert.equal(store.initStartupDateRange(startup, { all: false }), 2); // default group from setup (dateRange: null) + g1
  assert.deepEqual(store.getGroup(g1.id).dateRange, { start: startup, end: null });
  assert.deepEqual(store.getGroup(g2.id).dateRange, { start: 1000, end: 2000 });

  const secondStartup = 600000;
  assert.equal(store.initStartupDateRange(secondStartup, { all: true }), 3); // group from setup + g1 + g2
  assert.deepEqual(store.getGroup(g1.id).dateRange, { start: secondStartup, end: null });
  assert.deepEqual(store.getGroup(g2.id).dateRange, { start: secondStartup, end: null });
  assert.equal(store.getGroup(g1.id).lastScanAt, null);
});


test('activity rates count recent posts per group and planned intervals replace the backoff',t=>{
  const {store}=setup(t);
  const busy=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/busy/'}).group;
  const quiet=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/quiet/'}).group;
  const now=Date.parse('2026-10-17T00:00:00Z');
  store.observe(busy,[1,2,3,4].map(i=>({...post(`b${i}`),publishedAt:new Date(now-i*3600000).toISOString()})),options(now));
  store.observe(quiet,[{...post('old'),publishedAt:new Date(now-72*3600000).toISOString()}],options(now));
  const rates=store.activityRates(111,48*3600000,now);
  assert.equal(rates.get(busy.id),4/48);
  assert.equal(rates.get(quiet.id),0);
  assert.equal(store.scheduleScan(quiet.id,false,{minMs:10000,maxMs:600000,plannedMs:900000,now}),900000);
  assert.equal(store.scheduleScan(quiet.id,false,{minMs:10000,maxMs:600000,plannedMs:42000,now}),42000);
  assert.equal(store.scheduleScan(quiet.id,true,{minMs:10000,maxMs:600000,plannedMs:42000,now}),10000);
});

test('when several groups are due the busiest one (shortest planned interval) is scanned first',t=>{
  const {store}=setup(t);
  const quiet=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/quietfirst/'}).group;
  const busy=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/busylater/'}).group;
  const now=Date.parse('2026-10-17T00:00:00Z');
  for (const [group,ms] of [[quiet,600000],[busy,40000]]) {
    store.observe(group,[],{...options(now-700000)});
    store.scheduleScan(group.id,false,{minMs:10000,maxMs:600000,plannedMs:ms,now:now-700000});
  }
  const due=store.dueGroups([111],now,now).filter(group=>[quiet.id,busy.id].includes(group.id));
  assert.deepEqual(due.map(group=>group.id),[busy.id,quiet.id]);
});

test('activity profile counts recent posts, the ones the groups feed missed and a Vietnam hour-of-day histogram',t=>{
  const {store}=setup(t);
  const group=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/profiled/'}).group;
  const now=Date.parse('2026-10-17T05:00:00Z');
  const at=hours=>({...post(`p${hours}`),publishedAt:new Date(now-hours*3600000).toISOString()});
  store.observe(group,[at(1),at(2),at(100)],options(now));
  store.observe(group,[at(1)],{...options(now),fromFeed:true});
  const item=store.activityProfile(111,{now}).get(group.id);
  assert.deepEqual([item.recent,item.missed],[2,1]);
  assert.equal(item.hours.reduce((a,b)=>a+b,0),3);
  assert.equal(item.hours[11],1,'04:00Z is 11:00 in Vietnam');
});

test('activity ignores posts outside the Accept/Reject filter and caps each author, so fake-account spam stays quiet',t=>{
  const {store}=setup(t);
  const group=store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/spammy/'}).group;
  store.setKeywords(111,group.id,['cần tìm']);
  const now=Date.parse('2026-10-17T05:00:00Z');
  const make=(id,author,text,hours)=>({...post(id),text,author,authorUrl:`https://www.facebook.com/${author}`,publishedAt:new Date(now-hours*3600000).toISOString()});
  store.observe(group,[
    make('s1','bot1','cần tìm người làm web',1),make('s2','bot1','cần tìm người làm web',2),make('s3','bot1','cần tìm người làm web',3),make('s4','bot1','cần tìm người làm web',4),
    make('a1','alice','cần tìm dev app',5),make('o1','bob','nhận làm web giá rẻ',6),
  ],options(now));
  const item=store.activityProfile(111,{now,matches:(text,keywords)=>!keywords.length || keywords.some(k=>text.includes(k))}).get(group.id);
  assert.equal(item.total,6);
  assert.equal(item.recent,3,'bot1 counts twice, alice once, bob (rejected by Accept) not at all');
});

test('account-wide keywords are mirrored to general-config.json and restored when the database is lost', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'store-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'monitor.sqlite'), config = path.join(dir, 'general-config.json');
  let store = new Store(file);
  store.ensureUser(7, 70);
  store.setKeywords(7, null, ['thiết kế web']);
  store.setRejectKeywords(7, null, ['tuyển dụng']);
  const group = store.addGroup(7, 'https://www.facebook.com/groups/demo/').group;
  store.setKeywords(7, group.id, ['chỉ nhóm']);
  store.close();
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).users, { 7: { chatId: 70, keywords: ['thiết kế web'], rejectKeywords: ['tuyển dụng'] } });
  for (const name of ['monitor.sqlite', 'monitor.sqlite-wal', 'monitor.sqlite-shm']) rmSync(path.join(dir, name), { force: true });
  store = new Store(file);
  assert.deepEqual(store.getKeywords(7), ['thiết kế web']);
  assert.deepEqual(store.getRejectKeywords(7), ['tuyển dụng']);
  assert.equal(store.listGroups(7).length, 0);
  store.setKeywords(7, null, ['mới']);
  store.close();
  store = new Store(file);
  assert.deepEqual(store.getKeywords(7), ['mới']);
  store.close();
  writeFileSync(config, '{hỏng');
  store = new Store(file);
  assert.deepEqual(store.getKeywords(7), ['mới']);
  store.close();
});

test('pruning drops stale unreferenced posts but keeps reply mappings, action history and pending outbox',t=>{
  const store=new Store(':memory:'); t.after(()=>store.close());
  store.ensureUser(1,1);
  const group=store.addGroup(1,'https://www.facebook.com/groups/demo/').group;
  const day=86400000, now=100*day, old=now-10*day;
  const options={metricWindowMs:day,render:()=>'body',matches:()=>true};
  const post=id=>({id,url:`https://www.facebook.com/groups/demo/posts/${id}`,text:'x',publishedAt:new Date(old).toISOString()});
  store.observe(group,['a','b','c','d','e','f','g'].map(post),{...options,now:old});
  store.mapMessage(1,1,10,group.id,'b');
  store.enqueueComment(group.id,'c','hi','manual',old);
  store.prepare('INSERT INTO deliveries(group_id,post_id,body) VALUES(?,?,?)').run(group.id,'d','pending');
  store.prepare('INSERT INTO deliveries(group_id,post_id,body,sent_body) VALUES(?,?,?,?)').run(group.id,'e','sent','sent');
  store.enqueueFriendRequest(group.id,'f','https://www.facebook.com/profile.php?id=123','A','manual',old);
  store.observe(group,[post('g')],{...options,now});
  assert.equal(store.prunePosts(7*day,now),2);
  assert.deepEqual(store.prepare('SELECT post_id FROM posts ORDER BY post_id').all().map(row=>row.post_id),['b','c','d','f','g']);
  assert.equal(store.replyTarget(1,1,10)?.postId,'b');
  assert.equal(store.prunePosts(7*day,now),0);
});

test('rejected-by-keyword posts are queued once, only after the owner enabled it, with the right reason',async t => {
  const {matchesKeywords}=await import('../src/input.js');
  const {store,group}=setup(t);
  const opts=now=>({...options(now),matches:matchesKeywords});
  const queued=()=>store.prepare('SELECT post_id,body FROM rejected_deliveries ORDER BY post_id').all();
  store.setKeywords(111,null,['cần']); store.setRejectKeywords(111,null,['spam']);
  store.observe(group,[],opts(50));
  store.observe(group,[post('off','cần mua spam')],opts(100));
  assert.equal(queued().length,0);
  assert.equal(store.setRejectedNotify(111,200),1);
  store.observe(group,[post('off','cần mua spam'),post('ok','cần mua'),post('rej','cần mua spam rẻ'),post('acc','bán nhà')],opts(300));
  const rows=queued();
  assert.deepEqual(rows.map(row=>row.post_id),['acc','rej']);
  assert.match(rows[1].body,/Khớp Reject: spam/);
  assert.match(rows[0].body,/Không khớp từ khóa Accept nào/);
  assert.match(rows[0].body,/^🚫 Bài bị loại theo từ khóa · Nhóm #/);
  store.observe(group,[post('rej','cần mua spam rẻ')],opts(400));
  assert.equal(queued().length,2);
  const item=store.nextRejected(400,[111]);
  store.rejectedSent(item);
  assert.equal(store.nextRejected(400,[111]).post_id,'rej');
  assert.equal(store.nextRejected(400,[222]),undefined);
  assert.equal(store.prunePosts(0,1e12),2);
  assert.equal(queued().length,1);
  store.setRejectedNotify(111,null);
  assert.equal(store.nextRejected(400,[111]),undefined);
  assert.equal(queued().length,0);
});

test('rejected notifications respect the source date range',async t => {
  const {matchesKeywords}=await import('../src/input.js');
  const {store,group}=setup(t);
  store.observe(group,[],{...options(50),matches:matchesKeywords});
  store.setRejectKeywords(111,null,['spam']);
  store.setRejectedNotify(111,100);
  const now=Date.parse('2026-05-10T00:00:00Z');
  store.setDateRange(111,group.id,parseDateRange('01/05/2026 05/05/2026'));
  const inside=new Date('2026-05-02T00:00:00Z').toISOString(), outside=new Date('2026-05-08T00:00:00Z').toISOString();
  store.observe(group,[{...post('in','spam'),publishedAt:inside},{...post('out','spam'),publishedAt:outside}],{...options(now),matches:matchesKeywords});
  assert.deepEqual(store.prepare('SELECT post_id FROM rejected_deliveries').all().map(row=>row.post_id),['in']);
});

test('removing one list row is owner-checked; sent rows, posts and rejections are only hidden so dedupe holds',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);store.setRejectedNotify(1,0);store.setKeywords(1,null,['bếp']);
  const group=store.addJoinedGroup(1,{url:'https://www.facebook.com/groups/a/',name:'A'}).group;
  const foreign=store.addJoinedGroup(2,{url:'https://www.facebook.com/groups/b/',name:'B'}).group;
  const now=Date.now(),author='https://www.facebook.com/an';
  const post=(id,text='Bếp gas',slug='a')=>({id,url:`https://www.facebook.com/groups/${slug}/posts/${id}`,text,author:'An',authorUrl:author,publishedAt:new Date(now-1000).toISOString()});
  const options={now,render:(_group,item)=>item.text,matches:(text,accept)=>!accept.length || accept.some(word=>text.toLowerCase().includes(word)),metricWindowMs:60000};
  store.observe(group,[post('1'),post('2'),post('3','Hỏi đường')],options);
  store.observe(foreign,[post('9','Bếp','b')],options);
  const missing=/Không tìm thấy bản ghi của bạn/,count=(sql,...args)=>store.prepare(sql).get(...args).n;

  store.queueCommentList(1,group.id,['1','2'],['a']);store.queueComments(2,foreign.id,['9'],'b');
  const [pending,sent]=store.pageComments(1,{sort:'id',dir:'asc'}).items.map(item=>item.id);
  store.commentState(sent,'sent');
  assert.throws(()=>store.removeListItem('comments',2,pending),missing);
  assert.deepEqual(store.removeListItem('comments',1,pending),{action:'deleted'});
  assert.equal(count('SELECT COUNT(*) n FROM comments WHERE id=?',pending),0);
  assert.deepEqual(store.removeListItem('comments',1,sent),{action:'hidden'});
  assert.equal(store.pageComments(1,{}).total,0);
  assert.equal(store.queueComments(1,group.id,['2'],'a').queued,0,'the hidden sent comment still blocks the same comment');
  assert.throws(()=>store.removeListItem('comments',1,sent),missing);
  store.queueComments(1,group.id,['1'],'c');
  const sending=store.pageComments(1,{}).items[0].id;store.commentState(sending,'sending');
  assert.throws(()=>store.removeListItem('comments',1,sending),/Đang gửi/);
  assert.equal(store.pageComments(2,{}).total,1,'the other owner keeps its row');

  store.enqueueDirectMessage(group.id,'1',author,'An','Chào','manual',now);
  const message=store.pageDirectMessages(1,{}).items[0].id;store.directMessageState(message,'sent',null,now);
  assert.deepEqual(store.removeListItem('inboxes',1,message),{action:'hidden'});
  assert.equal(store.pageDirectMessages(1,{}).total,0);
  assert.equal(store.enqueueDirectMessage(group.id,'2',author,'An','Chào lần 2','auto',now),0,'one opening message per recipient survives hiding');

  store.enqueueFriendRequest(group.id,'1',author,'An','manual',now);
  const friend=store.pageFriendRequests(1,{}).items[0].id;store.friendRequestState(friend,'sent',null,now);
  assert.deepEqual(store.removeListItem('friends',1,friend),{action:'hidden'});
  assert.equal(store.enqueueFriendRequest(group.id,'2',author,'An','auto',now),0);
  store.queueFriendRequest(1,group.id,'1');
  assert.deepEqual(store.pageFriendRequests(1,{}).items.map(item=>[item.id,item.state]),[[friend,'pending']],'a manual re-send shows the row again');
  assert.deepEqual(store.removeListItem('friends',1,friend),{action:'deleted'});

  const {job}=store.scheduleCommenterBlock(1,1,0,group.id,'1',post('1').url,now);
  store.commenterBlockJobState(job.id,'running');
  assert.throws(()=>store.removeListItem('blocks',2,job.id),missing);
  assert.deepEqual(store.removeListItem('blocks',1,job.id),{action:'deleted',stopped:true});
  assert.equal(store.pageCommenterBlocks(1,{}).total,0);
  const {job:done}=store.scheduleCommenterBlock(1,1,0,group.id,'2',post('2').url,now);
  store.commenterBlockJobState(done.id,'done');
  assert.deepEqual(store.removeListItem('blocks',1,done.id),{action:'deleted'});

  const link=store.saveAffiliateLink(1,'shopee:1','https://shopee.vn/a','https://s.shopee.vn/a',now);
  assert.throws(()=>store.removeListItem('links',2,link.id),missing);
  assert.deepEqual(store.removeListItem('links',1,link.id),{action:'deleted'});

  for (let item,id=100;(item=store.nextDelivery(now+1,[1]));) store.delivered(item,++id);
  const key={groupId:group.id,postId:'1'};
  assert.throws(()=>store.removeListItem('posts',2,key),missing);
  assert.deepEqual(store.removeListItem('posts',1,key),{action:'hidden'});
  assert.deepEqual(store.pagePosts(1,{}).items.map(item=>item.id).sort(),['2','3']);
  assert.deepEqual(store.pagePosts(1,{filters:{hidden:'yes'}}).items.map(item=>item.id),['1']);
  assert.equal(store.queueComments(1,group.id,null,'tất cả').queued,1,'/comment ID all skips the hidden post');
  assert.equal(store.observe(group,[post('1')],options),0,'seen again: not a new post');
  assert.equal(store.nextDelivery(now+1,[1]),undefined,'and not delivered again');
  assert.equal(store.pagePosts(1,{filters:{hidden:'yes'}}).total,1,'a rescan keeps it hidden');
  assert.deepEqual(store.removeListItem('posts',1,key,{restore:true}),{action:'restored'});
  assert.equal(store.pagePosts(1,{}).total,3);
  assert.throws(()=>store.removeListItem('posts',1,key,{restore:true}),missing);

  const rejected={groupId:group.id,postId:'3'};
  assert.equal(store.pageRejected(1,{}).total,1);
  assert.deepEqual(store.removeListItem('rejected',1,rejected),{action:'hidden'});
  store.observe(group,[post('3','Hỏi đường')],options);
  assert.equal(count('SELECT COUNT(*) n FROM rejected_deliveries'),1,'no second rejection notice');
  assert.equal(store.pageRejected(1,{}).total,0);
  assert.deepEqual(store.removeListItem('rejected',1,rejected,{restore:true}),{action:'restored'});
  assert.equal(store.pageRejected(1,{}).total,1);

  assert.throws(()=>store.removeListItem('comments',1,sent,{restore:true}),/Chỉ bỏ ẩn/);
  assert.throws(()=>store.removeListItem('hot',1,1),/không hỗ trợ/);
  assert.throws(()=>store.removeListItem('sources',2,group.id),missing);
  assert.deepEqual(store.removeListItem('sources',1,group.id),{action:'deleted'});
  assert.equal(store.pagePosts(2,{}).total,1);
});
