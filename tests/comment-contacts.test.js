import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractContacts, visibleComments, readCommentContacts, commentsFromGraphQL, readCommentContactsApi } from '../src/comment-contacts.js';

test('extracts Vietnamese phone formats and emails without duplicate contacts', () => {
  assert.deepEqual(extractContacts('Gọi 0912.345.678, +84 912 345 678; mail A.Test+shop@Example.com'), {
    phones: ['0912345678'], emails: ['a.test+shop@example.com'],
  });
  assert.deepEqual(extractContacts('ID 12309123456789, 0123456789; mail a@localhost'), { phones: [], emails: [] });
  assert.deepEqual(extractContacts('0084 912 345 678; 024 1234 5678').phones, ['0912345678','02412345678']);
  assert.deepEqual(extractContacts('0912345678 0987654321').phones, ['0912345678','0987654321']);
});

test('DOM extraction isolates target comments, replies and bodies from posts and other videos', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<article role="article"><div dir="auto">post@ignore.com</div>
      <article role="article"><a href="https://www.facebook.com/alice">Alice</a><div dir="auto">0912 345 678 a@example.com</div><a href="https://www.facebook.com/shop/videos/42?comment_id=10">1 giờ</a>
        <article role="article"><a href="https://www.facebook.com/bob">Bob</a><div dir="auto">bob@example.com</div><a href="https://www.facebook.com/shop/videos/42?comment_id=10&reply_comment_id=11">2 giờ</a></article>
      </article></article>
      <article role="article"><div dir="auto">wrong@example.com</div><a href="https://www.facebook.com/shop/videos/99?comment_id=12">1 giờ</a></article>`);
    const rows = await page.evaluate(visibleComments, { postId: '42' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].author, 'Alice');
    assert.equal(rows[0].text, '0912 345 678 a@example.com');
    assert.equal(rows[1].id, '11');
    const result = await readCommentContacts(page, {id:'42',url:'https://www.facebook.com/shop/videos/42'});
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.items[0].phones, ['0912345678']);
    await assert.rejects(readCommentContacts(page, {id:'99'}, {canContinue:()=>false}), /Đã hủy/);
    await assert.rejects(readCommentContacts(page, {id:'100'}), /Không đọc được/);
  } finally { await browser.close(); }
});

const base64 = value => Buffer.from(value).toString('base64');
const comment = (postId, cid, text, extra = {}) => ({ __typename: 'Comment', id: base64(`comment:${postId}_${cid}`), legacy_fbid: cid, body: { text },
  author: { __typename: 'User', id: `9${cid}`, name: `User ${cid}` }, ...extra });

test('GraphQL comments: top-level page info wins over replies, foreign comments are dropped, ids match comment_id permalinks', () => {
  const post = { id: '42', url: 'https://www.facebook.com/groups/demo/posts/42' };
  const reply = comment('42', '11', 'reply b@example.com');
  const text = [
    { data: { node: { comments: { edges: [
      { node: comment('42', '10', 'Gọi 0912 345 678', { feedback: { replies_connection: { edges: [{ node: reply, cursor: 'r0' }], page_info: { end_cursor: 'REPLY', has_next_page: true } } } }), cursor: 'c0' },
      { node: comment('99', '12', 'other post'), cursor: 'c1' },
    ], page_info: { end_cursor: 'TOP', has_next_page: true } } } } },
  ].map(line => JSON.stringify(line)).join('\n');
  const page = commentsFromGraphQL(`for (;;);${text}`, post);
  assert.deepEqual(page.comments.map(item => [item.id, item.author, item.authorUrl, item.url]), [
    ['10', 'User 10', 'https://www.facebook.com/profile.php?id=910', 'https://www.facebook.com/groups/demo/posts/42?comment_id=10'],
    ['11', 'User 11', 'https://www.facebook.com/profile.php?id=911', 'https://www.facebook.com/groups/demo/posts/42?comment_id=11'],
  ]);
  assert.deepEqual([page.endCursor, page.hasNextPage], ['TOP', true]);
  const before = commentsFromGraphQL(JSON.stringify({ data: { node: { comments: { edges: [{ node: comment('42', '1', 'x'), cursor: 'c0' }],
    page_info: { start_cursor: 'PREV', has_previous_page: false, end_cursor: 'E', has_next_page: true } } } } }), post, { before: true });
  assert.deepEqual([before.endCursor, before.hasNextPage], ['PREV', false]);
});

test('API comment reader pages up to the limit, stops on repeats and treats an empty first page as a schema miss', async () => {
  const post = { id: '42', url: 'https://www.facebook.com/groups/demo/posts/42' };
  const page = (cid, next) => JSON.stringify({ data: { node: { comments: { edges: [{ node: comment('42', cid, `${cid} a${cid}@example.com`), cursor: 'c' }],
    page_info: { end_cursor: next, has_next_page: Boolean(next) } } } } });
  const cursors = [];
  const pages = [page('1', 'N2'), page('2', 'N3'), page('2', 'N4'), page('3', null)];
  const result = await readCommentContactsApi(async cursor => { cursors.push(cursor); return pages.shift(); }, post);
  assert.deepEqual(cursors, [null, 'N2', 'N3']);
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.items.map(item => item.emails[0]), ['a1@example.com', 'a2@example.com']);
  let calls = 0;
  await readCommentContactsApi(async () => { calls++; return page(String(calls), `N${calls}`); }, post, { passes: 3 });
  assert.equal(calls, 3);
  await assert.rejects(readCommentContactsApi(async () => JSON.stringify({ data: { node: null } }), post), { code: 'GRAPHQL_SCHEMA' });
  await assert.rejects(readCommentContactsApi(async () => page('1', null), post, { canContinue: () => false }), /Đã hủy/);
});

test('API comment reader keeps every commenter and stops or refuses on a deferral as asked', async () => {
  const post = { id: '42', url: 'https://www.facebook.com/groups/demo/posts/42' };
  const node = id => ({ __typename: 'Comment', id: Buffer.from(`comment:42_${id}`).toString('base64'), legacy_fbid: id, body: { text: 'hi' }, author: { id: `7${id}`, name: `U${id}`, url: `https://www.facebook.com/u${id}` } });
  const page = (id, next) => JSON.stringify({ data: { node: { comments: { edges: [{ node: node(id), cursor: `c${id}` }], page_info: { end_cursor: next, has_next_page: Boolean(next) } } } } });
  const deferred = () => Object.assign(new Error('deferred'), { code: 'SCAN_DEFERRED' });
  const source = () => { let calls = 0; return async () => { calls++; if (calls === 3) throw deferred(); return page(String(calls), `N${calls}`); }; };
  const result = await readCommentContactsApi(source(), post);
  assert.equal(result.complete,false);
  assert.deepEqual(result.comments.map(c => [c.id, c.authorId]), [['1', '71'], ['2', '72']]);
  assert.deepEqual(result.items, []);
  await assert.rejects(readCommentContactsApi(source(), post, { partial: false }), { code: 'SCAN_DEFERRED' });
  let calls = 0;
  const many = await readCommentContactsApi(async () => { calls++; return page(String(calls), calls < 25 ? `N${calls}` : null); }, post, { passes: 500 });
  assert.equal(many.scanned, 25);
});

test('a deferred bulk read hands back its progress and a resumed read continues from the cursor without duplicates', async () => {
  const post = { id: '42', url: 'https://www.facebook.com/groups/demo/posts/42' };
  const node = id => ({ __typename: 'Comment', legacy_fbid: id, body: { text: 'hi' }, author: { id: `7${id}`, name: `U${id}` } });
  const page = (ids, next) => JSON.stringify({ data: { node: { comments: { edges: ids.map(id => ({ node: node(id) })), page_info: { end_cursor: next, has_next_page: Boolean(next) } } } } });
  const error = await readCommentContactsApi(async cursor => { if (cursor) throw Object.assign(new Error('deferred'), { code: 'SCAN_DEFERRED' }); return page(['1', '2'], 'N1'); },
    post, { partial: false }).catch(e => e);
  assert.equal(error.code, 'SCAN_DEFERRED');
  assert.deepEqual(error.progress, { cursor: 'N1', pages: 1, incompleteReplies: false, comments: [
    { id: '1', author: 'U1', authorId: '71', authorUrl: 'https://www.facebook.com/profile.php?id=71' },
    { id: '2', author: 'U2', authorId: '72', authorUrl: 'https://www.facebook.com/profile.php?id=72' }] });
  const cursors = [];
  const resumed = await readCommentContactsApi(async cursor => { cursors.push(cursor); return page(['2', '3'], null); }, post, { partial: false, resume: error.progress });
  assert.deepEqual(cursors, ['N1']);
  assert.deepEqual(resumed.comments.map(c => c.authorId), ['71', '72', '73']);
  assert.equal(resumed.complete, undefined);
  const stale = await readCommentContactsApi(async () => page(['1'], null), post, { partial: false, resume: error.progress });
  assert.equal(stale.complete, false, 'a saved cursor yielding nothing new is not the end of the list');
  assert.equal((await readCommentContactsApi(async () => page(['3'], null), post, { passes: 1, resume: error.progress })).complete, false, 'pass cap counts saved pages');
});

test('pagination reports incomplete on a pass cap, a repeated cursor or a missing next cursor', async () => {
  const post={id:'42',url:'https://www.facebook.com/groups/demo/posts/42'};
  const page=(id,cursor)=>JSON.stringify({data:{node:{comments:{edges:[{node:comment('42',id,'text')}],page_info:{has_next_page:true,end_cursor:cursor}}}}});
  for (const [passes,cursor] of [[1,'NEXT'],[5,'NEXT'],[5,null]]) {
    let count=0;
    const result=await readCommentContactsApi(async()=>page(String(++count),cursor),post,{passes});
    assert.equal(result.complete,false);
    assert.ok(count<=2);
  }
});

test('unread reply pages keep an otherwise finished API scan incomplete', async () => {
  const post = {id:'42',url:'https://www.facebook.com/groups/demo/posts/42'};
  const text = JSON.stringify({data:{node:{comments:{edges:[{node:comment('42','1','parent', {
    feedback:{replies_connection:{edges:[],page_info:{has_next_page:true,end_cursor:'REPLY'}}},
  })}],page_info:{has_next_page:false}}}}});
  const result = await readCommentContactsApi(async () => text, post);
  assert.equal(result.scanned,1);
  assert.equal(result.complete,false);
});

test('DOM scan selects all comments and expands multiple reply threads; caps remain incomplete', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const row = id => `<article role="article"><a href="https://www.facebook.com/profile.php?id=9${id}">User ${id}</a><div dir="auto">hello</div><a href="https://www.facebook.com/groups/demo/posts/42?comment_id=${id}">time</a></article>`;
    await page.setContent(`<button onclick="document.querySelector('[role=menuitem]').hidden=false">Most relevant</button>
      <button role="menuitem" hidden onclick="this.remove();document.querySelector('button').remove();document.querySelector('#threads').hidden=false">All comments</button>
      ${row(1)}<div id="threads" hidden><button onclick="this.nextElementSibling.hidden=false;this.remove()">View 1 reply</button><div hidden>${row(2)}</div>
      <button onclick="this.nextElementSibling.hidden=false;this.remove()">2 câu trả lời</button><div hidden>${row(3)}${row(4)}</div></div>`);
    const post = {id:'42',url:'https://www.facebook.com/groups/demo/posts/42'};
    const limited = await readCommentContacts(page,post,{passes:1});
    assert.equal(limited.complete,false);
    assert.equal(limited.scanned,1);
    const full = await readCommentContacts(page,post,{passes:5});
    assert.equal(full.complete,true);
    assert.deepEqual(full.comments.map(c => c.id),['1','2','3','4']);
  } finally { await browser.close(); }
});
