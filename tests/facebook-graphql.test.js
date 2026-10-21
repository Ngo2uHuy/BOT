import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { extractPageInfo } from '../src/facebook-api.js';
import { FacebookCollector } from '../src/facebook.js';
import {
  BUILTIN_QUERIES, GraphQLFeedClient, RequestLimiter, builtinTemplate, captureFeedTemplate, captureQueryTemplate, captureSession, classifyGraphQLResponse,
  describeGraphQLRequest, extractProfileGraphQLPosts, extractSessionFromHtml, feedRequest, feedbackId, groupIdFromUrl, paginateFeed, queryRequest,
} from '../src/facebook-graphql.js';
import { normalizeProfileUrl } from '../src/profile.js';

const story = (id, time, text = `post ${id}`) => ({ __typename: 'Story', post_id: id, creation_time: time, message: { text } });
const stream = (...lines) => lines.map(line => JSON.stringify(line)).join('\r\n');
const feedPage = (stories, pageInfo) => stream(
  { data: { node: { __typename: 'Group', group_feed: { edges: stories.slice(0, 1).map((node, i) => ({ node, cursor: `edge-${i}` })) } } } },
  ...stories.slice(1).map((node, i) => ({ label: 'GroupsCometFeedRegularStories$stream$edges', path: ['node', 'group_feed', 'edges', i + 1], data: { node, cursor: `edge-${i + 1}` } })),
  ...(pageInfo ? [{ label: 'GroupsCometFeedRegularStories$defer$page_info', path: ['node', 'group_feed'], data: { page_info: pageInfo } }] : []),
);

const postData = (overrides = {}) => new URLSearchParams({
  av: '42', __user: '42', __a: '1', __rev: '100', __hs: 'hs', fb_dtsg: 'SECRET_DTSG', lsd: 'LSD', jazoest: '2', doc_id: '987654321',
  fb_api_req_friendly_name: 'GroupsCometFeedRegularStoriesPaginationQuery',
  variables: JSON.stringify({ count: 3, cursor: 'abc', id: '111111111', sortingSetting: 'TOP_POSTS', feedLocation: 'GROUP' }),
  ...overrides,
}).toString();
const capture = (overrides, now = 0) => captureFeedTemplate({
  method: 'POST', url: 'https://www.facebook.com/api/graphql/', postData: postData(overrides),
  headers: { 'X-FB-Friendly-Name': 'GroupsCometFeedRegularStoriesPaginationQuery', 'x-fb-lsd': 'LSD', 'x-asbd-id': '129477', cookie: 'c_user=42' },
}, now);

test('page info comes from the deferred chunk, otherwise from the last streamed edge cursor', () => {
  const page = feedPage([story('1001', 1760000000), story('1002', 1759990000)], { end_cursor: 'END', has_next_page: true });
  assert.deepEqual(extractPageInfo(`for (;;);${page}`), { endCursor: 'END', hasNextPage: true });
  assert.deepEqual(extractPageInfo(feedPage([story('1001', 1760000000), story('1002', 1759990000)])), { endCursor: 'edge-1', hasNextPage: true });
  assert.deepEqual(extractPageInfo(feedPage([story('1001', 1760000000)], { end_cursor: 'END', has_next_page: false })), { endCursor: 'END', hasNextPage: false });
  assert.deepEqual(extractPageInfo('not json'), { endCursor: null, hasNextPage: false });
});

test('only group feed GraphQL requests become templates and replay swaps group, cursor and sorting', () => {
  const template = capture();
  assert.equal(template.groupId, '111111111');
  assert.equal(template.form.doc_id, '987654321');
  assert.deepEqual(template.headers, { 'x-fb-friendly-name': 'GroupsCometFeedRegularStoriesPaginationQuery', 'x-fb-lsd': 'LSD', 'x-asbd-id': '129477' });
  assert.equal(capture({ fb_api_req_friendly_name: 'CometNotificationsDropdownQuery' }), null);
  assert.equal(capture({ variables: JSON.stringify({ id: 'slug', count: 3 }) }), null);
  assert.equal(capture({ variables: '{broken' }), null);
  assert.equal(captureFeedTemplate({ method: 'GET', url: 'https://www.facebook.com/api/graphql/', postData: postData(), headers: {} }), null);
  assert.equal(captureFeedTemplate({ method: 'POST', url: 'https://evil.example/api/graphql/', postData: postData(), headers: {} }), null);
  const { form, headers } = feedRequest(template, { groupId: '222222222', cursor: null, count: 10 });
  assert.deepEqual(JSON.parse(form.variables), { count: 10, cursor: null, id: '222222222', sortingSetting: 'CHRONOLOGICAL', feedLocation: 'GROUP' });
  assert.equal(form.fb_dtsg, 'SECRET_DTSG');
  assert.equal(headers['x-fb-lsd'], 'LSD');
  assert.equal(JSON.parse(template.form.variables).cursor, 'abc');
  assert.equal(groupIdFromUrl('https://www.facebook.com/groups/123456789'), '123456789');
  assert.equal(groupIdFromUrl('https://www.facebook.com/groups/demo'), null);
});

test('rate limits, checkpoints, login loss and schema failures are told apart', () => {
  const ok = feedPage([story('1', 1760000000)]);
  assert.equal(classifyGraphQLResponse({ status: 200, text: ok }), 'ok');
  assert.equal(classifyGraphQLResponse({ status: 429, text: ok }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 200, text: '<!DOCTYPE html><title>Checkpoint</title>' }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 302, headers: { location: 'https://www.facebook.com/checkpoint/1501092823525282/' }, text: '' }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 302, headers: { location: 'https://www.facebook.com/login.php' }, text: '' }), 'login');
  assert.equal(classifyGraphQLResponse({ status: 200, text: 'for (;;);{"error":1357004,"errorSummary":"Sorry, something went wrong"}' }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 200, text: JSON.stringify({ errors: [{ code: 1675004, message: 'Rate limit exceeded' }] }) }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 200, text: JSON.stringify({ errors: [{ message: 'Rate limit hit' }], data: null }) }), 'rate_limited');
  assert.equal(classifyGraphQLResponse({ status: 200, text: 'for (;;);{"error":1357001,"errorSummary":"Not Logged In"}' }), 'login');
  assert.equal(classifyGraphQLResponse({ status: 200, text: JSON.stringify({ errors: [{ code: 1675030, message: 'Error performing query.' }] }) }), 'schema');
  assert.equal(classifyGraphQLResponse({ status: 200, text: 'garbage' }), 'schema');
  assert.equal(classifyGraphQLResponse({ status: 500, text: '{}' }), 'transient');
  assert.equal(classifyGraphQLResponse({ status: 503, text: '' }), 'transient');
  assert.equal(classifyGraphQLResponse({ status: 200, text: '  ' }), 'transient');
  assert.equal(classifyGraphQLResponse({ status: 400, text: '{}' }), 'schema');
});

test('pagination stops after K consecutive old posts, not at a pinned old post', async () => {
  const at = minutes => ({ publishedAt: new Date(Date.UTC(2026, 9, 10, 0, minutes)).toISOString() });
  const cutoff = Date.parse(at(30).publishedAt);
  const pages = [
    { posts: [{ id: 'pinned', ...at(1) }, { id: 'a', ...at(50) }, { id: 'b', ...at(45) }], endCursor: 'p2', hasNextPage: true },
    { posts: [{ id: 'c', ...at(40) }, { id: 'old1', ...at(20) }, { id: 'old2', ...at(10) }], endCursor: 'p3', hasNextPage: true },
    { posts: [{ id: 'old3', ...at(5) }, { id: 'old4', ...at(4) }], endCursor: 'p4', hasNextPage: true },
    { posts: [{ id: 'never', ...at(3) }], endCursor: null, hasNextPage: false },
  ];
  const cursors = [], emitted = [];
  const result = await paginateFeed(async cursor => { cursors.push(cursor); return pages[cursors.length - 1]; },
    { cutoff, maxPages: 5, stopAfterOld: 3, latest: true, onPage: posts => emitted.push(posts.length) });
  assert.deepEqual(cursors, [null, 'p2', 'p3']);
  assert.deepEqual(emitted, [3, 3, 2]);
  assert.equal(result.pages, 3);
  assert.ok(!result.posts.some(post => post.id === 'never'));
});

test('latest mode reads one page without a watermark, stops on a stale page and honours the page cap', async () => {
  const fresh = { posts: [{ id: '1', publishedAt: '2026-10-10T00:00:00Z' }], endCursor: 'next', hasNextPage: true };
  let calls = 0;
  await paginateFeed(async () => { calls++; return fresh; }, { cutoff: null, maxPages: 1, latest: true });
  assert.equal(calls, 1);
  calls = 0;
  await paginateFeed(async () => { calls++; return fresh; }, { cutoff: 0, maxPages: 5, latest: true });
  assert.equal(calls, 5);
  calls = 0;
  await paginateFeed(async () => { calls++; return fresh; }, { cutoff: Date.parse('2026-10-11T00:00:00Z'), maxPages: 5, stopAfterOld: 3, latest: true });
  assert.equal(calls, 1);
  calls = 0;
  const result = await paginateFeed(async () => {
    if (calls++) { const error = new Error('cap'); error.code = 'SCAN_DEFERRED'; throw error; }
    return fresh;
  }, { cutoff: 0, maxPages: 5 });
  assert.equal(result.posts.length, 1);
  await assert.rejects(paginateFeed(async () => { const error = new Error('cap'); error.code = 'SCAN_DEFERRED'; throw error; }), { code: 'SCAN_DEFERRED' });
});

test('request limiter serializes each account, spaces requests randomly and defers at the hourly cap', async () => {
  let now = 1000;
  const sleeps = [];
  const limiter = new RequestLimiter({ minDelayMs: 3000, maxDelayMs: 8000, maxPerHour: 3, now: () => now, random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); now += ms; } });
  let active = 0, peak = 0;
  const work = async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); await Promise.resolve(); active--; return 'ok'; };
  assert.deepEqual(await Promise.all([limiter.run(1, work), limiter.run(1, work), limiter.run(1, work)]), ['ok', 'ok', 'ok']);
  assert.equal(peak, 1);
  assert.deepEqual(sleeps, [5500, 5500]);
  await assert.rejects(limiter.run(1, work), error => error.code === 'SCAN_DEFERRED' && error.retryAt === 1000 + 3600000);
  assert.equal(await limiter.run(2, work), 'ok');
  now = 1000 + 3600000 + 1;
  assert.equal(await limiter.run(1, work), 'ok');
});

test('request spacing runs start-to-start, so response time does not lower the hourly pace, and every call is counted', async () => {
  let now = 0;
  const limiter = new RequestLimiter({ minDelayMs: 900, maxDelayMs: 900, maxPerHour: 4000, now: () => now, random: () => 0,
    sleep: async ms => { now += ms; } });
  const starts = [];
  for (let i = 0; i < 3; i++) await limiter.run(1, async () => { starts.push(now); now += 400; });
  assert.deepEqual(starts, [0, 900, 1800]);
  assert.equal(limiter.usedLastHour(1), 3);
  assert.equal(limiter.usedLastHour(2), 0);
});

function fakeRequest(responses) {
  const calls = [];
  const send = method => async (url, options) => {
    calls.push({ method, url, options });
    const { status = 200, body, headers = {} } = responses.shift();
    return { status: () => status, headers: () => headers, text: async () => body };
  };
  return { calls, post: send('POST'), get: send('GET') };
}

test('GraphQL client replays the template, parses posts/cursor and invalidates on schema errors', async () => {
  let now = 0;
  const client = new GraphQLFeedClient({ ttlMs: 1000, now: () => now, limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0, now: () => now }) });
  client.remember(7, capture({}, 0));
  const request = fakeRequest([
    { body: feedPage([story('5001', 1760000000), story('5002', 1759999000)], { end_cursor: 'NEXT', has_next_page: true }) },
    { status: 429, body: '' },
    { body: '{"data":null,"errors":[{"code":1675030}]}' },
  ]);
  const page = await client.fetchPage(request, 7, { groupId: '222222222', groupUrl: 'https://www.facebook.com/groups/demo', cursor: 'C1', count: 10 });
  assert.deepEqual(page.posts.map(post => post.id), ['5001', '5002']);
  assert.equal(page.posts[0].url, 'https://www.facebook.com/groups/demo/posts/5001');
  assert.equal(page.endCursor, 'NEXT');
  const sent = request.calls[0];
  assert.equal(sent.url, 'https://www.facebook.com/api/graphql/');
  assert.equal(sent.options.maxRedirects, 0);
  assert.deepEqual(JSON.parse(sent.options.form.variables).id, '222222222');
  assert.equal(JSON.parse(sent.options.form.variables).cursor, 'C1');
  await assert.rejects(client.fetchPage(request, 7, { groupId: '222222222', groupUrl: 'https://www.facebook.com/groups/demo' }), { code: 'RATE_LIMITED' });
  assert.ok(client.template(7), 'rate limits keep the template');
  await assert.rejects(client.fetchPage(request, 7, { groupId: '222222222', groupUrl: 'https://www.facebook.com/groups/demo' }), { code: 'GRAPHQL_SCHEMA' });
  assert.equal(client.template(7), null);
  client.remember(7, capture({}, 0));
  now = 1000;
  assert.equal(client.template(7), null, 'templates expire after the TTL');
});

async function apiCollector(t, responses, onNewPage = () => { throw new Error('browser fallback'); }, remember = graphql => graphql.remember(42, capture({}, Date.now()))) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-graphql-test-'));
  const request = fakeRequest(responses);
  const context = {
    request, grantPermissions: async () => {}, route: async () => {}, pages: () => [], on: () => {}, close: async () => {},
    cookies: async () => [{ name: 'c_user', value: '42' }], newPage: async () => onNewPage(),
  };
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => context;
  const logs = [];
  const graphql = new GraphQLFeedClient({ limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0 }) });
  remember(graphql);
  const collector = new FacebookCollector({ dataDir: dir, scanWorkers: 1, scanMode: 'api', graphql, log: message => logs.push(message) });
  t.after(async () => {
    chromium.launchPersistentContext = original;
    await collector.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { collector, request, logs, graphql };
}

test('api mode collects pages incrementally without opening a tab', async t => {
  const watermark = Date.parse('2026-10-10T00:00:00Z');
  const s = seconds => Math.floor(watermark / 1000) + seconds;
  const { collector, request } = await apiCollector(t, [
    { body: feedPage([story('1', s(300)), story('2', s(200)), story('3', s(100))], { end_cursor: 'P2', has_next_page: true }) },
    { body: feedPage([story('4', s(-100)), story('5', s(-200)), story('6', s(-300))], { end_cursor: 'P3', has_next_page: true }) },
  ]);
  const batches = [];
  const posts = await collector.collect(42, 'https://www.facebook.com/groups/demo', null,
    { latest: true, numericId: '333333333', watermark, onPosts: async batch => batches.push(batch.map(post => post.id)) });
  assert.equal(request.calls.length, 2);
  assert.deepEqual(posts.map(post => post.id), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(batches, [['1', '2', '3'], ['4', '5', '6']]);
  assert.equal(JSON.parse(request.calls[1].options.form.variables).cursor, 'P2');
  assert.equal(JSON.parse(request.calls[0].options.form.variables).id, '333333333');
});

test('api mode falls back to the browser on schema errors', async t => {
  const { collector, logs, graphql } = await apiCollector(t, [{ body: 'garbage' }, { body: 'garbage' }]);
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), /browser fallback/);
  assert.equal(graphql.template(42), null);
  assert.equal(logs.filter(line => line.includes('QUÉT API')).length, 1);
  graphql.remember(42, capture({}, Date.now()));
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), /browser fallback/);
  assert.equal(logs.filter(line => line.includes('QUÉT API')).length, 1, 'fallback log is throttled per account');
});

test('api mode surfaces Facebook rate limits to the account cooldown', async t => {
  const limited = await apiCollector(t, [{ status: 429, body: '' }]);
  await assert.rejects(limited.collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), { code: 'RATE_LIMITED' });
});

test('api mode without a numeric group ID uses the browser to bootstrap it', async t => {
  const { collector, request } = await apiCollector(t, []);
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/demo', null, { latest: true }), /browser fallback/);
  assert.equal(request.calls.length, 0);
});

test('browser bootstrap captures the feed template and accepts numeric-ID permalinks of a slug group', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'c_user', value: 'fixture', domain: '.facebook.com', path: '/' }]);
  const route = context.route.bind(context);
  context.route = pattern => route(pattern, request => request.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<h1>Demo</h1>
    <div role="feed" style="min-height:4000px"><div role="article"><a href="/groups/111111111/posts/42" data-post-date="2026-10-08T06:45:00Z">time</a><div data-ad-preview="message">Post</div></div></div>
    <script>let sent=false;addEventListener('scroll',()=>{if(sent)return;sent=true;fetch('/api/graphql/',{method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded','x-fb-friendly-name':'GroupsCometFeedRegularStoriesPaginationQuery','x-fb-lsd':'LSD'},
      body:${JSON.stringify(postData())}}).catch(()=>{});});</script>` }));
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => context;
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-graphql-bootstrap-'));
  const collector = new FacebookCollector({ dataDir: dir, scanWorkers: 1, scanMode: 'api', log: () => {} });
  try {
    const ids = [];
    const posts = await collector.collect(123, 'https://www.facebook.com/groups/demo', null, { latest: true, onGroupId: id => ids.push(id) });
    assert.deepEqual(ids, ['111111111']);
    assert.equal(collector.graphql.template(123).form.doc_id, '987654321');
    assert.deepEqual(posts.map(post => post.url), ['https://www.facebook.com/groups/111111111/posts/42']);
  } finally {
    chromium.launchPersistentContext = original;
    await collector.close(); await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const queryPost = (name, variables) => ({
  method: 'POST', url: 'https://www.facebook.com/api/graphql/', headers: { 'x-fb-lsd': 'LSD', cookie: 'c_user=42' },
  postData: new URLSearchParams({ fb_dtsg: 'SECRET_DTSG', lsd: 'LSD', jazoest: '2', doc_id: '555', fb_api_req_friendly_name: name, variables: JSON.stringify(variables) }).toString(),
});
const base64 = value => Buffer.from(value).toString('base64');
const profileStory = (postId, owner, ownerId, time) => ({ __typename: 'Story', post_id: postId, wwwURL: `https://www.facebook.com/${owner}/posts/pfbid0${postId}`,
  creation_time: time, message: { text: `post ${postId}` }, actors: [{ id: ownerId, name: owner }] });
const profilePage = (stories, pageInfo) => stream(
  { data: { node: { timeline_list_feed_units: { edges: stories.slice(0, 1).map(node => ({ node, cursor: 'e0' })) } } } },
  ...stories.slice(1).map((node, i) => ({ label: 'ProfileCometTimelineFeed$stream', path: ['node', 'timeline_list_feed_units', 'edges', i + 1], data: { node, cursor: `e${i + 1}` } })),
  ...(pageInfo ? [{ label: 'ProfileCometTimelineFeed$defer$page_info', path: ['node', 'timeline_list_feed_units'], data: { page_info: pageInfo } }] : []),
);
const profileTemplate = () => ({ ...captureQueryTemplate('profile', queryPost('ProfileCometTimelineFeedRefetchQuery', { count: 3, cursor: 'abc', id: '100012345' }), Date.now()),
  aliases: ['https://www.facebook.com/alice', 'https://www.facebook.com/profile.php?id=100012345'], name: 'Alice' });
const commentNode = (postId, cid, text) => ({ __typename: 'Comment', id: base64(`comment:${postId}_${cid}`), legacy_fbid: cid, body: { text },
  author: { __typename: 'User', id: `9${cid}`, name: `User ${cid}`, url: `https://www.facebook.com/user${cid}` } });
const commentsPage = (comments, pageInfo) => stream({ data: { node: { __typename: 'Feedback', comment_rendering_instance_for_feed_location: {
  comments: { edges: comments.map((node, i) => ({ node, cursor: `c${i}` })), ...(pageInfo ? { page_info: pageInfo } : {}) } } } } });
const groupsPage = (ids, pageInfo) => stream({ data: { viewer: { all_joined_groups: { edges: ids.map(id => ({ node: { __typename: 'Group', id, name: `G${id}`, url: `https://www.facebook.com/groups/${id}/` }, cursor: `g${id}` })),
  ...(pageInfo ? { page_info: pageInfo } : {}) } } } });

test('non-feed queries are captured by kind, ranked best-first and replayed swapping only cursor/count/target', () => {
  const profile = captureQueryTemplate('profile', queryPost('ProfileCometTimelineFeedRefetchQuery', { count: 3, cursor: 'abc', id: '100012345', scale: 1 }), 5);
  assert.equal(profile.targetId, '100012345');
  assert.equal(profile.capturedAt, 5);
  assert.deepEqual(profile.headers, { 'x-fb-lsd': 'LSD' });
  assert.deepEqual(JSON.parse(queryRequest(profile).form.variables), { count: 3, cursor: null, id: '100012345', scale: 1 });
  assert.equal(queryRequest(profile).form.fb_dtsg, 'SECRET_DTSG');
  assert.equal(captureQueryTemplate('profile', queryPost('ProfileCometHeaderQuery', { id: '100012345', cursor: null })), null);
  assert.equal(captureQueryTemplate('profile', queryPost('ProfileCometTimelineFeedRefetchQuery', { id: '100012345' })), null, 'not paginated');
  const comments = captureQueryTemplate('comments', queryPost('CommentsListComponentsPaginationQuery',
    { commentsAfterCount: -1, commentsAfterCursor: 'C', id: base64('feedback:7777').replace(/=+$/, ''), feedLocation: 'DEDICATED_COMMENTING_SURFACE' }));
  assert.equal(comments.targetId, '7777');
  assert.equal(comments.cursorKey, 'commentsAfterCursor');
  assert.deepEqual(JSON.parse(queryRequest(comments, { cursor: 'NEXT', targetId: '8888' }).form.variables),
    { commentsAfterCount: -1, commentsAfterCursor: 'NEXT', id: base64('feedback:8888').replace(/=+$/, ''), feedLocation: 'DEDICATED_COMMENTING_SURFACE' });
  assert.equal(feedbackId('8888'), base64('feedback:8888'));
  assert.equal(captureQueryTemplate('comments', queryPost('Depth1CommentsListPaginationQuery', { cursor: 'C', id: base64('feedback:7777') })), null, 'reply threads');
  assert.equal(captureQueryTemplate('comments', queryPost('CommentsListComponentsPaginationQuery', { cursor: 'C', id: '7777' })), null, 'no feedback ID');
  assert.equal(captureQueryTemplate('comments', queryPost('CometUFICreateCommentMutation', { cursor: 'C', id: base64('feedback:7777') })), null);
  const rail = captureQueryTemplate('joinedGroups', queryPost('GroupsCometLeftRailContainerPaginationQuery', { count: 10, cursor: 'R' }));
  const joined = captureQueryTemplate('joinedGroups', queryPost('GroupsCometAllJoinedGroupsSectionPaginationQuery', { count: 20, cursor: 'J' }));
  assert.ok(joined.priority < rail.priority);
  assert.equal(joined.idKey, null);
  assert.equal(captureQueryTemplate('joinedGroups', { ...queryPost('GroupsCometAllJoinedGroupsSectionPaginationQuery', { cursor: 'J' }), method: 'GET' }), null);
  const seen = describeGraphQLRequest(queryPost('SomethingNewPaginationQuery', { after: 'x', id: '1' }));
  assert.deepEqual(seen, { friendlyName: 'SomethingNewPaginationQuery', docId: '555', keys: ['after', 'id'] });
});

test('profile GraphQL posts keep DOM permalink IDs and need owner proof; reels need a numeric owner alias', () => {
  const aliases = new Set(['https://www.facebook.com/alice', 'https://www.facebook.com/profile.php?id=100012345']);
  const belongs = value => { try { return aliases.has(normalizeProfileUrl(value)); } catch { return false; } };
  const text = profilePage([
    profileStory('1', 'alice', '100012345', 1760000000), profileStory('2', 'bob', '200', 1760000100),
    profileStory('3', 'alice', '300', 1760000200), { __typename: 'Story', post_id: '4', creation_time: 1760000300, actors: [{ id: '100012345' }] },
  ], { end_cursor: 'END', has_next_page: true });
  const posts = extractProfileGraphQLPosts(text, 'profile', belongs);
  assert.deepEqual(posts.map(post => [post.id, post.url, post.kind, post.authorUrl, post.publishedAt]),
    [['pfbid01', 'https://www.facebook.com/alice/posts/pfbid01', 'post', 'https://www.facebook.com/profile.php?id=100012345', new Date(1760000000000).toISOString()]]);
  assert.deepEqual(extractPageInfo(text), { endCursor: 'END', hasNextPage: true });
  const reels = extractProfileGraphQLPosts(stream({ data: { node: { reels: { edges: [
    { node: { url: 'https://www.facebook.com/reel/42', video: { id: '9001', owner: { id: '100012345', name: 'Alice' }, creation_time: 1760000000 } }, cursor: 'r0' },
    { node: { url: 'https://www.facebook.com/reel/43', video: { id: '9002', owner: { id: '999' } } }, cursor: 'r1' },
    { node: { url: 'https://www.facebook.com/reel/44' }, cursor: 'r2' },
  ] } } } }), 'reels', belongs);
  assert.deepEqual(reels.map(reel => [reel.id, reel.kind, reel.author, reel.publishedAt]), [['42', 'reel', 'Alice', new Date(1760000000000).toISOString()]]);
});

test('scoped templates are independent of the feed template and schema errors only drop their own scope', async () => {
  const client = new GraphQLFeedClient({ limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0 }) });
  client.remember(7, capture({}, Date.now()));
  client.remember(7, profileTemplate(), 'profile:https://www.facebook.com/alice');
  const request = fakeRequest([{ body: profilePage([profileStory('1', 'alice', '100012345', 1760000000)]) }, { body: 'garbage' }]);
  const text = await client.fetchQuery(request, 7, 'profile:https://www.facebook.com/alice', { cursor: 'C2', referer: 'https://www.facebook.com/alice' });
  assert.match(text, /pfbid01/);
  assert.equal(JSON.parse(request.calls[0].options.form.variables).cursor, 'C2');
  assert.equal(request.calls[0].options.headers.referer, 'https://www.facebook.com/alice');
  await assert.rejects(client.fetchQuery(request, 7, 'profile:https://www.facebook.com/alice'), { code: 'GRAPHQL_SCHEMA' });
  assert.equal(client.template(7, 'profile:https://www.facebook.com/alice'), null);
  assert.ok(client.template(7), 'feed template survives');
  // Built-in kinds (comments too) seed from the session; a scope with neither template nor built-in has no query.
  await assert.rejects(client.fetchQuery(request, 7, 'reels:https://www.facebook.com/alice'), { code: 'GRAPHQL_SCHEMA' });
});

test('api mode scans a profile through its captured timeline query and falls back to the browser when nothing belongs to it', async t => {
  const scope = 'profile:https://www.facebook.com/alice';
  const { collector, request, logs, graphql } = await apiCollector(t, [
    { body: profilePage([profileStory('1', 'alice', '100012345', 1760000000), profileStory('2', 'bob', '200', 1760000100)], { end_cursor: 'P2', has_next_page: true }) },
    { body: profilePage([profileStory('9', 'bob', '200', 1760000000)]) },
  ], undefined, graphql => graphql.remember(42, profileTemplate(), scope));
  const batches = [];
  const posts = await collector.collect(42, 'https://www.facebook.com/alice', null, { latest: true, contentType: 'posts', onPosts: async batch => batches.push(batch.map(post => post.id)) });
  assert.deepEqual(posts.map(post => [post.id, post.groupName]), [['pfbid01', 'Alice']]);
  assert.deepEqual(batches, [['pfbid01']]);
  assert.equal(request.calls.length, 1);
  assert.equal(JSON.parse(request.calls[0].options.form.variables).cursor, null);
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/alice', null, { latest: true, contentType: 'posts' }), /browser fallback/);
  assert.equal(graphql.template(42, scope), null);
  assert.equal(logs.filter(line => line.includes('QUÉT API')).length, 1);
});

test('api mode reads comment contacts via the captured comments query for any post and falls back on foreign or empty pages', async t => {
  const template = captureQueryTemplate('comments', queryPost('CommentsListComponentsPaginationQuery', { commentsAfterCount: -1, commentsAfterCursor: 'C', id: base64('feedback:7777') }), Date.now());
  const { collector, request, logs, graphql } = await apiCollector(t, [
    { body: commentsPage([commentNode('8888', '1', 'Gọi 0912 345 678'), commentNode('8888', '2', 'ok')], { end_cursor: 'N2', has_next_page: true }) },
    { body: commentsPage([commentNode('8888', '3', 'mail a@example.com')], { end_cursor: null, has_next_page: false }) },
    { body: commentsPage([commentNode('1234', '5', '0912 345 678')]) },
  ], undefined, graphql => graphql.remember(42, template, 'comments'));
  const result = await collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888');
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.items.map(item => [item.id, item.phones, item.emails, item.authorUrl, item.url]), [
    ['1', ['0912345678'], [], 'https://www.facebook.com/user1', 'https://www.facebook.com/groups/demo/posts/8888?comment_id=1'],
    ['3', [], ['a@example.com'], 'https://www.facebook.com/user3', 'https://www.facebook.com/groups/demo/posts/8888?comment_id=3'],
  ]);
  assert.equal(JSON.parse(request.calls[0].options.form.variables).id, base64('feedback:8888'));
  assert.equal(JSON.parse(request.calls[0].options.form.variables).commentsAfterCursor, null);
  assert.equal(JSON.parse(request.calls[1].options.form.variables).commentsAfterCursor, 'N2');
  await assert.rejects(collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888'), /browser fallback/);
  assert.equal(graphql.template(42, 'comments'), null);
  assert.equal(logs.filter(line => line.includes('QUÉT API')).length, 1);
});

test('api mode lists joined groups via the captured query and rejects a much shorter list than the browser saw', async t => {
  const template = { ...captureQueryTemplate('joinedGroups', queryPost('GroupsCometAllJoinedGroupsSectionPaginationQuery', { count: 2, cursor: 'J' }), Date.now()), baseline: 3 };
  const { collector, request, graphql } = await apiCollector(t, [
    { body: groupsPage(['111', '222'], { end_cursor: 'G2', has_next_page: true }) },
    { body: groupsPage(['333'], { end_cursor: null, has_next_page: false }) },
    { body: groupsPage(['111'], { end_cursor: null, has_next_page: false }) },
  ], undefined, graphql => graphql.remember(42, template, 'joinedGroups'));
  const result = await collector.joinedGroups(42);
  assert.deepEqual(result, { limited: false, groups: ['111', '222', '333'].map(id => ({ url: `https://www.facebook.com/groups/${id}/`, name: `G${id}` })) });
  assert.equal(JSON.parse(request.calls[1].options.form.variables).cursor, 'G2');
  assert.equal(graphql.template(42, 'joinedGroups').baseline, 3);
  await assert.rejects(collector.joinedGroups(42), /browser fallback/);
  assert.equal(graphql.template(42, 'joinedGroups'), null);
});

async function bootstrapBrowser(t, html) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'c_user', value: 'fixture', domain: '.facebook.com', path: '/' }]);
  const route = context.route.bind(context);
  context.route = pattern => route(pattern, request => request.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html(new URL(request.request().url())) }));
  const original = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async () => context;
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-graphql-capture-'));
  const logs = [];
  const collector = new FacebookCollector({ dataDir: dir, scanWorkers: 1, scrollPasses: 1, scanMode: 'api', apiBootstrap: false, log: message => logs.push(message) });
  t.after(async () => {
    chromium.launchPersistentContext = original;
    await collector.close(); await browser.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { collector, logs };
}
const sendOn = (event, name, variables) => `<script>let sent=false;addEventListener('${event}',()=>{if(sent)return;sent=true;fetch('/api/graphql/',{method:'POST',
  headers:{'content-type':'application/x-www-form-urlencoded','x-fb-friendly-name':'${name}','x-fb-lsd':'LSD'},
  body:${JSON.stringify(queryPost(name, variables).postData)}}).catch(()=>{});},true);</script>`;
const profileHtml = name => `<main><h1>Alice</h1><div style="min-height:4000px"><div role="article"><h3><a href="/alice">alice</a></h3>
  <a href="/alice/posts/1" data-post-date="2026-10-08T06:45:00Z">Time</a><div data-ad-preview="message">Post 1</div></div></div></main>
  ${sendOn('scroll', name, { count: 3, cursor: 'abc', id: '100012345' })}`;

test('profile browser scans capture the timeline query from the network with the numeric owner alias', async t => {
  const { collector, logs } = await bootstrapBrowser(t, () => profileHtml('ProfileCometTimelineFeedRefetchQuery'));
  const posts = await collector.collect(123, 'https://www.facebook.com/alice', null, { latest: true, contentType: 'posts' });
  assert.deepEqual(posts.map(post => post.id), ['1']);
  const template = collector.graphql.template(123, 'profile:https://www.facebook.com/alice');
  assert.equal(template.form.doc_id, '555');
  assert.equal(template.name, 'Alice');
  assert.ok(template.aliases.includes('https://www.facebook.com/profile.php?id=100012345'));
  assert.ok(logs.some(line => line.includes('ProfileCometTimelineFeedRefetchQuery')));
});

test('a capture visit that matches no query logs friendly names, doc IDs and variable keys only', async t => {
  const { collector, logs } = await bootstrapBrowser(t, () => profileHtml('ProfileCometBrandNewFeedQuery'));
  await collector.collect(123, 'https://www.facebook.com/alice', null, { latest: true, contentType: 'posts' });
  assert.equal(collector.graphql.template(123, 'profile:https://www.facebook.com/alice'), null);
  const line = logs.find(item => item.includes('Chưa nhận ra'));
  assert.match(line, /"profile".*ProfileCometBrandNewFeedQuery#555 \{count,cursor,id\}/);
  assert.ok(!/SECRET_DTSG|LSD|100012345|c_user/.test(logs.join('\n')));
});

test('comment and joined-group browser reads capture their pagination queries from the network', async t => {
  const { collector } = await bootstrapBrowser(t, url => url.pathname.startsWith('/groups/joins')
    ? `<main role="main"><a href="https://www.facebook.com/groups/111/">G111</a><a href="https://www.facebook.com/groups/222/">G222</a></main>
       <div style="min-height:4000px"></div>${sendOn('scroll', 'GroupsCometAllJoinedGroupsSectionPaginationQuery', { count: 10, cursor: 'J' })}`
    : `<div role="article"><a href="https://www.facebook.com/an">An</a><div dir="auto">0912 345 678</div>
       <a href="https://www.facebook.com/groups/demo/posts/7777?comment_id=10">1 giờ</a></div><div role="button" tabindex="0">View more comments</div>
       ${sendOn('click', 'CommentsListComponentsPaginationQuery', { commentsAfterCount: -1, commentsAfterCursor: 'C', id: base64('feedback:7777') })}`);
  const contacts = await collector.collectCommentContacts(123, 'https://www.facebook.com/groups/demo/posts/7777');
  assert.equal(contacts.items.length, 1);
  assert.equal(collector.graphql.template(123, 'comments').targetId, '7777');
  const joined = await collector.joinedGroups(123);
  assert.equal(joined.groups.length, 2);
  assert.equal(collector.graphql.template(123, 'joinedGroups').baseline, 2);
});

const sessionHtml = `<script>["DTSGInitialData",[],{"token":"DTSG_TOKEN"},258]["LSD",[],{"token":"LSD_TOKEN"},323]
  {"USER_ID":"100055555555","__spin_r":1050596417,"__spin_b":"trunk","__spin_t":1792163051,"hsi":"7550000000000000001","haste_session":"20742.HYP"}</script>`;

test('session tokens come from page HTML or any captured GraphQL form, never without fb_dtsg and a numeric user', () => {
  const session = extractSessionFromHtml(sessionHtml, 5);
  assert.equal(session.form.fb_dtsg, 'DTSG_TOKEN');
  assert.equal(session.form.__user, '100055555555');
  assert.equal(session.form.av, '100055555555');
  assert.equal(session.form.jazoest, `2${[...'DTSG_TOKEN'].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`);
  assert.equal(session.form.__spin_r, '1050596417');
  assert.equal(session.form.__hsi, '7550000000000000001');
  assert.deepEqual(session.headers, { 'x-fb-lsd': 'LSD_TOKEN', 'x-asbd-id': '359341' });
  assert.equal(session.capturedAt, 5);
  assert.equal(extractSessionFromHtml('<html>login</html>'), null);
  assert.equal(extractSessionFromHtml(sessionHtml.replace('"USER_ID":"100055555555"', '"USER_ID":"0"')), null);
  const captured = captureSession({ method: 'POST', url: 'https://www.facebook.com/api/graphql/', postData: postData(), headers: { 'x-asbd-id': '129477' } });
  assert.equal(captured.form.fb_dtsg, 'SECRET_DTSG');
  assert.ok(!('doc_id' in captured.form) && !('variables' in captured.form) && !('fb_api_req_friendly_name' in captured.form));
  assert.equal(captured.headers['x-asbd-id'], '129477');
});

test('built-in queries replay with the session, swap the group in both ID fields and never shadow a captured template', () => {
  const session = extractSessionFromHtml(sessionHtml, Date.now());
  const feed = builtinTemplate('feed', session);
  const { form, headers } = feedRequest(feed, { groupId: '222222222', cursor: null, count: 10 });
  const variables = JSON.parse(form.variables);
  assert.equal(form.doc_id, BUILTIN_QUERIES.feed.docId);
  assert.equal(form.fb_api_req_friendly_name, 'GroupsCometFeedRegularStoriesPaginationQuery');
  assert.equal(form.fb_dtsg, 'DTSG_TOKEN');
  assert.equal(headers['x-fb-friendly-name'], 'GroupsCometFeedRegularStoriesPaginationQuery');
  assert.deepEqual([variables.id, variables.youthIntegrityHostID, variables.count, variables.sortingSetting], ['222222222', '222222222', 10, 'CHRONOLOGICAL']);
  // Matches the web client's CommentListComponentsRootQuery capture of 2026-10-19 except the target feedback ID.
  const comments = queryRequest(builtinTemplate('comments', session), { targetId: '8888' });
  assert.deepEqual([comments.form.doc_id, comments.form.fb_api_req_friendly_name, comments.headers['x-fb-friendly-name']],
    ['29409681848615704', 'CommentListComponentsRootQuery', 'CommentListComponentsRootQuery']);
  assert.deepEqual(JSON.parse(comments.form.variables), {
    commentsIntentToken: 'CHRONOLOGICAL_UNFILTERED_INTENT_V1', feedLocation: 'POST_PERMALINK_DIALOG', feedbackSource: 2, focusCommentID: null,
    scale: 1, useDefaultActor: false, id: base64('feedback:8888'),
    __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
  });
  const joined = queryRequest(builtinTemplate('joinedGroups', session), { cursor: 'J2' });
  assert.deepEqual(JSON.parse(joined.form.variables), { count: 20, cursor: 'J2', ordering: ['name'], scale: 1 });
  assert.equal(JSON.parse(feedRequest(capture(), { groupId: '333333333' }).form.variables).id, '333333333');

  let now = 1000;
  const client = new GraphQLFeedClient({ now: () => now, parkMs: 100, limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0, now: () => now }) });
  assert.equal(client.rememberSession(7, { ...session, capturedAt: now }), true);
  assert.ok(client.template(7).builtin && client.template(7, 'joinedGroups').builtin);
  client.invalidate(7);
  assert.equal(client.rememberSession(7, { ...session, capturedAt: now }), false);
  assert.equal(client.template(7), null, 'a failed built-in stays parked');
  now = 1200;
  client.rememberSession(7, { ...session, capturedAt: now });
  assert.ok(client.template(7).builtin, 'the park expires');
  client.remember(7, capture({}, now));
  client.rememberSession(7, { ...session, capturedAt: now });
  assert.equal(client.template(7).form.doc_id, '987654321', 'captured templates win');

  const seeded = new GraphQLFeedClient({ limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0 }) });
  seeded.remember(9, capture({}, Date.now()));
  assert.equal(seeded.template(9, 'joinedGroups').form.fb_dtsg, 'SECRET_DTSG', 'a captured query unlocks the other built-ins');
  const off = new GraphQLFeedClient({ builtins: {} });
  off.rememberSession(9, session);
  assert.equal(off.template(9), null);
});

test('api mode without any template reads the session from one HTML GET and scans with the built-in feed query', async t => {
  const now = Math.floor(Date.now() / 1000);
  const { collector, request, logs } = await apiCollector(t, [
    { body: sessionHtml },
    { body: feedPage([story('11', now - 60), story('12', now - 120)], { end_cursor: null, has_next_page: false }) },
  ], undefined, () => {});
  const posts = await collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true });
  assert.deepEqual(posts.map(post => post.id), ['11', '12']);
  assert.deepEqual(request.calls.map(call => [call.method, call.url]), [['GET', 'https://www.facebook.com/'], ['POST', 'https://www.facebook.com/api/graphql/']]);
  assert.equal(request.calls[1].options.form.doc_id, BUILTIN_QUERIES.feed.docId);
  assert.equal(JSON.parse(request.calls[1].options.form.variables).youthIntegrityHostID, '123456789');
  assert.ok(logs.some(line => line.includes('Đã lấy phiên GraphQL từ HTML')));
  assert.ok(!/DTSG_TOKEN|LSD_TOKEN/.test(logs.join('\n')));
});

test('a failed HTML bootstrap falls back to the browser and is not retried on every scan', async t => {
  const { collector, request } = await apiCollector(t, [{ body: '<html>login</html>' }], undefined, () => {});
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), /browser fallback/);
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), /browser fallback/);
  assert.equal(request.calls.length, 1);
});

test('a checkpoint redirect on the HTML bootstrap reaches the account cooldown', async t => {
  const { collector } = await apiCollector(t, [{ status: 302, body: '', headers: { location: 'https://www.facebook.com/checkpoint/1501092823525282/' } }], undefined, () => {});
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), { code: 'RATE_LIMITED' });
});

test('the limiter widens request spacing after a rate limit, never below the configured delay, and recovers',async () => {
  let now = 0;
  const slowdowns = [];
  const limiter = new RequestLimiter({ minDelayMs: 1000, maxDelayMs: 1000, now: () => now, sleep: async ms => { now += ms; }, random: () => 0, onSlowdown: (owner, slow) => slowdowns.push(slow) });
  await limiter.run(1, async () => 'ok');
  const limited = Object.assign(new Error('limited'), { code: 'RATE_LIMITED' });
  await assert.rejects(limiter.run(1, async () => { throw limited; }), { code: 'RATE_LIMITED' });
  assert.equal(limiter.slowdown(1), 2);
  const before = now;
  await limiter.run(1, async () => 'ok');
  assert.equal(now - before, 2000, 'the next request waits the doubled spacing');
  for (let i = 0; i < 25; i++) await limiter.run(1, async () => 'ok');
  assert.equal(limiter.slowdown(1), 1);
  assert.deepEqual([slowdowns[0], slowdowns.at(-1)], [2, 1]);
});

test('low requests yield to other work, defer at 75% of the budget and respect rate limits', async () => {
  let now = 0;
  const limiter = new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0, maxPerHour: 8, now: () => now, sleep: async ms => { now += ms; } });
  const order = [];
  let release;
  const first = limiter.run(1, () => new Promise(resolve => { release = resolve; }));
  const queued = [limiter.run(1, async () => order.push('low'), { low: true }), limiter.run(1, async () => order.push('read')), limiter.run(1, async () => order.push('priority'), { priority: true })];
  await Promise.resolve();
  release();
  await Promise.all([first, ...queued]);
  assert.deepEqual(order, ['priority', 'read', 'low']);
  const budget = new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0, maxPerHour: 4, now: () => now, sleep: async ms => { now += ms; } });
  for (let i = 0; i < 3; i++) await budget.run(1, async () => 'ok');
  const start = now;
  await assert.rejects(budget.run(1, async () => { throw new Error('must not execute'); }, { low: true }), error => error.code === 'SCAN_DEFERRED' && error.retryAt === start+3600000);
  assert.equal(now,start,'deferral does not occupy the worker');
  assert.equal(budget.usedLastHour(1) <= 3, true);
  const limited = Object.assign(new Error('limited'), { code: 'RATE_LIMITED' });
  await assert.rejects(limiter.run(2, async () => { throw limited; }, { low: true }), { code: 'RATE_LIMITED' });
  assert.equal(limiter.slowdown(2), 2);
});

test('outages keep the template and a parked built-in is re-seeded from the session the account still has', async () => {
  let now = 1000;
  const client = new GraphQLFeedClient({ now: () => now, parkMs: 100, limiter: new RequestLimiter({ minDelayMs: 0, maxDelayMs: 0, now: () => now }) });
  client.rememberSession(7, { ...extractSessionFromHtml(sessionHtml, now), capturedAt: now });
  const request = fakeRequest([{ status: 502, body: '' }, { status: 200, body: '' }, { body: 'garbage' }]);
  const call = () => client.fetchQuery(request, 7, 'recentFeed');
  await assert.rejects(call(), { code: 'GRAPHQL_TRANSIENT' });
  await assert.rejects(call(), { code: 'GRAPHQL_TRANSIENT' });
  assert.ok(client.template(7, 'recentFeed').builtin, 'a 5xx or empty body is not a schema change');
  await assert.rejects(call(), { code: 'GRAPHQL_SCHEMA' });
  assert.equal(client.template(7, 'recentFeed'), null, 'parked after a real schema failure');
  now = 1200;
  assert.ok(client.template(7, 'recentFeed').builtin, 'back once the park ends, without a new session');
});

test('an empty group feed fails only that group and keeps the account-wide template', async t => {
  const { collector, graphql } = await apiCollector(t, [{ body: feedPage([], { end_cursor: null, has_next_page: false }) }]);
  await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/123456789', null, { latest: true }), { code: 'EMPTY_FEED' });
  assert.equal(graphql.template(42).form.doc_id, '987654321');
});

test('a date-range history pass stops at the watermark within 3 pages unless a backfill is requested', async t => {
  const watermark = Date.parse('2026-10-10T00:00:00Z');
  const s = seconds => Math.floor(watermark / 1000) + seconds;
  const fresh = i => ({ body: feedPage([story(`n${i}`, s(300 - i)), story(`m${i}`, s(200 - i))], { end_cursor: `F${i}`, has_next_page: true }) });
  const old = (i, next = true) => ({ body: feedPage([story(`a${i}`, s(-100 - i)), story(`b${i}`, s(-200 - i)), story(`c${i}`, s(-300 - i))], { end_cursor: `O${i}`, has_next_page: next }) });
  const { collector, request } = await apiCollector(t, [fresh(1), fresh(2), fresh(3), old(1), old(2), old(3), old(4, false)]);
  const range = { start: watermark - 30 * 86400000, end: null };
  const run = backfill => collector.collect(42, 'https://www.facebook.com/groups/demo', range, { background: true, numericId: '333333333', watermark, backfill });
  await run(false);
  assert.equal(request.calls.length, 3, 'open range: page cap');
  await run(false);
  assert.equal(request.calls.length, 4, 'stops at posts older than the watermark, not the range start');
  await run(true);
  assert.equal(request.calls.length, 7, 'a backfill pages back to the range start');
});

test('without a captured comments query the built-in first page is used; more pages go to the browser read', async t => {
  const page = more => ({ body: commentsPage([commentNode('8888', '1', 'x'), commentNode('8888', '2', 'y')], { end_cursor: more ? 'N2' : null, has_next_page: more }) });
  const { collector, request, graphql } = await apiCollector(t, [page(false), page(true)]);
  const one = await collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888', { passes: 500, partial: false });
  assert.deepEqual([one.comments.length, one.complete], [2, undefined]);
  assert.equal(request.calls[0].options.form.doc_id, BUILTIN_QUERIES.comments.docId);
  await assert.rejects(collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888', { passes: 500, partial: false }), /browser fallback/);
  assert.equal(request.calls.length, 2, 'never replays the root query as page two');
  assert.ok(graphql.template(42, 'comments')?.builtin, 'a working built-in is kept');
});

test('bulk comment reads page past the default 10 and refuse a list cut short by a deferral', async t => {
  const template = captureQueryTemplate('comments', queryPost('CommentsListComponentsPaginationQuery', { commentsAfterCount: -1, commentsAfterCursor: 'C', id: base64('feedback:7777') }), Date.now());
  const pages = count => Array.from({ length: count }, (_, i) => ({ body: commentsPage([commentNode('8888', String(i + 1), 'x')], { end_cursor: i + 1 < count ? `N${i + 1}` : null, has_next_page: i + 1 < count }) }));
  const { collector, request } = await apiCollector(t, [...pages(12), ...pages(12)], undefined, graphql => graphql.remember(42, template, 'comments'));
  const all = await collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888', { passes: 500, partial: false });
  assert.equal(all.comments.length, 12);
  assert.equal(request.calls.length, 12);
  const capped = await collector.collectCommentContacts(42, 'https://www.facebook.com/groups/demo/posts/8888');
  assert.equal(capped.comments.length, 10);
  assert.equal(capped.complete, false);
});

test('vanity profiles resolve over plain HTTP only to IDs bound to them; 429 is a rate limit', async t => {
  const { collector, request } = await apiCollector(t, [
    { body: '<html><meta property="al:android:url" content="fb://profile/100077"></html>' },
    { body: '<script>{"userVanity":"other.user","userID":"555"}</script>' },
    { status: 302, body: '', headers: { location: 'https://www.facebook.com/checkpoint/123' } },
    { status: 429, body: '' },
  ]);
  assert.equal(await collector.resolveProfileId(42, 'https://www.facebook.com/profile.php?id=123'), '123');
  assert.equal(request.calls.length, 0, 'numeric profiles need no request');
  assert.equal(await collector.resolveProfileId(42, 'https://www.facebook.com/ten.abc'), '100077');
  assert.equal(request.calls[0].url, 'https://www.facebook.com/ten.abc');
  assert.equal(request.calls[0].options.maxRedirects, 0);
  assert.equal(await collector.resolveProfileId(42, 'https://www.facebook.com/ten.abc'), null);
  await assert.rejects(collector.resolveProfileId(42, 'https://www.facebook.com/ten.abc'), { code: 'RATE_LIMITED' });
  await assert.rejects(collector.resolveProfileId(42, 'https://www.facebook.com/ten.abc'), { code: 'RATE_LIMITED' });
});
