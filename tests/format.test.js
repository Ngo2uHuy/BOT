import test from "node:test";
import assert from "node:assert/strict";
import { formatPost } from "../src/format.js";

const group = { id: 1, label: "Nhóm nhà đất", url: "https://www.facebook.com/groups/123/" };
const post = { url: "https://www.facebook.com/groups/123/posts/456/", text: "Cần mua đất Đà Nẵng <b>gấp</b>", author: "Nguyễn An", publishedAt: "2026-10-08T10:00:00Z", reactions: 12, comments: 0, shares: null };

test("format includes text, permanent link and date and author profile without engagement", () => {
  const text = formatPost(group, post, ["mua đất"]);
  assert.ok(text.includes(post.text));
  assert.ok(text.includes(post.url));
  assert.ok(text.includes("Từ khóa: mua đất"));
  assert.match(text, /Ngày đăng:.*8\/10\/2026/);
  assert.ok(text.includes('17:00:00'));
  assert.ok(text.includes('Trang cá nhân: không rõ'));
  assert.doesNotMatch(text, /Cảm xúc \(tổng\):|Bình luận:|Chia sẻ:/);
});

test('keyword labels preserve accents and ignore case just like the filter', () => {
  assert.doesNotMatch(formatPost(group, {...post,text:'Ấn phẩm cơ bản'}, ['có bạn']), /Từ khóa:/);
  assert.match(formatPost(group, {...post,text:'CÓ BẠN giúp không'}, ['có bạn']), /Từ khóa: có bạn/);
});

test("long content is explicitly shortened without losing link or exceeding Telegram limit", () => {
  const long = formatPost({ ...group, label: "Nhóm ".repeat(2000) }, { ...post, text: "😀 Đà Nẵng\n".repeat(3000), author: "Tên ".repeat(2000), publishedAt: "giờ ".repeat(2000) }, ["Đà Nẵng".repeat(2000)]);
  assert.ok(long.length <= 4096);
  assert.ok(long.includes("Nội dung rút gọn — mở link để đọc tiếp"));
  assert.ok(long.endsWith(post.url));
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(long), false);
});

test("missing content and metrics do not become fabricated zeros", () => {
  const text = formatPost(group, { url: post.url, reactions: NaN, comments: -1, shares: "12" });
  assert.ok(text.includes("Không đọc được nội dung"));
  assert.equal((text.match(/không rõ/g) || []).length, 2);
});

test("notifications ignore unseen metadata but change for meaningful content changes", () => {
  const body = formatPost(group, post);
  assert.equal(body, formatPost(group, { ...post, seenAt: "tomorrow" }));
  assert.equal(body, formatPost(group, { ...post, reactions: 13 }));
  assert.notEqual(body, formatPost(group, { ...post, text: "Nội dung mới" }));
});

test("invalid links are refused instead of being injected into notifications", () => {
  assert.throws(() => formatPost(group, { ...post, url: "https://evil.example/post" }));
  assert.throws(() => formatPost(group, { ...post, url: `${post.url}\nFake field` }));
});
