import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectScanPage, emptyScanError } from '../src/scan-diagnostics.js';
import { safeError } from '../src/monitor.js';

test('scan diagnostics distinguish evidence without assuming missing membership', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [html, code] of [
      ['<p>Tham gia nhóm này để xem</p>', 'MEMBERSHIP_REQUIRED'],
      ['<p>This content is not available</p>', 'CONTENT_UNAVAILABLE'],
      ['<p>You’re temporarily blocked</p>', 'RATE_LIMITED'],
      ['<div role="feed"><a href="?pending">2 giờ</a></div>', 'PERMALINK_UNRESOLVED'],
      ['<a href="/groups/1/posts/2">Bài</a>', 'POST_EXTRACTION_FAILED'],
      ['<div role="progressbar">Loading</div>', 'FEED_LOADING'],
      ['<div role="article" style="display:none"><a href="/posts/2">Hidden</a></div>', 'NO_POST_EVIDENCE'],
      ['<div role="article"><div data-ad-preview="message">You’re temporarily blocked</div></div>', 'NO_POST_EVIDENCE'],
    ]) {
      await page.setContent(html);
      const error = emptyScanError(await page.evaluate(inspectScanPage), { passes: 3 });
      assert.ok(error.message.startsWith(`[${code}]`), error.message);
      assert.match(safeError(error), /Kết quả: chưa đánh dấu quét thành công/);
    }
    const state = await page.evaluate(inspectScanPage);
    assert.match(emptyScanError(state, { snapshots: 2 }).message, /GROUP_LINK_REJECTED/);
  } finally { await browser.close(); }
});
