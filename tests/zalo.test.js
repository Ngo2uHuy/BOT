import test from 'node:test';
import assert from 'node:assert/strict';
import { zaloPhones } from '../src/zalo.js';
import { postButtons } from '../src/post-buttons.js';

test('Zalo candidates use only post body, normalize and deduplicate mobile numbers', () => {
  assert.deepEqual(zaloPhones({text:'0912.345.678 +84 912 345 678; 0084 987 654 321; 024 1234 5678'}), ['0912345678','0987654321']);
  assert.deepEqual(zaloPhones({text:'ID 12309123456789', author:'0912345678', url:'https://example.com/0912345678', phones:['0912345678']}), []);
  assert.deepEqual(zaloPhones(null), []);
});

test('Zalo contact button appears for anonymous posts with mobile numbers only', () => {
  const post = {url:'https://www.facebook.com/groups/123/posts/10',author:'Anonymous member'};
  const hasZalo = text => postButtons({...post,text}).inline_keyboard.flat().some(button => button.callback_data === 'post:zalo');
  assert.equal(hasZalo('Liên hệ 0912345678'), true);
  assert.equal(hasZalo('Không có số'), false);
  assert.equal(hasZalo('024 1234 5678'), false);
});
