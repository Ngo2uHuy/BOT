import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request, chromium } from 'playwright';
import { FacebookCollector } from '../src/facebook.js';
import { sessionFile, validateSession, submitHttpAction } from '../src/facebook-http.js';
import { login } from '../src/login.js';
import { desktopConfig } from '../desktop/settings.js';

const cookies = [
  { name: 'c_user', value: '12345', domain: '.facebook.com', path: '/' },
  { name: 'xs', value: 'test-only', domain: '.facebook.com', path: '/' },
];
const html = '<script>["DTSGInitialData",[],{"token":"TEST"}];{"USER_ID":"12345"}</script>';
const response = (body, status = 200) => ({ status: () => status, headers: () => ({}), text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

test('block API sends the selected ID once and requires a matching acknowledgement', async () => {
  const session={form:{__user:'12345'},headers:{}};
  let count=0;
  const invoke=body=>submitHttpAction({session,kind:'block',target:'67890',request:{post:async (url,{form})=>{
    count++;
    assert.equal(form.fb_api_req_friendly_name,'ProfileCometActionBlockUserMutation');
    assert.equal(form.doc_id,'27871511059188774');
    const variables=JSON.parse(form.variables);
    assert.deepEqual(variables,{
      collectionID:null,hasCollectionAndSectionID:false,
      input:{blocksource:'PROFILE',should_apply_to_later_created_profiles:false,user_id:'67890',
        actor_id:'12345',client_mutation_id:variables.input.client_mutation_id},
      scale:1,sectionID:null,isPrivacyCheckupContext:false,
      __relay_internal__pv__FBProfile_enable_perf_improv_gkrelayprovider:true,
    });
    assert.ok(variables.input.client_mutation_id);
    return response(body);
  }}});
  assert.equal((await invoke({data:{user_block:{blocked_user:{id:'67890'}}}})).state,'blocked');
  // Real browser response from the 2026-10-19 capture.
  assert.equal((await invoke({data:{user_block:{viewer:{}}},extensions:{is_final:true}})).state,'blocked');
  await assert.rejects(invoke({data:{user_block:{viewer:{}}},errors:[{message:'invalid input'}]}),/invalid input/);
  await assert.rejects(invoke({data:{user_block:{blocked_user:{id:'99999'}}}}),/chưa trả xác nhận/);
  await assert.rejects(invoke({data:{user_block:null}}),/chưa trả xác nhận/);
  await assert.rejects(invoke({errors:[{message:'invalid input'}]}),/invalid input/);
  assert.equal(count,6);
  const request={post:()=>{throw new Error('must not submit');}};
  await assert.rejects(submitHttpAction({session,request,kind:'block',target:'12345'}),/chính tài khoản/);
  await assert.rejects(submitHttpAction({session,request,kind:'block',target:'67890',canSubmit:()=>false}),/Đã hủy/);
});

test('null block payload with rendering errors remains unconfirmed without retrying', async () => {
  let calls=0;
  const missing={message:'A server error missing_required_variable_value occured. Check server logs for details.'};
  const request={post:async()=>{calls++;return response({data:{user_block:null},errors:[missing,{message:'Chưa xử lý được yêu cầu của bạn'},missing]});}};
  await assert.rejects(submitHttpAction({session:{form:{__user:'12345'},headers:{}},request,kind:'block',target:'67890'}), /missing_required_variable_value/);
  assert.equal(calls,1);
  const noData={post:async()=>response({errors:[missing]})};
  await assert.rejects(submitHttpAction({session:{form:{__user:'12345'},headers:{}},request:noData,kind:'block',target:'67890'}),/missing_required_variable_value/);
});

test('session import rejects other domains, missing authentication and traversal', () => {
  assert.throws(() => validateSession({ cookies: [] }), /thiếu/);
  assert.throws(() => validateSession(cookies.map(cookie => ({ ...cookie, domain: '.evil.com' }))), /thiếu/);
  assert.throws(() => sessionFile('data', '../42'), /không hợp lệ/);
  assert.equal(validateSession(cookies).cookies.length, 2);
  const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  assert.equal(validateSession({ cookies, userAgent: agent }).userAgent, agent);
  assert.equal(validateSession({ cookies, userAgent: 'Playwright/1.64.0' }).userAgent, undefined);
  assert.throws(() => desktopConfig({ FACEBOOK_BROWSERLESS: 'true', SCAN_MODE: 'browser' }, '.'), /HTTP-only/);
});

test('HTTP-only scans and submits actions without browser, disposes responses and fails closed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'http-only-'));
  const filename = sessionFile(dir, 42);
  await mkdir(path.dirname(filename));
  await writeFile(filename, JSON.stringify({ cookies }));
  let calls = 0, disposed = 0, closed = 0, launches = 0, fail = false;
  t.mock.method(chromium, 'launchPersistentContext', () => { launches++; throw new Error('Browser forbidden'); });
  t.mock.method(request, 'newContext', async options => {
    assert.equal(options.storageState.cookies.length, 2);
    assert.ok(!('userAgent' in options.storageState));
    assert.match(options.userAgent, /^Mozilla\/5\.0 /, 'never the default Playwright agent');
    const wrap = body => { calls++; return { ...response(body), dispose: async () => { disposed++; } }; };
    return {
      get: async (url, { headers }) => {
        assert.equal(headers['sec-fetch-mode'], 'navigate');
        return wrap(url === 'https://www.facebook.com/groups/named/' ? `${html}{"groupID":"77777"}{"groupID":"77777"}` : html);
      },
      post: async (url, { form, headers }) => {
        assert.equal(headers['sec-fetch-mode'], 'cors');
        if (fail) return wrap({ errors: [{ message: 'Document not found' }] });
        if (url.endsWith('/messaging/send/')) return wrap({ payload: { actions: [{ message_id: 'mid.1', offline_threading_id: form.offline_threading_id }] } });
        const variables = JSON.parse(form.variables);
        if (form.fb_api_req_friendly_name === 'useCometUFICreateCommentMutation') return wrap({ data: { comment_create: { comment: { id: 'comment.1' } } } });
        if (form.fb_api_req_friendly_name === 'FriendingCometFriendRequestSendMutation') return wrap({ data: { friend_request_send: { friend_requestees: [{ id: variables.input.friend_requestee_ids[0], friendship_status: 'OUTGOING_REQUEST' }] } } });
        if (form.fb_api_req_friendly_name.includes('Joined')) return wrap({ data: { group: { __typename: 'Group', id: '99999', name: 'Test group' } } });
        return wrap({ data: { story: { post_id: '88888', creation_time: 1792163051, message: { text: 'Hello' }, actors: [{ id: '67890', name: 'Test author' }] } } });
      },
      dispose: async () => { closed++; },
    };
  });
  const collector = new FacebookCollector({ dataDir: dir, scanMode: 'api', browserless: true, apiMinDelayMs: 0, apiMaxDelayMs: 0, log: () => {} });
  try {
    await collector.validateSessions([42]);
    await assert.rejects(collector.validateSessions([99]), /Chưa có phiên HTTP/);
    const posts = await collector.collect(42, 'https://www.facebook.com/groups/99999', null, { latest: true });
    assert.equal(posts[0].id, '88888');
    assert.equal((await collector.joinedGroups(42)).groups.length, 1);
    assert.equal((await collector.comment(42, 'https://www.facebook.com/groups/99999/posts/88888', 'Hello')).id, 'comment.1');
    assert.equal((await collector.friendRequest(42, 'https://www.facebook.com/profile.php?id=67890')).state, 'sent');
    assert.equal((await collector.directMessage(42, 'https://www.facebook.com/profile.php?id=67890', 'Hello')).success, true);
    const count = calls;
    await assert.rejects(collector.comment(42, 'https://www.facebook.com/groups/99999/posts/88888', 'Cancelled', () => false), /Đã hủy/);
    assert.equal(calls, count);
    await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/slug'), /HTTP-only/);
    const aliases = [];
    assert.equal((await collector.collect(42, 'https://www.facebook.com/groups/named', null, { latest: true, onGroupId: id => aliases.push(id) }))[0].id, '88888');
    assert.deepEqual(aliases, ['77777']);
    await assert.rejects(collector.collectCommentContacts(42, 'https://www.facebook.com/groups/99999/posts/88888'), {code:'NO_COMMENTS'});
    fail = true;
    await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/99999'), /GraphQL/);
    assert.equal(launches, 0);
    assert.equal(disposed, calls);
  } finally { await collector.close(); await rm(dir, { recursive: true, force: true }); }
  assert.equal(closed, 1);
});

test('mutation uncertainty is not retried and wrong recipients are rejected', async () => {
  let calls = 0;
  const options = { session: { form: { __user: '12345' }, headers: {} }, kind: 'friend', target: '67890',
    request: { post: async () => { calls++; return response({ data: { friend_request_send: { friend_requestees: [{ id: '99999', friendship_status: 'OUTGOING_REQUEST' }] } } }); } } };
  await assert.rejects(submitHttpAction(options), /chưa trả xác nhận/);
  assert.equal(calls, 1);
  options.request.post = async () => { calls++; throw new Error('timeout'); };
  await assert.rejects(submitHttpAction(options), /chưa xác nhận/);
  assert.equal(calls, 2);
});

test('a confirmed mutation succeeds despite non-fatal errors; errors without confirmation are reported', async () => {
  const confirmed = { data: { comment_create: { comment: { id: 'comment.7' } } }, errors: [{ message: 'Field warning', severity: 'WARNING' }] };
  const options = { session: { form: { __user: '12345' }, headers: {} }, kind: 'comment', target: '88888', text: 'Hi',
    request: { post: async () => response(confirmed) } };
  assert.equal((await submitHttpAction(options)).id, 'comment.7');
  options.request.post = async () => response({ data: { comment_create: { feedback_comment_edge: { node: { id: 'comment.8' } } } } });
  assert.equal((await submitHttpAction(options)).id, 'comment.8');
  const missing = { message: 'A server error missing_required_variable_value occured. Check server logs for details.' };
  options.request.post = async () => response({ data: { comment_create: null }, errors: [missing, missing] });
  assert.match((await submitHttpAction(options)).note, /đã nhận bình luận/);
  options.request.post = async () => response({ data: { comment_create: null }, errors: [missing, { summary: 'Không thể bình luận' }] });
  await assert.rejects(submitHttpAction(options), /không xác nhận thao tác API/);
  options.request.post = async () => response({ data: { comment_create: null }, errors: [{ summary: 'Không thể bình luận' }] });
  await assert.rejects(submitHttpAction(options), /không xác nhận thao tác API \(Không thể bình luận\)/);
});

test('login imports cookies without launching Chromium', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'http-login-'));
  t.mock.method(chromium, 'launchPersistentContext', () => { throw new Error('Must not launch'); });
  const old = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const input = path.join(dir, 'import.json');
    await writeFile(input, JSON.stringify(cookies));
    await login(['--user-id', '42', '--cookies-file', input]);
    assert.equal(JSON.parse(await readFile(sessionFile(dir, 42), 'utf8')).cookies.length, 2);
  } finally {
    if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP-only reports a logged-out session once per window instead of a missing template', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'http-only-out-'));
  const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  const filename = sessionFile(dir, 42);
  await mkdir(path.dirname(filename));
  await writeFile(filename, JSON.stringify({ cookies, userAgent: agent }));
  let gets = 0, sentAgent;
  t.mock.method(request, 'newContext', async options => {
    sentAgent = options.userAgent;
    return { get: async () => { gets++; return { ...response('<script>["DTSGInitialData",[],{},258]{"USER_ID":"0"}</script><input name="pass">'), dispose: async () => {} }; },
      post: async () => { throw new Error('no GraphQL without a session'); }, dispose: async () => {} };
  });
  const logs = [];
  const collector = new FacebookCollector({ dataDir: dir, scanMode: 'api', browserless: true, apiMinDelayMs: 0, apiMaxDelayMs: 0, log: line => logs.push(line) });
  try {
    await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/99999', null, { latest: true }), /đã bị đăng xuất/);
    assert.ok(logs.some(line => /^\[API \| Tài khoản 42\] GET \/ → HTTP 200 \(\d+ ms, \d+ KB\)$/.test(line)), logs.join('\n'));
    assert.ok(!/test-only|c_user/.test(logs.join('\n')));
    await assert.rejects(collector.collect(42, 'https://www.facebook.com/groups/slug', null, { latest: true }), /đã bị đăng xuất/);
    assert.equal(gets, 1);
    assert.equal(sentAgent, agent);
  } finally { await collector.close(); await rm(dir, { recursive: true, force: true }); }
});
