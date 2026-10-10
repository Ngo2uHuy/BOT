import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('metric refresh only selects delivered posts for authorized owners within the time window',t => {
  const {store,group} = setup(t);
  store.observe(group,[post('1')],options(100));
  store.observe(group,[post('2')],options(200));
  assert.equal(store.metricCandidate(10000,86400000,5000,[111]),undefined);
  store.delivered(store.nextDelivery(200,[111]),777);
  assert.equal(store.metricCandidate(10000,86400000,5000,[222]),undefined);
  assert.equal(store.metricCandidate(10000,86400000,5000,[111]).post.id,'2');
  store.markMetricAttempt(group.id,'2',10000);
  assert.equal(store.metricCandidate(10001,86400000,5000,[111]),undefined);
});
