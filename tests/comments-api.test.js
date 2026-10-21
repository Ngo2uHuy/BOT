import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { submitComment, submitCommentGraphQL } from '../src/comments.js';

test('submitCommentGraphQL returns null when session is not authenticated', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div>Unauthenticated page</div>');
    const result = await submitCommentGraphQL(page, { id: '123' }, 'Hello');
    assert.equal(result, null);
  } finally {
    await browser.close();
  }
});

test('submitCommentGraphQL successfully posts via mocked Facebook GraphQL API', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let interceptedBody = null;

    await page.route('https://www.facebook.com/**', async route => {
      const url = route.request().url();
      if (url.includes('/api/graphql/')) {
        interceptedBody = route.request().postData();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              comment_create: {
                comment: {
                  id: 'comment_123_456',
                  legacy_fbid: '456'
                }
              }
            }
          })
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <html>
            <head>
              <script>
                window.DTSGInitialData = { token: 'mock_dtsg_token_123' };
                document.cookie = 'c_user=1000123456789; path=/';
                window.require = function(mod) {
                  if (mod === 'useCometUFICreateCommentMutation_facebookRelayOperation') return '29599577942977732';
                  return null;
                };
              </script>
            </head>
            <body>
              <div id="root">Facebook App</div>
            </body>
          </html>
        `
      });
    });

    await page.goto('https://www.facebook.com/groups/123/posts/987654321');
    const result = await submitComment(page, { id: '987654321' }, 'Test GraphQL comment');
    assert.equal(result.id, 'comment_123_456');
    assert.ok(interceptedBody, 'GraphQL request should be sent');
    assert.ok(interceptedBody.includes('useCometUFICreateCommentMutation'), 'Friendly name must match');
    assert.ok(interceptedBody.includes('doc_id=29599577942977732'), 'doc_id must match');
    assert.ok(interceptedBody.includes('av=1000123456789'), 'av must match c_user');

    const params = new URLSearchParams(interceptedBody);
    const variables = JSON.parse(params.get('variables'));
    assert.equal(variables.input.actor_id, '1000123456789');
    assert.equal(variables.input.message.text, 'Test GraphQL comment');
    assert.equal(variables.input.feedback_id, Buffer.from('feedback:987654321').toString('base64'));
  } finally {
    await browser.close();
  }
});

test('missing doc_id returns {ok:false} (not success) and its reason reaches the final DOM-fallback error', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let graphqlCalled = false;
    await page.route('https://www.facebook.com/**', async route => {
      if (route.request().url().includes('/api/graphql/')) {
        graphqlCalled = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<html><head><script>
          window.DTSGInitialData = { token: 'mock_token' };
          document.cookie = 'c_user=1000123456789; path=/';
        </script></head><body></body></html>`
      });
    });

    await page.goto('https://www.facebook.com/groups/123/posts/987654321');
    const result = await submitCommentGraphQL(page, { id: '987654321' }, 'Hello');
    assert.equal(result.ok, false);
    assert.match(result.error, /doc_id/);
    assert.equal(graphqlCalled, false, 'must not send with a stale doc_id');
    // Nothing was sent, so the failure is definite (not uncertain).
    await assert.rejects(
      submitComment(page, { id: '987654321' }, 'Hello'),
      error => error.commentSubmitted === false && /Không xác định duy nhất bài viết.*\[API: Không lấy được doc_id/.test(error.message)
    );
  } finally {
    await browser.close();
  }
});

test('submitCommentGraphQL propagates critical errors from Facebook', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://www.facebook.com/**', async route => {
      const url = route.request().url();
      if (url.includes('/api/graphql/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { comment_create: null },
            errors: [{
              severity: 'CRITICAL',
              code: 1446013,
              summary: 'Bài viết đã bị gỡ'
            }]
          })
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `
          <html>
            <head>
              <script>
                window.DTSGInitialData = { token: 'mock_token' };
                document.cookie = 'c_user=1000123456789; path=/';
                window.require = mod => mod === 'useCometUFICreateCommentMutation_facebookRelayOperation' ? '29599577942977732' : null;
              </script>
            </head>
            <body></body>
          </html>
        `
      });
    });

    await page.goto('https://www.facebook.com/groups/123/posts/987654321');
    await assert.rejects(
      submitComment(page, { id: '987654321' }, 'Fail test'),
      /Facebook báo lỗi: Bài viết đã bị gỡ/
    );
  } finally {
    await browser.close();
  }
});
