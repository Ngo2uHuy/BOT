import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Monitor, safeError } from '../src/monitor.js';
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
