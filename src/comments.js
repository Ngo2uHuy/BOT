export function commentText(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Nội dung bình luận cần từ 1 đến 2000 ký tự.');
  return text;
}

export function parseCommentList(value) {
  const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Danh sách bình luận trống. Nhập mỗi nội dung hoặc link trên một dòng.');
  return lines.map(commentText);
}

const EDITORS = '[role="textbox"], textarea, [contenteditable="true"]';

async function mainEditors(root) {
  const result = [];
  const boxes = root.locator(EDITORS);
  for (let i=0;i<await boxes.count();i++) {
    const box = boxes.nth(i);
    if (!await box.isVisible() || !await box.isEditable()) continue;
    if (await box.evaluate(node => {
      const names = ['aria-label','data-placeholder','placeholder'].map(key=>node.getAttribute(key) || '');
      names.push(...(node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || ''));
      if (!names.some(name=>/^(?:Write (?:a |an? )?(?:public )?comment|Viết bình luận|Bình luận|Comment as)/i.test(name.trim()))) return false;
      const article = node.closest('[role="article"]');
      return !article || ![...article.querySelectorAll('a[href*="comment_id="]')].some(a=>a.closest('[role="article"]') === article);
    })) result.push(box);
  }
  return result;
}

async function permalinkScope(page) {
  // Facebook can nest main/dialog landmarks or show unrelated dialogs. Match
  // the unique comment editor first, then retain its outer scope so newly added
  // comments beside an inner main region remain visible to confirmation checks.
  const scopes = page.locator('[role="dialog"]:visible, [role="main"]:visible, main:visible');
  const candidates = [];
  for (let i=0;i<await scopes.count();i++) {
    const scope = scopes.nth(i);
    if ((await mainEditors(scope)).length === 1) candidates.push(scope);
  }
  const minimal = [];
  for (const scope of candidates) {
    let containsOther = false;
    for (const other of candidates) {
      if (scope === other) continue;
      const handle = await other.elementHandle();
      try { if (handle && await scope.evaluate((node,other)=>node !== other && other.contains(node),handle)) containsOther = true; }
      finally { await handle?.dispose(); }
    }
    if (!containsOther) minimal.push(scope);
  }
  return minimal.length === 1 ? minimal[0] : null;
}

// This adapter only submits through a uniquely identified top-level post composer.
export async function submitComment(page, post, text, canSubmit = () => true) {
  let submitted = false;
  try {
  if (!/^[A-Za-z0-9_-]+$/.test(post.id)) throw new Error('ID bài không hợp lệ.');
  const articles = page.locator('[role="article"]').filter({
    has: page.locator(`a[href*="/posts/${post.id}"], a[href*="/permalink/${post.id}"]`),
  });
  const roots = [];
  for (let i = 0; !post.kind && i < await articles.count(); i++) {
    const article = articles.nth(i);
    if (await article.isVisible() && await article.evaluate((node,id) => !node.parentElement?.closest('[role="article"]') &&
      [...node.querySelectorAll('a[href]')].some(anchor => {
        const url = new URL(anchor.href);
        return new RegExp(`/groups/[^/]+/(posts|permalink)/${id}/?$`).test(url.pathname) && !url.searchParams.has('comment_id') && !url.searchParams.has('reply_comment_id') && anchor.closest('[role="article"]') === node;
      }),post.id)) roots.push(article);
  }
  // Permalink pages can render the post inside a dialog/main without an article.
  // Use this fallback only when navigation itself identifies the exact target.
  if (roots.length !== 1) {
    const actual = new URL(page.url());
    const expected = new URL(post.url || `https://www.facebook.com/groups/unknown/posts/${post.id}`);
    const path = value => value.pathname.replace('/permalink/','/posts/').replace(/\/$/,'');
    const exact = actual.protocol === 'https:' && /^(?:www\.|m\.|web\.)?facebook\.com$/.test(actual.hostname)
      && path(actual) === path(expected) && ['id','story_fbid'].every(key => actual.searchParams.get(key) === expected.searchParams.get(key))
      && !actual.searchParams.has('comment_id') && !actual.searchParams.has('reply_comment_id');
    if (exact) {
      if (post.kind === 'reel' && !(await mainEditors(page)).length) {
        const buttons = page.locator('[role="main"], main').getByRole('button', {name:/^(?:Bình luận|Comment|Comments)(?:\s+\d.*)?$/i});
        if (await buttons.count() === 1 && await buttons.first().isVisible()) await buttons.first().click();
      }
      const until = Date.now()+10000;
      do {
        const scope = await permalinkScope(page);
        if (scope) { roots.splice(0,roots.length,scope); break; }
        await page.waitForTimeout(300);
      } while (Date.now()<until);
    }
  }
  if (roots.length !== 1) {
    const counts = await page.evaluate(() => {
      const visible = selector => [...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length).length;
      return `article=${visible('[role="article"]')}, dialog=${visible('[role="dialog"]')}, main=${visible('[role="main"],main')}, editor=${visible('[contenteditable="true"],textarea,[role="textbox"]')}`;
    });
    throw new Error(`Không xác định duy nhất bài viết để bình luận (${counts}).`);
  }
  const root = roots[0];
  const editors = await mainEditors(root);
  if (editors.length !== 1) throw new Error('Không tìm thấy ô bình luận chính; bài có thể đã khóa bình luận.');
  const editor = editors[0];
  const before = await root.evaluate((node,text) => [...node.querySelectorAll('[role="article"]')]
    .filter(comment => comment.innerText.includes(text) && comment.querySelector('a[href*="comment_id="]') && !comment.querySelector('[contenteditable="true"]')).length,text);
  await editor.fill(commentText(text));
  if (!await canSubmit()) throw new Error('Đã hủy bình luận trước khi gửi.');
  // After this point any error is ambiguous: callers must never retry automatically.
  submitted = true;
  await editor.press('Enter');
  const until = Date.now()+10000;
  do {
    const count = await root.evaluate((node,text) => [...node.querySelectorAll('[role="article"]')]
      .filter(comment => comment.innerText.includes(text) && comment.querySelector('a[href*="comment_id="]') && !comment.querySelector('[contenteditable="true"]')).length,text);
    if (count > before) return;
    await page.waitForTimeout(250);
  } while (Date.now()<until);
  throw new Error('Đã thao tác gửi nhưng chưa thấy link bình luận mới; cần kiểm tra bài Facebook.');
  } catch(error) {
    error.commentSubmitted = submitted;
    throw error;
  }
}
