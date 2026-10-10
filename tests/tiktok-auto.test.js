import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

function setup(t) {
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(111,111);
  const group=store.addGroup(111,'https://www.facebook.com/groups/demo').group;
  const account='tiktok:test';
  const offers=[1,2,3].map(id=>({productUrl:`https://www.tiktok.com/view/product/${id}`,affiliateUrl:`https://vt.tiktok.com/test${id}`}));
  const affiliate={accountKey:()=>account,topOffers:async()=>({offers,scanned:3})};
  const monitor=new Monitor({store,collector:{},api:{sendMessage:async()=>({message_id:1})},config:{allowedUserIds:[111],metricWindowMs:86400000},tiktokAffiliate:affiliate,log:()=>{}});
  const now=Date.now();
  const observe=(id,overrides={})=>store.observe(group,[{id,url:`https://www.facebook.com/groups/demo/posts/${id}`,text:'kitchen',publishedAt:new Date(now-1000).toISOString(),...overrides}],monitor.options());
  store.setKeywords(111,group.id,['kitchen']);
  store.setTikTokAuto(111,group.id,{count:2,rank:'rate',keyword:''},account,now-2000);
  observe('baseline');
  return {store,group,account,offers,affiliate,monitor,observe};
}

test('TikTok automatic jobs exclude baseline, old/unknown/future dates, mismatched keywords and duplicates',t=>{
  const {store,observe}=setup(t);
  assert.equal(store.nextTikTokJob([111]),undefined);
  observe('old',{publishedAt:'2020-01-01T00:00:00Z'});
  observe('unknown',{publishedAt:null});
  observe('future',{publishedAt:'2099-01-01T00:00:00Z'});
  observe('irrelevant',{text:'cars'});
  assert.equal(store.nextTikTokJob([111]),undefined);
  observe('new');observe('new');
  assert.equal(store.nextTikTokJob([111]).post_id,'new');
  assert.equal(store.nextTikTokJob([222]),undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tiktok_auto_jobs').get().n,1);
});

test('TikTok worker caps links, commits once, and disabling cancels queued comments',async t=>{
  const {store,group,monitor,observe}=setup(t);observe('new');
  assert.equal(await monitor.tikTokAutoOne(),true);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM comments').get().n,2);
  const item=store.nextComment([111]);assert.equal(store.canComment(item),true);
  assert.equal(await monitor.tikTokAutoOne(),false);
  store.setTikTokAuto(111,group.id,null,null);
  assert.equal(store.nextComment([111]),undefined);
  assert.equal(store.canComment(item),false);
});

for(const change of ['off','keywords','cancel','account']) {
  test(`TikTok worker does not enqueue after ${change} changes while fetching`,async t=>{
    const {store,group,monitor,affiliate,observe,offers}=setup(t);observe('new');
    if(change==='account') affiliate.accountKey=()=> 'tiktok:another';
    affiliate.topOffers=async()=>{
      if(change==='off') store.setTikTokAuto(111,group.id,null,null);
      if(change==='keywords') store.setKeywords(111,group.id,['cars']);
      if(change==='cancel') store.cancelComments(111,group.id);
      return {offers,scanned:3};
    };
    await monitor.tikTokAutoOne();
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM comments').get().n,0);
    assert.equal(store.nextTikTokJob([111]),undefined);
  });
}

test('pause during TikTok fetch defers job until resume; latest filters gate comment submission',async t=>{
  const {store,group,monitor,affiliate,observe,offers}=setup(t);observe('new');
  affiliate.topOffers=async()=>{store.setPaused(111,group.id,true);return {offers,scanned:3};};
  await monitor.tikTokAutoOne();assert.equal(store.nextComment([111]),undefined);
  store.setPaused(111,group.id,false);assert.ok(store.nextTikTokJob([111]));
  affiliate.topOffers=async()=>({offers,scanned:3});await monitor.tikTokAutoOne();
  const item=store.nextComment([111]);assert.ok(item);
  store.setKeywords(111,group.id,['cars']);assert.equal(store.canComment(item),false);
});

test('TikTok completion transaction rolls back links and comments if any link is invalid',t=>{
  const {store,observe,offers,account}=setup(t);observe('new');
  const job=store.nextTikTokJob([111]);store.tikTokJobState(job,'working');
  assert.throws(()=>store.finishTikTokJob(job,[offers[0],{productUrl:'test',affiliateUrl:''}],account));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM comments').get().n,0);
  assert.equal(store.listAffiliateLinks(111,account).length,0);
  assert.equal(store.finishTikTokJob(job,offers,account),2);
  assert.equal(store.finishTikTokJob(job,offers,account),null);
});
