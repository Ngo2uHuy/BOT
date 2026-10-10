import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeProfileUrl, normalizeProfilePostUrl, profileReelsUrl } from '../src/profile.js';
import { FacebookCollector, normalizePostUrl } from '../src/facebook.js';
import { Store } from '../src/store.js';

test('profile URLs and post targets are canonical, strict and separate from groups', () => {
  assert.equal(normalizeProfileUrl('m.facebook.com/alice/reels/?tracking=1'),'https://www.facebook.com/alice');
  assert.equal(profileReelsUrl('https://www.facebook.com/profile.php?id=12'),'https://www.facebook.com/profile.php?id=12&sk=reels');
  for (const value of ['https://evil.com/alice','https://facebook.com:443/alice','https://facebook.com/a/../alice','https://facebook.com/groups/1','https://facebook.com/alice/posts/1']) assert.throws(() => normalizeProfileUrl(value));
  assert.equal(normalizePostUrl('https://www.facebook.com/reel/42?tracking=1').kind,'reel');
  assert.equal(normalizePostUrl('https://www.facebook.com/alice/posts/42','https://www.facebook.com/groups/1'),null);
  assert.equal(normalizeProfilePostUrl('https://www.facebook.com/story.php?id=12&story_fbid=42').url,'https://www.facebook.com/permalink.php?story_fbid=42&id=12');
  assert.equal(normalizeProfilePostUrl('https://www.facebook.com/reel/42?comment_id=1'),null);
});

test('profiles preserve owner isolation, deduplicate modes and use comment queue', () => {
  const store = new Store(':memory:');
  try {
    store.ensureUser(1,1); store.ensureUser(2,2);
    const {group} = store.addProfile(1,'https://www.facebook.com/alice','reels');
    assert.equal(group.sourceType,'profile');
    assert.equal(group.initialized,true);
    store.setPaused(1,group.id,true);
    assert.equal(store.addProfile(1,'https://www.facebook.com/alice/','all').created,false);
    assert.equal(store.getGroup(group.id).paused,true);
    assert.equal(store.getGroup(group.id).contentType,'all');
    assert.equal(store.listGroups(2).length,0);
    store.setPaused(1,group.id,false);
    store.observe(group,[{id:'42',url:'https://www.facebook.com/reel/42',kind:'reel',text:'Hello',publishedAt:null}],{metricWindowMs:60000,render:()=> 'Hello',matches:()=>true});
    assert.throws(()=>store.queueComments(2,group.id,['42'],'Hi'));
    assert.equal(store.queueComments(1,group.id,['42'],'Hi').queued,1);
    assert.equal(store.queueComments(1,group.id,['42'],'Hi').queued,0);
  } finally {store.close();}
});

test('collector scans profile posts and reel grid, excludes foreign authors and comments on both', async () => {
  const browser = await chromium.launch({headless:true});
  const context = await browser.newContext();
  await context.addCookies([{name:'c_user',value:'fixture',domain:'.facebook.com',path:'/'}]);
  const fixturePost = (owner,id,kind='posts') => `<div role="article"><h3><a href="/${owner}">${owner}</a></h3><a href="/${kind === 'reel' ? 'reel' : owner+'/posts'}/${id}" data-post-date="2026-10-08T06:45:00Z">Time</a><div data-ad-preview="message">Post ${id}</div></div>`;
  const originalRoute = context.route.bind(context);
  context.route = pattern => originalRoute(pattern, async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/alice') body = fixturePost('alice','1')+fixturePost('bob','9');
    else if (url.pathname === '/alice/reels/') body = '<a href="/reel/2">Reel</a><a href="/reel/3">Foreign reel</a>';
    else body = fixturePost(url.pathname === '/reel/3' ? 'bob':'alice',url.pathname.split('/').at(-1),url.pathname.startsWith('/reel/')?'reel':'posts');
    await route.fulfill({contentType:'text/html; charset=utf-8',body:`<main><h1>Alice</h1>${body}<div role="textbox" contenteditable="true" aria-label="Viết bình luận"></div></main><script>
      document.querySelector('[role="textbox"]').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const c=document.createElement('div');c.setAttribute('role','article');c.textContent=e.target.innerText;const a=document.createElement('a');a.href=location.pathname+'?comment_id=1';c.append(a);document.querySelector('main').append(c);e.target.innerText='';});</script>`});
  });
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => context;
  const dir = await mkdtemp(path.join(tmpdir(),'profile-test-'));
  const collector = new FacebookCollector({dataDir:dir,scrollPasses:1});
  try {
    const posts = await collector.collect(1,'https://www.facebook.com/alice',null,{latest:true,contentType:'all'});
    assert.deepEqual(posts.map(p=>p.id).sort(),['1','2']);
    for (const post of posts) await collector.comment(1,post.url,'Fixture comment',()=>true);
    const reels = await collector.collect(1,'https://www.facebook.com/alice',null,{latest:true,contentType:'reels'});
    assert.deepEqual(reels.map(p=>p.id),['2']);
  } finally {
    chromium.launchPersistentContext = original;
    await collector.close(); await browser.close();
    await rm(dir,{recursive:true,force:true});
  }
});
