import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { directMessageText, renderDirectMessage, profileIdOrUsername, sendDirectMessage, isAnonymousAuthor } from '../src/direct-messages.js';

test('directMessageText validates message bounds', () => {
  assert.equal(directMessageText('  Xin chào bạn  '), 'Xin chào bạn');
  assert.throws(() => directMessageText(''), /từ 1 đến 2000 ký tự/);
  assert.throws(() => directMessageText('   '), /từ 1 đến 2000 ký tự/);
  assert.throws(() => directMessageText('a'.repeat(2001)), /từ 1 đến 2000 ký tự/);
});

test('renderDirectMessage substitutes template variables', () => {
  const template = 'Chào {name}, mình quan tâm bài viết #{id} của bạn: {link}';
  const post = { id: '999', url: 'https://www.facebook.com/groups/123/posts/999' };
  const rendered = renderDirectMessage(template, { name: 'Nguyễn Văn A', post });
  assert.equal(rendered, 'Chào Nguyễn Văn A, mình quan tâm bài viết #999 của bạn: https://www.facebook.com/groups/123/posts/999');

  // Test fallback when name is absent
  assert.equal(renderDirectMessage('Chào {tên}', {}), 'Chào bạn');
});

test('profileIdOrUsername extracts profile ID or username', () => {
  assert.equal(profileIdOrUsername('https://www.facebook.com/profile.php?id=100012345678'), '100012345678');
  assert.equal(profileIdOrUsername('https://www.facebook.com/alice.smith'), 'alice.smith');
  assert.equal(profileIdOrUsername('https://www.facebook.com/groups/123/user/456/'), '456');
  assert.equal(profileIdOrUsername('https://www.facebook.com/groups/123'), null);
});

test('isAnonymousAuthor identifies anonymous author variants', () => {
  assert.equal(isAnonymousAuthor('Người tham gia ẩn danh'), true);
  assert.equal(isAnonymousAuthor('Thành viên ẩn danh'), true);
  assert.equal(isAnonymousAuthor('Người đóng góp ẩn danh'), true);
  assert.equal(isAnonymousAuthor('Anonymous participant'), true);
  assert.equal(isAnonymousAuthor('Anonymous member'), true);
  assert.equal(isAnonymousAuthor('Hà Phan'), false);
  assert.equal(isAnonymousAuthor('Nguyễn Văn A'), false);
  assert.equal(isAnonymousAuthor(null), true);
});

function setupStore(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureUser(1, 1);
  const group = store.addGroup(1, 'https://www.facebook.com/groups/123/').group;
  store.prepare('UPDATE groups SET initialized=1 WHERE id=?').run(group.id);
  return { store, group };
}

test('opening messages deduplicate across posts and sources, isolate owners, and guard old queued jobs', t => {
  const { store, group } = setupStore(t);
  store.ensureUser(2, 2);
  const second = store.addGroup(1, 'https://www.facebook.com/groups/456/').group;
  const otherOwner = store.addGroup(2, 'https://www.facebook.com/groups/123/').group;
  const recipient = 'https://www.facebook.com/profile.php?id=888';
  for (const source of [group, second, otherOwner]) {
    store.observe(source, [{id:'10',url:`${source.url}posts/10`,author:'Bình',authorUrl:recipient,text:'Hello'}],
      {now:5000,metricWindowMs:86400000,render:()=>'',matches:()=>true});
  }
  assert.equal(store.queueDirectMessage(1,group.id,'10','Opening').queued,1);
  for (const state of ['pending','sending','sent','uncertain']) {
    const first = store.listDirectMessages(1)[0];
    store.directMessageState(first.id,state);
    assert.equal(store.enqueueDirectMessage(second.id,'10',recipient,'Bình','Different text','auto',5000),0);
    assert.throws(()=>store.queueDirectMessage(1,second.id,'10','Manual text'),/Chỉ gửi tin mở đầu/);
  }
  assert.equal(store.queueDirectMessage(2,otherOwner.id,'10','Independent opening').queued,1);
  assert.equal(store.canDirectMessage(store.nextDirectMessage([2])),true);

  const first = store.listDirectMessages(1)[0];
  store.directMessageState(first.id,'failed');
  assert.equal(store.queueDirectMessage(1,second.id,'10','Retry known failure').queued,1);
  const secondJob = store.nextDirectMessage([1]);
  assert.equal(store.canDirectMessage(secondJob),true);
  // Simulate a duplicate left in the database by an older version.
  store.directMessageState(first.id,'pending');
  assert.equal(store.canDirectMessage(secondJob),false);
  const earliest = store.nextDirectMessage([1]);
  assert.equal(store.canDirectMessage(earliest),true);
  store.directMessageState(earliest.id,'sending');
  assert.equal(store.canDirectMessage(earliest),true);
  assert.equal(store.canDirectMessage(secondJob),false);
});

test('store manages autoInbox and direct_messages lifecycle', t => {
  const { store, group } = setupStore(t);
  const now = 100000;

  // Set and clear autoInbox
  store.setAutoInbox(1, group.id, 'Chào {name}', now);
  assert.equal(store.getGroup(group.id).autoInbox, 'Chào {name}');
  assert.equal(store.getGroup(group.id).autoInboxSince, now);

  // Observe post with author
  const post = {
    id: '10',
    url: 'https://www.facebook.com/groups/123/posts/10',
    author: 'Trần Bình',
    authorUrl: 'https://www.facebook.com/profile.php?id=888',
    text: 'Cần bán máy tính',
    publishedAt: new Date(now + 1000).toISOString()
  };
  store.observe(group, [post], { now: now + 2000, metricWindowMs: 86400000, render: () => '', matches: () => true });

  const messages = store.listDirectMessages(1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].recipient_name, 'Trần Bình');
  assert.equal(messages[0].recipient_url, 'https://www.facebook.com/profile.php?id=888');
  assert.equal(messages[0].body, 'Chào Trần Bình');
  assert.equal(messages[0].source, 'auto');
  assert.equal(messages[0].state, 'pending');

  // Next direct message retrieval
  const next = store.nextDirectMessage([1]);
  assert.ok(next);
  assert.equal(next.id, messages[0].id);

  // Mark sent and verify no cooldown — next message is immediately available
  store.directMessageState(next.id, 'sent', null, now + 3000);
  const immediate = store.nextDirectMessage([1]);
  assert.equal(immediate, undefined); // No more pending messages

  // Manual messages must not open the same conversation again with different text.
  assert.throws(() => store.queueDirectMessage(1, group.id, '10', 'Tin nhắn thủ công'), /Chỉ gửi tin mở đầu/);
  store.cancelDirectMessages(1, group.id);
  assert.equal(store.listDirectMessages(1)[0].state, 'sent');
});

test('anonymous posts or posts without authorUrl cannot be queued for direct messaging', t => {
  const { store, group } = setupStore(t);
  const now = Date.now();
  const anonPost = {
    id: '20',
    url: 'https://www.facebook.com/groups/123/posts/20',
    author: 'Người tham gia ẩn danh',
    authorUrl: null,
    text: 'Bài ẩn danh'
  };
  store.observe(group, [anonPost], { now, metricWindowMs: 86400000, render: () => '', matches: () => true });

  assert.throws(() => {
    store.queueDirectMessage(1, group.id, '20', 'Chào bạn');
  }, /ẩn danh hoặc không xác định/);
});

test('bot direct message commands and callback handlers work correctly', async t => {
  const { store, group } = setupStore(t);

  const post = {
    id: '10',
    url: 'https://www.facebook.com/groups/123/posts/10',
    author: 'Lê Cường',
    authorUrl: 'https://www.facebook.com/profile.php?id=999',
    text: 'Cần tìm đối tác'
  };
  store.observe(group, [post], { now: 5000, metricWindowMs: 86400000, render: () => '', matches: () => true });
  store.mapMessage(1, 1, 88, group.id, '10');

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

  // Test /autoinbox command
  await send(`/autoinbox ${group.id} Xin chào {name}`);
  assert.equal(store.getGroup(group.id).autoInbox, 'Xin chào {name}');

  // Test /autoinbox off
  await send(`/autoinbox ${group.id} off`);
  assert.equal(store.getGroup(group.id).autoInbox, null);

  // Test /inbox manual command
  await send(`/inbox ${group.id} 10 | Chào Cường nhé`);
  const list = store.listDirectMessages(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].body, 'Chào Cường nhé');
  assert.equal(list[0].recipient_name, 'Lê Cường');

  // Test /inboxes status command
  await send('/inboxes');
  assert.ok(replies.some(r => r && r.includes('Lê Cường')));

  // Test /cancelinbox
  await send(`/cancelinbox ${group.id}`);
  assert.equal(store.listDirectMessages(1)[0].state, 'cancelled');

  // Test post:inbox button callback
  await bot.handleUpdate({
    update_id: Math.floor(Math.random() * 100000),
    callback_query: {
      id: 'cb1',
      from: { id: 1, is_bot: false, first_name: 'user' },
      message: { message_id: 88, chat: { id: 1, type: 'private' } },
      data: 'post:inbox'
    }
  });
  // Reply to the mapped inbox prompt
  await send('Nội dung qua reply', 200);
  const updatedList = store.listDirectMessages(1);
  assert.equal(updatedList[0].body, 'Nội dung qua reply');
});

test('sendDirectMessage attempts call when callAfter is enabled and handles missing call button gracefully', async () => {
  let typedText = '';
  const makeNode = (visible = true) => ({
    isVisible: async () => visible,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    innerText: async () => typedText,
    getAttribute: async () => null,
    waitFor: async () => {},
    evaluate: async (fn, ...args) => {
      if (args.length > 0 && typeof args[0] === 'string') typedText = args[0];
      return true;
    },
    locator: sel => makeLocator(sel),
  });

  const makeLocator = (selector, visible = true) => ({
    count: async () => (visible ? 1 : 0),
    nth: () => makeNode(visible),
    first: () => makeNode(visible),
    isVisible: async () => visible,
    locator: sel => makeLocator(sel, visible),
  });

  const fakePage = {
    url: () => 'https://www.facebook.com/profile.php?id=888',
    goto: async () => {},
    innerText: async () => 'Trang cá nhân',
    waitForTimeout: async () => {},
    keyboard: {
      press: async key => {
        if (key === 'Enter') typedText = '';
      },
      type: async text => { typedText = text; },
      insertText: async text => { typedText = text; },
    },
    locator: selector => {
      if (selector.includes('textbox') || selector.includes('contenteditable') || selector.includes('Tin nhắn') || selector.includes('ChatTab')) {
        return makeLocator(selector, true);
      }
      return makeLocator(selector, false);
    }
  };

  const res = await sendDirectMessage(
    fakePage,
    'https://www.facebook.com/profile.php?id=888',
    'Chào bạn',
    () => true,
    { callAfter: true }
  );

  assert.equal(res.success, true);
  assert.equal(res.called, false);
  assert.match(res.callNote, /Nút gọi bị ẩn/);
});

test('auto direct messages and auto comments do not send duplicates to the same author or post', t => {
  const { store, group } = setupStore(t);
  const now = 100000;

  store.setAutoReply(1, group.id, 'Cảm ơn {name}', now);
  store.setAutoInbox(1, group.id, 'Chào {name}', now);

  const post1 = {
    id: '101',
    url: 'https://www.facebook.com/groups/123/posts/101',
    author: 'Nguyễn Văn A',
    authorUrl: 'https://www.facebook.com/profile.php?id=999',
    text: 'Cần hỗ trợ 1',
    publishedAt: new Date(now + 1000).toISOString()
  };

  // First post: both comment and DM should be queued
  store.observe(group, [post1], { now: now + 2000, metricWindowMs: 86400000, render: () => '', matches: () => true });

  const dms1 = store.listDirectMessages(1);
  assert.equal(dms1.length, 1);
  assert.equal(dms1[0].recipient_url, 'https://www.facebook.com/profile.php?id=999');

  const comments1 = store.prepare("SELECT * FROM comments WHERE group_id=? AND post_id='101'").all(group.id);
  assert.equal(comments1.length, 1);

  // Mark both as sent
  store.directMessageState(dms1[0].id, 'sent', null, now + 3000);
  store.commentState(comments1[0].id, 'sent');

  // Second post by the SAME author:
  const post2 = {
    id: '102',
    url: 'https://www.facebook.com/groups/123/posts/102',
    author: 'Nguyễn Văn A',
    authorUrl: 'https://www.facebook.com/profile.php?id=999',
    text: 'Cần hỗ trợ 2',
    publishedAt: new Date(now + 4000).toISOString()
  };

  store.observe(group, [post2], { now: now + 5000, metricWindowMs: 86400000, render: () => '', matches: () => true });

  // Post 2 should get a comment, but NO new direct message for Nguyễn Văn A!
  const dms2 = store.listDirectMessages(1);
  assert.equal(dms2.length, 1); // Still only 1 DM in total

  const comments2 = store.prepare("SELECT * FROM comments WHERE group_id=? AND post_id='102'").all(group.id);
  assert.equal(comments2.length, 1); // Post 102 gets its own comment

  // Re-observing post 1 does not add duplicate comment or DM
  store.observe(group, [post1], { now: now + 6000, metricWindowMs: 86400000, render: () => '', matches: () => true });
  const allComments1 = store.prepare("SELECT * FROM comments WHERE group_id=? AND post_id='101'").all(group.id);
  assert.equal(allComments1.length, 1);
});

test('resolveRecipientFbid extracts numeric FBID from profile URL or scripts', async () => {
  const { resolveRecipientFbid } = await import('../src/direct-messages.js');
  const mockPage = {
    evaluate: async () => '100099887766'
  };
  assert.equal(await resolveRecipientFbid(mockPage, 'https://www.facebook.com/profile.php?id=100099887766'), '100099887766');
  assert.equal(await resolveRecipientFbid(mockPage, 'https://www.facebook.com/alice.smith'), '100099887766');
});

test('sendDirectMessageAPI sends payload via simulated Facebook API endpoint', async () => {
  const { sendDirectMessageAPI } = await import('../src/direct-messages.js');
  let evaluatedPayload = null;
  const mockPage = {
    evaluate: async (fn, args) => {
      evaluatedPayload = args;
      return { ok: true, data: { payload: { success: true } } };
    }
  };

  const result = await sendDirectMessageAPI(mockPage, '100099887766', 'Xin chào bạn', () => true);
  assert.deepEqual(result, { payload: { success: true } });
  assert.equal(evaluatedPayload.recipientId, '100099887766');
  assert.equal(evaluatedPayload.text, 'Xin chào bạn');
});

test('sendDirectMessageAPI returns {ok:false,error} instead of null when evaluate reports failure', async () => {
  const { sendDirectMessageAPI } = await import('../src/direct-messages.js');
  const failing = { evaluate: async () => ({ ok: false, error: 'Không lấy được doc_id GraphQL gửi tin nhắn từ trang Facebook.' }) };
  assert.deepEqual(await sendDirectMessageAPI(failing, '100099887766', 'Hi'), { ok: false, error: 'Không lấy được doc_id GraphQL gửi tin nhắn từ trang Facebook.' });
  // An aborted evaluate may have already sent the POST: uncertain, never {ok:false}.
  const throwing = { evaluate: async () => { throw new Error('boom'); } };
  await assert.rejects(sendDirectMessageAPI(throwing, '100099887766', 'Hi'), error => error.commentSubmitted === true && /chưa xác nhận.*boom/.test(error.message));
});

test('sendDirectMessage treats API {ok:false} as failure and reports the reason in the final error', async () => {
  const hidden = () => ({ count: async () => 0, nth: () => hidden(), first: () => hidden(), isVisible: async () => false, waitFor: async () => { throw new Error('hidden'); }, evaluate: async () => null, locator: () => hidden() });
  const makePage = evaluate => ({
    url: () => 'https://www.facebook.com/profile.php?id=888',
    goto: async () => {},
    innerText: async () => 'Trang cá nhân',
    waitForTimeout: async () => {},
    evaluate,
    locator: () => hidden(),
  });
  const profile = 'https://www.facebook.com/profile.php?id=888';

  await assert.rejects(
    sendDirectMessage(makePage(async () => ({ ok: false, error: 'DOC_ID_MISSING' })), profile, 'Chào', () => true, { callAfter: false }),
    error => error.commentSubmitted === false && /Không tìm thấy ô nhập tin nhắn.*\[API: DOC_ID_MISSING\]/.test(error.message)
  );
  await assert.rejects(sendDirectMessage(makePage(async () => null), profile, 'Chào', () => false, { callAfter: false }),
    error => error.commentSubmitted === false && /Đã hủy/.test(error.message));

  // A dispatched but unconfirmed send stops before the Messenger UI.
  let ui = false;
  const sentPage = { ...makePage(async () => ({ ok: false, sent: true, uncertain: true, error: 'no ack' })), locator: () => { ui = true; return hidden(); } };
  await assert.rejects(sendDirectMessage(sentPage, profile, 'Chào', () => true, { callAfter: false }), error => error.commentSubmitted === true);
  assert.equal(ui, false);

  const ok = await sendDirectMessage(makePage(async () => ({ ok: true, data: { payload: {} } })), profile, 'Chào', () => true, { callAfter: false });
  assert.equal(ok.success, true);
  assert.equal(ok.called, false);
});

test('missedCall rings in the call popup then closes it', async () => {
  const { missedCall } = await import('../src/direct-messages.js');
  let rang = false, popupClosed = false, ended = false;
  const node = (visible, onClick = () => {}) => ({
    isVisible: async () => visible, click: async () => onClick(), getAttribute: async () => null,
  });
  const list = (visible, onClick) => ({ count: async () => (visible ? 1 : 0), nth: () => node(visible, onClick) });
  const popup = {
    locator: sel => list(sel.includes('Kết thúc cuộc gọi'), () => { ended = true; }),
    close: async () => { popupClosed = true; },
  };
  const page = {
    waitForTimeout: async () => {},
    waitForEvent: async () => popup,
    locator: sel => list(sel.includes('cuộc gọi thoại'), () => { rang = true; }),
  };
  assert.deepEqual(await missedCall(page), { called: true, callNote: null });
  assert.equal(rang && ended && popupClosed, true);

  const hidden = { ...page, locator: sel => list(false) };
  assert.equal((await missedCall(hidden)).called, false);
});
