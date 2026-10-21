import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Monitor, allocateScanRates, safeError } from '../src/monitor.js';
import { parseDateRange } from '../src/dates.js';

test('changing date range cancels a queued post without a known date', async t => {
  let sends = 0;
  const {store,group,monitor} = setup(t,{sendMessage:async () => {sends++; return {message_id:5};}});
  store.setDateRange(111,group.id,parseDateRange('10/10/2025'));
  await monitor.deliverOne();
  assert.equal(sends,0);
  assert.equal(store.status(111).pending,0);
});

function setup(t,api) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.ensureUser(111,111);
  const group = store.addGroup(111,'https://www.facebook.com/groups/demo/').group;
  const config = {allowedUserIds:[111],metricWindowMs:86400000,pollIntervalMs:60000,metricRefreshMs:600000};
  const monitor = new Monitor({store,collector:{},api,config,log:() => {}});
  const post = id => ({id,url:`https://www.facebook.com/groups/demo/posts/${id}`,text:'Cần mua máy tính',reactions:null});
  store.observe(group,[post('1')],monitor.options());
  store.observe(group,[post('2')],monitor.options());
  return {store,group,monitor};
}

test('send failures retain outbox and retry; successful send persists Telegram message id',async t => {
  let fail=true;
  const {store,monitor} = setup(t,{sendMessage:async () => {
    if (fail) throw new Error('network unavailable');
    return {message_id:888};
  }});
  await monitor.deliverOne();
  assert.equal(store.status(111).pending,1);
  const item = store.nextDelivery(Date.now()+6000,[111]);
  store.deliveryFailed(item,0,0);
  fail=false;
  await monitor.deliverOne();
  assert.equal(store.status(111).pending,0);
});

test('changing keywords before dispatch cancels pending notification',async t => {
  let sends=0;
  const {store,monitor} = setup(t,{sendMessage:async () => {sends++; return {message_id:5};}});
  store.setKeywords(111,null,['ô tô']);
  await monitor.deliverOne();
  assert.equal(sends,0);
  assert.equal(store.status(111).pending,0);
});

test('dispatch renders newest matching keywords rather than the queued header',async t => {
  let text;
  const {store,monitor} = setup(t,{sendMessage:async (_chat,body) => {text=body; return {message_id:5};}});
  store.setKeywords(111,null,['máy tính']);
  await monitor.deliverOne();
  assert.match(text,/Từ khóa: máy tính/);
  assert.equal(store.status(111).pending,0);
});

test('an empty or inaccessible feed never establishes a successful baseline',async t => {
  const {store,group,monitor} = setup(t,{});
  const fresh = store.addGroup(111,'https://www.facebook.com/groups/fresh/').group;
  store.setPaused(111,group.id,true);
  monitor.collector = {collect:async () => []};
  monitor.wait = async () => {monitor.abort.abort();};
  await monitor.scanLoop();
  const result = store.getGroup(fresh.id);
  assert.equal(result.initialized,false);
  assert.match(result.lastError,/Không đọc được bài nào/);
});

test('Telegram rate limit retry_after is respected without losing a delivery',async t => {
  const {store,monitor} = setup(t,{sendMessage:async () => {throw {error_code:429,description:'Too Many Requests',parameters:{retry_after:30}};}});
  monitor.wait=async () => {};
  const start=Date.now();
  await monitor.deliverOne();
  assert.equal(store.nextDelivery(start+29000,[111]),undefined);
  assert.ok(store.nextDelivery(start+32000,[111]));
});

test('diagnostics redact Telegram tokens',() => {
  assert.equal(safeError(new Error('fetch https://api.telegram.org/bot123456789:ABC_def-123/getMe failed')).includes('ABC_def'),false);
});

test('a streamed post can be commented before its scan completes and is never queued twice',async t => {
  const {store,group,monitor} = setup(t,{sendMessage:async()=>({message_id:9})});
  store.setAutoReply(111,group.id,'Auto',Date.now()-10000);
  let finished=false, sent=false, woke=0;
  monitor.commentWake=()=>{woke++;};
  monitor.collector={
    collect:async (_owner,_url,range,options)=>{
      assert.equal(range,null);
      assert.equal(options.latest,true);
      const post={id:'3',url:'https://www.facebook.com/groups/demo/posts/3',text:'new',publishedAt:new Date().toISOString()};
      await options.onPosts([post]);
      await monitor.commentOne();
      assert.equal(sent,true);
      await options.onPosts([post]);
      finished=true;
      return [post];
    },
    comment:async()=>{assert.equal(finished,false);sent=true;},
  };
  monitor.config.pollIntervalMs=0;
  monitor.wait=async()=>monitor.abort.abort();
  await monitor.scanLoop();
  assert.ok(woke>0);
  assert.equal(store.listComments(111).length,1);
  assert.equal(store.listComments(111)[0].state,'sent');
});

test('history uses a separate lane and never moves the fast scan timestamp',async t => {
  const {store,group,monitor}=setup(t,{});
  store.setDateRange(111,group.id,parseDateRange('10/10/2025'));
  const before=store.getGroup(group.id).lastScanAt;
  monitor.collector={collect:async(_owner,_url,range,options)=>{
    assert.ok(range);
    assert.equal(options.background,true);
    assert.equal(options.latest,false);
    const post={id:'history',url:'https://www.facebook.com/groups/demo/posts/history',text:'old',publishedAt:'2025-10-10T00:00:00Z'};
    await options.onPosts([post]);
    monitor.abort.abort();
    return [post];
  }};
  await monitor.backgroundLoop();
  assert.equal(store.getGroup(group.id).lastScanAt,before);
  assert.ok(store.listPosts(111,group.id).some(post=>post.id==='history'));
});

test('explicit rescan overrides retry delay without changing another owner source',async t=>{
  const {store,group,monitor}=setup(t,{});
  monitor.failures.set(group.id,{attempts:3,retryAt:Date.now()+3600000});
  assert.equal(store.requestScan(222,group.id),0);
  assert.equal(store.requestScan(111,group.id),1);
  let called=false;
  monitor.collector={collect:async()=>{
    called=true;
    monitor.abort.abort();
    return [{id:'rescan',url:'https://www.facebook.com/groups/demo/posts/rescan',text:'new'}];
  }};
  monitor.wait=async()=>monitor.abort.abort();
  await monitor.scanLoop();
  assert.equal(called,true);
});

test('account cooldown blocks manual rescans and background requests while allowing other owners', async t => {
  const { store, group, monitor } = setup(t, {});
  store.requestScan(111, group.id);
  store.ensureUser(222, 222);
  store.addGroup(222, 'https://www.facebook.com/groups/other/');
  monitor.config.allowedUserIds.push(222);
  const calls = [];
  monitor.collector = {
    canScan: owner => owner !== 111,
    collect: async owner => { calls.push(owner); return [{ id: 'ok', url: 'https://www.facebook.com/groups/other/posts/ok', text: 'ok' }]; },
    collectPost: async () => assert.fail('blocked background call'),
  };
  monitor.wait = async () => monitor.abort.abort();
  await monitor.scanLoop();
  assert.deepEqual(calls, [222]);
  monitor.abort = new AbortController();
  await monitor.backgroundLoop();
  assert.deepEqual(calls, [222]);
  assert.equal(store.getGroup(group.id).lastScanAt, null);
});


test('fast scan passes incremental hints, stores the numeric alias and schedules the next scan adaptively', async t => {
  const { store, group, monitor } = setup(t, {});
  store.setNumericId(group.id, '123456789');
  store.requestScan(111, group.id);
  Object.assign(monitor.config, { scanMinIntervalMs: 120000, scanMaxIntervalMs: 1800000 });
  let seen;
  monitor.collector = { collect: async (_owner, _url, _range, options) => {
    seen = options;
    options.onGroupId('987654321');
    return [{ id: '9', url: 'https://www.facebook.com/groups/demo/posts/9', text: 'new', publishedAt: new Date().toISOString() }];
  } };
  monitor.wait = async () => monitor.abort.abort();
  const before = Date.now();
  await monitor.scanLoop();
  assert.equal(seen.numericId, '123456789');
  assert.equal(seen.watermark, null);
  const current = store.getGroup(group.id);
  assert.equal(current.numericId, '987654321');
  assert.equal(current.scanIntervalMs, 120000);
  assert.ok(current.nextScanAt >= before + 120000);
  assert.ok(current.lastSeenTime >= before - 1000);
});

test('hitting the account request cap postpones the account without recording a scan error', async t => {
  const { store, group, monitor } = setup(t, {});
  store.requestScan(111, group.id);
  let calls = 0;
  monitor.collector = { collect: async () => {
    calls++;
    const error = new Error('[SCAN_DEFERRED] cap');
    error.code = 'SCAN_DEFERRED';
    error.retryAt = Date.now() + 60000;
    throw error;
  } };
  monitor.wait = async () => monitor.abort.abort();
  await monitor.scanLoop();
  assert.equal(calls, 1);
  assert.equal(store.getGroup(group.id).lastError, null);
  assert.equal(monitor.failures.size, 0);
  assert.ok(monitor.deferredOwners.get(111) > Date.now());
});

test('the recent groups feed stores posts of followed groups, keeps the group watermark and rescans those groups',async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.ensureUser(111,111);
  const slug = store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/demo/'}).group;
  store.setNumericId(slug.id,'5550001');
  const numeric = store.addJoinedGroup(111,{url:'https://www.facebook.com/groups/777000111/'}).group;
  store.scheduleScan(slug.id,false,{minMs:600000,maxMs:600000});
  store.scheduleScan(numeric.id,false,{minMs:600000,maxMs:600000});
  const now = Date.now(), at = minutes => new Date(now-minutes*60000).toISOString();
  const post = (group,id,minutes) => ({id,url:`https://www.facebook.com/groups/${group}/posts/${id}`,text:'bài mới',publishedAt:at(minutes)});
  const calls = [];
  const feeds = [[post('5550001','11',1),post('777000111','12',2),post('999999','13',3)],[post('777000111','14',0.5)]];
  const collector = {async recentGroupPosts(ownerId,options) { calls.push(options.watermark); return feeds.shift(); }};
  const logs = [];
  const monitor = new Monitor({store,collector,api:{},config:{allowedUserIds:[111],metricWindowMs:86400000,feedPollMs:10000},log:line => logs.push(line)});
  assert.equal(await monitor.feedOnce(111),2);
  assert.deepEqual(store.listAllPosts(111).map(item => item.id).sort(),['11','12']);
  assert.equal(store.getGroup(slug.id).lastSeenTime,null,'a feed hit never advances the per-group watermark');
  assert.equal(store.getGroup(slug.id).nextScanAt,0);
  assert.equal(store.getGroup(numeric.id).nextScanAt,0);
  assert.equal(await monitor.feedOnce(111),1);
  assert.deepEqual(calls,[null,Date.parse(at(1))]);
  assert.match(logs[0],/^\[FEED GẦN ĐÂY \| Tài khoản 111\] 3 bài, 2 bài mới từ 2 nhóm/);
});

test('scan budget allocation is exact, capped at SCAN_MIN, floored at SCAN_MAX and keeps priority when overloaded',() => {
  const sum = rates => [...rates.values()].reduce((total,rate) => total+rate,0);
  const few = allocateScanRates(new Map([[1,5],[2,1],[3,0.1]]),2520,{minRate:6,maxRate:360});
  assert.deepEqual([...few.values()],[360,360,360],'few groups: everyone at the fastest allowed rate, budget left unused');
  const weights = new Map(Array.from({length:131},(_,i) => [i,i < 10 ? 0.3 : i < 90 ? 0.05 : 0.02]));
  const normal = allocateScanRates(weights,2520,{minRate:6,maxRate:360});
  assert.ok(Math.abs(sum(normal)-2520) < 1e-6);
  assert.ok(Math.min(...normal.values()) >= 6 - 1e-9 && Math.max(...normal.values()) <= 360);
  assert.ok(normal.get(0) > normal.get(50) && normal.get(50) > normal.get(120));
  const many = allocateScanRates(new Map(Array.from({length:600},(_,i) => [i,i < 10 ? 0.3 : 0.02])),2520,{minRate:6,maxRate:360});
  assert.ok(Math.abs(sum(many)-2520) < 1e-6);
  assert.ok(Math.min(...many.values()) >= 2520*0.75/600 - 1e-9,'an overloaded floor shrinks to 75% of the budget');
  assert.ok(many.get(0) > many.get(599)*5,'busy groups keep their priority');
});

test('sweep weights hunt feed blind spots and follow the hour of day',async () => {
  const { sweepWeights } = await import('../src/monitor.js');
  const hours = peak => Array.from({length:24},(_,h) => h === peak ? 14 : 0);
  const profile = new Map([
    ['covered',{recent:10,missed:0,hours:hours(9)}],
    ['blind',{recent:10,missed:10,hours:hours(9)}],
    ['night',{recent:10,missed:10,hours:hours(2)}],
  ]);
  const day = sweepWeights(profile,9);
  assert.ok(day.weights.get('blind') > day.weights.get('covered')*5,'missed posts weigh 10x the ones the feed delivered');
  assert.ok(day.weights.get('blind') > day.weights.get('night')*2,'a group quiet at this hour gets less');
  assert.ok(day.load > 1);
  assert.ok(sweepWeights(profile,15).load < 0.5,'an hour with no posts lowers the budget factor');
  assert.equal(sweepWeights(new Map(),9).load,1);
});

test('history backfills a closed range once, then follows it incrementally; open ranges never backfill',async t=>{
  const {store,group,monitor}=setup(t,{});
  monitor.config.historyIntervalMs=0;
  monitor.wait=async()=>{};
  const run=async range=>{
    store.setDateRange(111,group.id,range);
    const flags=[];
    monitor.abort=new AbortController();
    monitor.collector={collect:async(_owner,_url,_range,options)=>{flags.push(options.backfill); if(flags.length===3) monitor.abort.abort(); return [];}};
    await monitor.backgroundLoop();
    return flags;
  };
  assert.deepEqual(await run(parseDateRange('10/10/2025 12/10/2025')),[true,false,false]);
  assert.deepEqual(await run({start:Date.now()-3*86400000,end:null}),[false,false,false]);
});

test('hourly cap and rate limits keep actions pending and back off per account instead of retrying at once',async t=>{
  const {store,group,monitor}=setup(t,{sendMessage:async()=>({message_id:1})});
  store.queueComments(111,group.id,['1'],'hello');
  const retryAt=Date.now()+5*60000;
  let calls=0, fail=Object.assign(new Error('cap'),{code:'SCAN_DEFERRED',retryAt});
  monitor.collector={
    comment:async()=>{calls++; if(fail) throw fail;},
    directMessage:async()=>{throw fail;},
    friendRequest:async()=>{throw Object.assign(new Error('limited'),{code:'RATE_LIMITED',commentSubmitted:false});},
  };
  assert.equal(await monitor.commentOne(),false);
  assert.equal(store.listComments(111)[0].state,'pending');
  assert.equal(monitor.actionBackoff.get('comment:111').until,retryAt);
  assert.equal(await monitor.commentOne(),false,'not retried before retryAt');
  assert.equal(calls,1);
  store.enqueueDirectMessage(group.id,'1','https://www.facebook.com/profile.php?id=123','A','hi','manual',Date.now());
  store.enqueueFriendRequest(group.id,'1','https://www.facebook.com/profile.php?id=123','A','manual',Date.now());
  assert.equal(await monitor.directMessageOne(),false);
  assert.equal(store.listDirectMessages(111)[0].state,'pending');
  assert.equal(await monitor.friendOne(),false);
  assert.equal(store.listFriendRequests(111)[0].state,'pending');
  assert.ok(monitor.actionBackoff.get('friend:111').until>=Date.now()+59000);
  assert.equal(store.nextFriendRequest(monitor.actionOwners('friend')),undefined);
  assert.ok(store.nextFriendRequest(monitor.activeFacebookOwners()));
  assert.equal(monitor.holdAction('friend',111,{},1000),1000+120000,'doubles');
  for (let i=0;i<10;i++) monitor.holdAction('friend',111,{},1000);
  assert.equal(monitor.actionBackoff.get('friend:111').delay,1800000,'capped at 30 minutes');
  monitor.actionBackoff.set('comment:111',{delay:60000,until:0});
  fail=null;
  assert.equal(await monitor.commentOne(),true);
  assert.equal(store.listComments(111)[0].state,'sent');
  assert.equal(monitor.actionBackoff.has('comment:111'),false,'success resets the backoff');
});

test('a DM or friend request that may have reached Facebook is uncertain; only an explicit rejection fails',async t=>{
  const {store,group,monitor}=setup(t,{sendMessage:async()=>({message_id:1})});
  const errors=[Object.assign(new Error('no ack'),{commentSubmitted:true}),Object.assign(new Error('rejected'),{commentSubmitted:false}),
    Object.assign(new Error('limited after POST'),{code:'RATE_LIMITED',commentSubmitted:true})];
  monitor.collector={directMessage:async()=>{throw errors.shift();},friendRequest:async()=>{throw errors.shift();}};
  for (const id of ['1','2']) store.enqueueDirectMessage(group.id,id,`https://www.facebook.com/profile.php?id=12${id}`,'A','hi','manual',Date.now());
  store.enqueueFriendRequest(group.id,'1','https://www.facebook.com/profile.php?id=121','A','manual',Date.now());
  assert.equal(await monitor.directMessageOne(),true);
  assert.equal(await monitor.directMessageOne(),true);
  assert.deepEqual(store.listDirectMessages(111).map(row=>row.state),['failed','uncertain']);
  assert.equal(await monitor.friendOne(),true);
  assert.equal(store.listFriendRequests(111)[0].state,'uncertain');
});

test('feed lane failures back off instead of logging every poll',async t=>{
  const {monitor}=setup(t,{});
  monitor.config.feedPollMs=10000;
  monitor.collector={recentGroupPosts:async()=>{throw new Error('[GRAPHQL_SCHEMA] x');}};
  const waits=[];
  monitor.wait=async ms=>{waits.push(ms); if(waits.length===3) monitor.abort.abort();};
  await monitor.feedLoop(111);
  assert.deepEqual(waits,[60000,120000,240000]);
});

test('an empty group feed backs off toward SCAN_MAX instead of retrying every minute',async t=>{
  const {store,group,monitor}=setup(t,{});
  monitor.failures.set(group.id,{attempts:5,retryAt:0});
  store.requestScan(111,group.id);
  monitor.collector={collect:async()=>{throw Object.assign(new Error('[EMPTY_FEED] empty'),{code:'EMPTY_FEED'});}};
  monitor.wait=async()=>monitor.abort.abort();
  await monitor.scanLoop();
  assert.ok(monitor.failures.get(group.id).retryAt-Date.now()>1700000);
});

test('the per-chat throttle defers a delivery without counting a failed attempt',async t=>{
  const {store,monitor}=setup(t,{sendMessage:async()=>({message_id:5})});
  monitor.lastSent.set(111,Date.now());
  await monitor.deliverOne();
  const rows=store.prepare('SELECT attempts,next_attempt_at FROM deliveries').all();
  assert.equal(rows.reduce((sum,row)=>sum+row.attempts,0),0);
  assert.ok(rows.some(row=>row.next_attempt_at>0));
});

test('scan budget reserves realistic feed, notification and history lane requests',async t=>{
  const {monitor}=setup(t,{});
  const logs=[];
  monitor.log=line=>logs.push(line);
  Object.assign(monitor.config,{apiMaxRequestsPerHour:2000,feedPollMs:60000,notificationPollMs:120000,historyIntervalMs:600000});
  monitor.scanPlan(111,Date.now());
  // 2000*0.95 - 2*(60 feed + 30 notification + 6 history for 1 group)
  assert.match(logs.join('\n'),/\/1708 request\/giờ/);
});
