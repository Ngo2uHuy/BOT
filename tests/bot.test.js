import test from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/bot.js";

function fixture({ maxFileBytes = 1024, getFile, collector, blockWaits, blockProgress } = {}) {
  const replies = [];
  const calls = [];
  const groups = [];
  let rejectedSince = null;
  const store = {
    ensureUser(ownerId, chatId) { calls.push(["ensureUser", ownerId, chatId]); },
    addGroup(ownerId, url) {
      const existing = groups.find((group) => group.ownerId === ownerId && group.url === url);
      if (existing) return { group: existing, created: false };
      const group = { id: groups.length + 1, ownerId, url, keywords: null };
      groups.push(group);
      return { group, created: true };
    },
    listGroups(ownerId) { return groups.filter((group) => group.ownerId === ownerId); },
    addJoinedGroup(ownerId,item) { return this.addGroup(ownerId,item.url); },
    addProfile(ownerId,url,mode) { calls.push(['addProfile',ownerId,url,mode]); return this.addGroup(ownerId,url); },
    removeGroup(ownerId, id) { calls.push(["removeGroup", ownerId, id]); },
    setPaused(ownerId, id, paused) { calls.push(["setPaused", ownerId, id, paused]); },
    setKeywords(ownerId, id, keywords) { calls.push(["setKeywords", ownerId, id, keywords]); },
    setRejectKeywords(ownerId, id, keywords) { calls.push(["setRejectKeywords", ownerId, id, keywords]); },
    setDateRange(ownerId, id, range) { calls.push(['setDateRange', ownerId, id, range]); },
    setRejectedNotify(ownerId, since) { calls.push(['setRejectedNotify', ownerId, since]); rejectedSince = since; },
    getRejectedNotify() { return rejectedSince; },
    cancelCommenterBlocks(ownerId, groupId) { calls.push(['cancelCommenterBlocks', ownerId, groupId]); return 2; },
    pageCommenterBlocks(ownerId, query) { return { items: [], total: 4, page: 1, pages: 1, pageSize: query.pageSize }; },
    pageGroups(ownerId, query) { const items = this.listGroups(ownerId); return { items, total: items.length, page: 1, pages: 1, pageSize: query.pageSize }; },
    getKeywords() { return []; },
    getRejectKeywords() { return []; },
    status() { return { groups: 0, active: 0, posts: 0, pending: 0 }; },
  };
  const bot = createBot({ token: "123456:test_token", allowedUserIds: [1, 2], store, maxFileBytes, collector, blockWaits, blockProgress });
  bot.botInfo = { id: 123456, is_bot: true, first_name: "Test", username: "test_monitor_bot" };
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage") {
      replies.push(payload);
      return { ok: true, result: { message_id: replies.length, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
    }
    if (method === "getFile") return { ok: true, result: getFile ? getFile(payload) : { file_id: "file", file_unique_id: "unique", file_path: "documents/file_1.txt" } };
    throw new Error(`Unexpected API call ${method}`);
  });
  async function send(text, { userId = 1, chatType = "private", document } = {}) {
    const command = text?.match(/^\/\S+/)?.[0];
    const message = {
      message_id: 1, date: 0, chat: { id: userId, type: chatType },
      from: { id: userId, is_bot: false, first_name: "User" },
      ...(document ? { document } : { text, entities: command ? [{ type: "bot_command", offset: 0, length: command.length }] : [] }),
    };
    await bot.handleUpdate({ update_id: calls.length + replies.length, message });
  }
  return { send, replies, calls, groups };
}

test('contacts command uses authenticated owner and reports source details', async () => {
  const calls = [];
  const {send,replies} = fixture({collector:{collectCommentContacts: async (...args) => {
    calls.push(args);
    return {scanned:2,items:[{author:'Alice',phones:['0912345678'],emails:['a@example.com'],text:'Liên hệ',url:'https://www.facebook.com/a/posts/42?comment_id=1'}]};
  }}});
  await send('/contacts');
  assert.equal(calls.length, 0);
  await send('/contacts https://www.facebook.com/a/posts/42', {userId:2});
  assert.deepEqual(calls, [[2,'https://www.facebook.com/a/posts/42']]);
  assert.match(replies.at(-1).text, /0912345678/);
  assert.match(replies.at(-1).text, /comment_id=1/);
  await send('/contacts https://www.facebook.com/a/posts/42', {userId:3});
  assert.equal(calls.length, 1);
});

test('profile command validates input and registers mode under the current owner',async () => {
  const {send,replies,calls}=fixture();
  await send('/profile https://www.facebook.com/alice reels');
  assert.deepEqual(calls.find(call=>call[0]==='addProfile'),['addProfile',1,'https://www.facebook.com/alice','reels']);
  assert.match(replies.at(-1).text,/\/posts 1/);
  await send('/profile https://evil.com/alice all');
  await send('/profile https://www.facebook.com/alice invalid');
  assert.equal(calls.filter(call=>call[0]==='addProfile').length,1);
});

test('profile batches deduplicate, share mode and validate all links before mutation',async () => {
  const {send,replies,calls,groups}=fixture();
  await send('/profile https://facebook.com/alice, https://facebook.com/bob\nhttps://m.facebook.com/alice/; https://facebook.com/profile.php?id=12 reels',{userId:2});
  assert.deepEqual(calls.filter(call=>call[0]==='addProfile'),[
    ['addProfile',2,'https://www.facebook.com/alice','reels'],
    ['addProfile',2,'https://www.facebook.com/bob','reels'],
    ['addProfile',2,'https://www.facebook.com/profile.php?id=12','reels'],
  ]);
  assert.match(replies.at(-1).text,/bỏ qua 1 link trùng/);
  await send('/profile https://facebook.com/carol https://evil.com/bob posts');
  assert.equal(groups.length,3);
  assert.match(replies.at(-1).text,/thứ 2 không hợp lệ/);
  await send('/profile https://facebook.com/carol https://facebook.com/david');
  assert.equal(groups.length,5);
  assert.equal(calls.filter(call=>call[0]==='addProfile').at(-1)[3],'all');
  await send('/profile reels');
  assert.equal(groups.length,5);
  assert.match(replies.at(-1).text,/Cú pháp/);
});

test('joined selection is private, validates indexes and deduplicates all', async () => {
  const owners=[];
  const {send,replies,groups}=fixture({collector:{async joinedGroups(owner) {
    owners.push(owner);
    return {groups:Array.from({length:16},(_,i)=>({name:`Group ${i+1}`,url:`https://www.facebook.com/groups/${i+1}/`})),limited:true};
  }}});
  await send('/select all');
  assert.match(replies.at(-1).text,/Dùng \/joined/);
  await send('/joined');
  assert.match(replies.at(-1).text,/chưa đầy đủ/);
  await send('/joined 2');
  assert.match(replies.at(-1).text,/16\. Group 16/);
  assert.deepEqual(owners,[1]);
  await send('/select 1,99');
  assert.equal(groups.length,0);
  await send('/select 1,2');
  assert.equal(groups.length,2);
  await send('/select all',{userId:2});
  assert.equal(groups.length,2);
  await send('/select ALL');
  assert.equal(groups.length,16);
  await send('/select all');
  assert.equal(groups.length,16);
});

test('all group mutations remain scoped to the current owner', async () => {
  const {send,calls}=fixture();
  await send('/add https://facebook.com/groups/1/ https://facebook.com/groups/2/');
  await send('/add https://facebook.com/groups/3/',{userId:2});
  for (const command of ['/daterange all off','/groupkeywords ALL off','/remove all']) await send(command);
  for (const name of ['setDateRange','setKeywords','removeGroup']) {
    assert.deepEqual(calls.filter(c=>c[0]===name).map(c=>c.slice(1,3)),[[1,1],[1,2]]);
  }
  await send('/pause all');
  assert.deepEqual(calls.at(-1),['setPaused',1,null,true]);
  await send('/resume ALL');
  assert.deepEqual(calls.at(-1),['setPaused',1,null,false]);
});

test('date command validates dates and group ownership', async () => {
  const {send,calls,replies} = fixture();
  await send('/add https://facebook.com/groups/1/');
  await send('/daterange 1 10/10/2025');
  assert.equal(calls.at(-1)[0], 'setDateRange');
  assert.equal(calls.at(-1)[3].end, null);
  await send('/daterange 1 9/9/2025 9/9/2026');
  assert.ok(calls.at(-1)[3].end);
  await send('/daterange 1 31/2/2025');
  assert.match(replies.at(-1).text, /không tồn tại/);
  await send('/daterange 1 off', {userId:2});
  assert.match(replies.at(-1).text, /Không tìm thấy/);
  await send('/daterange 1 off');
  assert.equal(calls.at(-1)[3],null);
  await send('/daterange all 08/10/2026 14:30:15');
  assert.deepEqual(calls.at(-1),['setDateRange',1,1,{start:Date.parse('2026-10-08T07:30:15Z'),end:null}]);
});

test("only private allowlisted users can register sources; whoami works before allowlist", async () => {
  const { send, replies, calls, groups } = fixture();
  await send("/add https://facebook.com/groups/1/", { chatType: "group" });
  assert.equal(replies.length, 0);
  assert.equal(calls.length, 0);
  await send("/add https://facebook.com/groups/1/", { userId: 99 });
  assert.match(replies.at(-1).text, /chưa được cấp quyền/);
  assert.equal(calls.length, 0);
  await send("/whoami", { userId: 99 });
  assert.match(replies.at(-1).text, /ID Telegram của bạn: 99/);
  assert.equal(calls.length, 0);
  await send("/add https://facebook.com/groups/1/");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ownerId, 1);
  assert.equal(groups[0].url, "https://www.facebook.com/groups/1/");
});

test("mutations cannot target another user's group ID", async () => {
  const { send, replies, calls } = fixture();
  await send("/add https://facebook.com/groups/1/");
  for (const command of ["/remove 1", "/pause 1", "/resume 1", "/groupkeywords 1 foo"]) {
    await send(command, { userId: 2 });
    assert.match(replies.at(-1).text, /Không tìm thấy nhóm/);
  }
  assert.equal(calls.filter(([name]) => name !== "ensureUser").length, 0);
});

test("upload streams stop when actual size exceeds bound, even without file_size", async (t) => {
  const { send, replies, groups } = fixture({ maxFileBytes: 32 });
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64)); },
      cancel() { cancelled = true; },
    }));
  });
  await send(undefined, { document: { file_name: "groups.txt", file_id: "file", file_unique_id: "unique" } });
  assert.equal(cancelled, true);
  assert.equal(groups.length, 0);
  assert.match(replies.at(-1).text, /Không đọc được file/);
});

test("UTF-8 CSV uploads add links and reject invalid UTF-8 without partial import", async (t) => {
  const { send, groups, replies } = fixture();
  const document = { file_name: "groups.csv", file_id: "file", file_unique_id: "unique" };
  t.mock.method(globalThis, "fetch", async () => new Response('name,url\nA,https://facebook.com/groups/1/\nB,https://facebook.com/groups/2/'));
  await send(undefined, { document });
  assert.equal(groups.length, 2);
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xfe, 0xff]));
  await send(undefined, { document });
  assert.equal(groups.length, 2);
  assert.match(replies.at(-1).text, /Không đọc được file/);
});

test("Telegram API errors are not echoed with potential credentials", async () => {
  const { send, replies } = fixture({ getFile() { throw new Error("https://api.telegram.org/bot123456:test_token/getFile"); } });
  await send(undefined, { document: { file_name: "groups.txt", file_id: "file", file_unique_id: "unique" } });
  assert.match(replies.at(-1).text, /Không đọc được file/);
  assert.equal(replies.some((reply) => reply.text.includes("test_token")), false);
});

test("reject and groupreject commands update store scoped to owner", async () => {
  const { send, calls, replies } = fixture();
  await send('/add https://facebook.com/groups/1/ https://facebook.com/groups/2/');
  await send('/reject lừa đảo; vay tiền');
  assert.deepEqual(calls.find(c => c[0] === 'setRejectKeywords' && c[2] === null), ['setRejectKeywords', 1, null, ['lừa đảo', 'vay tiền']]);
  assert.match(replies.at(-1).text, /Đã đặt từ khóa loại trừ/);

  await send('/groupreject 1 spam; quảng cáo');
  assert.deepEqual(calls.find(c => c[0] === 'setRejectKeywords' && c[2] === 1), ['setRejectKeywords', 1, 1, ['spam', 'quảng cáo']]);
  assert.match(replies.at(-1).text, /Từ khóa loại trừ.*1 nhóm/);

  await send('/reject');
  assert.match(replies.at(-1).text, /Từ khóa loại trừ.*mặc định/);

  await send('/groupreject 1 default');
  assert.deepEqual(calls.filter(c => c[0] === 'setRejectKeywords').at(-1), ['setRejectKeywords', 1, 1, null]);
  assert.match(replies.at(-1).text, /mặc định tài khoản/);

  await send('/groupkeywords 1 default');
  assert.deepEqual(calls.filter(c => c[0] === 'setKeywords').at(-1), ['setKeywords', 1, 1, null]);
  assert.match(replies.at(-1).text, /mặc định tài khoản/);
});

test("config command displays current accept, reject and source settings", async () => {
  const { send, replies, groups } = fixture();
  await send('/config');
  assert.match(replies.at(-1).text, /CẤU HÌNH HIỆN TẠI/);
  assert.match(replies.at(-1).text, /Từ khóa nhận \(Accept\)/);
  assert.match(replies.at(-1).text, /Từ khóa loại trừ \(Reject\)/);

  await send('/add https://facebook.com/groups/100/');
  await send('/config');
  assert.match(replies.at(-1).text, /#1.*đang theo dõi/);
  assert.match(replies.at(-1).text, /Accept: mặc định/);
  assert.match(replies.at(-1).text, /Reject: mặc định/);

  await send('/config 1');
  assert.match(replies.at(-1).text, /CẤU HÌNH NGUỒN #1/);
  assert.match(replies.at(-1).text, /Từ khóa nhận \(Accept\)/);
  assert.match(replies.at(-1).text, /Từ khóa chặn \(Reject\)/);

  await send('/config 999');
  assert.match(replies.at(-1).text, /Không tìm thấy nguồn/);

  await send('/list');
  assert.match(replies.at(-1).text, /Từ khóa nhận \(Accept\)/);
  assert.match(replies.at(-1).text, /Từ khóa chặn \(Reject\)/);
});



test('/rejected toggles notifications for rejected posts and reports status', async () => {
  const { send, replies, calls } = fixture();
  await send('/rejected');
  assert.match(replies.at(-1).text, /TẮT/);
  await send('/rejected on');
  assert.match(replies.at(-1).text, /Đã bật gửi bài bị loại/);
  assert.equal(calls.find(call => call[0] === 'setRejectedNotify')[2] > 0, true);
  await send('/rejected');
  assert.match(replies.at(-1).text, /BẬT/);
  await send('/rejected off');
  assert.match(replies.at(-1).text, /Đã tắt gửi bài bị loại/);
  assert.deepEqual(calls.at(-1), ['setRejectedNotify', 1, null]);
  await send('/rejected xyz');
  assert.match(replies.at(-1).text, /Cú pháp/);
});

test('blocks command lists the owner jobs with queue position, progress and counts; cancelblocks is owner scoped',async () => {
  const owners = [];
  const jobs = [
    {id:1,groupId:3,postId:'10',state:'pending',auto:false,result:null,error:null,wait:{text:'Đứng thứ 2/5 trong hàng đợi · 3 luồng đang bận'}},
    {id:2,groupId:3,postId:'11',state:'running',auto:true,result:null,error:null},
    {id:3,groupId:4,postId:'12',state:'done',auto:false,result:{blocked:4,skipped:1},error:null},
    {id:4,groupId:4,postId:'13',state:'failed',auto:false,result:null,error:'Lỗi mạng'},
  ];
  const {send,replies,calls} = fixture({blockWaits:(ownerId,options) => { owners.push([ownerId,options.limit]); return jobs; },blockProgress:id => id === 2 ? {phase:'blocking',index:3,total:8} : null});
  await send('/blocks',{userId:2});
  assert.deepEqual(owners,[[2,20]]);
  const text = replies.at(-1).text;
  assert.match(text,/#3 · bài 10 · thủ công: đang chờ\nĐứng thứ 2\/5 trong hàng đợi · 3 luồng đang bận/);
  assert.match(text,/bài 11 · tự động: đang chạy\nđang chặn 3\/8/);
  assert.match(text,/đã xong\nđã chặn 4, bỏ qua 1/);
  assert.match(text,/chưa xong\nLỗi: Lỗi mạng/);
  await send('/cancelblocks');
  assert.match(replies.at(-1).text,/Cú pháp/);
  await send('/cancelblocks 3',{userId:2});
  await send('/cancelblocks all');
  assert.deepEqual(calls.filter(call => call[0] === 'cancelCommenterBlocks'),[['cancelCommenterBlocks',2,3],['cancelCommenterBlocks',1,null]]);
  assert.match(replies.at(-1).text,/Đã hủy 2 lượt.*[Kk]hông tắt tự chặn.*\/autoblock/);
  await send('/blocks',{userId:3});
  assert.equal(owners.length,1);
});
