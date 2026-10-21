import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { FACEBOOK_COOLDOWN_MS } from '../src/facebook-cooldown.js';
import { readJoinedGroupsApi } from '../src/joined-groups.js';
import { FacebookCollector, engagementFromLabels, extractVisiblePostSnapshots, normalizeCount, normalizeFacebookGroupUrl, normalizePostUrl, normalizeSnapshots, profileDirectory, revealPermalinks, revealPostDate } from '../src/facebook.js';

test('collector blocks queued work, retries once after six hours, and resumes after recovery', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'c_user', value: 'fixture', domain: '.facebook.com', path: '/' }]);
  let requests = 0, mode = 'notice', now = Date.now();
  const route = context.route.bind(context);
  context.route = pattern => route(pattern, request => {
    requests++;
    return request.fulfill({ status: mode === 'http' ? 429 : 200, contentType: 'text/html; charset=utf-8', body: mode === 'notice'
      ? `<h1>You're Temporarily Blocked</h1><a href="/groups/123/posts/42">Old link</a>`
      : `<div role="feed"><div role="article"><a href="/groups/123/posts/42" data-post-date="2026-10-08T06:45:00Z">time</a><div data-ad-preview="message">Post</div></div></div>` });
  });
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => context;
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-collector-test-'));
  const cooldownDuration = 6 * 60 * 60 * 1000;
  const collector = new FacebookCollector({ dataDir: dir, scanWorkers: 1, log: () => {}, cooldownMs: cooldownDuration });
  collector.cooldown.now = () => now;
  const scan = () => collector.collect(123, 'https://www.facebook.com/groups/123', null, { latest: true });
  try {
    const results = await Promise.allSettled([scan(), scan(), collector.collect(123, 'https://www.facebook.com/groups/123', null, { background: true })]);
    // A background request already in flight may also observe the restriction.
    assert.equal(results[0].reason.code, 'RATE_LIMITED');
    assert.equal(results[1].reason.code, 'FACEBOOK_COOLDOWN');
    const before = requests;
    await assert.rejects(collector.joinedGroups(123), { code: 'FACEBOOK_COOLDOWN' });
    await assert.rejects(collector.comment(123, 'https://www.facebook.com/groups/123/posts/42', 'hello'), { code: 'FACEBOOK_COOLDOWN' });
    assert.equal(requests, before);
    now += cooldownDuration;
    mode = 'http';
    await assert.rejects(scan(), { code: 'RATE_LIMITED' });
    assert.equal(collector.canScan(123), false);
    now += cooldownDuration;
    mode = 'ok';
    const attempts = await Promise.allSettled([scan(), scan()]);
    // The serial lane may run the second job normally after the successful probe.
    assert.equal(attempts[0].status, 'fulfilled');
    assert.equal(collector.canScan(123, false), true);
  } finally {
    chromium.launchPersistentContext = original;
    await collector.close(); await browser.close(); await removeTestDirectory(dir);
  }
});

test('delayed portal tooltip without aria-describedby resolves the correct post date',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<base href="https://www.facebook.com/"><div role="feed"><div role="article">
      <a id="stamp" href="?placeholder">2 giờ</a><div data-ad-preview="message">Post</div></div></div>
      <div role="tooltip">1 tháng 1 năm 2020 lúc 01:00</div>
      <script>document.querySelector('#stamp').addEventListener('mouseenter',e=>{e.target.href='/groups/123/posts/42';setTimeout(()=>{const tip=document.createElement('div');tip.setAttribute('role','tooltip');tip.textContent='Thứ Năm, 8 tháng 10 năm 2026 lúc 13:45';document.body.append(tip);},500);});</script>`);
    await revealPermalinks(page);
    const posts=normalizeSnapshots(await page.evaluate(extractVisiblePostSnapshots),'https://www.facebook.com/groups/123');
    assert.equal(posts[0].publishedAt,'2026-10-08T06:45:00.000Z');
    await page.setContent('<a id="stamp" href="https://www.facebook.com/groups/123/posts/43">2 giờ</a><div role="tooltip">1 tháng 1 năm 2020 lúc 01:00</div>');
    await revealPostDate(page,page.locator('#stamp'),200);
    assert.equal(await page.locator('#stamp').getAttribute('data-post-date'),null);
  } finally {await browser.close();}
});
import { login } from '../src/login.js';

test('timestamp already present in title resolves without hover',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<a id="stamp" href="https://www.facebook.com/groups/123/posts/42" title="2026-10-08T06:45:00Z">time</a>');
    await page.locator('#stamp').evaluate(node=>node.addEventListener('mouseenter',()=>node.setAttribute('data-hovered','yes')));
    await revealPostDate(page,page.locator('#stamp'));
    assert.equal(await page.locator('#stamp').getAttribute('data-post-date'),'2026-10-08T06:45:00.000Z');
    assert.equal(await page.locator('#stamp').getAttribute('data-hovered'),null);
  } finally {await browser.close();}
});

test('collector streams dated posts and comments in a separate tab while its only scan slot is busy',async () => {
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.addCookies([{name:'c_user',value:'fixture',domain:'.facebook.com',path:'/'}]);
  const route=context.route.bind(context);
  context.route=(pattern)=>route(pattern,request=>request.fulfill({contentType:'text/html; charset=utf-8',body:`
    <h1>Fixture group</h1><div role="feed"><div role="article" id="post">
    <a href="https://www.facebook.com/groups/123/posts/42" data-post-date="2026-10-08T06:45:00Z">time</a>
    <div data-ad-preview="message">New post</div>
    <div role="textbox" contenteditable="true" aria-label="Viết bình luận"></div></div></div>
    <script>document.querySelector('[role="textbox"]').addEventListener('keydown',e=>{
      if(e.key!=='Enter')return;e.preventDefault();const c=document.createElement('div');c.setAttribute('role','article');
      c.textContent=e.target.innerText;const a=document.createElement('a');a.href='/groups/123/posts/42?comment_id=1';
      a.textContent='time';c.append(a);document.querySelector('#post').append(c);e.target.innerText='';
    });</script>`}));
  const original=chromium.launchPersistentContext;
  let opens=0;
  chromium.launchPersistentContext=async()=>{opens++;return context;};
  const dir=await mkdtemp(path.join(tmpdir(),'fb-collector-test-'));
  const collector=new FacebookCollector({dataDir:dir,scanWorkers:1});
  let release, ready, timer, scan;
  const gate=new Promise(resolve=>release=resolve);
  const streamed=new Promise(resolve=>ready=resolve);
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Comment blocked by scan')),10000);});
  try {
    scan=collector.collect('123','https://www.facebook.com/groups/123',null,{latest:true,onPosts:async posts=>{
      ready(posts);await gate;
    }});
    const posts=await Promise.race([streamed,timeout,scan.then(()=>{throw new Error('Scan did not stream');})]);
    assert.equal(posts[0].id,'42');
    assert.equal(posts[0].publishedAt,'2026-10-08T06:45:00.000Z');
    await Promise.race([collector.comment('123',posts[0].url,'Fixture comment',()=>true),timeout]);
    assert.equal(opens,1);
    assert.equal(context.pages().length,1); // The scan remains open, comment tab was closed.
    release();
    assert.equal((await scan).length,1);
  } finally {
    clearTimeout(timer);release();
    await scan?.catch(()=>{});
    chromium.launchPersistentContext=original;
    await collector.close();await browser.close();await removeTestDirectory(dir);
  }
});

async function removeTestDirectory(dir) {
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^fb-(?:collector|login)-test-/);
  await rm(resolved, { recursive: true, force: true });
}

test('count parsing preserves unknowns and handles Vietnamese/English abbreviations', () => {
  for (const [input, expected] of [['1.2K', 1200], ['1,2 nghìn', 1200], ['2 triệu', 2000000], ['1,234', 1234], ['1.234', 1234], ['1\u202f234', 1234], ['0', 0], [null, null], ['', null], ['Like', null], ['1,2', null], ['1.2.3K', null], ['-4', null]]) {
    assert.equal(normalizeCount(input), expected, String(input));
  }
  assert.deepEqual(engagementFromLabels(['All reactions: 1.2K', '23 comments', '4 lượt chia sẻ']), { reactions: 1200, comments: 23, shares: 4 });
  assert.deepEqual(engagementFromLabels(['Thích', 'Bình luận', 'Chia sẻ']), { reactions: null, comments: null, shares: null });
});

test('only HTTPS Facebook group/post URLs accepted, comment links never become posts', () => {
  assert.equal(normalizeFacebookGroupUrl('https://m.facebook.com/groups/sample.group/?ref=share'), 'https://www.facebook.com/groups/sample.group');
  for (const url of ['http://facebook.com/groups/1', 'https://facebook.com.evil.test/groups/1', 'https://evil.test/groups/1', 'https://user:pass@facebook.com/groups/1', 'https://facebook.com:444/groups/1', 'https://facebook.com/groups/../login', 'file:///groups/1']) assert.throws(() => normalizeFacebookGroupUrl(url));
  assert.deepEqual(normalizePostUrl('https://www.facebook.com/groups/123/permalink/456/?ref=share'), { id: '456', groupUrl: 'https://www.facebook.com/groups/123', url: 'https://www.facebook.com/groups/123/posts/456' });
  assert.equal(normalizePostUrl('https://www.facebook.com/groups/123/posts/456?comment_id=789'), null);
  assert.equal(normalizePostUrl('https://www.facebook.com/groups/999/posts/456', 'https://www.facebook.com/groups/123'), null);
  for (const id of ['../1', '0', '-1', '1/2', '01', 'NaN']) assert.throws(() => profileDirectory('./data', id));
  assert.equal(path.basename(profileDirectory('./data', '123')), '123');
});

test('snapshot normalization deduplicates, rejects other groups, preserves unavailable time/counts', () => {
  const posts = normalizeSnapshots([
    { url: 'https://www.facebook.com/groups/123/posts/42', text: 'short', labels: [] },
    { url: 'https://www.facebook.com/groups/123/permalink/42', text: 'full message', author: ' Lan ', publishedAt: 'invalid', labels: ['Tất cả cảm xúc: 7'] },
    { url: 'https://www.facebook.com/groups/999/posts/43', text: 'other group', labels: [] },
  ], ['https://www.facebook.com/groups/sample', 'https://www.facebook.com/groups/123']);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { id: '42', url: 'https://www.facebook.com/groups/123/posts/42', text: 'full message', author: 'Lan', publishedAt: null, authorUrl: null, media: [] });
});

test('local browser fixture extracts top-level posts without comments or hidden posts', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><base href="https://www.facebook.com/"></head><body>
      <main><div role="feed">
        <div data-pagelet="FeedUnit_0"><div role="article">
          <h2><a href="/profile.php?id=8">Lan Nguyễn</a></h2>
          <a href="https://evil.test/groups/123/posts/99">external</a>
          <a href="/groups/123/posts/42/?ref=share">2 giờ</a><time datetime="2026-10-08T01:00:00Z"></time>
          <div data-ad-preview="message">Tìm nhà Hà Nội. <a href="/groups/999/posts/900">A linked post</a></div>
          <span aria-label="All reactions: 1.2K"></span><span>23 comments</span><span>4 shares</span>
          <div role="article"><a href="/groups/123/posts/42?comment_id=777">comment</a><div data-ad-preview="message">DO NOT COLLECT COMMENT</div><span>999 comments</span></div>
          <div role="article"><a href="/groups/999/posts/901">shared article</a><div data-ad-preview="message">DO NOT COLLECT SHARED TEXT</div></div>
        </div></div>
        <div role="article"><h3><a href="/someone">Minh</a></h3><a href="/groups/123/permalink/43">now</a><div data-ad-comet-preview="message">Bài thứ hai</div><span>Thích</span></div>
        <div role="article" style="display:none"><a href="/groups/123/posts/44">hidden</a><div data-ad-preview="message">HIDDEN</div></div>
        <div role="article"><a href="/groups/123/posts/45?comment_id=777">only comment</a><div data-ad-preview="message">COMMENT ONLY</div></div>
      </div></main></body></html>`);
    const snapshots = await page.evaluate(extractVisiblePostSnapshots);
    const posts = normalizeSnapshots(snapshots, 'https://www.facebook.com/groups/123');
    assert.deepEqual(posts.map(post => post.id), ['42', '43']);
    assert.equal(posts[0].text, 'Tìm nhà Hà Nội. A linked post');
    assert.equal(posts[0].author, 'Lan Nguyễn');
    assert.equal(posts[0].publishedAt, '2026-10-08T01:00:00.000Z');
    assert.equal(posts[0].authorUrl, 'https://www.facebook.com/profile.php?id=8');
    assert.equal(posts[0].reactions, undefined);
    assert.equal(posts[0].shares, undefined);
    assert.equal(posts[1].authorUrl, 'https://www.facebook.com/someone');
    await page.setContent('<div role="article"><a href="https://www.facebook.com/groups/123/posts/7?comment_id=8">comment</a></div>');
    assert.deepEqual(await page.evaluate(extractVisiblePostSnapshots), []);
  } finally { await browser.close(); }
});

test('permalinks that Facebook only fills in on hover are revealed before extraction', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><base href="https://www.facebook.com/"></head><body>
      <div role="feed"><div><div role="article">
        <a role="link" href="?__cft__[0]=abc&__tn__=%2CO%2CP-R#?fkg" data-real="/groups/123/posts/50/?__cft__[0]=abc">2 giờ</a>
        <div data-ad-rendering-role="story_message">Cần thiết kế biểu đồ tuần tự</div>
        <div role="article"><a href="/groups/123/posts/50/?comment_id=9">1 giờ</a></div>
      </div></div></div>
      <script>for (const a of document.querySelectorAll('a[data-real]')) a.addEventListener('mouseenter', () => a.setAttribute('href', a.dataset.real));</script>
    </body></html>`);
    assert.deepEqual(normalizeSnapshots(await page.evaluate(extractVisiblePostSnapshots), 'https://www.facebook.com/groups/123'), []);
    await revealPermalinks(page);
    const posts = normalizeSnapshots(await page.evaluate(extractVisiblePostSnapshots), 'https://www.facebook.com/groups/123');
    assert.deepEqual(posts.map(post => [post.id, post.text]), [['50', 'Cần thiết kế biểu đồ tuần tự']]);
  } finally { await browser.close(); }
});

test('collector rejects an unsigned-in profile before making a Facebook navigation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-collector-test-'));
  const collector = new FacebookCollector({ dataDir: dir });
  try {
    await assert.rejects(collector.collect('123', 'https://www.facebook.com/groups/123'), /Chưa đăng nhập Facebook/);
  } finally {
    await collector.close();
    await removeTestDirectory(dir);
  }
  await assert.rejects(collector.collect('123', 'https://www.facebook.com/groups/123'), /đã đóng/);
});

test('manual login refuses to open a profile while the bot process is active', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-login-test-'));
  const previous = process.env.DATA_DIR;
  try {
    process.env.DATA_DIR = dir;
    await writeFile(path.join(dir, 'monitor.lock'), String(process.pid));
    await assert.rejects(login(['--user-id', '123']), /Bot đang chạy/);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await removeTestDirectory(dir);
  }
});

test('collector in default mode has zero cooldown and keeps canScan active after rate limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-collector-test-'));
  const collector = new FacebookCollector({ dataDir: dir, scanWorkers: 1, log: () => {} });
  try {
    assert.equal(collector.canScan(123), true);
    collector.cooldown.pause(123);
    assert.equal(collector.canScan(123), true);
  } finally {
    await collector.close();
    await removeTestDirectory(dir);
  }
});

test('API joined-group reader paginates, marks partial lists as limited and rejects suspicious results', async () => {
  const page = (ids, next) => JSON.stringify({ data: { viewer: { groups: { edges: ids.map(id => ({ node: { __typename: 'Group', id, name: `G${id}`, url: `https://www.facebook.com/groups/${id}/` }, cursor: id })),
    page_info: { end_cursor: next, has_next_page: Boolean(next) } } } } });
  const cursors = [];
  const pages = [page(['1', '2'], 'A'), page(['3'], null)];
  const full = await readJoinedGroupsApi(async cursor => { cursors.push(cursor); return pages.shift(); });
  assert.deepEqual([full.groups.map(group => group.name), full.limited, cursors], [['G1', 'G2', 'G3'], false, [null, 'A']]);
  let calls = 0;
  const capped = await readJoinedGroupsApi(async () => page([String(++calls)], `C${calls}`), { maxPages: 2 });
  assert.deepEqual([capped.groups.length, capped.limited], [2, true]);
  calls = 0;
  const deferred = await readJoinedGroupsApi(async () => {
    if (calls++) throw Object.assign(new Error('cap'), { code: 'SCAN_DEFERRED' });
    return page(['1'], 'A');
  });
  assert.deepEqual([deferred.groups.length, deferred.limited], [1, true]);
  await assert.rejects(readJoinedGroupsApi(async () => page([], null)), { code: 'GRAPHQL_SCHEMA' });
  await assert.rejects(readJoinedGroupsApi(async () => page(['1'], null), { baseline: 10 }), { code: 'GRAPHQL_SCHEMA' });
});
