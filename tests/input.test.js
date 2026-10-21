import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGroupUrl, parseGroupInput, matchesKeywords, parseKeywords, testKeywords } from "../src/input.js";

test("normalize supported Facebook group home pages and remove tracking", () => {
  for (const host of ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"]) {
    assert.equal(normalizeGroupUrl(`http://${host}/groups/12345/?ref=share`), "https://www.facebook.com/groups/12345/");
  }
  assert.equal(normalizeGroupUrl("facebook.com/groups/Cho.Nha_Dat-1"), "https://www.facebook.com/groups/Cho.Nha_Dat-1/");
});

test("reject malicious hosts, credentials, ports, non-groups and posts", () => {
  for (const value of [
    "https://facebook.com.evil.example/groups/123/", "https://evilfacebook.com/groups/123/",
    "https://www.facebook.com@evil.example/groups/123/", "https://user@www.facebook.com/groups/123/",
    "https://www.facebook.com:443/groups/123/", "http://www.facebook.com:80/groups/123/",
    "https://www.facebook.com./groups/123/", "ftp://www.facebook.com/groups/123/",
    "https://%66acebook.com/groups/123/",
    "https://www.facebook.com/groups/123/posts/456/", "https://www.facebook.com/groups/123/permalink/456/",
    "https://www.facebook.com/groups/123?multi_permalinks=456", "https://www.facebook.com/groups/123?post_id=456",
    "https://www.facebook.com/groups/a%2fb/", "https://www.facebook.com/groups/a%5Cb/",
    "https://www.facebook.com/groups/a/../b/", "https://www.facebook.com/groups/%2e%2e/",
    "https://www.facebook.com/groups/..", "https://www.facebook.com/groups/",
    "https://www.facebook.com/groups/123\\@evil.example", "https://www.facebook.com/groups/123\n/posts/4",
    "https://www.facebook.com/login", "https://127.0.0.1/groups/123/", "javascript:alert(1)",
  ]) assert.throws(() => normalizeGroupUrl(value), undefined, value);
});

test("extract unique links from text or CSV and report invalid candidates", () => {
  const parsed = parseGroupInput('\uFEFFname,url\n"A","https://m.facebook.com/groups/12/?ref=share"\nB,https://www.facebook.com/groups/12/\n(https://facebook.com/groups/abc/)\nhttps://example.com/groups/3/\nhttps://facebook.com/groups/12/posts/4/');
  assert.deepEqual(parsed.urls, ["https://www.facebook.com/groups/12/", "https://www.facebook.com/groups/abc/"]);
  assert.deepEqual(parsed.invalid, ["https://example.com/groups/3/", "https://facebook.com/groups/12/posts/4/"]);
  assert.deepEqual(parseGroupInput("name,url\nKhông có link"), { urls: [], invalid: [] });
});

test("Vietnamese keyword matching preserves accents and ignores case with OR substring", () => {
  assert.equal(matchesKeywords("Cần MUA ĐẤT ở Đà Nẵng", ["thuê nhà", "mua đất"]), true);
  assert.equal(matchesKeywords("Cần MUA ĐẤT ở Đà Nẵng", ["mua dat"]), false);
  assert.equal(matchesKeywords("TUYỂN DỤNG lập trình", ["tuyển dụng"]), true);
  assert.equal(matchesKeywords("Bán xe", ["mua đất"]), false);
  assert.equal(matchesKeywords("bất kỳ", []), true);
  assert.equal(matchesKeywords(null, null), true);
  assert.deepEqual(parseKeywords("Mua đất; mua dat; MUA ĐẤT; tuyển dụng\n cho thuê"), ["Mua đất", "mua dat", "tuyển dụng", "cho thuê"]);
  assert.deepEqual(parseKeywords("OFF"), []);
});

test("accept and reject keyword filtering", () => {
  assert.equal(matchesKeywords("Cần Mua Đất nhưng môi giới", ["mua đất"], ["môi giới"]), false);
  assert.equal(matchesKeywords("Cần Mua Đất chính chủ", ["mua đất"], ["môi giới"]), true);
  assert.equal(matchesKeywords("Cho vay tiền online nhanh", [], ["vay tiền"]), false);
  assert.equal(matchesKeywords("Tuyển dụng nhân viên kế toán", [], ["vay tiền"]), true);
  assert.equal(matchesKeywords("CHO VAY NÓNG lãi thấp", [], ["vay nóng"]), false);
  assert.equal(matchesKeywords("CHO VAY NÓNG lãi thấp", [], ["vay nong"]), true);
  assert.equal(matchesKeywords("Bất kỳ bài viết nào", [], []), true);
});

test('có bạn never matches cơ bản in accept, reject or keyword deduplication', () => {
  const ad = 'Thiết kế sơ đồ, biểu đồ và ấn phẩm cơ bản';
  assert.equal(matchesKeywords(ad, ['có bạn']), false);
  assert.equal(matchesKeywords('CÓ BẠN nào làm được không?', ['có bạn']), true);
  assert.equal(matchesKeywords('co ban nào làm được không?', ['có bạn']), false);
  assert.equal(matchesKeywords(ad, [], ['có bạn']), true);
  assert.equal(matchesKeywords('CÓ BẠN nào làm được không?', [], ['có bạn']), false);
  assert.deepEqual(parseKeywords(`có bạn;CÓ BẠN;${'có bạn'.normalize('NFD')};cơ bản;co ban`), ['có bạn','cơ bản','co ban']);
});

test('filter diagnostics agree with production filtering and report both matches', () => {
  for (const [text,accept,reject] of [
    ['CÓ BẠN giúp không',['có bạn'],[]], ['ấn phẩm cơ bản',['có bạn'],[]],
    ['CÓ BẠN, mình nhận làm',['có bạn'],['mình nhận']],
    ['bất kỳ',[],[]], ['bất kỳ',[],['BẤT KỲ']],
    ['có bạn'.normalize('NFD'),['có bạn'],[]], ['nội dung',[' '],['']],
  ]) assert.equal(testKeywords(text,accept,reject).accepted,matchesKeywords(text,accept,reject));
  const result=testKeywords('CÓ BẠN, mình nhận làm',['có bạn'],['mình nhận']);
  assert.deepEqual(result.matchedAccept,['có bạn']);
  assert.deepEqual(result.matchedReject,['mình nhận']);
  assert.equal(result.accepted,false);
});
