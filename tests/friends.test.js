import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { sendFriendRequest, sendFriendRequestAPI, profileFriendState, FRIEND_LABELS } from '../src/friends.js';
import { isAnonymousAuthor } from '../src/direct-messages.js';

test('sendFriendRequestAPI validates recipient ID format', async () => {
  assert.equal(await sendFriendRequestAPI(null, null), null);
  assert.equal(await sendFriendRequestAPI(null, 'abc'), null);
});

test('sendFriendRequestAPI handles simulated GraphQL responses', async () => {
  const fakePageSuccess = {
    evaluate: async () => ({ ok: true, data: { friend_request_send: { client_mutation_id: '1' } } })
  };
  const resSuccess = await sendFriendRequestAPI(fakePageSuccess, '100012345678');
  assert.equal(resSuccess.ok, true);

  const fakePageAlready = {
    evaluate: async () => ({ ok: true, state: 'already_friends', note: 'Đã gửi lời mời từ trước' })
  };
  const resAlready = await sendFriendRequestAPI(fakePageAlready, '100012345678');
  assert.equal(resAlready.state, 'already_friends');
});

test('sendFriendRequest rejects invalid author URLs and anonymous authors', async () => {
  const fakePage = {};
  await assert.rejects(
    () => sendFriendRequest(fakePage, 'https://www.facebook.com/groups/123'),
    /Link trang cá nhân không hợp lệ/
  );
  await assert.rejects(
    () => sendFriendRequest(fakePage, 'https://www.facebook.com/groups/123/posts/456'),
    /Link trang cá nhân không hợp lệ/
  );
  assert.equal(isAnonymousAuthor('Người tham gia ẩn danh'), true);
});

// states: sequence of header states returned by successive profileFriendState calls.
function fakeProfile(states, { visible = () => false, api = null } = {}) {
  const clicks = [];
  let index = 0;
  const node = sel => ({
    isVisible: async () => visible(sel),
    click: async () => { clicks.push(sel); },
    waitFor: async () => {},
    innerText: async () => '',
  });
  return {
    clicks,
    url: () => 'https://www.facebook.com/profile.php?id=123',
    innerText: async () => '',
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      if (fn === profileFriendState) {
        const state = states[Math.min(index++, states.length - 1)];
        return { state };
      }
      return api?.(arg);
    },
    locator: sel => ({ first: () => node(sel) }),
  };
}

test('profileFriendState matches exact labels in the profile header only', () => {
  const button = (label, extra = {}) => ({
    getAttribute: name => (name === 'aria-label' ? label : null),
    removeAttribute() {}, setAttribute(name, value) { this.marked = value; },
    closest: () => extra.inArticle ? {} : null,
    getClientRects: () => [1],
    compareDocumentPosition: () => extra.afterTabs ? 0 : 4,
    innerText: label,
  });
  const run = buttons => {
    const main = { querySelector: () => ({}), querySelectorAll: () => buttons };
    globalThis.document = { querySelector: () => main, querySelectorAll: () => [] };
    globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
    try { return profileFriendState(FRIEND_LABELS); }
    finally { delete globalThis.document; delete globalThis.Node; }
  };
  assert.equal(run([button('Thêm bạn bè'), button('Nhắn tin')]).state, 'add');
  assert.equal(run([button('Phản hồi', { inArticle: true }), button('Thêm bạn bè')]).state, 'add');
  assert.equal(run([button('Nhắn tin'), button('Thêm bạn bè', { afterTabs: true })]).state, 'unknown');
  assert.equal(run([button('Bạn bè'), button('Nhắn tin')]).state, 'friends');
});

test('sendFriendRequest detects DOM states correctly', async () => {
  const profile = 'https://www.facebook.com/profile.php?id=123';

  assert.equal((await sendFriendRequest(fakeProfile(['friends']), profile)).state, 'already_friends');
  assert.equal((await sendFriendRequest(fakeProfile(['requested']), profile)).state, 'already_requested');

  const pageRespond = fakeProfile(['incoming'], { visible: sel => sel.includes('Xác nhận') });
  assert.equal((await sendFriendRequest(pageRespond, profile)).state, 'accepted');
  await assert.rejects(() => sendFriendRequest(fakeProfile(['incoming']), profile), error => error.commentSubmitted === false && /không tìm thấy nút Xác nhận/.test(error.message));

  // Add friend click is verified by the header switching to a pending request.
  const pageAdd = fakeProfile(['add', 'requested']);
  assert.equal((await sendFriendRequest(pageAdd, profile)).state, 'sent');
  assert.ok(pageAdd.clicks.some(sel => sel.includes('data-bot-friend-action')));

  // API is tried before the header button; success needs no click at all.
  const pageApi = fakeProfile(['add'], { api: () => ({ ok: true, data: { friend_request_send: {} } }) });
  assert.equal((await sendFriendRequest(pageApi, profile)).state, 'sent');
  assert.equal(pageApi.clicks.length, 0);

  // The final error carries the API failure reason.
  await assert.rejects(
    () => sendFriendRequest(fakeProfile(['unknown'], { api: () => ({ ok: false, error: 'doc_id lỗi' }) }), profile),
    /\[API: doc_id lỗi\]/
  );

  await assert.rejects(
    () => sendFriendRequest(fakeProfile(['self']), profile),
    /chính tài khoản Facebook của bot/
  );

  // Unknown header: API failure falls back to the "..." menu.
  const pageMenu = fakeProfile(['unknown'], {
    visible: sel => sel.includes('Xem thêm') || sel.includes('menuitem'),
    api: () => ({ ok: false, error: 'The GraphQL document with ID 5729177243869288 was not found.' }),
  });
  assert.equal((await sendFriendRequest(pageMenu, profile)).state, 'sent');
  assert.ok(pageMenu.clicks.some(sel => sel.includes('menuitem')));

  // A dispatched API request is never repeated through the profile button.
  const pageSent = fakeProfile(['add'], { api: () => ({ ok: false, sent: true, uncertain: true, error: 'no ack' }) });
  await assert.rejects(() => sendFriendRequest(pageSent, profile), error => error.commentSubmitted === true && /chưa xác nhận/.test(error.message));
  assert.equal(pageSent.clicks.length, 0);
  const pageRejected = fakeProfile(['add'], { api: () => ({ ok: false, sent: true, error: 'Denied' }) });
  await assert.rejects(() => sendFriendRequest(pageRejected, profile), error => error.commentSubmitted === false && /Denied/.test(error.message));
  assert.equal(pageRejected.clicks.length, 0);

  await assert.rejects(
    () => sendFriendRequest(fakeProfile(['unknown'], { api: () => null }), profile),
    error => error.commentSubmitted === false && /Không tìm thấy nút Thêm bạn bè/.test(error.message)
  );
});

import { postButtons } from '../src/post-buttons.js';
test('postButtons disables profile and friend buttons for anonymous authors', () => {
  const normalPost = {
    url: 'https://www.facebook.com/groups/123/posts/1',
    author: 'Nguyễn Văn A',
    authorUrl: 'https://www.facebook.com/profile.php?id=100'
  };
  const normalBtns = postButtons(normalPost);
  const friendBtn = normalBtns.inline_keyboard.flat().find(b => b.text === '🤝 Kết bạn');
  assert.equal(friendBtn.callback_data, 'post:friend');

  const anonPost = {
    url: 'https://www.facebook.com/groups/123/posts/2',
    author: 'Người tham gia ẩn danh',
    authorUrl: 'https://www.facebook.com/profile.php?id=999'
  };
  const anonBtns = postButtons(anonPost);
  const anonFriendBtn = anonBtns.inline_keyboard.flat().find(b => b.text === '🤝 Kết bạn');
  assert.equal(anonFriendBtn.callback_data, 'post:no-profile-friend');
});

function setupStore(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureUser(1, 1);
  const group = store.addGroup(1, 'https://www.facebook.com/groups/123/').group;
  store.prepare('UPDATE groups SET initialized=1 WHERE id=?').run(group.id);
  return { store, group };
}

test('store manages autoFriend and friend_requests lifecycle', t => {
  const { store, group } = setupStore(t);
  const now = 100000;

  // Toggle autoFriend
  store.setAutoFriend(1, group.id, true, now);
  assert.equal(store.getGroup(group.id).autoFriend, true);
  assert.equal(store.getGroup(group.id).autoFriendSince, now);

  // Observe post with valid author
  const post = {
    id: '10',
    url: 'https://www.facebook.com/groups/123/posts/10',
    author: 'Nguyễn Văn Nam',
    authorUrl: 'https://www.facebook.com/profile.php?id=99999',
    text: 'Cần tìm đối tác kinh doanh',
    publishedAt: new Date(now + 1000).toISOString()
  };
  store.observe(group, [post], { now: now + 2000, metricWindowMs: 86400000, render: () => '', matches: () => true });

  const list = store.listFriendRequests(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].recipient_name, 'Nguyễn Văn Nam');
  assert.equal(list[0].recipient_url, 'https://www.facebook.com/profile.php?id=99999');
  assert.equal(list[0].source, 'auto');
  assert.equal(list[0].state, 'pending');

  // Retrieve nextFriendRequest
  const next = store.nextFriendRequest([1]);
  assert.ok(next);
  assert.equal(next.id, list[0].id);

  // Deduplication: observing another post with same author should not enqueue duplicate auto friend request
  const post2 = {
    id: '11',
    url: 'https://www.facebook.com/groups/123/posts/11',
    author: 'Nguyễn Văn Nam',
    authorUrl: 'https://www.facebook.com/profile.php?id=99999',
    text: 'Bài viết số 2 cùng tác giả',
    publishedAt: new Date(now + 3000).toISOString()
  };
  store.observe(group, [post2], { now: now + 4000, metricWindowMs: 86400000, render: () => '', matches: () => true });
  assert.equal(store.listFriendRequests(1).length, 1);

  // Update state to sent
  store.friendRequestState(next.id, 'sent', null, now + 5000);
  assert.equal(store.listFriendRequests(1)[0].state, 'sent');
  assert.equal(store.nextFriendRequest([1]), undefined);

  // Turning off autoFriend
  store.setAutoFriend(1, group.id, false);
  assert.equal(store.getGroup(group.id).autoFriend, false);

  // Manual friend request for another post
  const post3 = {
    id: '12',
    url: 'https://www.facebook.com/groups/123/posts/12',
    author: 'Lê Hoàng',
    authorUrl: 'https://www.facebook.com/profile.php?id=88888',
    text: 'Bài viết của Lê Hoàng',
    publishedAt: new Date(now + 1000).toISOString()
  };
  store.observe(group, [post3], { now: now + 2000, metricWindowMs: 86400000, render: () => '', matches: () => true });
  const manual = store.queueFriendRequest(1, group.id, '12', 'manual', now + 6000);
  assert.equal(manual.queued, 1);
  assert.equal(manual.recipientName, 'Lê Hoàng');

  const pendingManual = store.nextFriendRequest([1]);
  assert.ok(pendingManual);
  assert.equal(pendingManual.post_id, '12');

  // A request recorded as sent can be queued again manually.
  store.friendRequestState(pendingManual.id, 'sent', null, now + 7000);
  assert.equal(store.queueFriendRequest(1, group.id, '12', 'manual', now + 8000).queued, 1);
  assert.equal(store.nextFriendRequest([1]).post_id, '12');

  // Cancel friend requests
  store.cancelFriendRequests(1, group.id);
  assert.equal(store.listFriendRequests(1).find(r => r.post_id === '12').state, 'cancelled');
});

test('bot friend commands and button callback work correctly', async t => {
  const { store, group } = setupStore(t);
  const now = 200000;
  const post = {
    id: '50',
    url: 'https://www.facebook.com/groups/123/posts/50',
    author: 'Phạm Đức',
    authorUrl: 'https://www.facebook.com/profile.php?id=77777',
    text: 'Cần tuyển nhân viên',
    publishedAt: new Date(now).toISOString()
  };
  store.observe(group, [post], { now, metricWindowMs: 86400000, render: () => '', matches: () => true });

  const bot = createBot({ token: '123:test', allowedUserIds: [1], store });
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Bot', username: 'test_bot' };

  const replies = [];
  bot.api.config.use(async (_prev, _method, payload) => {
    replies.push(payload.text);
    return { ok: true, result: { message_id: 200 } };
  });

  const send = async (text, reply, owner = 1) => bot.handleUpdate({
    update_id: Math.floor(Math.random() * 100000),
    message: {
      message_id: 10,
      date: 0,
      chat: { id: owner, type: 'private' },
      from: { id: owner, is_bot: false, first_name: 'user' },
      text,
      ...(reply ? { reply_to_message: { message_id: reply } } : { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] })
    }
  });

  // Test /autofriend on
  await send(`/autofriend ${group.id} on`);
  assert.equal(store.getGroup(group.id).autoFriend, true);

  // Test /autofriend off
  await send(`/autofriend ${group.id} off`);
  assert.equal(store.getGroup(group.id).autoFriend, false);

  // Test /friend manual command
  await send(`/friend ${group.id} 50`);
  const list = store.listFriendRequests(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].recipient_name, 'Phạm Đức');
  assert.equal(list[0].state, 'pending');

  // Test /friends status command
  await send('/friends');
  assert.ok(replies.some(r => r && r.includes('Phạm Đức')));

  // Test /cancelfriend
  await send(`/cancelfriend ${group.id}`);
  assert.equal(store.listFriendRequests(1)[0].state, 'cancelled');

  // Test post:friend button callback
  store.mapMessage(1, 1, 99, group.id, '50');
  await bot.handleUpdate({
    update_id: Math.floor(Math.random() * 100000),
    callback_query: {
      id: 'cb_friend',
      from: { id: 1, is_bot: false, first_name: 'user' },
      message: { message_id: 99, chat: { id: 1, type: 'private' } },
      data: 'post:friend'
    }
  });
  const reList = store.listFriendRequests(1);
  assert.equal(reList[0].state, 'pending');
});
