import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { sendFriendRequestAPI } from '../src/friends.js';
import { sendDirectMessageAPI } from '../src/direct-messages.js';
import { submitComment, submitCommentGraphQL } from '../src/comments.js';

function pageWithResponse(respond) {
  return {
    evaluate: async (fn, args) => runInNewContext(`(${fn.toString()})(args)`, {
      args, URLSearchParams, setTimeout, btoa,
      window: { DTSGInitialData: { token: 'test' }, require: () => '123456' },
      document: { cookie: 'c_user=12345', scripts: [] },
      fetch: async (url, options) => {
        const response = respond(url, new URLSearchParams(options.body));
        return { ok: response.status !== 500, status: response.status || 200,
          text: async () => response.raw ?? JSON.stringify(response.body) };
      },
    }),
  };
}

const sentUnconfirmed = error => error.commentSubmitted === true && /chưa xác nhận/.test(error.message);

test('friend API requires confirmed status for the requested recipient', async () => {
  for (const payload of [{}, { friend_requestees: [{ id: '999', friendship_status: 'OUTGOING_REQUEST' }] }]) {
    await assert.rejects(sendFriendRequestAPI(pageWithResponse(() => ({ body: { data: { friend_request_send: payload } } })), '67890'), sentUnconfirmed);
  }
  await assert.rejects(sendFriendRequestAPI(pageWithResponse(() => ({ body: { data: { friend_request_send: {
    friend_requestees: [{ id: '67890', friendship_status: 'CAN_REQUEST' }] } } } })), '67890'), error => error.commentSubmitted === false);
  await assert.rejects(sendFriendRequestAPI(pageWithResponse(() => ({ raw: '<html>' })), '67890'), sentUnconfirmed);
  const result = await sendFriendRequestAPI(pageWithResponse(() => ({ body: { data: {
    friend_request_send: { friend_requestees: [{ id: '67890', friendship_status: 'OUTGOING_REQUEST' }] },
  } } })), '67890');
  assert.equal(result.ok, true);
});

test('message API never resends an unconfirmed message through another endpoint', async () => {
  const urls = [];
  const page = pageWithResponse(url => (urls.push(url), { body: { payload: {}, data: { viewer: { id: '12345' } } } }));
  await assert.rejects(sendDirectMessageAPI(page, '67890', 'Hello'), sentUnconfirmed);
  await assert.rejects(sendDirectMessageAPI(pageWithResponse(url => (urls.push(url), { raw: 'for (;;);<html>' })), '67890', 'Hello'), sentUnconfirmed);
  assert.deepEqual(urls, ['/messaging/send/', '/messaging/send/']);
});

test('message API tries GraphQL only after messaging/send explicitly rejects', async () => {
  const urls = [];
  const result = await sendDirectMessageAPI(pageWithResponse(url => (urls.push(url), url === '/messaging/send/'
    ? { raw: 'for (;;);{"error":1545012,"errorSummary":"Rejected"}' }
    : { raw: '{"data":{"message_send":{"message":{"id":"mid.1"}}}}\n{"extensions":{}}' })), '67890', 'Hello');
  assert.equal(result.data.message_send.message.id, 'mid.1');
  assert.deepEqual(urls, ['/messaging/send/', '/api/graphql/']);
  await assert.rejects(sendDirectMessageAPI(pageWithResponse(url => url === '/messaging/send/'
    ? { body: { error: 1, errorSummary: 'Rejected' } } : { body: { errors: [{ message: 'Denied' }] } }), '67890', 'Hello'),
  error => error.commentSubmitted === false && /Denied/.test(error.message));
});

test('message API accepts acknowledgment matching the outgoing message', async () => {
  const result = await sendDirectMessageAPI(pageWithResponse((url, form) => ({ raw: `for (;;);\n${JSON.stringify({ payload: { actions: [{
    message_id: 'mid.confirmed', offline_threading_id: form.get('offline_threading_id'),
  }] } })}\n{"extensions":{}}` })), '67890', 'Hello');
  assert.equal(result.payload.actions[0].message_id, 'mid.confirmed');
});

test('comment API handles prefixed stream and requires a comment ID', async () => {
  const post = { id: '98765' };
  const result = await submitCommentGraphQL(pageWithResponse(() => ({ raw: 'for (;;);\n{"data":{"comment_create":{"comment":{"id":"comment.1"}}}}\n{"extensions":{}}' })), post, 'Hello');
  assert.equal(result.id, 'comment.1');
  await assert.rejects(submitCommentGraphQL(pageWithResponse(() => ({ body: { data: { comment_create: {} } } })), post, 'Hello'),
    error => error.commentSubmitted === true && /không phản hồi/.test(error.message));
  await assert.rejects(submitCommentGraphQL(pageWithResponse(() => ({ status: 500, body: { data: { comment_create: { comment: { id: 'fake' } } } } })), post, 'Hello'), sentUnconfirmed);
});

test('submitComment does not retype a dispatched API comment in the UI', async () => {
  let ui = false;
  const page = { ...pageWithResponse(() => ({ raw: '<html>not json' })), locator: () => { ui = true; throw new Error('UI used'); } };
  await assert.rejects(submitComment(page, { id: '98765' }, 'Hello'), sentUnconfirmed);
  assert.equal(ui, false);
  const aborted = { evaluate: async (fn, args) => { if (args) throw new Error('Execution context was destroyed'); return { dtsg: 'test', cUser: '12345' }; },
    locator: () => { ui = true; throw new Error('UI used'); } };
  await assert.rejects(submitComment(aborted, { id: '98765' }, 'Hello'), sentUnconfirmed);
  assert.equal(ui, false);
});
