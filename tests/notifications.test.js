import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationHints } from '../src/notifications.js';
import { builtinTemplate, queryRequest } from '../src/facebook-graphql.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const payload = urls => JSON.stringify({data:{viewer:{notifications_page:{edges:urls.map(url=>({node:{notif:{url}}}))}}}});

test('notification parser only takes Facebook group post links from the notification connection', () => {
  assert.deepEqual(notificationHints(payload([
    'https://www.facebook.com/groups/123/posts/456/?notif_id=private',
    '/groups/123/posts/456', 'https://m.facebook.com/groups/demo/permalink/789/',
    'https://www.facebook.com.evil.test/groups/123/posts/456',
    'https://www.facebook.com/groups/123/', 'https://www.facebook.com/alice/posts/123',
    'https://www.facebook.com/groups/Demo2/?multi_permalinks=321%2C654&notif_id=1', '/alice/?multi_permalinks=999',
  ])),[{groupKey:'123',postId:'456'},{groupKey:'demo',postId:'789'},{groupKey:'demo2',postId:'321'}]);
  assert.deepEqual(notificationHints(payload([])),[]);
  assert.throws(()=>notificationHints(JSON.stringify({data:{url:'/groups/123/posts/456'}})),{code:'GRAPHQL_SCHEMA'});
});

test('notification request uses captured read query and clears previous notification cache IDs', () => {
  const template=builtinTemplate('notifications',{form:{__user:'123'},headers:{},capturedAt:1});
  const request=queryRequest(template,{count:15,cursor:null});
  assert.equal(request.form.doc_id,'28368359382859755');
  assert.equal(request.form.fb_api_req_friendly_name,'CometNotificationsListPaginationQuery');
  assert.deepEqual(JSON.parse(request.form.variables),{count:15,cursor:null,environment:'MAIN_SURFACE',filter_tokens:['Cg8CZnQPA2FsbAE='],notif_cache_ids:[],notif_query_flags:['IS_COMET'],scale:1});
});

test('notification hints baseline then boost at most three owned groups; deduplicate, throttle and never queue actions',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);
  const groups=Array.from({length:5},(_,i)=>store.addGroup(1,`https://www.facebook.com/groups/g${i}/`).group);
  store.setNumericId(groups[0].id,'12345');
  const paused=store.addGroup(1,'https://www.facebook.com/groups/paused/').group;
  store.setPaused(1,paused.id,true);
  store.addGroup(2,'https://www.facebook.com/groups/other/');
  for(const g of groups) store.scheduleScan(g.id,false,{minMs:1000,maxMs:999999,plannedMs:900000});
  let hints=[{groupKey:'g0',postId:'1'}];
  const monitor=new Monitor({store,collector:{notificationGroups:async()=>hints},api:{},config:{allowedUserIds:[1]},log:()=>{}});
  assert.equal(await monitor.notificationOnce(1,1000),0);
  assert.ok(store.getGroup(groups[0].id).nextScanAt>0);
  hints=[{groupKey:'12345',postId:'1'},...groups.map((_,i)=>({groupKey:`g${i}`,postId:'2'})),{groupKey:'other',postId:'2'},{groupKey:'paused',postId:'2'}];
  assert.equal(await monitor.notificationOnce(1,2000),3);
  assert.equal(await monitor.notificationOnce(1,3000),2);
  hints=[{groupKey:'12345',postId:'3'}];
  assert.equal(await monitor.notificationOnce(1,4000),0);
  hints=[{groupKey:'12345',postId:'4'}];
  assert.equal(await monitor.notificationOnce(1,302000),1);
  assert.equal(store.prepare('SELECT count(*) n FROM posts').get().n,0);
  assert.equal(store.prepare('SELECT count(*) n FROM comments').get().n,0);
  assert.equal(store.prepare('SELECT count(*) n FROM deliveries').get().n,0);
  assert.equal(await monitor.notificationOnce(2),0);
  const restarted=new Monitor({store,collector:monitor.collector,api:{},config:{allowedUserIds:[1]},log:()=>{}});
  assert.equal(await restarted.notificationOnce(1),0);
});

test('already observed posts and in-flight groups do not get extra scans',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());store.ensureUser(1,1);
  const group=store.addGroup(1,'https://www.facebook.com/groups/demo/').group;
  store.observe(group,[{id:'12',url:`${group.url}posts/12`,text:'x'}],{render:()=>'',matches:()=>true,metricWindowMs:1000});
  let hints=[];
  const monitor=new Monitor({store,collector:{notificationGroups:async()=>hints},api:{},config:{allowedUserIds:[1]},log:()=>{}});
  await monitor.notificationOnce(1);
  hints=[{groupKey:'demo',postId:'12'}];
  assert.equal(await monitor.notificationOnce(1),0);
  monitor.scanning.add(group.id);hints=[{groupKey:'demo',postId:'13'}];
  assert.equal(await monitor.notificationOnce(1),0);
});

test('notification signals skipped by cap, in-flight scan or cooldown are retried later instead of lost',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());store.ensureUser(1,1);
  const group=store.addGroup(1,'https://www.facebook.com/groups/demo/').group;
  store.scheduleScan(group.id,false,{minMs:1000,maxMs:999999,plannedMs:900000});
  let hints=[];
  const monitor=new Monitor({store,collector:{notificationGroups:async()=>hints},api:{},config:{allowedUserIds:[1]},log:()=>{}});
  await monitor.notificationOnce(1,1000);
  monitor.scanning.add(group.id);hints=[{groupKey:'demo',postId:'7'}];
  assert.equal(await monitor.notificationOnce(1,2000),0);
  monitor.scanning.delete(group.id);
  assert.equal(await monitor.notificationOnce(1,3000),1);
  assert.equal(monitor.notifications.get(1).pending.size,0);
  hints=[{groupKey:'demo',postId:'8'}];
  assert.equal(await monitor.notificationOnce(1,4000),0);
  assert.equal(await monitor.notificationOnce(1,304000),1);
  hints=[{groupKey:'demo',postId:'9'}];
  await monitor.notificationOnce(1,305000);
  assert.equal(await monitor.notificationOnce(1,305000+1800001),0);
  assert.equal(monitor.notifications.get(1).pending.size,0);
});

test('notification polls page past unseen notifications, scale the boost cap with budget and report groups not in the bot',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());store.ensureUser(1,1);
  const groups=Array.from({length:6},(_,i)=>store.addGroup(1,`https://www.facebook.com/groups/g${i}/`).group);
  const paused=store.addGroup(1,'https://www.facebook.com/groups/paused/').group;store.setPaused(1,paused.id,true);
  for(const g of groups) store.scheduleScan(g.id,false,{minMs:1000,maxMs:999999,plannedMs:900000});
  let hints=[{groupKey:'g0',postId:'1'}];const calls=[],logs=[];
  const collector={notificationGroups:async(owner,options)=>{calls.push({maxPages:options.maxPages,known:hints.map(options.isKnown)});return hints;}};
  const monitor=new Monitor({store,collector,api:{},config:{allowedUserIds:[1],apiMaxRequestsPerHour:3000,notificationPollMs:120000},log:message=>logs.push(message)});
  await monitor.notificationOnce(1,1000);
  hints=[...groups.map((_,i)=>({groupKey:`g${i}`,postId:'2'})),{groupKey:'g0',postId:'1'},{groupKey:'new1',postId:'5'},{groupKey:'paused',postId:'5'}];
  assert.equal(await monitor.notificationOnce(1,2000),6);
  assert.deepEqual(calls.map(call=>call.maxPages),[1,3]);
  assert.deepEqual(calls[1].known,[false,false,false,false,false,false,true,false,false]);
  assert.match(logs.find(line=>line.includes('chưa thêm vào bot')),/1 nhóm chưa thêm vào bot: facebook\.com\/groups\/new1$/);
  hints=[{groupKey:'new1',postId:'6'}];logs.length=0;
  await monitor.notificationOnce(1,3000);
  assert.equal(logs.some(line=>line.includes('chưa thêm vào bot')),false);
});
