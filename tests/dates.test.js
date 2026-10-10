import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateRange, matchesDateRange, formatDateRange } from '../src/dates.js';
import { parsePublishedAt, normalizeAuthorUrl } from '../src/facebook.js';

test('clock ranges use Vietnam time and include the final second', () => {
  const range = parseDateRange('08/10/2026 14:30:15 08/10/2026 15:00:00');
  assert.equal(range.start,Date.parse('2026-10-08T07:30:15Z'));
  assert.equal(range.end,Date.parse('2026-10-08T08:00:01Z'));
  assert.match(formatDateRange(range),/14:30:15/);
  assert.match(formatDateRange(range),/15:00:00/);
  const now = Date.parse('2026-10-09T00:00:00Z');
  for (const [publishedAt,expected] of [['2026-10-08T07:30:14Z',false],['2026-10-08T07:30:15Z',true],['2026-10-08T08:00:00.999Z',true],['2026-10-08T08:00:01Z',false]]) {
    assert.equal(matchesDateRange({publishedAt},range,now),expected);
  }
  assert.equal(parseDateRange('08/10/2026 14:30:15').end,null);
  assert.equal(parseDateRange('08/10/2026 14:30:15 09/10/2026').end,Date.parse('2026-10-09T17:00:00Z'));
  for (const clock of ['24:00:00','12:60:00','12:00:60','1:00:00','12:00']) assert.throws(()=>parseDateRange(`08/10/2026 ${clock}`));
  assert.throws(()=>parseDateRange('08/10/2026 15:00:00 08/10/2026 14:59:59'));
});

test('Vietnamese date ranges include full boundary days and reject unknown dates', () => {
  const range = parseDateRange('9/9/2025 9/9/2026');
  const matches = publishedAt => matchesDateRange({ publishedAt }, range, Date.parse('2026-10-01Z'));
  assert.equal(matches('2025-09-08T16:59:59Z'), false);
  assert.equal(matches('2025-09-08T17:00:00Z'), true);
  assert.equal(matches('2026-09-09T16:59:59.999Z'), true);
  assert.equal(matches('2026-09-09T17:00:00Z'), false);
  assert.equal(matches(null), false);
  assert.equal(parseDateRange('10/10/2025').end, null);
  assert.equal(parseDateRange('off'), null);
  for (const value of ['31/2/2025', '29/2/2025', '10/10/2026 9/10/2026', '2025-10-10', '1/1/2025 extra extra']) assert.throws(() => parseDateRange(value));
  assert.ok(parseDateRange('29/2/2024'));
  assert.equal(matchesDateRange({ publishedAt: '2030-01-01T00:00:00Z' }, parseDateRange('10/10/2025'), Date.parse('2026-01-01T00:00:00Z')), false);
});

test('absolute Facebook dates and safe author links', () => {
  assert.equal(parsePublishedAt('8/10/2026 lúc 13:45'), '2026-10-08T06:45:00.000Z');
  assert.equal(parsePublishedAt('Thursday, October 8, 2026 at 1:45 PM'), '2026-10-08T06:45:00.000Z');
  assert.equal(parsePublishedAt('8 tháng 10 năm 2026 lúc 13:45'), '2026-10-08T06:45:00.000Z');
  assert.equal(parsePublishedAt('Thứ Sáu, 10 tháng 10, 2025 lúc 08:30'), '2025-10-10T01:30:00.000Z');
  assert.equal(parsePublishedAt('2 giờ'), null);
  assert.equal(parsePublishedAt('31 tháng 2, 2025'), null);
  assert.equal(normalizeAuthorUrl('https://www.facebook.com/groups/1/user/123/?ref=x'), 'https://www.facebook.com/profile.php?id=123');
  assert.equal(normalizeAuthorUrl('https://evil.test/person'), null);
  assert.equal(normalizeAuthorUrl('https://www.facebook.com/groups/1/posts/2'), null);
});
